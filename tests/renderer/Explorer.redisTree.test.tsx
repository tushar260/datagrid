// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { REDIS_BIN_PREFIX, type DataSource, type RedisKeyTree, type RedisTreeType } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

const h = vi.hoisted(() => ({ session: { expanded: [] as string[], folders: [] as string[] } }))
vi.mock('../../src/renderer/src/session', () => ({
  get initialSession() { return h.session },
  patchSession: () => undefined
}))
vi.mock('../../src/renderer/src/DbPicker', () => ({ default: () => <div className="picker-stub" /> }))
vi.mock('../../src/renderer/src/CreateDialogs', () => ({ default: () => <div className="create-stub" /> }))

import Explorer from '../../src/renderer/src/Explorer'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'

Element.prototype.scrollIntoView = vi.fn()

const redis = (id: string, cfg: Partial<NonNullable<DataSource['redis']>> = {}): DataSource => ({
  id, name: 'Cache', kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  redis: { host: 'localhost', port: 6379, db: 0, tls: false, keyDelimiter: ':', ...cfg } // ':' explicit: the built-in default is a flat list
})
const k = (key: string, type: RedisTreeType = 'string'): { key: string; type: RedisTreeType } => ({ key, type })
const KEYS = [
  k('user:42:profile', 'hash'), k('user:42:name'), k('user:7:name'), k('counter'), k('queue:jobs', 'list'), k('tags', 'set'),
  k('board', 'zset'), k('events', 'stream'), k('a'), k('a:b'), k('mod', 'other')
]
const tree = (keys = KEYS, over: Partial<RedisKeyTree> = {}): RedisKeyTree => ({ keys, complete: true, dbsize: keys.length, ...over })
const DBS = { databases: [{ db: 0, keys: 11 }, { db: 3, keys: 2 }], count: 16, cluster: false }

let api: MockApi
let cb: Record<'onOpen' | 'onEdit' | 'onConsole' | 'onTableRenamed' | 'onRefreshed' | 'onObjectGone' | 'onSources' | 'onKeyRenamed' | 'onKeysGone', ReturnType<typeof vi.fn>>
let clip: ReturnType<typeof vi.fn>
let confirmFn: ReturnType<typeof vi.fn>

function setup(redisOver: Record<string, unknown> = {}, ds: DataSource = redis('d1')): void {
  api = installApi({
    listSources: [ds], databases: ['app'], schemasAll: ['public'], tableNames: { public: [] }, tables: [],
    renameSource: undefined, deleteSource: undefined, duplicateSource: undefined, disconnect: undefined, moveSource: undefined,
    redis: { databases: DBS, keyTree: vi.fn(async () => tree()), delete: vi.fn(async () => KEYS.length), rename: vi.fn(async () => undefined), ...redisOver }
  })
}

beforeEach(() => {
  h.session = { expanded: [], folders: [] }
  localStorage.clear()
  resetExplorerClick()
  clip = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  confirmFn = vi.fn(() => true)
  window.confirm = confirmFn as never
  cb = {
    onOpen: vi.fn(), onEdit: vi.fn(), onConsole: vi.fn(), onTableRenamed: vi.fn(), onRefreshed: vi.fn(), onObjectGone: vi.fn(),
    onSources: vi.fn(), onKeyRenamed: vi.fn(), onKeysGone: vi.fn()
  }
  setup()
})
afterEach(cleanup)

const ui = (extra: Record<string, unknown> = {}): React.JSX.Element => (
  <Explorer {...(Object.assign({}, cb, { reloadKey: 0 }, extra) as React.ComponentProps<typeof Explorer>)} />
)
const row = (id: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).find((r) => r.dataset.id === id) ?? null
const ids = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).map((r) => r.dataset.id!)
const R = (id: string): HTMLElement => {
  const r = row(id)
  if (!r) throw new Error('no row ' + id + ' in ' + ids().join(', '))
  return r
}
const label = (id: string): string => R(id).querySelector('.tlabel')!.textContent!
const badge = (id: string): string | null => R(id).querySelector('.badge')?.textContent ?? null
const click = (id: string, init: Record<string, unknown> = {}): void => {
  fireEvent.mouseDown(R(id), init)
  fireEvent.click(R(id), init)
}
const ctx = (id: string): void => void fireEvent.contextMenu(R(id), { clientX: 12, clientY: 34 })
const menuLabels = (): string[] => Array.from(document.querySelectorAll('.ctxmenu:not(.submenu) > .ctxitem')).map((i) => i.querySelector('span')!.textContent!)
const pick = (l: string): void => {
  const el = Array.from(document.querySelectorAll<HTMLElement>('.ctxitem')).find((i) => i.querySelector('span')?.textContent === l)
  if (!el) throw new Error(`no menu item "${l}" in [${menuLabels().join(' | ')}]`)
  fireEvent.click(el)
}
const key = (kk: string, init: Record<string, unknown> = {}): void => void fireEvent.keyDown(document.body, { key: kk, ...init })
const combo = (code: string, init: Record<string, unknown> = {}): void =>
  void fireEvent.keyDown(document.body, { key: code.replace('Key', '').toLowerCase(), code, ...init })
