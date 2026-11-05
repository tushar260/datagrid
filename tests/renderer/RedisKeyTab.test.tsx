// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RedisKeyTab from '../../src/renderer/src/RedisKeyTab'
import { redisKeyRef } from '../../src/renderer/src/lib/refs'
import { resetExplorerClick, setExplorerRefreshProbe, trackExplorerClicks } from '../../src/renderer/src/lib/focusZone'
import { REDIS_BIN_PREFIX, type RedisKeyDetail, type RedisValue } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

const detail = (k: string, value: RedisValue, over: Partial<RedisKeyDetail> = {}): RedisKeyDetail => ({
  key: k, type: value.kind === 'none' ? 'none' : value.kind === 'unsupported' ? value.type : value.kind, ttl: -1, size: 64, length: 1, encoding: 'embstr', value, ...over
})
const str = (text: string, over: Partial<Extract<RedisValue, { kind: 'string' }>> = {}): RedisValue =>
  ({ kind: 'string', text, binary: false, base64: btoa(text), bytes: text.length, truncated: false, ...over })

let api: MockApi
let clip: ReturnType<typeof vi.fn>
let confirmFn: ReturnType<typeof vi.fn>
const cbs = { onType: vi.fn(), onRenamed: vi.fn(), onDeleted: vi.fn() }

function setup(get: (k: string) => RedisKeyDetail | Promise<RedisKeyDetail> = (k) => detail(k, str('hello'))): void {
  api = installApi({
    redis: {
      get: vi.fn(async (_d: string, _db: number, k: string) => get(k)),
      setString: vi.fn(async () => undefined),
      setTtl: vi.fn(async () => undefined),
      delete: vi.fn(async () => 1),
      rename: vi.fn(async () => undefined),
      item: vi.fn(async () => undefined)
    }
  })
}
beforeEach(() => {
  resetExplorerClick()
  clip = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  confirmFn = vi.fn(() => true)
  window.confirm = confirmFn as never
  for (const f of Object.values(cbs)) f.mockClear()
  setup()
})
afterEach(cleanup)

const ref = (k: string, db = 2) => redisKeyRef('ds1', 'Cache', db, k)
const ui = (k: string, extra: Record<string, unknown> = {}, db = 2): React.JSX.Element => (
  <RedisKeyTab t={ref(k, db)} {...cbs} {...extra} />
)
const pane = (): HTMLElement => screen.getByTestId('redis-detail')
const btn = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement

