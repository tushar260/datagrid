// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { cacheKeys, compactKeyTree, type DataSource, type RedisKeyTree } from '../../src/shared'
import { handleInvalidated, primeIndex } from '../../src/renderer/src/lib/objectCache'
import { resetSettings, updateSettings } from '../../src/renderer/src/lib/settings'
import { cacheFake, installApi, type MockApi } from './helpers/mockApi'

const h = vi.hoisted(() => ({ session: { expanded: [] as string[], folders: [] as string[] } }))
vi.mock('../../src/renderer/src/session', () => ({ get initialSession() { return h.session }, patchSession: () => undefined }))
vi.mock('../../src/renderer/src/DbPicker', () => ({ default: () => <div className="picker-stub" /> }))
vi.mock('../../src/renderer/src/CreateDialogs', () => ({ default: () => <div className="create-stub" /> }))

import Explorer from '../../src/renderer/src/Explorer'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'

Element.prototype.scrollIntoView = vi.fn()

const pg = (id: string, over: Partial<DataSource> = {}): DataSource => ({ id, name: id.toUpperCase(), host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false, ...over })
const ddb = (id: string): DataSource => ({ ...pg(id, { kind: 'dynamodb', host: '', port: 0, user: '', database: '' }), dynamo: { region: 'eu-west-1', authMode: 'default' } })
const redis = (id: string): DataSource => ({
  ...pg(id, { name: 'Cache', kind: 'redis', host: '', port: 0, user: '', database: '' }),
  redis: { host: 'localhost', port: 6379, db: 0, tls: false, keyDelimiter: ':' }
})
const T = (name: string, kind = 'table'): { name: string; kind: string } => ({ name, kind })
const HOUR = 3600_000

type Store = Record<string, Record<string, { at: number; data: unknown }>>
const E = (data: unknown, ago = 3 * HOUR): { at: number; data: unknown } => ({ at: Date.now() - ago, data })
const pgStored = (id = 'd1'): Store => ({
  [id]: {
    [cacheKeys.pgDbs]: E(['app', 'other']),
    [cacheKeys.pgSchemas('app')]: E(['public']),
    [cacheKeys.pgTableNames('app')]: E({ public: ['users', 'orders'] }),
    [cacheKeys.pgTables('app', 'public')]: E([T('users'), T('orders')])
  }
})

let api: MockApi
let fake: ReturnType<typeof cacheFake>
let cb: Record<'onOpen' | 'onEdit' | 'onConsole' | 'onTableRenamed' | 'onRefreshed' | 'onObjectGone' | 'onSources', ReturnType<typeof vi.fn>>

function setup(store: Store = {}, over: Record<string, unknown> = {}, sources: DataSource[] = [pg('d1', { name: 'Local' })]): void {
  fake = cacheFake(store)
  api = installApi({
    listSources: sources,
    databases: ['app', 'other'],
    schemasAll: ['public'],
    tableNames: { public: ['users', 'orders'] },
    tables: [T('users'), T('orders')],
    roles: ['alice'],
    tablespaces: ['pg_default'],
    cache: fake,
    ...over
  })
}
beforeEach(() => {
  h.session = { expanded: [], folders: [] }
  localStorage.clear()
  resetSettings()
  resetExplorerClick()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn() }, configurable: true })
  cb = { onOpen: vi.fn(), onEdit: vi.fn(), onConsole: vi.fn(), onTableRenamed: vi.fn(), onRefreshed: vi.fn(), onObjectGone: vi.fn(), onSources: vi.fn() }
  setup()
})
afterEach(() => {
  cleanup()
  resetSettings()
})