const arrow = (id: string): HTMLElement => R(id).querySelector('.arrow') as HTMLElement
async function expand(id: string, child: string): Promise<void> {
  fireEvent.click(arrow(id))
  await waitFor(() => expect(row(child)).toBeTruthy())
}
async function mount(): Promise<void> {
  render(ui())
  await waitFor(() => expect(row('d1')).toBeTruthy())
}
/** source -> db0 -> strings */
async function openTo(db = 'd1/db0', child = 'd1/db0/strings'): Promise<void> {
  await mount()
  await expand('d1', 'd1/db0')
  await expand(db, child)
}
const S = 'd1/db0/strings'
const USER = `${S}/d:user:`
const U42 = `${USER}/d:user:42:`
const leafOf = (parent: string, kk: string): string => `${parent}/k:${kk}`
/** a promise whose resolution the test controls */
const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } => {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)))
  return { promise, resolve, reject }
}

describe('database node', () => {
  it('shows just the index, a key-count badge, and scans nothing until expanded', async () => {
    await mount()
    await expand('d1', 'd1/db0')
    expect(label('d1/db0')).toBe('0')
    expect(label('d1/db3')).toBe('3')
    expect(badge('d1/db0')).toBe('11 keys')
    expect(api.redis.keyTree).not.toHaveBeenCalled()
  })

  it('expanding it scans all keys once, with the 100,000 cap, and shows the type folders in DataGrip order', async () => {
    await openTo()
    expect(api.redis.keyTree).toHaveBeenCalledTimes(1)
    expect(api.redis.keyTree).toHaveBeenCalledWith('d1', 0, { max: 100000 })
    expect(ids().filter((i) => i.startsWith('d1/db0/'))).toEqual([
      'd1/db0/strings', 'd1/db0/lists', 'd1/db0/sets', 'd1/db0/zsets', 'd1/db0/hashes', 'd1/db0/streams', 'd1/db0/other'
    ])
    expect(['strings', 'lists', 'sets', 'zsets', 'hashes', 'streams', 'other'].map((t) => label('d1/db0/' + t))).toEqual([
      'strings', 'lists', 'sets', 'sorted sets', 'hash tables', 'streams', 'other'
    ])
  })

  it('each type folder shows its key count in the dim badge style', async () => {
    await openTo()
    expect(badge(S)).toBe('5') // counter, a, a:b, user:42:name, user:7:name
    expect(badge('d1/db0/lists')).toBe('1')
    expect(badge('d1/db0/hashes')).toBe('1')
  })

  it('type folders are shown only when they contain keys', async () => {
    setup({ keyTree: vi.fn(async () => tree([k('a'), k('b', 'hash')])) })
    await openTo()
    expect(ids().filter((i) => i.startsWith('d1/db0/'))).toEqual(['d1/db0/strings', 'd1/db0/hashes'])
  })

  it('an empty database says "empty"', async () => {
    setup({ keyTree: vi.fn(async () => tree([])) })
    await openTo('d1/db3', 'd1/db3')
    await waitFor(() => expect(document.body.textContent).toContain('empty'))
  })

  it('the source badge counts databases', async () => {
    await mount()
    await expand('d1', 'd1/db0')
    await waitFor(() => expect(badge('d1')).toBe('2'))
  })
})

describe('loading, cancelling, errors', () => {
  it('shows "Scanning keys…" while the scan runs and the folders once it answers', async () => {
    const d = deferred<RedisKeyTree>()
    setup({ keyTree: vi.fn(() => d.promise) })
    await mount()
    await expand('d1', 'd1/db0')
    fireEvent.click(arrow('d1/db0'))
    await waitFor(() => expect(document.body.textContent).toContain('Scanning keys…'))
    expect(R('d1/db0').querySelector('.loader')).toBeTruthy()
    d.resolve(tree())
    await waitFor(() => expect(row(S)).toBeTruthy())
    expect(document.body.textContent).not.toContain('Scanning keys…')
  })

  it('collapsing while scanning cancels it (main is told) and a late answer is ignored', async () => {
    const d = deferred<RedisKeyTree>()
    setup({ keyTree: vi.fn(() => d.promise) })
    await mount()
    await expand('d1', 'd1/db0')
    fireEvent.click(arrow('d1/db0'))
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalled())
    fireEvent.click(R('d1/db0').querySelector('.loader')!)
    await waitFor(() => expect(api.redis.keyTreeCancel).toHaveBeenCalledWith('d1', 0))
    expect(document.body.textContent).not.toContain('Scanning keys…')
    d.resolve(tree())
    await new Promise((r) => setTimeout(r, 30))
    expect(row(S)).toBeNull()
  })

  it('a scan error is shown under the database like other tree nodes', async () => {
    setup({ keyTree: vi.fn(async () => { throw new Error("Error invoking remote method 'redis:keyTree': Error: Connection refused") }) })
    await mount()
    await expand('d1', 'd1/db0')
    fireEvent.click(arrow('d1/db0'))
    await waitFor(() => expect(document.querySelector('.tree-err')?.textContent).toBe('Connection refused'))
  })

  it('a refresh while scanning supersedes the first scan: only the newer answer shows', async () => {
    const first = deferred<RedisKeyTree>()
    const second = deferred<RedisKeyTree>()
    const keyTree = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    setup({ keyTree })
    await mount()
    await expand('d1', 'd1/db0')
    fireEvent.click(arrow('d1/db0'))
    await waitFor(() => expect(keyTree).toHaveBeenCalledTimes(1))
    ctx('d1/db0')
    pick('Refresh')
    await waitFor(() => expect(keyTree).toHaveBeenCalledTimes(2))
    second.resolve(tree([k('new')]))
    await waitFor(() => expect(row(S)).toBeTruthy())
    first.resolve(tree([k('old1'), k('old2')]))
    await new Promise((r) => setTimeout(r, 30))
    expect(badge(S)).toBe('1')
  })
})

