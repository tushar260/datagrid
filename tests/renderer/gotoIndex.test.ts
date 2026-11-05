// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RECENT_KEY, RECENT_MAX, buildGotoEntries, databaseNodeId, entrySuffix, indexSources, isIndexed, loadRecent, recentEntries, recordOpenedTable, recordRecent,
  tableRefOf, unindexed, type GotoEntry
} from '../../src/renderer/src/lib/gotoIndex'
import { peekIndex, resetObjectCache } from '../../src/renderer/src/lib/objectCache'
import { cacheKeys, type CacheEntry, type DataSource } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

type Store = Record<string, Record<string, unknown>> // dsId -> key -> data
const peekOf = (s: Store) => (id: string): ReadonlyMap<string, CacheEntry> | undefined =>
  s[id] ? new Map(Object.entries(s[id]).map(([k, data]) => [k, { at: 1, data }])) : undefined
const T = (name: string, kind = 'table'): { name: string; kind: string } => ({ name, kind })

const pg = (id = 'pg', o: Partial<DataSource> = {}): DataSource => ({ id, name: id.toUpperCase(), host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false, ...o })
const ddb = (id = 'dy', o: Partial<DataSource> = {}): DataSource => ({ ...pg(id, { kind: 'dynamodb', host: '', port: 0, user: '', database: '' }), dynamo: { region: 'eu-west-1', authMode: 'default' }, ...o })
const rd = (id = 'rd'): DataSource => ({ ...pg(id, { kind: 'redis', host: '', port: 0, user: '', database: '' }), redis: { host: 'localhost', port: 6379, db: 0, tls: false } })

const pgStore = (extra: Store[string] = {}): Store => ({
  pg: {
    [cacheKeys.pgDbs]: ['app', 'other'],
    [cacheKeys.pgSchemas('app')]: ['public', 'information_schema', 'pg_catalog', 'sales'],
    [cacheKeys.pgSchemas('other')]: ['public'],
    [cacheKeys.pgTables('app', 'public')]: [T('users'), T('v_users', 'view'), T('mv', 'matview')],
    [cacheKeys.pgTables('app', 'information_schema')]: [T('columns')],
    [cacheKeys.pgTables('app', 'pg_catalog')]: [T('pg_class')],
    [cacheKeys.pgTables('app', 'sales')]: [T('orders'), T('ft', 'foreign')],
    [cacheKeys.pgTables('other', 'public')]: [T('things')],
    ...extra
  }
})
const names = (es: GotoEntry[]): string[] => es.map((e) => e.name)

beforeEach(() => localStorage.clear())