describe('RedisKeyTab', () => {
  it('loads the key of the ref (db and name) and shows the detail pane full width', async () => {
    render(ui('user:42:profile'))
    await waitFor(() => expect(pane()).toBeTruthy())
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledWith('ds1', 2, 'user:42:profile'))
    expect(document.querySelector('.rk-tab')).toBeTruthy()
    expect(document.querySelector('.rk-name')!.textContent).toBe('user:42:profile')
    await waitFor(() => expect((document.querySelector('.rk-text') as HTMLTextAreaElement).value).toBe('hello'))
  })

  it('header: type badge, TTL editor, size / length / encoding', async () => {
    setup((k) => detail(k, str('abc'), { ttl: 90_000, size: 2048, length: 3, encoding: 'embstr' }))
    render(ui('k'))
    await waitFor(() => expect(pane().textContent).toContain('2.0 KB'))
    expect(pane().querySelector('.rk-head span[class*="type"], .rk-head .badge, .rk-head > span:first-child')!.textContent).toBe('string')
    expect((pane().querySelector('.rk-ttl input') as HTMLInputElement).value).toBe('90')
    expect(pane().textContent).toContain('Expires in')
    expect(pane().textContent).toContain('3 bytes')
    expect(pane().textContent).toContain('embstr')
    for (const b of ['Rename', 'Copy', 'Copy value', 'Delete']) expect(btn(b)).toBeTruthy()
  })

  it('reports the key type once loaded (the tab icon) but not for a missing key', async () => {
    render(ui('h1'))
    await waitFor(() => expect(cbs.onType).toHaveBeenCalledWith('string'))
    cleanup()
    cbs.onType.mockClear()
    setup((k) => detail(k, { kind: 'none' }, { ttl: -2 }))
    render(ui('gone'))
    await waitFor(() => expect(pane().textContent).toContain('no longer exists'))
    expect(cbs.onType).not.toHaveBeenCalled()
  })

  describe('every type renders', () => {
    const cases: [string, RedisValue, string[]][] = [
      ['string', str('plain text'), ['plain text']],
      ['hash', { kind: 'hash', items: [{ field: 'f1', value: 'v1' }, { field: 'f2', value: 'v2' }], next: null }, ['f1', 'v1', 'f2', 'v2']],
      ['list', { kind: 'list', items: ['one', 'two'], offset: 0, next: null }, ['one', 'two']],
      ['set', { kind: 'set', items: ['m1', 'm2'], next: null }, ['m1', 'm2']],
      ['zset', { kind: 'zset', items: [{ member: 'alice', score: '1.5' }, { member: 'bob', score: '2' }], offset: 0, next: null }, ['alice', '1.5', 'bob']],
      ['stream', { kind: 'stream', entries: [{ id: '1-0', fields: [{ field: 'temp', value: '21' }] }], next: null }, ['1-0', 'temp', '21']],
      ['ReJSON-RL', { kind: 'unsupported', type: 'ReJSON-RL' }, ['module type']]
    ]
    it.each(cases)('%s', async (type, value, texts) => {
      setup((k) => detail(k, value, { type }))
      render(ui('k'))
      await waitFor(() => expect(cbs.onType).toHaveBeenCalledWith(type))
      for (const t of texts) {
        await waitFor(() => {
          const ta = document.querySelector('.rk-text') as HTMLTextAreaElement | null
          expect(pane().textContent + (ta?.value ?? '')).toContain(t)
        })
      }
    })
  })

  it('a binary-named key is requested with its encoded name and shown escaped', async () => {
    const enc = REDIS_BIN_PREFIX + Buffer.from([0xff, 0x41]).toString('base64')
    render(ui(enc))
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledWith('ds1', 2, enc))
    expect(document.querySelector('.rk-name')!.textContent).toBe('\\xffA')
  })

  describe('delete', () => {
    it('confirms, deletes the key and tells the app (which closes the tab)', async () => {
      render(ui('doomed'))
      await waitFor(() => expect(btn('Delete').disabled).toBe(false))
      fireEvent.click(btn('Delete'))
      expect(confirmFn.mock.calls[0][0]).toContain('doomed')
      await waitFor(() => expect(api.redis.delete).toHaveBeenCalledWith('ds1', 2, ['doomed']))
      await waitFor(() => expect(cbs.onDeleted).toHaveBeenCalledTimes(1))
    })

    it('declining does nothing', async () => {
      confirmFn.mockReturnValue(false)
      render(ui('safe'))
      await waitFor(() => expect(btn('Delete').disabled).toBe(false))
      fireEvent.click(btn('Delete'))
      expect(api.redis.delete).not.toHaveBeenCalled()
      expect(cbs.onDeleted).not.toHaveBeenCalled()
    })

    it('a failure is shown and the tab stays', async () => {
      api.redis.delete.mockRejectedValue(new Error("Error invoking remote method 'redis:delete': Error: READONLY replica"))
      render(ui('k'))
      await waitFor(() => expect(btn('Delete').disabled).toBe(false))
      fireEvent.click(btn('Delete'))
      await waitFor(() => expect(pane().textContent).toContain('READONLY replica'))
      expect(cbs.onDeleted).not.toHaveBeenCalled()
    })
  })

  describe('rename', () => {
    it('renames the key and tells the app the new name (the tab re-keys and retitles)', async () => {
      const user = userEvent.setup()
      render(ui('old:name'))
      await waitFor(() => expect(btn('Rename').disabled).toBe(false))
      await user.click(btn('Rename'))
      const input = document.querySelector('.rk-rename') as HTMLInputElement
      expect(input.value).toBe('old:name')
      await user.clear(input)
      await user.type(input, 'new:name{Enter}')
      await waitFor(() => expect(api.redis.rename).toHaveBeenCalledWith('ds1', 2, 'old:name', 'new:name'))
      await waitFor(() => expect(cbs.onRenamed).toHaveBeenCalledWith('new:name'))
    })

    it('an unchanged name or Escape renames nothing', async () => {
      const user = userEvent.setup()
      render(ui('k'))
      await waitFor(() => expect(btn('Rename').disabled).toBe(false))
      await user.click(btn('Rename'))
      await user.type(document.querySelector('.rk-rename') as HTMLInputElement, '{Enter}')
      await user.click(btn('Rename'))
      await user.type(document.querySelector('.rk-rename') as HTMLInputElement, 'x{Escape}')
      expect(api.redis.rename).not.toHaveBeenCalled()
      expect(cbs.onRenamed).not.toHaveBeenCalled()
    })

    it('a name that already exists is reported', async () => {
      const user = userEvent.setup()
      api.redis.rename.mockRejectedValue(new Error('Key "b" already exists'))
      render(ui('a'))
      await waitFor(() => expect(btn('Rename').disabled).toBe(false))
      await user.click(btn('Rename'))
      const input = document.querySelector('.rk-rename') as HTMLInputElement
      await user.clear(input)
      await user.type(input, 'b{Enter}')
      await waitFor(() => expect(pane().textContent).toContain('already exists'))
      expect(cbs.onRenamed).not.toHaveBeenCalled()
    })
  })

  describe('a key that is gone', () => {
    it('shows "no longer exists" with a Reload that fetches again (and recovers when it is back)', async () => {
      let exists = false
      setup((k) => (exists ? detail(k, str('back')) : detail(k, { kind: 'none' }, { ttl: -2 })))
      render(ui('x'))
      await waitFor(() => expect(pane().textContent).toContain('This key no longer exists'))
      expect(btn('Delete').disabled).toBe(true)
      expect(btn('Rename').disabled).toBe(true)
      exists = true
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
      await waitFor(() => expect((document.querySelector('.rk-text') as HTMLTextAreaElement).value).toBe('back'))
      expect(pane().textContent).not.toContain('no longer exists')
    })

    it('a load error is shown', async () => {
      api = installApi({ redis: { get: vi.fn(async () => { throw new Error("Error invoking remote method 'redis:get': Error: Connection refused") }) } })
      render(ui('x'))
      await waitFor(() => expect(pane().textContent).toContain('Connection refused'))
      expect(pane().textContent).not.toContain('Error invoking')
    })
  })

  describe('edits update in place', () => {
    it('Save / Revert / Format JSON sit in the header bar, above the editor', async () => {
      render(ui('s'))
      await waitFor(() => expect(document.querySelector('.rk-text')).toBeTruthy())
      const head = pane().querySelector('.rk-head') as HTMLElement
      for (const n of ['Save', 'Revert', 'Format JSON']) {
        expect(head.contains(btn(n))).toBe(true)
        expect(pane().querySelector('.rk-value')!.contains(btn(n))).toBe(false)
      }
      expect(pane().querySelector('.rk-actions')).toBeNull()
      const ta = document.querySelector('.rk-text') as HTMLElement
      expect(head.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(btn('Save').disabled).toBe(true)
    })

    it('saving a string keeps the TTL and reloads the key', async () => {
      const user = userEvent.setup()
      render(ui('s'))
      await waitFor(() => expect((document.querySelector('.rk-text') as HTMLTextAreaElement).value).toBe('hello'))
      const ta = document.querySelector('.rk-text') as HTMLTextAreaElement
      await user.clear(ta)
      await user.type(ta, 'changed')
      api.redis.get.mockClear()
      await user.click(btn('Save'))
      await waitFor(() => expect(api.redis.setString).toHaveBeenCalledWith('ds1', 2, 's', 'changed', { keepTtl: true }))
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(1))
      expect(cbs.onRenamed).not.toHaveBeenCalled()
      expect(cbs.onDeleted).not.toHaveBeenCalled()
    })

    it('setting a TTL and removing it', async () => {
      const user = userEvent.setup()
      render(ui('s'))
      await waitFor(() => expect(pane().querySelector('.rk-ttl input')).toBeTruthy())
      const ttl = pane().querySelector('.rk-ttl input') as HTMLInputElement
      await user.type(ttl, '5m')
      await user.click(btn('Set'))
      await waitFor(() => expect(api.redis.setTtl).toHaveBeenCalledWith('ds1', 2, 's', 300))
    })

    it('Persist removes the expiry', async () => {
      setup((k) => detail(k, str('x'), { ttl: 90_000 }))
      render(ui('s'))
      await waitFor(() => expect(btn('Persist').disabled).toBe(false))
      fireEvent.click(btn('Persist'))
      await waitFor(() => expect(api.redis.setTtl).toHaveBeenCalledWith('ds1', 2, 's', null))
    })
  })

  describe('Copy value', () => {
    it('copies a string value as text (including unsaved edits)', async () => {
      const user = userEvent.setup()
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
      render(ui('s'))
      await waitFor(() => expect(btn('Copy value').disabled).toBe(false))
      fireEvent.click(btn('Copy value'))
      expect(clip).toHaveBeenCalledWith('hello')
      const ta = document.querySelector('.rk-text') as HTMLTextAreaElement
      await user.type(ta, '!')
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
      fireEvent.click(btn('Copied value')) // (the label flips for a moment after the first copy)
      expect(clip).toHaveBeenLastCalledWith('hello!')
    })

    it('copies a hash as JSON and the key name with the plain Copy button', async () => {
      setup((k) => detail(k, { kind: 'hash', items: [{ field: 'a', value: '1' }, { field: 'b', value: '2' }], next: null }))
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
      render(ui('hh'))
      await waitFor(() => expect(btn('Copy value').disabled).toBe(false))
      fireEvent.click(btn('Copy value'))
      expect(JSON.parse(clip.mock.calls[0][0])).toEqual({ a: '1', b: '2' })
      fireEvent.click(btn('Copy'))
      expect(clip).toHaveBeenLastCalledWith('hh')
    })

    it('is disabled for a missing key', async () => {
      setup((k) => detail(k, { kind: 'none' }, { ttl: -2 }))
      render(ui('x'))
      await waitFor(() => expect(pane().textContent).toContain('no longer exists'))
      expect(btn('Copy value').disabled).toBe(true)
    })
  })

  describe('reloading', () => {
    it('a changed reloadToken reloads the key', async () => {
      const r = render(ui('k', { reloadToken: 0 }))
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(1))
      r.rerender(ui('k', { reloadToken: 1 }))
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(2))
      r.rerender(ui('k', { reloadToken: 1 }))
      await new Promise((x) => setTimeout(x, 20))
      expect(api.redis.get).toHaveBeenCalledTimes(2)
    })

    it('⌘R reloads the active tab', async () => {
      render(ui('k'))
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(1))
      fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', metaKey: true })
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(2))
    })

    it('⌘R works with the focus inside the value textarea and the TTL input, and shows the loading state while reloading', async () => {
      let n = 0
      let release: (() => void) | null = null
      setup((k) => (++n === 1 ? detail(k, str('v1')) : new Promise<RedisKeyDetail>((r) => { release = () => r(detail(k, str('v2'))) })))
      render(ui('k'))
      const ta = (): HTMLTextAreaElement => document.querySelector('.rk-text') as HTMLTextAreaElement
      await waitFor(() => expect(ta().value).toBe('v1'))
      ta().focus()
      fireEvent.keyDown(ta(), { key: 'r', code: 'KeyR', metaKey: true })
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(pane().classList.contains('reloading')).toBe(true))
      expect(pane().getAttribute('aria-busy')).toBe('true')
      expect(ta().value).toBe('v1') // the old value stays until the new one arrives
      release!()
      await waitFor(() => expect(ta().value).toBe('v2'))
      expect(pane().classList.contains('reloading')).toBe(false)
      const ttl = pane().querySelector('.rk-ttl input') as HTMLInputElement
      ttl.focus()
      fireEvent.keyDown(ttl, { key: 'r', code: 'KeyR', ctrlKey: true })
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(3))
    })

    it('⌘R reloads when the focus is in a text field of the explorer (filter box) or the explorer has nothing to refresh', async () => {
      const untrack = trackExplorerClicks()
      const side = document.createElement('div')
      side.className = 'explorer'
      side.innerHTML = '<input class="filter" />'
      document.body.appendChild(side)
      render(ui('k'))
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(1))
      const filter = side.querySelector('input') as HTMLInputElement
      fireEvent.mouseDown(filter)
      fireEvent.keyDown(filter, { key: 'r', code: 'KeyR', metaKey: true })
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(2))
      // tree focused, but nothing selected to refresh: the tab takes it
      const unprobe = setExplorerRefreshProbe(() => false)
      fireEvent.mouseDown(side)
      fireEvent.keyDown(side, { key: 'r', code: 'KeyR', metaKey: true })
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(3))
      // ... and when the tree does have something to refresh it stays the explorer's
      unprobe()
      const unprobe2 = setExplorerRefreshProbe(() => true)
      fireEvent.keyDown(side, { key: 'r', code: 'KeyR', metaKey: true })
      await new Promise((x) => setTimeout(x, 20))
      expect(api.redis.get).toHaveBeenCalledTimes(3)
      unprobe2()
      untrack()
      side.remove()
    })

    it('⌘R asks before dropping unsaved text: declining keeps it, accepting reloads; a clean editor reloads without asking', async () => {
      const user = userEvent.setup()
      let server = 'v1'
      setup((k) => detail(k, str(server)))
      render(ui('k'))
      const ta = (): HTMLTextAreaElement => document.querySelector('.rk-text') as HTMLTextAreaElement
      await waitFor(() => expect(ta().value).toBe('v1'))
      // clean: no prompt
      server = 'v2'
      fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', metaKey: true })
      await waitFor(() => expect(ta().value).toBe('v2'))
      expect(confirmFn).not.toHaveBeenCalled()
      // dirty + declined
      await user.type(ta(), '!')
      server = 'v3'
      confirmFn.mockReturnValueOnce(false)
      api.redis.get.mockClear()
      fireEvent.keyDown(ta(), { key: 'r', code: 'KeyR', metaKey: true })
      expect(confirmFn).toHaveBeenCalledTimes(1)
      expect(String(confirmFn.mock.calls[0][0])).toContain('unsaved')
      await new Promise((x) => setTimeout(x, 20))
      expect(api.redis.get).not.toHaveBeenCalled()
      expect(ta().value).toBe('v2!')
      // the ⟳ button asks as well; accepting reloads and replaces the text
      fireEvent.click(btn('⟳'))
      expect(confirmFn).toHaveBeenCalledTimes(2)
      await waitFor(() => expect(ta().value).toBe('v3'))
      expect(btn('Save').disabled).toBe(true)
    })

    it('⌘R is left to the explorer when the last click was in it, and ignored in inactive tabs and open dialogs', async () => {
      const untrack = trackExplorerClicks()
      const side = document.createElement('div')
      side.className = 'explorer'
      document.body.appendChild(side)
      render(ui('k'))
      await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(1))
      fireEvent.mouseDown(side)
      fireEvent.keyDown(side, { key: 'r', code: 'KeyR', metaKey: true })
      await new Promise((x) => setTimeout(x, 20))
      expect(api.redis.get).toHaveBeenCalledTimes(1)
      untrack()
      side.remove()
      cleanup()
      resetExplorerClick()
      api.redis.get.mockClear()
      render(ui('k', { active: false }))
      fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', metaKey: true })
      await new Promise((x) => setTimeout(x, 20))
      expect(api.redis.get).not.toHaveBeenCalled()
    })
  })

  it('a restored (inactive) tab fetches nothing until it is first shown', async () => {
    const r = render(ui('k', { active: false }))
    await new Promise((x) => setTimeout(x, 30))
    expect(api.redis.get).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Loading…')
    r.rerender(ui('k', { active: true }))
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(1))
    r.rerender(ui('k', { active: false }))
    r.rerender(ui('k', { active: true }))
    expect(api.redis.get).toHaveBeenCalledTimes(1)
  })

  it('a different key (renamed tab) starts clean and loads the new name', async () => {
    const r = render(ui('old'))
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledWith('ds1', 2, 'old'))
    r.rerender(ui('new'))
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledWith('ds1', 2, 'new'))
    expect(document.querySelector('.rk-name')!.textContent).toBe('new')
  })
})