describe('capped scans', () => {
  it('shows a non-selectable dim note when the key list was cut off', async () => {
    setup({ keyTree: vi.fn(async () => tree([k('a'), k('b')], { complete: false, dbsize: 250_000 })) })
    await openTo()
    const note = document.querySelector('.tree-note') as HTMLElement
    expect(note.textContent).toBe('Showing first 2 of 250,000 keys — use the key browser to search')
    expect(note.classList.contains('tree-row')).toBe(false)
    expect(note.dataset.id).toBeUndefined()
    // it is not part of keyboard navigation either
    expect(ids().some((i) => i.includes('__note'))).toBe(false)
  })

  it('no note when everything was read', async () => {
    await openTo()
    expect(document.querySelector('.tree-note')).toBeNull()
  })

  it('the note names the real number of keys shown (thousands separators)', async () => {
    const keys = Array.from({ length: 1234 }, (_, i) => k('k' + i))
    setup({ keyTree: vi.fn(async () => tree(keys, { complete: false, dbsize: 2_000_000 })) })
    await openTo()
    expect(document.querySelector('.tree-note')!.textContent).toBe('Showing first 1,234 of 2,000,000 keys — use the key browser to search')
  })
})

describe('key folders and leaves', () => {
  it('groups keys into nested folders by the delimiter: user -> 42 -> profile, with counts and sorted folders first', async () => {
    await openTo()
    expect(ids().filter((i) => i.startsWith(S + '/'))).toEqual([]) // nothing rendered below a collapsed folder
    await expand(S, `${S}/d:a:`)
    expect(ids().filter((i) => i.startsWith(S + '/'))).toEqual([`${S}/d:a:`, USER, leafOf(S, 'a'), leafOf(S, 'counter')])
    expect(label(USER)).toBe('user')
    expect(badge(USER)).toBe('2')
    await expand(USER, `${USER}/d:user:7:`)
    expect(ids().filter((i) => i.startsWith(USER + '/'))).toEqual([`${USER}/d:user:7:`, U42])
    expect(label(U42)).toBe('42')
    expect(badge(U42)).toBe('1')
  })

  it('a key leaf shows the last segment, the full key as tooltip and a type icon', async () => {
    await openTo()
    await expand(S, USER)
    await expand(USER, U42)
    await expand(U42, leafOf(U42, 'user:42:name'))
    const leaf = R(leafOf(U42, 'user:42:name'))
    expect(leaf.querySelector('.tlabel')!.textContent).toBe('name')
    expect(leaf.dataset.tip).toBe('user:42:name')
    expect(leaf.querySelector('.ticon')!.getAttribute('data-tip')).toBe('String key')
    expect(leaf.querySelector('.arrow')).toBeNull()
  })

  it('a key that is also a prefix is a leaf next to the folder of the same name', async () => {
    await openTo()
    await expand(S, `${S}/d:a:`)
    expect(label(`${S}/d:a:`)).toBe('a')
    expect(label(leafOf(S, 'a'))).toBe('a')
    await expand(`${S}/d:a:`, leafOf(`${S}/d:a:`, 'a:b'))
    expect(label(leafOf(`${S}/d:a:`, 'a:b'))).toBe('b')
  })

  it('every type has its own icon label', async () => {
    setup({}, redis('d1', { keyDelimiter: '' })) // flat: the key leaves sit directly under their type folder
    await openTo()
    const tips: Record<string, string> = {}
    for (const [g, leaf] of [['strings', 'counter'], ['lists', 'queue:jobs'], ['sets', 'tags'], ['zsets', 'board'], ['hashes', 'user:42:profile'], ['streams', 'events'], ['other', 'mod']]) {
      fireEvent.click(arrow('d1/db0/' + g))
      await waitFor(() => expect(row(`d1/db0/${g}/k:${leaf}`)).toBeTruthy())
      tips[g] = R(`d1/db0/${g}/k:${leaf}`).querySelector('.ticon')!.getAttribute('data-tip')!
    }
    expect(tips).toEqual({
      strings: 'String key', lists: 'List key', sets: 'Set key', zsets: 'Sorted set key', hashes: 'Hash key', streams: 'Stream key', other: 'Key'
    })
  })

  it('empty segments and odd keys never lose or duplicate a row', async () => {
    const odd = ['a::b', ':lead', 'trail:', '::', '(empty)', 'x:(empty):y']
    setup({ keyTree: vi.fn(async () => tree(odd.map((x) => k(x)))) })
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(ids().filter((i) => i.startsWith(S + '/')).length).toBeGreaterThan(3))
    const kids = ids().filter((i) => i.startsWith(S + '/'))
    expect(new Set(kids).size).toBe(kids.length)
    expect(kids).toContain(leafOf(S, '(empty)'))
  })

  it('only expanded nodes are rendered (a closed folder renders none of its keys)', async () => {
    const keys = Array.from({ length: 5000 }, (_, i) => k(`g${i % 5}:k${i}`))
    setup({ keyTree: vi.fn(async () => tree(keys)) })
    await openTo()
    expect(document.querySelectorAll('.tree-row').length).toBeLessThan(10)
    await expand(S, `${S}/d:g0:`)
    expect(document.querySelectorAll('.tree-row').length).toBeLessThan(20)
    await expand(`${S}/d:g0:`, leafOf(`${S}/d:g0:`, 'g0:k0'))
    expect(document.querySelectorAll('.tree-row').length).toBeLessThan(600)
  })

  it('a folder with thousands of keys shows them in pages with a "Show more" row', async () => {
    const keys = Array.from({ length: 1200 }, (_, i) => k('f:' + String(i).padStart(4, '0')))
    setup({ keyTree: vi.fn(async () => tree(keys)) })
    await openTo()
    await expand(S, `${S}/d:f:`)
    await expand(`${S}/d:f:`, leafOf(`${S}/d:f:`, 'f:0000'))
    const count = (): number => document.querySelectorAll('[data-id*="/k:f:"]').length
    expect(count()).toBe(500)
    const more = document.querySelector('.tree-more') as HTMLElement
    expect(more.textContent).toBe('Show 500 more (700 remaining)')
    fireEvent.click(more)
    await waitFor(() => expect(count()).toBe(1000))
    fireEvent.click(document.querySelector('.tree-more')!)
    await waitFor(() => expect(count()).toBe(1200))
    expect(document.querySelector('.tree-more')).toBeNull()
  })

  it('building the tree for 100,000 keys is quick and does not render them', async () => {
    const keys = Array.from({ length: 100_000 }, (_, i) => k(`app:${i % 100}:${i}`))
    setup({ keyTree: vi.fn(async () => tree(keys, { complete: false, dbsize: 150_000 })) })
    const t0 = performance.now()
    await openTo()
    expect(badge(S)).toBe('100,000')
    expect(performance.now() - t0).toBeLessThan(4000)
    expect(document.querySelectorAll('.tree-row').length).toBeLessThan(10)
  })
})