describe('buildGotoEntries: PostgreSQL', () => {
  it('lists databases and tables / views / matviews / foreign tables, system schemas hidden', () => {
    const es = buildGotoEntries([pg()], peekOf(pgStore()))
    expect(names(es).sort()).toEqual(['app', 'ft', 'mv', 'orders', 'other', 'things', 'users', 'v_users'])
    const by = (n: string): GotoEntry => es.find((e) => e.name === n)!
    expect(by('app')).toMatchObject({ kind: 'database', engine: 'postgres', database: 'app', dsId: 'pg', dsName: 'PG' })
    expect(by('users')).toMatchObject({ kind: 'table', database: 'app', schema: 'public' })
    expect(by('v_users').kind).toBe('view')
    expect(by('mv').kind).toBe('matview')
    expect(by('ft').kind).toBe('foreign')
    expect(by('orders')).toMatchObject({ schema: 'sales', database: 'app' })
    expect(by('things')).toMatchObject({ schema: 'public', database: 'other' })
  })

  it('names are the only matched text; `lower` is precomputed', () => {
    const e = buildGotoEntries([pg('pg', { name: 'Production' })], peekOf(pgStore())).find((x) => x.name === 'users')!
    expect(e.lower).toBe('users')
    expect(e.name).toBe('users')
    expect(e.id).toBeTruthy()
  })

  it('ids are unique even for the same table name in two schemas / databases / sources', () => {
    const store = pgStore({ [cacheKeys.pgTables('other', 'public')]: [T('users')], [cacheKeys.pgTables('app', 'sales')]: [T('users')] })
    store.pg2 = store.pg
    const es = buildGotoEntries([pg('pg'), pg('pg2')], peekOf(store))
    expect(new Set(es.map((e) => e.id)).size).toBe(es.length)
  })

  it('honours visible databases', () => {
    const es = buildGotoEntries([pg('pg', { visibleDbs: ['other'] })], peekOf(pgStore()))
    expect(names(es).sort()).toEqual(['other', 'things'])
  })

  it('honours a saved schema filter (it replaces the system-schema default, like the explorer)', () => {
    const only = buildGotoEntries([pg('pg', { schemaFilter: { app: ['sales'] } })], peekOf(pgStore()))
    expect(names(only).filter((n) => !['app', 'other', 'things'].includes(n)).sort()).toEqual(['ft', 'orders'])
    const withSys = buildGotoEntries([pg('pg', { schemaFilter: { app: ['public', 'information_schema'] } })], peekOf(pgStore()))
    expect(names(withSys)).toContain('columns')
    expect(names(withSys)).not.toContain('pg_class')
    expect(names(withSys)).not.toContain('orders')
  })

  it('honours table filters (list and rule) per database/schema', () => {
    const list = buildGotoEntries([pg('pg', { tableFilter: { 'app/public': { list: ['users'] } } })], peekOf(pgStore()))
    expect(names(list)).toContain('users')
    expect(names(list)).not.toContain('v_users')
    expect(names(list)).toContain('orders') // other schemas unaffected
    const rule = buildGotoEntries([pg('pg', { tableFilter: { 'app/sales': { rule: { mode: 'starts', pattern: 'or' } } } })], peekOf(pgStore()))
    expect(names(rule)).toContain('orders')
    expect(names(rule)).not.toContain('ft')
  })

  it('a database whose schemas were never loaded still appears (it can be selected), without tables', () => {
    const es = buildGotoEntries([pg()], peekOf({ pg: { [cacheKeys.pgDbs]: ['a', 'b'], [cacheKeys.pgSchemas('a')]: ['public'] } }))
    expect(names(es)).toEqual(['a', 'b'])
  })

  it('a schema whose tables were never loaded contributes nothing', () => {
    const es = buildGotoEntries([pg()], peekOf({ pg: { [cacheKeys.pgDbs]: ['a'], [cacheKeys.pgSchemas('a')]: ['public', 'x'], [cacheKeys.pgTables('a', 'x')]: [T('t')] } }))
    expect(names(es)).toEqual(['a', 't'])
  })

  it('no database list -> nothing for that source', () => {
    expect(buildGotoEntries([pg()], peekOf({ pg: { [cacheKeys.pgSchemas('a')]: ['public'] } }))).toEqual([])
    expect(buildGotoEntries([pg()], () => undefined)).toEqual([])
  })

  it('ignores malformed cache contents instead of throwing', () => {
    const bad = pgStore({ [cacheKeys.pgTables('app', 'sales')]: 'oops', [cacheKeys.pgSchemas('other')]: { x: 1 } })
    expect(() => buildGotoEntries([pg()], peekOf(bad))).not.toThrow()
    expect(buildGotoEntries([pg()], peekOf({ pg: { [cacheKeys.pgDbs]: [1, 2] } }))).toEqual([])
    expect(buildGotoEntries([pg()], peekOf({ pg: { [cacheKeys.pgDbs]: ['a'], [cacheKeys.pgSchemas('a')]: ['public'], [cacheKeys.pgTables('a', 'public')]: [null] } }))).toHaveLength(1)
  })

  it('a missing kind is a table', () => {
    const es = buildGotoEntries([pg()], peekOf({ pg: { [cacheKeys.pgDbs]: ['a'], [cacheKeys.pgSchemas('a')]: ['public'], [cacheKeys.pgTables('a', 'public')]: [{ name: 't' }] } }))
    expect(es.find((e) => e.name === 't')!.kind).toBe('table')
  })
})