type P = React.ComponentProps<typeof Explorer>
const ui = (extra: Record<string, unknown> = {}): React.JSX.Element => <Explorer {...(Object.assign({}, cb, { reloadKey: 0 }, extra) as unknown as P)} />
const row = (id: string): HTMLElement | null => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).find((r) => r.dataset.id === id) ?? null
const R = (id: string): HTMLElement => {
  const r = row(id)
  if (!r) throw new Error('no row ' + id)
  return r
}
const ids = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).map((r) => r.dataset.id!)
const badge = (id: string): string | null => R(id).querySelector('.badge')?.textContent ?? null
const tip2 = (id: string): string | undefined => R(id).dataset.tip2
const selected = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row.sel')).map((r) => r.dataset.id!)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const btn = (tip: string): HTMLButtonElement => document.querySelector(`.explorer-head [data-tip="${tip}"]`) as HTMLButtonElement
const ctx = (id: string): void => void fireEvent.contextMenu(R(id), { clientX: 12, clientY: 34 })
const pick = (l: string): void => {
  const el = Array.from(document.querySelectorAll<HTMLElement>('.ctxitem')).find((i) => i.querySelector('span')?.textContent === l)
  if (!el) throw new Error('no menu item ' + l)
  fireEvent.click(el)
}
async function mount(extra: Record<string, unknown> = {}): Promise<ReturnType<typeof render>> {
  const r = render(ui(extra))
  await waitFor(() => expect(document.querySelector('.explorer .tree-row')).toBeTruthy())
  return r
}
async function open(id: string, child: string): Promise<void> {
  await waitFor(() => expect(R(id).querySelector('.arrow')).toBeTruthy())
  fireEvent.click(R(id).querySelector('.arrow')!)
  await waitFor(() => expect(row(child)).toBeTruthy())
}
async function openAll(): Promise<void> {
  await open('d1', 'd1/app')
  await open('d1/app', 'd1/app/public')
  await open('d1/app/public', 'd1/app/public/users')
}
const networkCalls = (): number =>
  [api.databases, api.schemasAll, api.tableNames, api.tables, api.roles, api.tablespaces, api.dynamo.tables, api.redis.databases, api.redis.keyTree].reduce((n, f) => n + f.mock.calls.length, 0)

describe('Explorer + cache: a first visit', () => {
  it('fetches from the server and stores each list under its key', async () => {
    await mount()
    await openAll()
    await waitFor(() => expect(fake.entries.size).toBeGreaterThanOrEqual(4))
    const keys = [...fake.entries.keys()].map((k) => k.split('\u0000')[1]).sort()
    expect(keys).toEqual([cacheKeys.pgDbs, cacheKeys.pgSchemas('app'), cacheKeys.pgTableNames('app'), cacheKeys.pgTables('app', 'public')].sort())
    expect(fake.entries.get('d1\u0000' + cacheKeys.pgTables('app', 'public'))!.data).toEqual([T('users'), T('orders')])
  })

  it('never stores rows, values, passwords or errors', async () => {
    setup({}, { databases: async () => { throw new Error('connection refused: password=hunter2') } })
    await mount()
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(api.databases).toHaveBeenCalled())
    await sleep(30)
    expect(fake.entries.size).toBe(0)
    expect(fake.set).not.toHaveBeenCalled()
  })
})

describe('Explorer + cache: after a restart (everything is stored)', () => {
  beforeEach(() => setup(pgStored()))

  it('expanding the whole tree makes no network call at all', async () => {
    await mount()
    await openAll()
    expect(ids()).toEqual(expect.arrayContaining(['d1/app', 'd1/other', 'd1/app/public', 'd1/app/public/users', 'd1/app/public/orders']))
    expect(networkCalls()).toBe(0)
    expect(fake.set).not.toHaveBeenCalled() // and nothing is rewritten
  })

  it('the count pills come from the cache too', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    await waitFor(() => expect(badge('d1/app/public')).toBe('2'))
    expect(networkCalls()).toBe(0)
  })

  it('a restored session (expanded ids) rebuilds the tree from the cache', async () => {
    h.session = { expanded: ['d1', 'd1/app', 'd1/app/public'], folders: [] }
    await mount()
    await waitFor(() => expect(row('d1/app/public/users')).toBeTruthy())
    expect(networkCalls()).toBe(0)
  })

  it('the tooltip says it was loaded from the cache, with its age', async () => {
    await mount()
    await open('d1', 'd1/app')
    expect(tip2('d1')).toBe('h:5432 · u@postgres · Loaded from cache 3h ago — Refresh to update')
    expect(tip2('d1/app')).toBeUndefined() // not loaded yet: no note
    await open('d1/app', 'd1/app/public')
    expect(tip2('d1/app')).toBe('Loaded from cache 3h ago — Refresh to update')
  })

  it('a source that was never cached fetches normally (and a cached one next to it does not)', async () => {
    setup(pgStored('d1'), {}, [pg('d1', { name: 'Local' }), pg('d2', { name: 'Fresh' })])
    await mount()
    await open('d1', 'd1/app')
    expect(networkCalls()).toBe(0)
    await open('d2', 'd2/app')
    expect(api.databases).toHaveBeenCalledTimes(1)
    expect(api.databases.mock.calls[0][0]).toBe('d2')
  })

  it('an empty cached list of tables is trusted (no refetch of "no tables")', async () => {
    setup({ d1: { ...pgStored().d1, [cacheKeys.pgTables('app', 'public')]: E([]), [cacheKeys.pgTableNames('app')]: E({ public: [] }) } })
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    fireEvent.click(R('d1/app/public').querySelector('.arrow')!)
    await sleep(30)
    expect(api.tables).not.toHaveBeenCalled()
  })
})