describe('key delimiter setting', () => {
  const folderIds = (): string[] => ids().filter((i) => i.startsWith(S + '/'))

  it('sources without the setting (the default) show a flat list of keys under the type, like DataGrip', async () => {
    const src = redis('d1')
    delete src.redis!.keyDelimiter
    setup({}, src)
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(ids()).toContain(leafOf(S, 'user:42:name')))
    expect(folderIds().filter((i) => i.startsWith(`${S}/d:`))).toEqual([])
  })

  it('a custom delimiter groups by it', async () => {
    setup({ keyTree: vi.fn(async () => tree([k('a/b/c'), k('a/d'), k('x:y')])) }, redis('d1', { keyDelimiter: '/' }))
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(folderIds()).toContain(`${S}/d:a/`))
    expect(folderIds()).toContain(leafOf(S, 'x:y'))
    expect(badge(`${S}/d:a/`)).toBe('2')
  })

  it('a multi-character delimiter', async () => {
    setup({ keyTree: vi.fn(async () => tree([k('a::b'), k('a:c')])) }, redis('d1', { keyDelimiter: '::' }))
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(folderIds()).toContain(`${S}/d:a::`))
    expect(folderIds()).toContain(leafOf(S, 'a:c'))
  })

  it('a blank delimiter lists keys flat under their type', async () => {
    setup({}, redis('d1', { keyDelimiter: '' }))
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(folderIds()).toContain(leafOf(S, 'user:42:name')))
    expect(folderIds().some((i) => i.includes('/d:'))).toBe(false)
  })

  it('changing the delimiter (edit dialog -> reload) regroups the open database', async () => {
    const keyTree = vi.fn(async () => tree([k('a:b'), k('a/b')]))
    setup({ keyTree })
    const r = render(ui())
    await waitFor(() => expect(row('d1')).toBeTruthy())
    await expand('d1', 'd1/db0')
    await expand('d1/db0', S)
    fireEvent.click(arrow(S))
    await waitFor(() => expect(folderIds()).toContain(`${S}/d:a:`))
    api.listSources.mockResolvedValue([redis('d1', { keyDelimiter: '/' })])
    r.rerender(ui({ reloadKey: 1 }))
    await waitFor(() => expect(keyTree).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(ids()).toContain(S))
    await waitFor(() => {
      if (!row(`${S}/d:a/`)) fireEvent.click(arrow(S))
      expect(row(`${S}/d:a/`)).toBeTruthy()
    })
  })
})