describe('buildGotoEntries: DynamoDB, Redis, mixed', () => {
  it('DynamoDB tables (table filter applied), with the region', () => {
    const store = { dy: { [cacheKeys.ddbTables]: ['Orders', 'Users', 'audit'] } }
    const all = buildGotoEntries([ddb()], peekOf(store))
    expect(names(all)).toEqual(['Orders', 'Users', 'audit'])
    expect(all[0]).toMatchObject({ engine: 'dynamodb', kind: 'table', region: 'eu-west-1' })
    const filtered = buildGotoEntries([ddb('dy', { tableFilter: { dynamodb: { list: ['Users'] } } })], peekOf(store))
    expect(names(filtered)).toEqual(['Users'])
  })

  it('Redis databases are db0, db1... (named by index, never keys)', () => {
    const store = { rd: { [cacheKeys.redisDbs]: { databases: [{ db: 0, keys: 5, expires: 0 }, { db: 3, keys: 1, expires: 0 }], count: 16, cluster: false } } }
    const es = buildGotoEntries([rd()], peekOf(store))
    expect(names(es)).toEqual(['db0', 'db3'])
    expect(es[1]).toMatchObject({ engine: 'redis', kind: 'database', db: 3 })
    expect(buildGotoEntries([rd()], peekOf({ rd: { [cacheKeys.redisDbs]: { nope: 1 } } }))).toEqual([])
  })

  it('all kinds side by side, in the order of the sources', () => {
    const store: Store = {
      ...pgStore(),
      dy: { [cacheKeys.ddbTables]: ['Orders'] },
      rd: { [cacheKeys.redisDbs]: { databases: [{ db: 0, keys: 1, expires: 0 }], count: 16, cluster: false } }
    }
    const es = buildGotoEntries([rd(), pg(), ddb()], peekOf(store))
    expect(es[0].dsId).toBe('rd')
    expect(es.at(-1)!.dsId).toBe('dy')
    expect(new Set(es.map((e) => e.engine))).toEqual(new Set(['redis', 'postgres', 'dynamodb']))
  })

  it('a source nobody loaded yet is simply absent', () => {
    expect(buildGotoEntries([pg('x'), ddb('y'), rd('z')], () => undefined)).toEqual([])
  })
})

describe('entrySuffix / tableRefOf / databaseNodeId', () => {
  const es = buildGotoEntries([pg('pg', { name: 'prod-pg' }), ddb('dy', { name: 'Dyn' }), rd('rd')], peekOf({
    ...pgStore(),
    dy: { [cacheKeys.ddbTables]: ['Orders'] },
    rd: { [cacheKeys.redisDbs]: { databases: [{ db: 2, keys: 1, expires: 0 }], count: null, cluster: false } }
  }))
  const by = (n: string): GotoEntry => es.find((e) => e.name === n)!
  it('kind, then database.schema for PostgreSQL tables, then [data source]', () => {
    expect(entrySuffix(by('users'))).toBe('table app.public [prod-pg]')
    expect(entrySuffix(by('v_users'))).toBe('view app.public [prod-pg]')
    expect(entrySuffix(by('app'))).toBe('database [prod-pg]')
    expect(entrySuffix(by('Orders'))).toBe('table [Dyn]')
    expect(entrySuffix(by('db2'))).toBe('database [RD]')
  })
  it('a table opens the same tab the explorer would open', () => {
    expect(tableRefOf(by('users'))).toEqual({ dsId: 'pg', dsName: 'prod-pg', database: 'app', schema: 'public', table: 'users', kind: 'table' })
    expect(tableRefOf(by('v_users')).kind).toBe('view')
    expect(tableRefOf(by('Orders'))).toEqual({ dsId: 'dy', dsName: 'Dyn', database: '', schema: '', table: 'Orders', kind: 'table', engine: 'dynamodb', region: 'eu-west-1' })
  })
  it('a database entry is revealed at the explorer node of that database', () => {
    expect(databaseNodeId(by('app'))).toBe('pg/app')
    expect(databaseNodeId(by('db2'))).toBe('rd/db2')
  })
})

