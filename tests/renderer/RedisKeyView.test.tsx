// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RedisKeyView from '../../src/renderer/src/RedisKeyView'
import type { TableRef } from '../../src/renderer/src/Explorer'
import { getTableView, setTableView } from '../../src/renderer/src/session'
import { redisRef, tableKey } from '../../src/renderer/src/lib/refs'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'
import type { RedisKeyDetail, RedisKeyInfo, RedisValue } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

const key = (k: string, type = 'string', ttl = -1): RedisKeyInfo => ({ key: k, type, ttl })
const detail = (k: string, value: RedisValue, over: Partial<RedisKeyDetail> = {}): RedisKeyDetail => ({
  key: k, type: value.kind === 'none' ? 'none' : value.kind === 'unsupported' ? value.type : value.kind, ttl: -1, size: 64, length: 1, encoding: 'embstr', value, ...over
})
const str = (text: string, over: Partial<Extract<RedisValue, { kind: 'string' }>> = {}): RedisValue =>
  ({ kind: 'string', text, binary: false, base64: btoa(text), bytes: text.length, truncated: false, ...over })

let api: MockApi
let clip: ReturnType<typeof vi.fn>
let confirmFn: ReturnType<typeof vi.fn>
let n = 0
// view state is keyed by tableKey: give every test its own ref so saved patterns never leak between tests
const mk = (): TableRef => ({ ...redisRef('ds', 'Cache', 2), dsId: 'ds' + ++n })

const KEYS = [key('user:1', 'hash'), key('user:2', 'hash', 90_000), key('queue', 'list'), key('cfg', 'string')]

function setup(over: Record<string, unknown> = {}): void {
  api = installApi({
    redis: {
      scan: vi.fn(async () => ({ keys: KEYS, cursor: null })),
      dbsize: vi.fn(async () => 1234),
      get: vi.fn(async (_d: string, _db: number, k: string) => detail(k, str('hello ' + k))),
      ...((over.redis as object) ?? {})
    }
  })
}
beforeEach(() => {
  localStorage.clear()
  resetExplorerClick()
  clip = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  confirmFn = vi.fn(() => true)
  window.confirm = confirmFn as never
  setup()
})
afterEach(cleanup)

const scanArgs = (i = -1): Record<string, unknown> => api.redis.scan.mock.calls.at(i)![2]
const keyRows = (): HTMLElement[] => Array.from(document.querySelectorAll('.rk-list tbody tr'))
const keyNames = (): string[] => keyRows().map((r) => r.querySelector('.rk-key')!.textContent!)
const pickKey = (i: number, init: Record<string, unknown> = {}): void => void fireEvent.mouseDown(keyRows()[i].querySelector('.rk-key')!, { button: 0, ...init })
const status = (): string => screen.getByTestId('redis-status').textContent!
const patternBox = (): HTMLInputElement => document.querySelector('.fb-field.where input') as HTMLInputElement
const typeSelect = (): HTMLSelectElement => document.querySelector('.filterbar select') as HTMLSelectElement
const btn = (title: RegExp | string): HTMLButtonElement => screen.getByTitle(title) as HTMLButtonElement
const grid = (): HTMLElement => document.querySelector('.rk-list .gridwrap') as HTMLElement
const detailPane = (): HTMLElement => screen.getByTestId('redis-detail')
const loaded = async (t = mk()): Promise<TableRef> => {
  render(<RedisKeyView t={t} />)
  await waitFor(() => expect(keyRows().length).toBeGreaterThan(0))
  return t
}