describe('opening keys', () => {
  it('double-click on a key opens a key tab', async () => {
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(row(leafOf(S, 'counter'))).toBeTruthy())
    fireEvent.doubleClick(R(leafOf(S, 'counter')))
    expect(cb.onOpen).toHaveBeenCalledTimes(1)
    expect(cb.onOpen).toHaveBeenCalledWith({
      dsId: 'd1', dsName: 'Cache', database: 'db0', schema: '', table: 'counter', kind: 'redis', engine: 'redis', db: 0, redisKey: 'counter'
    })
  })

  it('Enter on a selected key opens it; Enter on a folder toggles it', async () => {
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(row(leafOf(S, 'counter'))).toBeTruthy())
    click(leafOf(S, 'counter'))
    key('Enter')
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ redisKey: 'counter', db: 0 }))
    click(USER)
    key('Enter')
    await waitFor(() => expect(row(`${USER}/d:user:7:`)).toBeTruthy())
    expect(cb.onOpen).toHaveBeenCalledTimes(1)
    key('Enter')
    await waitFor(() => expect(row(`${USER}/d:user:7:`)).toBeNull())
  })

  it('a key in db 3 opens in db 3', async () => {
    setup({ keyTree: vi.fn(async () => tree([k('z')])) })
    await mount()
    await expand('d1', 'd1/db3')
    await expand('d1/db3', 'd1/db3/strings')
    await expand('d1/db3/strings', 'd1/db3/strings/k:z')
    fireEvent.doubleClick(R('d1/db3/strings/k:z'))
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ db: 3, redisKey: 'z', database: 'db3' }))
  })

  it('binary key names show their escaped form and open with the encoded name', async () => {
    const enc = REDIS_BIN_PREFIX + Buffer.from([0xff, 0x00, 0x41]).toString('base64')
    setup({ keyTree: vi.fn(async () => tree([k(enc)])) })
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(row(leafOf(S, enc))).toBeTruthy())
    expect(label(leafOf(S, enc))).not.toContain('b64')
    fireEvent.doubleClick(R(leafOf(S, enc)))
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ redisKey: enc }))
  })
})

describe('menus', () => {
  async function leafReady(): Promise<void> {
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(row(leafOf(S, 'counter'))).toBeTruthy())
  }

  it('database menu keeps Open Key Browser / New Query Console', async () => {
    await openTo('d1/db0', S)
    ctx('d1/db0')
    expect(menuLabels()).toEqual(['Open Key Browser', 'New Query Console', 'Refresh', 'Copy Name'])
    pick('Open Key Browser')
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'redis', db: 0, table: 'db0' }))
    expect((cb.onOpen.mock.calls[0][0] as { redisKey?: string }).redisKey).toBeUndefined()
    ctx('d1/db0')
    pick('New Query Console')
    expect(cb.onConsole).toHaveBeenCalledWith({ dsId: 'd1', dsName: 'Cache', database: 'db0', engine: 'redis', db: 0 })
  })

  it('key menu: Open, Copy Key Name, Rename…, Delete…, Refresh', async () => {
    await leafReady()
    ctx(leafOf(S, 'counter'))
    expect(menuLabels()).toEqual(['Open', 'Copy Key Name', 'Rename…', 'Delete…', 'Refresh'])
  })

  it('Open / Copy Key Name from the menu', async () => {
    await leafReady()
    ctx(leafOf(S, 'counter'))
    pick('Open')
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ redisKey: 'counter' }))
    ctx(leafOf(S, 'counter'))
    pick('Copy Key Name')
    expect(clip).toHaveBeenCalledWith('counter')
  })

  it('Copy Key Name copies the FULL key, not the last segment', async () => {
    await openTo()
    await expand(S, USER)
    await expand(USER, U42)
    await expand(U42, leafOf(U42, 'user:42:name'))
    ctx(leafOf(U42, 'user:42:name'))
    pick('Copy Key Name')
    expect(clip).toHaveBeenCalledWith('user:42:name')
  })

  it('folder menu: Browse in Key Browser, Copy Prefix, Refresh; type folder: Browse in Key Browser, Refresh', async () => {
    await openTo()
    await expand(S, USER)
    ctx(USER)
    expect(menuLabels()).toEqual(['Browse in Key Browser', 'Copy Prefix', 'Refresh'])
    document.body.click()
    ctx(S)
    expect(menuLabels()).toEqual(['Browse in Key Browser', 'Refresh'])
  })

  it('Browse in Key Browser on a folder opens the key browser prefilled with its pattern and type', async () => {
    await openTo()
    await expand(S, USER)
    await expand(USER, U42)
    ctx(U42)
    pick('Browse in Key Browser')
    expect(cb.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'redis', db: 0, table: 'db0', redisFilter: { pattern: 'user:42:*', type: 'string', n: expect.any(Number) } })
    )
    expect((cb.onOpen.mock.calls[0][0] as { redisKey?: string }).redisKey).toBeUndefined()
  })

  it('Browse in Key Browser on a type folder prefills the type filter only; "other" has none', async () => {
    await openTo()
    ctx('d1/db0/hashes')
    pick('Browse in Key Browser')
    expect(cb.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ redisFilter: { pattern: '', type: 'hash', n: expect.any(Number) } }))
    ctx('d1/db0/other')
    pick('Browse in Key Browser')
    expect(cb.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ redisFilter: { pattern: '', type: '', n: expect.any(Number) } }))
  })

  it('the prefix pattern escapes glob characters', async () => {
    setup({ keyTree: vi.fn(async () => tree([k('a*b[1]:x')])) })
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(row(`${S}/d:a*b[1]:`)).toBeTruthy())
    ctx(`${S}/d:a*b[1]:`)
    pick('Browse in Key Browser')
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ redisFilter: expect.objectContaining({ pattern: 'a\\*b\\[1\\]:*' }) }))
  })

  it('Copy Prefix copies the prefix with its trailing delimiter', async () => {
    await openTo()
    await expand(S, USER)
    await expand(USER, U42)
    ctx(U42)
    pick('Copy Prefix')
    expect(clip).toHaveBeenCalledWith('user:42:')
  })

  it('there is no "delete the whole folder" action', async () => {
    await openTo()
    await expand(S, USER)
    ctx(USER)
    expect(menuLabels().some((l) => /delete|drop/i.test(l))).toBe(false)
  })
})