describe('isIndexed / unindexed', () => {
  it('PostgreSQL is indexed when databases, every shown schema and its tables are known', () => {
    expect(isIndexed(pg(), peekOf(pgStore())(('pg')))).toBe(true)
    expect(isIndexed(pg(), undefined)).toBe(false)
    const s = pgStore()
    delete s.pg[cacheKeys.pgTables('other', 'public')]
    expect(isIndexed(pg(), peekOf(s)('pg'))).toBe(false)
    const t = pgStore()
    delete t.pg[cacheKeys.pgSchemas('other')]
    expect(isIndexed(pg(), peekOf(t)('pg'))).toBe(false)
    const u = pgStore()
    delete u.pg[cacheKeys.pgDbs]
    expect(isIndexed(pg(), peekOf(u)('pg'))).toBe(false)
  })
  it('system schemas, hidden databases and filtered-out schemas do not have to be loaded', () => {
    const s = pgStore()
    delete s.pg[cacheKeys.pgTables('app', 'information_schema')]
    expect(isIndexed(pg(), peekOf(s)('pg'))).toBe(true)
    const h = pgStore()
    delete h.pg[cacheKeys.pgSchemas('other')]
    expect(isIndexed(pg('pg', { visibleDbs: ['app'] }), peekOf(h)('pg'))).toBe(true)
    const f = pgStore()
    delete f.pg[cacheKeys.pgTables('app', 'sales')]
    expect(isIndexed(pg('pg', { schemaFilter: { app: ['public'] } }), peekOf(f)('pg'))).toBe(true)
  })
  it('DynamoDB needs the table list; Redis needs the database list (keys are never indexed)', () => {
    expect(isIndexed(ddb(), peekOf({ dy: {} })('dy'))).toBe(false)
    expect(isIndexed(ddb(), peekOf({ dy: { [cacheKeys.ddbTables]: [] } })('dy'))).toBe(true)
    expect(isIndexed(rd(), peekOf({ rd: {} })('rd'))).toBe(false)
    expect(isIndexed(rd(), peekOf({ rd: { [cacheKeys.redisDbs]: { databases: [], count: null, cluster: false } } })('rd'))).toBe(true)
  })
  it('unindexed() is what the footer offers to index', () => {
    const peek = peekOf({ ...pgStore(), rd: { [cacheKeys.redisDbs]: { databases: [], count: 1, cluster: false } } })
    expect(unindexed([pg(), ddb(), rd()], peek).map((d) => d.id)).toEqual(['dy'])
  })
})

describe('recent list (empty query)', () => {
  const R = (name: string, o: Partial<Parameters<typeof recordRecent>[0]> = {}): Parameters<typeof recordRecent>[0] => ({
    dsId: 'pg', engine: 'postgres', kind: 'table', name, database: 'app', schema: 'public', ...o
  })
  it('most recent first, no duplicates, persisted in localStorage', () => {
    recordRecent(R('a'))
    recordRecent(R('b'))
    recordRecent(R('a'))
    expect(loadRecent().map((r) => r.name)).toEqual(['a', 'b'])
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toHaveLength(2)
    expect(RECENT_KEY).toBe('datagrip-lite:goto-recent')
  })
  it('the same name in another schema / database / source is another entry', () => {
    recordRecent(R('a'))
    recordRecent(R('a', { schema: 'x' }))
    recordRecent(R('a', { database: 'other' }))
    recordRecent(R('a', { dsId: 'pg2' }))
    expect(loadRecent()).toHaveLength(4)
  })
  it('keeps at most ' + RECENT_MAX, () => {
    for (let i = 0; i < RECENT_MAX + 7; i++) recordRecent(R('t' + i))
    const l = loadRecent()
    expect(l).toHaveLength(RECENT_MAX)
    expect(l[0].name).toBe('t' + (RECENT_MAX + 6))
  })
  it('survives garbage in localStorage', () => {
    localStorage.setItem(RECENT_KEY, '{nope')
    expect(loadRecent()).toEqual([])
    localStorage.setItem(RECENT_KEY, '{"a":1}')
    expect(loadRecent()).toEqual([])
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ dsId: 'x' }, null, 5, { dsId: 'pg', name: 'ok', engine: 'postgres', kind: 'table' }, { dsId: 'pg', name: 'bad', engine: 'mysql', kind: 'table' }]))
    expect(loadRecent().map((r) => r.name)).toEqual(['ok'])
    recordRecent(R('new'))
    expect(loadRecent().map((r) => r.name)).toEqual(['new', 'ok'])
  })
  it('recentEntries() skips removed data sources and carries the current source name', () => {
    recordRecent(R('a'))
    recordRecent(R('gone', { dsId: 'removed' }))
    recordRecent(R('Orders', { dsId: 'dy', engine: 'dynamodb', schema: undefined, database: undefined, region: 'eu-west-1' }))
    const es = recentEntries([pg('pg', { name: 'Renamed' }), ddb('dy')])
    expect(names(es)).toEqual(['Orders', 'a'])
    expect(es[1].dsName).toBe('Renamed')
    expect(es[0]).toMatchObject({ engine: 'dynamodb', region: 'eu-west-1' })
  })
  it('recordOpenedTable(): PostgreSQL and DynamoDB tables are remembered, Redis tabs are not', () => {
    recordOpenedTable({ dsId: 'pg', dsName: 'P', database: 'app', schema: 'public', table: 'users', kind: 'view' })
    recordOpenedTable({ dsId: 'dy', dsName: 'D', database: '', schema: '', table: 'Orders', kind: 'table', engine: 'dynamodb', region: 'eu-west-1' })
    recordOpenedTable({ dsId: 'rd', dsName: 'R', database: 'db0', schema: '', table: 'db0', kind: 'redis', engine: 'redis', db: 0 })
    const l = loadRecent()
    expect(l.map((r) => r.name)).toEqual(['Orders', 'users'])
    expect(l[1]).toMatchObject({ kind: 'view', database: 'app', schema: 'public', engine: 'postgres' })
    expect(l[0]).toMatchObject({ engine: 'dynamodb', region: 'eu-west-1' })
  })
  it('a full localStorage does not throw', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => recordRecent(R('a'))).not.toThrow()
    spy.mockRestore()
  })
})