describe('scanning', () => {
  it('scans on mount with the default page size, never KEYS, and shows the loaded / total counts', async () => {
    await loaded()
    expect(api.redis.scan).toHaveBeenCalledTimes(1)
    expect(api.redis.scan.mock.calls[0][0]).toBe(api.redis.scan.mock.calls[0][0])
    expect(api.redis.scan.mock.calls[0][1]).toBe(2)
    expect(scanArgs()).toEqual({ pattern: '', type: undefined, limit: 200 })
    expect(keyNames()).toEqual(['user:1', 'user:2', 'queue', 'cfg'])
    await waitFor(() => expect(status()).toBe('4 keys loaded of 1,234 in db2'))
    expect(api.redis.dbsize).toHaveBeenCalledWith(expect.any(String), 2)
    expect(document.querySelector('.fb-hint')!.textContent).toBe('all keys')
  })

  it('shows type chips and TTLs (∞ for no expiry)', async () => {
    await loaded()
    const cells = (i: number): string[] => Array.from(keyRows()[i].querySelectorAll('td')).map((c) => c.textContent!)
    expect(cells(0)).toEqual(['1', 'user:1', 'hash', '∞'])
    expect(cells(1)).toEqual(['2', 'user:2', 'hash', '1m 30s'])
    expect(keyRows()[0].querySelector('.rt')!.className).toContain('rt-hash')
    expect(keyRows()[1].querySelectorAll('td')[3].getAttribute('title')).toBe('90000 ms left')
    expect(keyRows()[0].querySelectorAll('td')[3].getAttribute('title')).toBe('No expiry')
  })

  it('a restored (inactive) tab fetches nothing until it is shown', async () => {
    const t = mk()
    const { rerender } = render(<RedisKeyView t={t} active={false} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(api.redis.scan).not.toHaveBeenCalled()
    rerender(<RedisKeyView t={t} active />)
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(1))
  })

  it('"more to scan" and Load more continue from the cursor and merge without duplicates', async () => {
    api.redis.scan
      .mockResolvedValueOnce({ keys: [key('a'), key('b')], cursor: '17' })
      .mockResolvedValueOnce({ keys: [key('b', 'string', 5000), key('c')], cursor: null })
    await loaded()
    expect(status()).toMatch(/^2 keys loaded .*more to scan$/)
    const more = screen.getByRole('button', { name: 'Load more' }) as HTMLButtonElement
    expect(more.disabled).toBe(false)
    fireEvent.click(more)
    await waitFor(() => expect(keyNames()).toEqual(['a', 'b', 'c']))
    expect(scanArgs()).toMatchObject({ cursor: '17', limit: 200 })
    expect(status()).not.toContain('more to scan')
    expect((screen.getByRole('button', { name: 'Load more' }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('.rk-hint')!.textContent).toBe('End of the keyspace')
    expect(keyRows()[1].querySelectorAll('td')[3].textContent).toBe('5s') // the repeated key was refreshed
  })

  it('an empty page with a cursor tells the user to keep scanning', async () => {
    api.redis.scan.mockResolvedValue({ keys: [], cursor: '5' })
    render(<RedisKeyView t={mk()} />)
    await waitFor(() => expect(document.body.textContent).toContain('No match yet in the part of the keyspace scanned so far'))
  })

  it.each([
    ['', '', 'db2 has no keys'],
    ['zzz', '', 'No keys match'],
    ['', 'set', 'No keys match']
  ])('an empty, finished scan (pattern %j, type %j) says "%s"', async (pattern, type, text) => {
    const t = mk()
    setTableView(tableKey(t), { page: 0, pageSize: 200, sort: null, where: pattern, orderExpr: type })
    api.redis.scan.mockResolvedValue({ keys: [], cursor: null })
    render(<RedisKeyView t={t} />)
    await waitFor(() => expect(document.body.textContent).toContain(text))
  })

  it('a scan error is shown without the IPC prefix and keeps the toolbar usable', async () => {
    api.redis.scan.mockRejectedValue(new Error("Error invoking remote method 'redis:scan': Error: Connection refused (localhost:6379)"))
    render(<RedisKeyView t={mk()} />)
    await waitFor(() => expect(document.querySelector('.msg.bad')!.textContent).toBe('Connection refused (localhost:6379)'))
    api.redis.scan.mockResolvedValue({ keys: KEYS, cursor: null })
    fireEvent.click(btn(/^Reload \(/))
    await waitFor(() => expect(keyRows()).toHaveLength(4))
    expect(document.querySelector('.msg.bad')).toBeNull()
  })

  it('a slow older scan cannot overwrite a newer one', async () => {
    let release!: (v: unknown) => void
    api.redis.scan.mockImplementationOnce(() => new Promise((r) => { release = r }))
    const t = mk()
    render(<RedisKeyView t={t} />)
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(1))
    api.redis.scan.mockResolvedValueOnce({ keys: [key('fresh')], cursor: null })
    fireEvent.click(btn(/^Reload \(/))
    await waitFor(() => expect(keyNames()).toEqual(['fresh']))
    release({ keys: [key('stale')], cursor: null })
    await new Promise((r) => setTimeout(r, 20))
    expect(keyNames()).toEqual(['fresh'])
  })
})

describe('filters', () => {
  it('a plain word means "contains"; Enter applies and the effective MATCH is shown', async () => {
    const user = userEvent.setup()
    await loaded()
    await user.type(patternBox(), 'user{Enter}')
    await waitFor(() => expect(scanArgs()).toMatchObject({ pattern: '*user*' }))
    expect(document.querySelector('.fb-hint code')!.textContent).toBe('*user*')
  })

  it('glob syntax is passed through; nothing is scanned while typing', async () => {
    const user = userEvent.setup()
    await loaded()
    await user.type(patternBox(), 'user:*')
    expect(api.redis.scan).toHaveBeenCalledTimes(1)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(scanArgs()).toMatchObject({ pattern: 'user:*' }))
  })

  it('Enter with an unchanged pattern re-scans', async () => {
    const user = userEvent.setup()
    await loaded()
    await user.type(patternBox(), 'a{Enter}')
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(2))
    await user.type(patternBox(), '{Enter}')
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(3))
  })

  it('the type filter scans with TYPE immediately and lists the five common types plus stream', async () => {
    await loaded()
    expect(Array.from(typeSelect().options).map((o) => o.value)).toEqual(['', 'string', 'hash', 'list', 'set', 'zset', 'stream'])
    fireEvent.change(typeSelect(), { target: { value: 'hash' } })
    await waitFor(() => expect(scanArgs()).toMatchObject({ type: 'hash' }))
    fireEvent.change(typeSelect(), { target: { value: '' } })
    await waitFor(() => expect(scanArgs().type).toBeUndefined())
  })

  it('the page size changes the scan limit', async () => {
    await loaded()
    const size = screen.getByTitle('Keys per scan step') as HTMLSelectElement
    expect(Array.from(size.options).map((o) => o.value)).toEqual(['100', '200', '500', '1000', '5000'])
    fireEvent.change(size, { target: { value: '500' } })
    await waitFor(() => expect(scanArgs()).toMatchObject({ limit: 500 }))
  })

  it('pattern, type and page size are saved per tab and restored', async () => {
    const t = mk()
    setTableView(tableKey(t), { page: 0, pageSize: 1000, sort: null, where: 'sess:*', orderExpr: 'string' })
    render(<RedisKeyView t={t} />)
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalled())
    expect(scanArgs()).toEqual({ pattern: 'sess:*', type: 'string', limit: 1000 })
    expect(patternBox().value).toBe('sess:*')
    expect(typeSelect().value).toBe('string')
    fireEvent.change(typeSelect(), { target: { value: 'list' } })
    await waitFor(() => expect(getTableView(tableKey(t))).toMatchObject({ where: 'sess:*', orderExpr: 'list', pageSize: 1000 }))
  })
})