describe('refresh', () => {
  it('db menu Refresh re-scans the database', async () => {
    await openTo()
    expect(api.redis.keyTree).toHaveBeenCalledTimes(1)
    ctx('d1/db0')
    pick('Refresh')
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(2))
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/db0')
  })

  it('⌘R on the selected database re-scans it', async () => {
    await openTo()
    click('d1/db0')
    combo('KeyR', { metaKey: true })
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(2))
  })

  it('refresh on a key / folder / type folder re-scans its database', async () => {
    await openTo()
    await expand(S, USER)
    ctx(USER)
    pick('Refresh')
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(2))
    ctx(S)
    pick('Refresh')
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(row(leafOf(S, 'counter'))).toBeTruthy())
    ctx(leafOf(S, 'counter'))
    pick('Refresh')
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(4))
  })

  it('a refresh shows the new keys and keeps the expansion state', async () => {
    const keyTree = vi.fn().mockResolvedValueOnce(tree([k('x:1')])).mockResolvedValue(tree([k('x:1'), k('x:2'), k('y')]))
    setup({ keyTree })
    await openTo()
    await expand(S, `${S}/d:x:`)
    ctx('d1/db0')
    pick('Refresh')
    await waitFor(() => expect(row(leafOf(S, 'y'))).toBeTruthy())
    expect(row(`${S}/d:x:`)).toBeTruthy()
    expect(badge(`${S}/d:x:`)).toBe('2')
  })

  it('refreshing the source re-scans the databases that were opened (not the ones that never were)', async () => {
    await openTo()
    ctx('d1')
    pick('Refresh')
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(2))
    expect(api.redis.keyTree.mock.calls.every((c) => c[1] === 0)).toBe(true)
  })

  it('treeRefresh from the app re-scans an opened database but never an unopened one', async () => {
    const r = render(ui())
    await waitFor(() => expect(row('d1')).toBeTruthy())
    await expand('d1', 'd1/db0')
    const t1 = { id: 'd1/db0', n: 1 }
    r.rerender(ui({ treeRefresh: t1 }))
    await new Promise((x) => setTimeout(x, 30))
    expect(api.redis.keyTree).not.toHaveBeenCalled() // db0 was never expanded
    await expand('d1/db0', S)
    expect(api.redis.keyTree).toHaveBeenCalledTimes(1)
    const t2 = { id: 'd1/db0', n: 2 }
    r.rerender(ui({ treeRefresh: t2 }))
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(2))
    r.rerender(ui({ treeRefresh: t2 }))
    await new Promise((x) => setTimeout(x, 30))
    expect(api.redis.keyTree).toHaveBeenCalledTimes(2)
  })
})