describe('Explorer + cache: Refresh goes to the server and updates the cache', () => {
  beforeEach(() => setup(pgStored()))

  it('context menu Refresh on a source refetches its databases and stores the new list', async () => {
    api.databases.mockResolvedValue(['app', 'other', 'brand_new'])
    await mount()
    await open('d1', 'd1/app')
    expect(ids()).not.toContain('d1/brand_new')
    ctx('d1')
    pick('Refresh')
    await waitFor(() => expect(row('d1/brand_new')).toBeTruthy())
    expect(api.databases).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(fake.entries.get('d1\u0000' + cacheKeys.pgDbs)!.data).toEqual(['app', 'other', 'brand_new']))
    expect(tip2('d1')).toBe('h:5432 · u@postgres · Refreshed just now')
  })

  it('Refresh on a schema refetches its tables only (not the databases above it)', async () => {
    api.tables.mockResolvedValue([T('users'), T('orders'), T('invoices')])
    await mount()
    await openAll()
    ctx('d1/app/public')
    pick('Refresh')
    await waitFor(() => expect(row('d1/app/public/invoices')).toBeTruthy())
    expect(api.databases).not.toHaveBeenCalled()
    expect(api.tables).toHaveBeenCalledTimes(1)
    await waitFor(() => expect((fake.entries.get('d1\u0000' + cacheKeys.pgTables('app', 'public'))!.data as unknown[]).length).toBe(3))
  })

  it('Refresh on a database refetches its schemas, counts and tables', async () => {
    api.schemasAll.mockResolvedValue(['public', 'extra'])
    await mount()
    await openAll()
    ctx('d1/app')
    pick('Refresh')
    await waitFor(() => expect(row('d1/app/extra')).toBeTruthy())
    expect(api.databases).not.toHaveBeenCalled()
    expect(api.schemasAll).toHaveBeenCalledTimes(1)
    expect(api.tableNames).toHaveBeenCalledTimes(1)
  })

  it('⌘R on the selected node refreshes it from the server', async () => {
    api.databases.mockResolvedValue(['app', 'other', 'viakey'])
    await mount()
    await open('d1', 'd1/app')
    fireEvent.mouseDown(R('d1'))
    fireEvent.click(R('d1'))
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', metaKey: true })
    await waitFor(() => expect(row('d1/viakey')).toBeTruthy())
    expect(api.databases).toHaveBeenCalledTimes(1)
  })

  it('"Refresh all" refetches every loaded list, and only those', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    api.databases.mockClear()
    api.schemasAll.mockClear()
    api.tableNames.mockClear()
    api.tables.mockClear()
    fireEvent.click(btn('Refresh all'))
    await waitFor(() => expect(api.databases).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.schemasAll).toHaveBeenCalled())
    expect(api.tables).not.toHaveBeenCalled() // the schema node was never expanded
    expect(api.schemasAll.mock.calls.every((c) => c[1] === 'app')).toBe(true) // 'other' was never loaded
  })

  it('a refresh of one source does not make the other source skip its cache', async () => {
    setup({ ...pgStored('d1'), ...pgStored('d2') }, {}, [pg('d1'), pg('d2')])
    await mount()
    await open('d1', 'd1/app')
    await open('d2', 'd2/app')
    ctx('d1')
    pick('Refresh')
    await waitFor(() => expect(api.databases).toHaveBeenCalledTimes(1))
    expect(api.databases.mock.calls[0][0]).toBe('d1')
  })

  it('after the refresh the node is current: collapsing and re-expanding does not refetch', async () => {
    await mount()
    await open('d1', 'd1/app')
    ctx('d1')
    pick('Refresh')
    await waitFor(() => expect(api.databases).toHaveBeenCalledTimes(1))
    await sleep(500)
    fireEvent.click(R('d1').querySelector('.arrow')!)
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await sleep(50)
    expect(api.databases).toHaveBeenCalledTimes(1)
  })

  it('a refresh that fails keeps the cached tree on screen and the cached entry on disk', async () => {
    api.databases.mockRejectedValue(new Error('offline'))
    await mount()
    await open('d1', 'd1/app')
    ctx('d1')
    pick('Refresh')
    await waitFor(() => expect(api.databases).toHaveBeenCalled())
    await sleep(50)
    expect(fake.entries.get('d1\u0000' + cacheKeys.pgDbs)!.data).toEqual(['app', 'other'])
  })

  it('Refresh never rewrites the other kinds of lists (roles / tablespaces untouched)', async () => {
    await mount()
    await open('d1', 'd1/app')
    ctx('d1/app')
    pick('Refresh')
    await sleep(50)
    expect(api.roles).not.toHaveBeenCalled()
    expect(api.tablespaces).not.toHaveBeenCalled()
  })
})