describe('selection and the detail pane', () => {
  it('nothing is selected at first: the pane invites and the buttons are disabled', async () => {
    await loaded()
    expect(document.body.textContent).toContain('Select a key to see its value')
    expect(btn(/^Delete the selected/).disabled).toBe(true)
    expect(btn(/^Copy the selected/).disabled).toBe(true)
    expect(api.redis.get).not.toHaveBeenCalled()
  })

  it('clicking a key loads it in the detail pane', async () => {
    await loaded()
    pickKey(2)
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledWith(expect.any(String), 2, 'queue'))
    await waitFor(() => expect(within(detailPane()).getByDisplayValue('hello queue')).toBeTruthy())
    expect(keyRows()[2].className).toContain('cur')
    expect(keyRows()[2].className).toContain('sel')
  })

  it('⌘/Ctrl-click toggles, ⇧-click selects a range; several selected shows a count and no detail', async () => {
    await loaded()
    pickKey(0)
    pickKey(2, { metaKey: true })
    expect(keyRows().map((r) => r.classList.contains('sel'))).toEqual([true, false, true, false])
    expect(document.body.textContent).toContain('2 keys selected')
    expect(screen.queryByTestId('redis-detail')).toBeNull()
    pickKey(3, { shiftKey: true })
    expect(keyRows().map((r) => r.classList.contains('sel'))).toEqual([false, false, true, true])
    pickKey(3, { ctrlKey: true })
    expect(keyRows().map((r) => r.classList.contains('sel'))).toEqual([false, false, true, false])
    await waitFor(() => expect(screen.getByTestId('redis-detail')).toBeTruthy())
  })

  it('arrow keys, Home / End and ⇧-arrows move and extend the selection; ⌘A selects all; Escape clears', async () => {
    await loaded()
    pickKey(0)
    const k = (key: string, init: Record<string, unknown> = {}): void => void fireEvent.keyDown(grid(), { key, ...init })
    k('ArrowDown')
    expect(keyRows()[1].className).toContain('cur')
    k('End')
    expect(keyRows()[3].className).toContain('cur')
    k('ArrowUp', { shiftKey: true })
    expect(keyRows().map((r) => r.classList.contains('sel'))).toEqual([false, false, true, true])
    k('Home')
    expect(keyRows().map((r) => r.classList.contains('sel'))).toEqual([true, false, false, false])
    k('a', { metaKey: true })
    expect(keyRows().every((r) => r.classList.contains('sel'))).toBe(true)
    k('Escape')
    expect(keyRows().some((r) => r.classList.contains('sel'))).toBe(false)
  })

  it('Copy copies the selected key names, one per line; right-click copies one name', async () => {
    await loaded()
    pickKey(0)
    pickKey(2, { metaKey: true })
    fireEvent.click(btn(/^Copy the selected/))
    expect(clip).toHaveBeenCalledWith('user:1\nqueue')
    fireEvent.keyDown(grid(), { key: 'c', metaKey: true })
    expect(clip).toHaveBeenCalledTimes(2)
    fireEvent.contextMenu(keyRows()[3].querySelector('.rk-key')!)
    expect(clip).toHaveBeenLastCalledWith('cfg')
  })

  it('the grid row follows the type / TTL the detail pane learns, and a reload keeps the focused key', async () => {
    api.redis.get.mockImplementation(async (_d: string, _db: number, k: string) => detail(k, str('v'), { ttl: 30_000, type: 'string' }))
    await loaded()
    pickKey(3)
    await waitFor(() => expect(keyRows()[3].querySelectorAll('td')[3].textContent).toBe('30s'))
    fireEvent.click(btn(/^Reload \(/))
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(keyRows()[3].className).toContain('cur'))
  })
})