describe('indexSources', () => {
  let api: MockApi
  const sig = { aborted: false }
  beforeEach(() => {
    sig.aborted = false
    api = installApi({ cache: undefined })
    resetObjectCache()
  })
  afterEach(() => vi.useRealTimers())
  const peek = (id: string): ReadonlyMap<string, CacheEntry> | undefined => peekIndex(id)

  it('PostgreSQL: databases, schemas, then one tablesAll per database; the lists land under the explorer\'s keys', async () => {
    api.databases.mockResolvedValue(['app', 'other'])
    api.schemasAll.mockImplementation(async (_d: string, db: string) => (db === 'app' ? ['public', 'information_schema', 'sales'] : ['public']))
    api.tablesAll.mockImplementation(async (_d: string, db: string) =>
      db === 'app' ? { public: [T('users')], sales: [T('orders')], information_schema: [T('columns')] } : { public: [T('things')] }
    )
    await indexSources([pg()], peek, { signal: sig })
    expect(api.tablesAll).toHaveBeenCalledTimes(2) // one query per database, not per schema
    expect(api.tables).not.toHaveBeenCalled()
    const es = buildGotoEntries([pg()], peek)
    expect(names(es).sort()).toEqual(['app', 'orders', 'other', 'things', 'users'])
    expect(isIndexed(pg(), peek('pg'))).toBe(true)
  })

  it('a schema without tables is stored as empty (so the source counts as indexed)', async () => {
    api.databases.mockResolvedValue(['app'])
    api.schemasAll.mockResolvedValue(['public', 'empty'])
    api.tablesAll.mockResolvedValue({ public: [T('t')] })
    await indexSources([pg()], peek, { signal: sig })
    expect(isIndexed(pg(), peek('pg'))).toBe(true)
  })

  it('does not refetch what is already known; honours visible databases', async () => {
    api.databases.mockResolvedValue(['app', 'other', 'hidden'])
    api.schemasAll.mockResolvedValue(['public'])
    api.tablesAll.mockResolvedValue({ public: [T('t')] })
    await indexSources([pg('pg', { visibleDbs: ['app', 'other'] })], peek, { signal: sig })
    expect(api.schemasAll).toHaveBeenCalledTimes(2)
    expect(api.schemasAll.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(['app', 'other'])
    api.tablesAll.mockClear()
    api.schemasAll.mockClear()
    await indexSources([pg('pg', { visibleDbs: ['app', 'other'] })], peek, { signal: sig })
    expect(api.tablesAll).not.toHaveBeenCalled()
  })

  it('DynamoDB and Redis need one call each', async () => {
    api.dynamo.tables.mockResolvedValue(['A', 'B'])
    api.redis.databases.mockResolvedValue({ databases: [{ db: 0, keys: 1, expires: 0 }], count: 16, cluster: false })
    await indexSources([ddb(), rd()], peek, { signal: sig })
    expect(names(buildGotoEntries([ddb(), rd()], peek))).toEqual(['A', 'B', 'db0'])
    expect(api.redis.keyTree).not.toHaveBeenCalled() // never keys
    expect(api.redis.scan).not.toHaveBeenCalled()
  })

  it('at most 3 data sources at a time (default), or the given concurrency', async () => {
    let live = 0
    let max = 0
    api.dynamo.tables.mockImplementation(async () => {
      live++
      max = Math.max(max, live)
      await new Promise((r) => setTimeout(r, 15))
      live--
      return ['t']
    })
    const many = Array.from({ length: 9 }, (_, i) => ddb('d' + i))
    await indexSources(many, peek, { signal: sig })
    expect(max).toBe(3)
    expect(api.dynamo.tables).toHaveBeenCalledTimes(9)
    max = 0
    await indexSources(many.map((d) => ({ ...d, id: d.id + 'x' })), peek, { signal: sig, concurrency: 1 })
    expect(max).toBe(1)
  })

  it('reports progress: 0/N, then one step per finished source', async () => {
    api.dynamo.tables.mockResolvedValue(['t'])
    const seen: string[] = []
    await indexSources([ddb('a'), ddb('b'), ddb('c')], peek, { signal: sig, concurrency: 1, onProgress: (p) => seen.push(`${p.done}/${p.total}`) })
    expect(seen).toEqual(['0/3', '1/3', '2/3', '3/3'])
  })

  it('one failing source does not stop the others; its message is reported without the IPC prefix', async () => {
    api.dynamo.tables.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error("Error invoking remote method 'dynamo:tables': Error: Could not connect to the endpoint URL")
      return ['ok']
    })
    const errors: [string, string][] = []
    const progress: number[] = []
    await indexSources([ddb('bad'), ddb('good')], peek, { signal: sig, onError: (d, m) => errors.push([d.id, m]), onProgress: (p) => progress.push(p.done) })
    expect(errors).toEqual([['bad', 'Could not connect to the endpoint URL']])
    expect(names(buildGotoEntries([ddb('good')], peek))).toEqual(['ok'])
    expect(progress.at(-1)).toBe(2) // failed sources count as processed
    expect(peek('bad')).toBeUndefined() // nothing cached for the failure
  })

  it('a PostgreSQL source where every database fails is an error; where only some fail it is not', async () => {
    api.databases.mockResolvedValue(['a', 'b'])
    api.schemasAll.mockImplementation(async (_i: string, db: string) => {
      if (db === 'a') throw new Error('permission denied')
      return ['public']
    })
    api.tablesAll.mockResolvedValue({ public: [T('t')] })
    const errors: string[] = []
    await indexSources([pg()], peek, { signal: sig, onError: (_d, m) => errors.push(m) })
    expect(errors).toEqual([]) // b worked
    expect(names(buildGotoEntries([pg()], peek)).sort()).toEqual(['a', 'b', 't'])
    resetObjectCache()
    api.schemasAll.mockRejectedValue(new Error('permission denied'))
    await indexSources([pg()], peek, { signal: sig, onError: (_d, m) => errors.push(m) })
    expect(errors).toEqual(['permission denied'])
  })

  it('a hung source is given up on after the timeout; the rest continues', async () => {
    vi.useFakeTimers()
    api.dynamo.tables.mockImplementation((id: string) => (id === 'hang' ? new Promise(() => undefined) : Promise.resolve(['t'])))
    const errors: string[] = []
    const run = indexSources([ddb('hang'), ddb('fine')], peek, { signal: sig, timeoutMs: 1000, onError: (d, m) => errors.push(d.id + ': ' + m) })
    await vi.advanceTimersByTimeAsync(1500)
    await run
    expect(errors).toEqual(['hang: Listing tables timed out'])
    expect(names(buildGotoEntries([ddb('fine')], peek))).toEqual(['t'])
  })

  it('aborting stops new work (closing the modal cancels indexing)', async () => {
    const started: string[] = []
    api.dynamo.tables.mockImplementation(async (id: string) => {
      started.push(id)
      await new Promise((r) => setTimeout(r, 10))
      return ['t']
    })
    const s = { aborted: false }
    const run = indexSources([ddb('a'), ddb('b'), ddb('c'), ddb('d')], peek, { signal: s, concurrency: 1 })
    await new Promise((r) => setTimeout(r, 5))
    s.aborted = true
    await run
    expect(started).toEqual(['a'])
  })

  it('aborting mid-way through a PostgreSQL source skips its remaining databases', async () => {
    const s = { aborted: false }
    api.databases.mockResolvedValue(['a', 'b', 'c'])
    api.schemasAll.mockImplementation(async () => {
      s.aborted = true
      return ['public']
    })
    api.tablesAll.mockResolvedValue({ public: [] })
    await indexSources([pg()], peek, { signal: s })
    expect(api.schemasAll).toHaveBeenCalledTimes(1)
  })

  it('no sources: resolves, reports 0/0', async () => {
    const seen: string[] = []
    await indexSources([], peek, { signal: sig, onProgress: (p) => seen.push(`${p.done}/${p.total}`) })
    expect(seen).toEqual(['0/0'])
  })
})