describe('Explorer + cache: in-app changes drop the stale lists (announced by the main process)', () => {
  beforeEach(() => setup(pgStored()))

  it('an invalidation event forgets the list in memory (index, age note); main already deleted the stored copy', async () => {
    const { peekIndex, cacheMeta } = await import('../../src/renderer/src/lib/objectCache')
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    expect(peekIndex('d1')!.has(cacheKeys.pgSchemas('app'))).toBe(true)
    act(() => handleInvalidated('d1', [cacheKeys.pgSchemas('app')]))
    expect(peekIndex('d1')!.has(cacheKeys.pgSchemas('app'))).toBe(false)
    expect(peekIndex('d1')!.has(cacheKeys.pgDbs)).toBe(true) // only what was named
    expect(cacheMeta('d1', cacheKeys.pgSchemas('app'))).toBeUndefined()
  })

  it('after a table was created (stored list dropped by main), expanding the schema asks the server', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    fake.entries.delete('d1\u0000' + cacheKeys.pgTables('app', 'public')) // what main does on db:createTable
    act(() => handleInvalidated('d1', [cacheKeys.pgTables('app', 'public'), cacheKeys.pgTableNames('app')]))
    api.tables.mockResolvedValue([T('users'), T('orders'), T('created_now')])
    await open('d1/app/public', 'd1/app/public/created_now')
    expect(api.tables).toHaveBeenCalledTimes(1)
  })

  it('a dropped list is not served from memory afterwards: with the stored entry gone the explorer fetches', async () => {
    await mount()
    fake.entries.clear()
    act(() => handleInvalidated('d1', ['']))
    await open('d1', 'd1/app')
    expect(api.databases).toHaveBeenCalledTimes(1)
  })
})

describe('Explorer + cache: the setting is off', () => {
  beforeEach(() => {
    setup(pgStored())
    updateSettings({ cacheObjects: false })
  })

  it('nothing is read from the cache: every expansion asks the server', async () => {
    await mount()
    await openAll()
    expect(api.databases).toHaveBeenCalledTimes(1)
    expect(api.schemasAll).toHaveBeenCalled()
    expect(api.tables).toHaveBeenCalled()
    expect(fake.get).not.toHaveBeenCalled()
  })

  it('nothing is written, and what is stored is left alone', async () => {
    api.databases.mockResolvedValue(['changed'])
    const before = JSON.stringify([...fake.entries.entries()])
    await mount()
    await open('d1', 'd1/changed')
    await sleep(30)
    expect(fake.set).not.toHaveBeenCalled()
    expect(fake.delete).not.toHaveBeenCalled()
    expect(JSON.stringify([...fake.entries.entries()])).toBe(before)
  })

  it('the tooltip still says when it was loaded', async () => {
    await mount()
    await open('d1', 'd1/app')
    expect(tip2('d1')).toBe('h:5432 · u@postgres · Refreshed just now')
  })

  it('turned back on, the stored lists are used again', async () => {
    updateSettings({ cacheObjects: true })
    await mount()
    await open('d1', 'd1/app')
    expect(networkCalls()).toBe(0)
  })
})