describe('selection, copy and delete', () => {
  async function leaves(): Promise<void> {
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(row(leafOf(S, 'counter'))).toBeTruthy())
  }

  it('⌘C copies the selected key name (full key)', async () => {
    await openTo()
    await expand(S, USER)
    await expand(USER, U42)
    await expand(U42, leafOf(U42, 'user:42:name'))
    click(leafOf(U42, 'user:42:name'))
    combo('KeyC', { metaKey: true })
    expect(clip).toHaveBeenCalledWith('user:42:name')
  })

  it('⌘C with several keys selected copies their names, one per line', async () => {
    await leaves()
    click(leafOf(S, 'a'))
    click(leafOf(S, 'counter'), { metaKey: true })
    combo('KeyC', { metaKey: true })
    expect(clip).toHaveBeenCalledWith('a\ncounter')
  })

  it('⌘C on a folder copies its prefix', async () => {
    await openTo()
    await expand(S, USER)
    click(USER)
    combo('KeyC', { metaKey: true })
    expect(clip).toHaveBeenCalledWith('user:')
  })

  it('⌘C on a database or while renaming does not copy anything special', async () => {
    await openTo()
    click('d1/db0')
    combo('KeyC', { metaKey: true })
    expect(clip).not.toHaveBeenCalled()
  })

  it('shift-click selects a range of keys; the multi menu offers Refresh, Copy Key Names, Delete N Keys…', async () => {
    await leaves()
    click(leafOf(S, 'a'))
    click(leafOf(S, 'counter'), { shiftKey: true })
    ctx(leafOf(S, 'counter'))
    expect(menuLabels()).toEqual(['Refresh', 'Copy Key Names', 'Delete 2 Keys…'])
    pick('Copy Key Names')
    expect(clip).toHaveBeenCalledWith('a\ncounter')
  })

  it('Delete… asks for confirmation, deletes the key, tells the app and re-scans', async () => {
    await leaves()
    ctx(leafOf(S, 'counter'))
    pick('Delete…')
    expect(confirmFn.mock.calls[0][0]).toContain('counter')
    await waitFor(() => expect(api.redis.delete).toHaveBeenCalledWith('d1', 0, ['counter']))
    await waitFor(() => expect(cb.onKeysGone).toHaveBeenCalledWith('d1', 0, ['counter']))
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(2))
  })

  it('declining the confirmation deletes nothing', async () => {
    confirmFn.mockReturnValue(false)
    await leaves()
    ctx(leafOf(S, 'counter'))
    pick('Delete…')
    expect(api.redis.delete).not.toHaveBeenCalled()
    expect(cb.onKeysGone).not.toHaveBeenCalled()
  })

  it('⌘⌫ on a selected key deletes it', async () => {
    await leaves()
    click(leafOf(S, 'counter'))
    key('Backspace', { metaKey: true })
    expect(confirmFn).toHaveBeenCalled()
    await waitFor(() => expect(api.redis.delete).toHaveBeenCalledWith('d1', 0, ['counter']))
  })

  it('deleting several selected keys: one confirmation, one delete call with all of them', async () => {
    await leaves()
    click(leafOf(S, 'a'))
    click(leafOf(S, 'counter'), { metaKey: true })
    ctx(leafOf(S, 'counter'))
    pick('Delete 2 Keys…')
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(confirmFn.mock.calls[0][0]).toContain('Delete 2 keys?')
    await waitFor(() => expect(api.redis.delete).toHaveBeenCalledWith('d1', 0, ['a', 'counter']))
    expect(cb.onKeysGone).toHaveBeenCalledWith('d1', 0, ['a', 'counter'])
  })

  it('keys from two databases are deleted per database', async () => {
    setup({ keyTree: vi.fn(async () => tree([k('p'), k('q')])) })
    await mount()
    await expand('d1', 'd1/db0')
    await expand('d1/db0', S)
    await expand(S, leafOf(S, 'p'))
    await expand('d1/db3', 'd1/db3/strings')
    await expand('d1/db3/strings', 'd1/db3/strings/k:q')
    click(leafOf(S, 'p'))
    click('d1/db3/strings/k:q', { metaKey: true })
    ctx('d1/db3/strings/k:q')
    pick('Delete 2 Keys…')
    await waitFor(() => expect(api.redis.delete).toHaveBeenCalledTimes(2))
    expect(api.redis.delete).toHaveBeenCalledWith('d1', 0, ['p'])
    expect(api.redis.delete).toHaveBeenCalledWith('d1', 3, ['q'])
  })

  it('a failed delete shows the error and still re-scans', async () => {
    setup({ delete: vi.fn(async () => { throw new Error('READONLY You can\'t write against a read only replica.') }) })
    await leaves()
    ctx(leafOf(S, 'counter'))
    pick('Delete…')
    await waitFor(() => expect(document.body.textContent).toContain("READONLY You can't write against a read only replica."))
    expect(cb.onKeysGone).not.toHaveBeenCalled()
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(2))
  })

  it('a mix of key and folder selected only offers Refresh and Copy Names', async () => {
    await leaves()
    click(leafOf(S, 'counter'))
    click(USER, { metaKey: true })
    ctx(USER)
    expect(menuLabels()).toEqual(['Refresh', 'Copy Names'])
  })
})