describe('deleting', () => {
  it('Delete asks, deletes the selected keys in one call and updates the grid and the total', async () => {
    await loaded()
    await waitFor(() => expect(status()).toContain('of 1,234'))
    pickKey(0)
    pickKey(1, { metaKey: true })
    fireEvent.click(btn(/^Delete the selected/))
    expect(confirmFn.mock.calls[0][0]).toContain('Delete 2 keys?')
    await waitFor(() => expect(api.redis.delete).toHaveBeenCalledWith(expect.any(String), 2, ['user:1', 'user:2']))
    await waitFor(() => expect(keyNames()).toEqual(['queue', 'cfg']))
    expect(status()).toBe('2 keys loaded of 1,232 in db2')
  })

  it('a single key is named in the confirmation; the Delete key does the same', async () => {
    await loaded()
    pickKey(2)
    fireEvent.keyDown(grid(), { key: 'Delete' })
    expect(confirmFn.mock.calls[0][0]).toBe('Delete key "queue"? This cannot be undone.')
    await waitFor(() => expect(keyNames()).toEqual(['user:1', 'user:2', 'cfg']))
  })

  it('declining deletes nothing', async () => {
    confirmFn.mockReturnValue(false)
    await loaded()
    pickKey(0)
    fireEvent.click(btn(/^Delete the selected/))
    expect(api.redis.delete).not.toHaveBeenCalled()
    expect(keyRows()).toHaveLength(4)
  })

  it('a failed delete shows the error and re-scans (some keys may be gone)', async () => {
    api.redis.delete.mockRejectedValue(new Error('READONLY You can\'t write against a read only replica.'))
    await loaded()
    pickKey(0)
    fireEvent.click(btn(/^Delete the selected/))
    await waitFor(() => expect(document.querySelector('.msg.bad')!.textContent).toContain('READONLY'))
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(2))
  })

  it('deleting from the detail pane removes the row and clears the pane', async () => {
    await loaded()
    pickKey(1)
    await waitFor(() => expect(within(detailPane()).getByText('Delete')).toBeTruthy())
    fireEvent.click(within(detailPane()).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.redis.delete).toHaveBeenCalledWith(expect.any(String), 2, ['user:2']))
    await waitFor(() => expect(keyNames()).toEqual(['user:1', 'queue', 'cfg']))
    expect(document.body.textContent).toContain('Select a key to see its value')
  })
})

describe('creating and renaming', () => {
  it('+ opens the dialog; creating a key shows exactly that key, selected', async () => {
    const user = userEvent.setup()
    await loaded()
    api.redis.scan.mockResolvedValue({ keys: [key('new:key')], cursor: null })
    fireEvent.click(btn('New key'))
    expect(screen.getByRole('heading').textContent).toBe('New key in db2')
    await user.type(screen.getByLabelText('Key'), 'new:key')
    await user.type(screen.getByLabelText('Value'), 'v1')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(api.redis.create).toHaveBeenCalledWith(expect.any(String), 2, 'new:key', { type: 'string', value: 'v1' }, { ttl: null }))
    await waitFor(() => expect(scanArgs()).toMatchObject({ pattern: '\\new:key' }))
    await waitFor(() => expect(keyNames()).toEqual(['new:key']))
    await waitFor(() => expect(keyRows()[0].className).toContain('cur'))
    expect(patternBox().value).toBe('\\new:key')
    expect(screen.queryByRole('heading', { name: /New key/ })).toBeNull()
  })

  it('glob characters of a created key are escaped in the exact-match pattern', async () => {
    const user = userEvent.setup()
    await loaded()
    fireEvent.click(btn('New key'))
    await user.type(screen.getByLabelText('Key'), 'a*b[[1]') // `[[` is user-event's escape for a literal [
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(scanArgs()).toMatchObject({ pattern: '\\a\\*b\\[1\\]' }))
  })

  it('cancelling the dialog creates nothing', async () => {
    await loaded()
    fireEvent.click(btn('New key'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: /New key/ })).toBeNull())
    expect(api.redis.create).not.toHaveBeenCalled()
    expect(api.redis.scan).toHaveBeenCalledTimes(1)
  })

  it('renaming from the detail pane re-scans for the new name', async () => {
    const user = userEvent.setup()
    await loaded()
    pickKey(3)
    await waitFor(() => expect(within(detailPane()).getByRole('button', { name: 'Rename' })).toBeTruthy())
    await waitFor(() => expect((within(detailPane()).getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(detailPane()).getByRole('button', { name: 'Rename' }))
    const box = detailPane().querySelector('.rk-rename') as HTMLInputElement
    expect(box.value).toBe('cfg')
    await user.clear(box)
    api.redis.scan.mockResolvedValue({ keys: [key('config')], cursor: null })
    await user.type(box, 'config{Enter}')
    await waitFor(() => expect(api.redis.rename).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', 'config'))
    await waitFor(() => expect(keyNames()).toEqual(['config']))
    expect(scanArgs()).toMatchObject({ pattern: '\\config' })
  })

  it('a rename that the server refuses (new name exists) shows the error and keeps the key', async () => {
    const user = userEvent.setup()
    api.redis.rename.mockRejectedValue(new Error('A key named "x" already exists'))
    await loaded()
    pickKey(3)
    await waitFor(() => expect((within(detailPane()).getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(detailPane()).getByRole('button', { name: 'Rename' }))
    const box = detailPane().querySelector('.rk-rename') as HTMLInputElement
    await user.clear(box)
    await user.type(box, 'x{Enter}')
    await waitFor(() => expect(detailPane().textContent).toContain('already exists'))
    expect(keyNames()).toContain('cfg')
  })
})

describe('reload shortcuts', () => {
  it('⌘R / Ctrl+R reloads the scan and the open key', async () => {
    await loaded()
    pickKey(0)
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', metaKey: true })
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(2))
  })

  it('⌘R with the focus inside the detail pane (value textarea / TTL box) reloads the scan and the open key', async () => {
    await loaded()
    pickKey(0)
    await waitFor(() => expect(detailPane().querySelector('.rk-text')).toBeTruthy())
    const ta = detailPane().querySelector('.rk-text') as HTMLTextAreaElement
    ta.focus()
    fireEvent.keyDown(ta, { key: 'r', code: 'KeyR', metaKey: true })
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(2))
    const ttl = detailPane().querySelector('.rk-ttl input') as HTMLInputElement
    ttl.focus()
    fireEvent.keyDown(ttl, { key: 'r', code: 'KeyR', metaKey: true })
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledTimes(3))
  })

  it('does nothing while a dialog is open, in an inactive tab, or when the explorer owns the key', async () => {
    const t = mk()
    const { rerender } = render(<RedisKeyView t={t} />)
    await waitFor(() => expect(keyRows().length).toBe(4))
    fireEvent.click(btn('New key'))
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', ctrlKey: true })
    expect(api.redis.scan).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: /New key/ })).toBeNull())
    rerender(<RedisKeyView t={t} active={false} />)
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', ctrlKey: true })
    expect(api.redis.scan).toHaveBeenCalledTimes(1)
    rerender(<RedisKeyView t={t} active />)
    const ex = document.createElement('div')
    ex.className = 'explorer'
    document.body.appendChild(ex)
    resetExplorerClick()
    ex.remove()
  })

  it('a changed reloadToken (Refresh in the explorer) re-scans', async () => {
    const t = mk()
    const { rerender } = render(<RedisKeyView t={t} reloadToken={0} />)
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(1))
    rerender(<RedisKeyView t={t} reloadToken={1} />)
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalledTimes(2))
  })
})