describe('Explorer + cache: DynamoDB and Redis', () => {
  it('DynamoDB table list comes from the cache', async () => {
    setup({ dy: { [cacheKeys.ddbTables]: E(['Orders', 'Users']) } }, {}, [ddb('dy')])
    await mount()
    fireEvent.click(R('dy').querySelector('.arrow')!)
    await waitFor(() => expect(row('dy/Orders')).toBeTruthy())
    expect(api.dynamo.tables).not.toHaveBeenCalled()
    expect(tip2('dy')).toContain('Loaded from cache 3h ago')
  })

  it('DynamoDB: Refresh asks AWS and stores the new list', async () => {
    setup({ dy: { [cacheKeys.ddbTables]: E(['Orders']) } }, { dynamo: { tables: vi.fn(async () => ['Orders', 'Fresh']) } }, [ddb('dy')])
    await mount()
    fireEvent.click(R('dy').querySelector('.arrow')!)
    await waitFor(() => expect(row('dy/Orders')).toBeTruthy())
    ctx('dy')
    pick('Refresh')
    await waitFor(() => expect(row('dy/Fresh')).toBeTruthy())
    await waitFor(() => expect(fake.entries.get('dy\u0000' + cacheKeys.ddbTables)!.data).toEqual(['Orders', 'Fresh']))
  })

  const KEYS = [{ key: 'a:1', type: 'string' as const }, { key: 'a:2', type: 'string' as const }, { key: 'q', type: 'list' as const }]
  const tree = (over: Partial<RedisKeyTree> = {}): RedisKeyTree => ({ keys: KEYS, complete: true, dbsize: 3, ...over })
  const dbs = { databases: [{ db: 0, keys: 3, expires: 0 }], count: 16, cluster: false }

  it('Redis: the database list and a key tree (compact form) come from the cache with no SCAN', async () => {
    setup({ rd: { [cacheKeys.redisDbs]: E(dbs), [cacheKeys.redisTree(0)]: E(compactKeyTree(tree())) } }, {}, [redis('rd')])
    await mount()
    fireEvent.click(R('rd').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0')).toBeTruthy())
    fireEvent.click(R('rd/db0').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0/strings')).toBeTruthy())
    fireEvent.click(R('rd/db0/strings').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0/strings/d:a:')).toBeTruthy())
    expect(api.redis.databases).not.toHaveBeenCalled()
    expect(api.redis.keyTree).not.toHaveBeenCalled()
    expect(tip2('rd/db0')).toContain('Loaded from cache 3h ago')
  })

  it('Redis: a fresh scan is stored compactly, an incomplete one is not stored', async () => {
    const keyTree = vi.fn(async () => tree())
    setup({}, { redis: { databases: vi.fn(async () => dbs), keyTree } }, [redis('rd')])
    await mount()
    fireEvent.click(R('rd').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0')).toBeTruthy())
    fireEvent.click(R('rd/db0').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0/strings')).toBeTruthy())
    await waitFor(() => expect(fake.entries.has('rd\u0000' + cacheKeys.redisTree(0))).toBe(true))
    expect(fake.entries.get('rd\u0000' + cacheKeys.redisTree(0))!.data).toEqual(compactKeyTree(tree()))

    // a scan that did not finish is shown but never kept
    cleanup()
    keyTree.mockResolvedValue(tree({ complete: false }))
    setup({}, { redis: { databases: vi.fn(async () => dbs), keyTree } }, [redis('rd')])
    await mount()
    fireEvent.click(R('rd').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0')).toBeTruthy())
    fireEvent.click(R('rd/db0').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0/strings')).toBeTruthy())
    await sleep(30)
    expect(fake.entries.has('rd\u0000' + cacheKeys.redisTree(0))).toBe(false)
  })

  it('Redis: a stored tree in a format the app does not understand is rescanned', async () => {
    setup({ rd: { [cacheKeys.redisDbs]: E(dbs), [cacheKeys.redisTree(0)]: E({ nonsense: true }) } }, { redis: { databases: vi.fn(async () => dbs), keyTree: vi.fn(async () => tree()) } }, [redis('rd')])
    await mount()
    fireEvent.click(R('rd').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0')).toBeTruthy())
    fireEvent.click(R('rd/db0').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0/strings')).toBeTruthy())
    expect(api.redis.keyTree).toHaveBeenCalledTimes(1)
  })

  it('Redis: Refresh on a database re-scans it and replaces the stored tree', async () => {
    const keyTree = vi.fn(async () => tree({ keys: [...KEYS, { key: 'zzz', type: 'string' as const }], dbsize: 4 }))
    setup({ rd: { [cacheKeys.redisDbs]: E(dbs), [cacheKeys.redisTree(0)]: E(compactKeyTree(tree())) } }, { redis: { databases: vi.fn(async () => dbs), keyTree } }, [redis('rd')])
    await mount()
    fireEvent.click(R('rd').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0')).toBeTruthy())
    fireEvent.click(R('rd/db0').querySelector('.arrow')!)
    await waitFor(() => expect(row('rd/db0/strings')).toBeTruthy())
    expect(keyTree).not.toHaveBeenCalled()
    ctx('rd/db0')
    pick('Refresh')
    await waitFor(() => expect(keyTree).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((fake.entries.get('rd\u0000' + cacheKeys.redisTree(0))!.data as { types: { string: string[] } }).types.string).toContain('zzz'))
  })
})

describe('Explorer + cache: the ⌘O index follows the explorer', () => {
  it('lists the explorer loads are visible to the index straight away', async () => {
    await mount()
    await openAll()
    const { peekIndex } = await import('../../src/renderer/src/lib/objectCache')
    expect(peekIndex('d1')!.get(cacheKeys.pgDbs)!.data).toEqual(['app', 'other'])
    expect(peekIndex('d1')!.get(cacheKeys.pgTables('app', 'public'))!.data).toEqual([T('users'), T('orders')])
  })

  it('startup priming (primeIndex) gives ⌘O the stored names before any node was expanded', async () => {
    setup(pgStored())
    await primeIndex()
    const { peekIndex } = await import('../../src/renderer/src/lib/objectCache')
    expect([...peekIndex('d1')!.keys()].sort()).toEqual([cacheKeys.pgDbs, cacheKeys.pgSchemas('app'), cacheKeys.pgTables('app', 'public')].sort())
    expect(networkCalls()).toBe(0)
  })
})

describe('Explorer: revealRequest (⌘O on a database)', () => {
  beforeEach(() => setup(pgStored()))

  it('selects the database node and expands it', async () => {
    const r = await mount()
    r.rerender(ui({ revealRequest: { target: 'd1/app', n: 1, expand: true } }))
    await waitFor(() => expect(row('d1/app')).toBeTruthy())
    await waitFor(() => expect(row('d1/app/public')).toBeTruthy())
    expect(selected()).toEqual(['d1/app'])
  })

  it('without `expand` it only reveals and selects', async () => {
    const r = await mount()
    r.rerender(ui({ revealRequest: { target: 'd1/app', n: 1 } }))
    await waitFor(() => expect(row('d1/app')).toBeTruthy())
    await waitFor(() => expect(selected()).toEqual(['d1/app']))
    expect(row('d1/app/public')).toBeNull()
  })

  it('the same request is not applied twice, a new `n` is', async () => {
    const r = await mount()
    const req = { target: 'd1/app', n: 7, expand: true }
    r.rerender(ui({ revealRequest: req }))
    await waitFor(() => expect(row('d1/app/public')).toBeTruthy())
    await waitFor(() => expect(R('d1/app').querySelector('.arrow')).toBeTruthy())
    fireEvent.click(R('d1/app').querySelector('.arrow')!) // the user collapses it
    await waitFor(() => expect(row('d1/app/public')).toBeNull())
    r.rerender(ui({ revealRequest: { ...req } })) // same n: ignored
    await sleep(30)
    expect(row('d1/app/public')).toBeNull()
    r.rerender(ui({ revealRequest: { ...req, n: 8 } }))
    await waitFor(() => expect(row('d1/app/public')).toBeTruthy())
  })

  it('a Redis database node is revealed and expanded as well', async () => {
    const dbs = { databases: [{ db: 0, keys: 1, expires: 0 }, { db: 3, keys: 1, expires: 0 }], count: 16, cluster: false }
    setup({ rd: { [cacheKeys.redisDbs]: E(dbs) } }, {}, [redis('rd')])
    const r = await mount()
    r.rerender(ui({ revealRequest: { target: 'rd/db3', n: 1, expand: true } }))
    await waitFor(() => expect(row('rd/db3')).toBeTruthy())
    await waitFor(() => expect(selected()).toEqual(['rd/db3']))
  })
})