describe('rename', () => {
  async function leaves(): Promise<void> {
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(row(leafOf(S, 'counter'))).toBeTruthy())
  }

  it('Rename… edits the full key name inline, renames, tells the app and re-scans', async () => {
    await openTo()
    await expand(S, USER)
    await expand(USER, U42)
    await expand(U42, leafOf(U42, 'user:42:name'))
    ctx(leafOf(U42, 'user:42:name'))
    pick('Rename…')
    const input = document.querySelector('.tree-input') as HTMLInputElement
    expect(input.value).toBe('user:42:name')
    fireEvent.change(input, { target: { value: 'user:42:fullname' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.redis.rename).toHaveBeenCalledWith('d1', 0, 'user:42:name', 'user:42:fullname'))
    await waitFor(() => expect(cb.onKeyRenamed).toHaveBeenCalledWith('d1', 0, 'user:42:name', 'user:42:fullname'))
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledTimes(2))
  })

  it('F2 renames the selected key', async () => {
    await leaves()
    click(leafOf(S, 'counter'))
    key('F2')
    expect(document.querySelector('.tree-input')).toBeTruthy()
  })

  it('an unchanged or empty name does nothing; Escape cancels', async () => {
    await leaves()
    ctx(leafOf(S, 'counter'))
    pick('Rename…')
    let input = document.querySelector('.tree-input') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Enter' })
    ctx(leafOf(S, 'counter'))
    pick('Rename…')
    input = document.querySelector('.tree-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    ctx(leafOf(S, 'counter'))
    pick('Rename…')
    input = document.querySelector('.tree-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'zzz' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await new Promise((r) => setTimeout(r, 20))
    expect(api.redis.rename).not.toHaveBeenCalled()
    expect(document.querySelector('.tree-input')).toBeNull()
  })

  it('a failed rename shows the error', async () => {
    setup({ rename: vi.fn(async () => { throw new Error('Key "x" already exists') }) })
    await leaves()
    ctx(leafOf(S, 'counter'))
    pick('Rename…')
    const input = document.querySelector('.tree-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(document.body.textContent).toContain('Key "x" already exists'))
    expect(cb.onKeyRenamed).not.toHaveBeenCalled()
  })

  it('binary key names cannot be renamed from the tree', async () => {
    const enc = REDIS_BIN_PREFIX + Buffer.from([0xff, 0x00]).toString('base64')
    setup({ keyTree: vi.fn(async () => tree([k(enc)])) })
    await openTo()
    fireEvent.click(arrow(S))
    await waitFor(() => expect(row(leafOf(S, enc))).toBeTruthy())
    ctx(leafOf(S, enc))
    pick('Rename…')
    expect(document.querySelector('.tree-input')).toBeNull()
    expect(document.body.textContent).toContain('Binary key names cannot be renamed')
  })
})

describe('keyboard navigation and expansion state', () => {
  it('arrows move through type folders / folders / keys; Right expands, Left collapses then jumps to the parent', async () => {
    await openTo()
    click(S)
    key('ArrowRight')
    await waitFor(() => expect(row(USER)).toBeTruthy())
    key('ArrowDown')
    expect(R(`${S}/d:a:`).classList.contains('sel')).toBe(true)
    key('ArrowDown')
    expect(R(USER).classList.contains('sel')).toBe(true)
    key('ArrowRight')
    await waitFor(() => expect(row(U42)).toBeTruthy())
    key('ArrowDown')
    key('ArrowDown')
    expect(R(U42).classList.contains('sel')).toBe(true)
    key('ArrowLeft') // closed folder -> parent
    expect(R(USER).classList.contains('sel')).toBe(true)
    key('ArrowLeft') // collapse
    await waitFor(() => expect(row(U42)).toBeNull())
  })

  it('Collapse All closes the tree; Expand All opens loaded nodes but skips huge folders (and never re-scans)', async () => {
    const big = Array.from({ length: 1500 }, (_, i) => k('b' + i))
    setup({ keyTree: vi.fn(async () => tree([...big, k('l1', 'list'), k('l2', 'list')])) })
    await openTo('d1/db0', 'd1/db0/strings')
    await new Promise((r) => setTimeout(r, 500))
    fireEvent.click(document.querySelector('.explorer-head [data-tip="Expand All (loaded)"]')!)
    await waitFor(() => expect(row('d1/db0/lists/k:l1')).toBeTruthy())
    expect(row('d1/db0/strings/k:b0')).toBeNull() // 1500 keys: left closed
    expect(api.redis.keyTree).toHaveBeenCalledTimes(1)
    fireEvent.click(document.querySelector('.explorer-head [data-tip="Collapse All"]')!)
    await waitFor(() => expect(ids()).toEqual(['d1']))
  })

  it('a previous session re-expands nested folders (ids survive restarts)', async () => {
    h.session = { expanded: ['d1', 'd1/db0', S, USER], folders: [] }
    await mount()
    await waitFor(() => expect(row(`${USER}/d:user:7:`)).toBeTruthy())
    expect(row(U42)).toBeTruthy()
  })

  it('selecting does not re-scan', async () => {
    await openTo()
    click(S)
    click('d1/db0/lists')
    expect(api.redis.keyTree).toHaveBeenCalledTimes(1)
  })
})