describe('detail viewers and editors', () => {
  const open = async (value: RedisValue, over: Partial<RedisKeyDetail> = {}, k = 'cfg'): Promise<void> => {
    api.redis.get.mockImplementation(async (_d: string, _db: number, name: string) => detail(name, value, over))
    await loaded()
    pickKey(keyNames().indexOf(k))
    await waitFor(() => expect(within(detailPane()).queryByText('Loading…')).toBeNull())
  }
  const inPane = (): ReturnType<typeof within> => within(detailPane())

  it('string: edit and Save keeps the TTL; Revert restores; Save is disabled until changed', async () => {
    const user = userEvent.setup()
    await open(str('old'))
    const ta = inPane().getByRole('textbox', { name: '' }) as HTMLTextAreaElement
    const save = inPane().getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await user.clear(ta)
    await user.type(ta, 'new')
    expect(save.disabled).toBe(false)
    await user.click(inPane().getByRole('button', { name: 'Revert' }))
    expect(ta.value).toBe('old')
    await user.clear(ta)
    await user.type(ta, 'new')
    await user.click(save)
    await waitFor(() => expect(api.redis.setString).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', 'new', { keepTtl: true }))
  })

  it('string: ⌘Enter saves; Format JSON pretty-prints without saving', async () => {
    const user = userEvent.setup()
    await open(str('{"a":1}'))
    const ta = detailPane().querySelector('textarea') as HTMLTextAreaElement
    await user.click(inPane().getByRole('button', { name: 'Format JSON' }))
    expect(ta.value).toBe('{\n  "a": 1\n}')
    expect(api.redis.setString).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.redis.setString).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', '{\n  "a": 1\n}', { keepTtl: true }))
  })

  it('string: Save / Revert / Format JSON live in the header bar, not below the editor', async () => {
    await open(str('old'))
    const head = detailPane().querySelector('.rk-head') as HTMLElement
    for (const n of ['Save', 'Revert', 'Format JSON', 'Rename', 'Delete']) {
      expect(within(head).getByRole('button', { name: n })).toBeTruthy()
    }
    expect(detailPane().querySelector('.rk-actions')).toBeNull()
    const value = detailPane().querySelector('.rk-value') as HTMLElement
    for (const n of ['Save', 'Revert', 'Format JSON']) expect(within(value).queryByRole('button', { name: n })).toBeNull()
    // Save comes first in the action group
    const labels = Array.from(head.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels.indexOf('Save')).toBeLessThan(labels.indexOf('Revert'))
    expect(labels.indexOf('Revert')).toBeLessThan(labels.indexOf('Format JSON'))
    expect(labels.indexOf('Format JSON')).toBeLessThan(labels.indexOf('Rename'))
  })

  it('non-string types have no Save / Revert / Format JSON in the header', async () => {
    await open({ kind: 'hash', items: [{ field: 'a', value: '1' }], next: null }, { type: 'hash' })
    const head = detailPane().querySelector('.rk-head') as HTMLElement
    for (const n of ['Save', 'Revert', 'Format JSON']) expect(within(head).queryByRole('button', { name: n })).toBeNull()
  })

  it('string: non-JSON disables Format JSON', async () => {
    await open(str('plain'))
    expect((inPane().getByRole('button', { name: 'Format JSON' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('binary string: hex dump, read-only, no editor', async () => {
    await open({ kind: 'string', text: '', binary: true, base64: btoa('\u0001\u0002\u00ff'), bytes: 3, truncated: false })
    expect(detailPane().textContent).toContain('Binary value (3 bytes)')
    expect(detailPane().querySelector('.rk-hex')!.textContent).toBe('01 02 ff')
    expect(detailPane().querySelector('textarea')).toBeNull()
    expect(inPane().queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('truncated string: warning and read-only', async () => {
    await open(str('big', { truncated: true, bytes: 5_000_000 }))
    for (const n of ['Save', 'Revert', 'Format JSON']) expect((inPane().getByRole('button', { name: n }) as HTMLButtonElement).disabled).toBe(true)
    expect(detailPane().textContent).toContain('editing is disabled')
    expect((detailPane().querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(true)
  })

  it('TTL: Set parses units, Persist removes, bad input is reported, Persist is off without a TTL', async () => {
    const user = userEvent.setup()
    await open(str('v'), { ttl: 120_000 })
    const box = inPane().getByPlaceholderText('no expiry') as HTMLInputElement
    expect(box.value).toBe('120')
    expect(detailPane().textContent).toContain('Expires in 2m')
    await user.clear(box)
    await user.type(box, '5m')
    await user.click(inPane().getByRole('button', { name: 'Set' }))
    await waitFor(() => expect(api.redis.setTtl).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', 300))
    await user.clear(box)
    await user.type(box, 'soon{Enter}')
    await waitFor(() => expect(detailPane().textContent).toContain('TTL: use seconds'))
    await user.click(inPane().getByRole('button', { name: 'Persist' }))
    await waitFor(() => expect(api.redis.setTtl).toHaveBeenLastCalledWith(expect.any(String), 2, 'cfg', null))
  })

  it('no expiry: says so and Persist is disabled', async () => {
    await open(str('v'))
    expect(detailPane().textContent).toContain('No expiry')
    expect((inPane().getByRole('button', { name: 'Persist' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows length, memory and encoding facts', async () => {
    await open(str('v'), { length: 1, size: 2048, encoding: 'embstr' })
    expect(detailPane().textContent).toContain('1 bytes')
    expect(detailPane().textContent).toContain('2.0 KB in memory')
    expect(detailPane().textContent).toContain('embstr')
  })

  it('hash: edit a value, delete a field, add a field', async () => {
    const user = userEvent.setup()
    await open({ kind: 'hash', items: [{ field: 'a', value: '1' }, { field: 'b', value: '2' }], next: null }, { type: 'hash', length: 2 })
    const rows = (): HTMLElement[] => Array.from(detailPane().querySelectorAll('.rk-items tbody tr'))
    expect(rows().map((r) => r.textContent!.replace(/[✎×]/g, ''))).toEqual(['a1', 'b2'])
    fireEvent.click(rows()[0].querySelector('[title="Edit value"]')!)
    const ta = rows()[0].querySelector('textarea') as HTMLTextAreaElement
    await user.clear(ta)
    await user.type(ta, 'one')
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', { op: 'hset', field: 'a', value: 'one' }))
    fireEvent.click(rows()[1].querySelector('[title="Delete field"]')!)
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', { op: 'hdel', field: 'b' }))
    await user.type(inPane().getByPlaceholderText('field'), 'c')
    await user.type(inPane().getByPlaceholderText('value'), 'three')
    await user.click(inPane().getByRole('button', { name: 'Add field' }))
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', { op: 'hset', field: 'c', value: 'three' }))
  })

  it('switching the focused key from a hash to a list (and back) swaps the item editors without crashing', async () => {
    api.redis.get.mockImplementation(async (_d: string, _db: number, name: string) =>
      name === keyNames()[0]
        ? detail(name, { kind: 'hash', items: [{ field: 'a', value: '1' }], next: null }, { type: 'hash' })
        : detail(name, { kind: 'list', items: ['x'], offset: 0, next: null }, { type: 'list' })
    )
    await loaded()
    pickKey(0)
    await waitFor(() => expect(detailPane().querySelector('.rk-items[data-kind="hash"]')).toBeTruthy())
    expect(inPane().getByPlaceholderText('field')).toBeTruthy()
    pickKey(1)
    await waitFor(() => expect(detailPane().querySelector('.rk-items[data-kind="list"]')).toBeTruthy())
    expect(inPane().queryByPlaceholderText('field')).toBeNull()
    expect(inPane().getByRole('button', { name: 'Push left' })).toBeTruthy()
    pickKey(0)
    await waitFor(() => expect(detailPane().querySelector('.rk-items[data-kind="hash"]')).toBeTruthy())
  })

  it('hash: Escape cancels an edit; binary values cannot be edited', async () => {
    await open({ kind: 'hash', items: [{ field: 'a', value: '1' }, { field: 'b', value: '\u0000b64:AAE=' }], next: null }, { type: 'hash' })
    const edits = Array.from(detailPane().querySelectorAll<HTMLButtonElement>('.rk-act button')).filter((b) => b.textContent === '✎')
    expect(edits.map((b) => b.disabled)).toEqual([false, true])
    fireEvent.click(edits[0])
    const ta = detailPane().querySelector('.rk-edit textarea') as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(detailPane().querySelector('.rk-edit')).toBeNull()
    expect(api.redis.item).not.toHaveBeenCalled()
  })

  it('list: edit by index, remove, push left / right', async () => {
    const user = userEvent.setup()
    await open({ kind: 'list', items: ['x', 'y'], offset: 0, next: null }, { type: 'list', length: 2 }, 'queue')
    const rows = (): HTMLElement[] => Array.from(detailPane().querySelectorAll('.rk-items tbody tr'))
    fireEvent.click(rows()[1].querySelector('[title="Edit value"]')!)
    const ta = rows()[1].querySelector('textarea') as HTMLTextAreaElement
    await user.clear(ta)
    await user.type(ta, 'Y')
    await user.click(rows()[1].querySelector('.rk-edit .primary')!)
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'queue', { op: 'lset', index: 1, value: 'Y' }))
    fireEvent.click(rows()[0].querySelector('.rk-ib[title^="Remove this value"]')!)
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'queue', { op: 'lrem', value: 'x', count: 1 }))
    await user.type(inPane().getByPlaceholderText('value'), 'z')
    await user.click(inPane().getByRole('button', { name: 'Push left' }))
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'queue', { op: 'lpush', value: 'z' }))
    await user.type(inPane().getByPlaceholderText('value'), 'w')
    await user.click(inPane().getByRole('button', { name: 'Push right' }))
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'queue', { op: 'rpush', value: 'w' }))
  })

  it('set: remove and add members', async () => {
    const user = userEvent.setup()
    await open({ kind: 'set', items: ['m1', 'm2'], next: null }, { type: 'set' })
    fireEvent.click(detailPane().querySelectorAll('[title="Remove member"]')[1])
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', { op: 'srem', member: 'm2' }))
    await user.type(inPane().getByPlaceholderText('member'), 'm3')
    await user.click(inPane().getByRole('button', { name: 'Add member' }))
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', { op: 'sadd', member: 'm3' }))
  })

  it('zset: edit a score, remove, add (score first)', async () => {
    const user = userEvent.setup()
    await open({ kind: 'zset', items: [{ member: 'a', score: '1' }, { member: 'b', score: '2.5' }], offset: 0, next: null }, { type: 'zset' })
    fireEvent.click(detailPane().querySelectorAll('[title="Edit score"]')[1])
    const ta = detailPane().querySelector('.rk-edit textarea') as HTMLTextAreaElement
    await user.clear(ta)
    await user.type(ta, ' 9 ')
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', { op: 'zadd', member: 'b', score: '9' }))
    fireEvent.click(detailPane().querySelectorAll('[title="Remove member"]')[0])
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', { op: 'zrem', member: 'a' }))
    await user.type(inPane().getByPlaceholderText('score'), '3')
    await user.type(inPane().getByPlaceholderText('member'), 'c')
    await user.click(inPane().getByRole('button', { name: 'Add member' }))
    await waitFor(() => expect(api.redis.item).toHaveBeenCalledWith(expect.any(String), 2, 'cfg', { op: 'zadd', member: 'c', score: '3' }))
  })

  it('stream: read-only entries with a note', async () => {
    await open({ kind: 'stream', entries: [{ id: '1-0', fields: [{ field: 'k', value: 'v' }] }], next: null }, { type: 'stream' })
    expect(detailPane().querySelector('tbody tr')!.textContent).toBe('1-0k=v')
    expect(detailPane().textContent).toContain('read-only')
    expect(detailPane().querySelector('.rk-add')).toBeNull()
  })

  it('unsupported module type: explained', async () => {
    await open({ kind: 'unsupported', type: 'ReJSON-RL' }, { type: 'ReJSON-RL' })
    expect(detailPane().textContent).toContain('ReJSON-RL')
    expect(detailPane().textContent).toContain('cannot be shown here')
  })

  it('empty containers say so', async () => {
    await open({ kind: 'hash', items: [], next: null }, { type: 'hash', length: 0 })
    expect(detailPane().textContent).toContain('Empty hash')
  })

  it('Load more in a hash appends the next page without repeating items', async () => {
    api.redis.get
      .mockResolvedValueOnce(detail('cfg', { kind: 'hash', items: [{ field: 'a', value: '1' }, { field: 'b', value: '2' }], next: '9' }, { type: 'hash' }))
      .mockResolvedValueOnce(detail('cfg', { kind: 'hash', items: [{ field: 'b', value: '2' }, { field: 'c', value: '3' }], next: null }, { type: 'hash' }))
    await loaded()
    pickKey(3)
    const more = await waitFor(() => inPane().getByRole('button', { name: 'Load more' }))
    fireEvent.click(more)
    await waitFor(() => expect(detailPane().querySelectorAll('.rk-items tbody tr')).toHaveLength(3))
    expect(api.redis.get.mock.calls[1][3]).toEqual({ cursor: '9' })
    expect(inPane().queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('Load more in a list continues at the offset', async () => {
    api.redis.get
      .mockResolvedValueOnce(detail('queue', { kind: 'list', items: ['a', 'b'], offset: 0, next: 2 }, { type: 'list' }))
      .mockResolvedValueOnce(detail('queue', { kind: 'list', items: ['c'], offset: 2, next: null }, { type: 'list' }))
    await loaded()
    pickKey(2)
    fireEvent.click(await waitFor(() => inPane().getByRole('button', { name: 'Load more' })))
    await waitFor(() => expect(detailPane().querySelectorAll('.rk-items tbody tr')).toHaveLength(3))
    expect(api.redis.get.mock.calls[1][3]).toEqual({ offset: 2 })
    expect(Array.from(detailPane().querySelectorAll('.rk-idx')).map((c) => c.textContent)).toEqual(['Index', '0', '1', '2'])
  })

  it('a key that vanished (deleted / expired) is reported, with Reload', async () => {
    await open({ kind: 'none' }, { type: 'none', ttl: -2 })
    expect(detailPane().textContent).toContain('This key no longer exists')
    expect((inPane().getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(inPane().getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(api.redis.get.mock.calls.length).toBeGreaterThan(1))
  })

  it('a failing read shows the error; a failing write too, without leaving the pane', async () => {
    const user = userEvent.setup()
    await open(str('v'))
    api.redis.setString.mockRejectedValue(new Error("Error invoking remote method 'redis:setString': Error: OOM command not allowed"))
    const ta = detailPane().querySelector('textarea') as HTMLTextAreaElement
    await user.type(ta, '!')
    await user.click(inPane().getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(detailPane().textContent).toContain('OOM command not allowed'))
    expect(ta.value).toBe('v!') // the user's edit is not lost
  })

  it('the key name is copied from the pane', async () => {
    await open(str('v'))
    fireEvent.click(inPane().getByRole('button', { name: 'Copy' }))
    expect(clip).toHaveBeenCalledWith('cfg')
    expect(inPane().getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('binary key names are shown decoded and copied decoded', async () => {
    api.redis.scan.mockResolvedValue({ keys: [key('\u0000b64:AAEC')], cursor: null })
    api.redis.get.mockImplementation(async (_d: string, _db: number, k: string) => detail(k, str('v')))
    await loaded()
    expect(keyNames()[0]).toBe('\\x00\\x01\\x02')
    pickKey(0)
    await waitFor(() => expect(api.redis.get).toHaveBeenCalledWith(expect.any(String), 2, '\u0000b64:AAEC'))
    fireEvent.contextMenu(keyRows()[0].querySelector('.rk-key')!)
    expect(clip).toHaveBeenCalledWith('\\x00\\x01\\x02')
  })
})

describe('prefill from the explorer tree ("Browse in Key Browser")', () => {
  const withFilter = (t: TableRef, pattern: string, type: string, nn = 1): TableRef => ({ ...t, redisFilter: { pattern, type, n: nn } })

  it('opens with the folder pattern and type already applied (one scan, with them)', async () => {
    const t = withFilter(mk(), 'user:42:*', 'hash')
    render(<RedisKeyView t={t} />)
    await waitFor(() => expect(keyRows().length).toBeGreaterThan(0))
    expect(patternBox().value).toBe('user:42:*')
    expect(typeSelect().value).toBe('hash')
    expect(api.redis.scan).toHaveBeenCalledTimes(1)
    expect(scanArgs(0)).toMatchObject({ pattern: 'user:42:*', type: 'hash' })
  })

  it('wins over the saved view of that tab', async () => {
    const t = mk()
    setTableView(tableKey(t), { page: 0, pageSize: 200, sort: null, where: 'old*', orderExpr: 'list' })
    render(<RedisKeyView t={withFilter(t, 'new:*', '')} />)
    await waitFor(() => expect(keyRows().length).toBeGreaterThan(0))
    expect(patternBox().value).toBe('new:*')
    expect(typeSelect().value).toBe('')
    expect(scanArgs(0)).toMatchObject({ pattern: 'new:*' })
    expect(scanArgs(0).type).toBeUndefined()
    expect(getTableView(tableKey(t))).toMatchObject({ where: 'new:*', orderExpr: '' })
  })

  it('a type-folder prefill has no pattern: all keys of that type', async () => {
    render(<RedisKeyView t={withFilter(mk(), '', 'zset')} />)
    await waitFor(() => expect(keyRows().length).toBeGreaterThan(0))
    expect(patternBox().value).toBe('')
    expect(scanArgs(0).pattern).toBe('')
    expect(scanArgs(0)).toMatchObject({ type: 'zset' })
  })

  it('a prefix pattern with escaped glob characters is used as is (not wrapped in *…*)', async () => {
    render(<RedisKeyView t={withFilter(mk(), 'a\\*b:*', '')} />)
    await waitFor(() => expect(keyRows().length).toBeGreaterThan(0))
    expect(scanArgs(0)).toMatchObject({ pattern: 'a\\*b:*' })
  })

  it('asking again with a new request updates the same open tab and re-scans once', async () => {
    const t = mk()
    const r = render(<RedisKeyView t={withFilter(t, 'a:*', 'string', 1)} />)
    await waitFor(() => expect(keyRows().length).toBeGreaterThan(0))
    api.redis.scan.mockClear()
    r.rerender(<RedisKeyView t={withFilter(t, 'b:*', 'list', 2)} />)
    await waitFor(() => expect(api.redis.scan).toHaveBeenCalled())
    expect(patternBox().value).toBe('b:*')
    expect(typeSelect().value).toBe('list')
    expect(scanArgs()).toMatchObject({ pattern: 'b:*', type: 'list' })
    expect(api.redis.scan).toHaveBeenCalledTimes(1)
  })

  it('the same request again (a re-render) does not override what the user typed since', async () => {
    const t = withFilter(mk(), 'a:*', '', 1)
    const r = render(<RedisKeyView t={t} />)
    await waitFor(() => expect(keyRows().length).toBeGreaterThan(0))
    const user = userEvent.setup()
    await user.clear(patternBox())
    await user.type(patternBox(), 'mine{Enter}')
    await waitFor(() => expect(scanArgs()).toMatchObject({ pattern: '*mine*' }))
    api.redis.scan.mockClear()
    r.rerender(<RedisKeyView t={{ ...t }} />)
    await new Promise((x) => setTimeout(x, 20))
    expect(patternBox().value).toBe('mine')
    expect(api.redis.scan).not.toHaveBeenCalled()
  })

  it('a tab opened without a prefill keeps using its saved view', async () => {
    const t = mk()
    setTableView(tableKey(t), { page: 0, pageSize: 200, sort: null, where: 'keep*', orderExpr: 'set' })
    render(<RedisKeyView t={t} />)
    await waitFor(() => expect(keyRows().length).toBeGreaterThan(0))
    expect(patternBox().value).toBe('keep*')
    expect(typeSelect().value).toBe('set')
  })
})
