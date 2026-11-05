// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('../../src/renderer/src/session')
const KEY = 'datagrid:session'

async function load(stored?: unknown): Promise<Mod> {
  localStorage.clear()
  if (stored !== undefined) localStorage.setItem(KEY, JSON.stringify(stored))
  vi.resetModules()
  return import('../../src/renderer/src/session')
}
const flush = (): boolean => window.dispatchEvent(new Event('pagehide'))
const stored = (): Record<string, any> => JSON.parse(localStorage.getItem(KEY)!)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const pgTab = { type: 'table', t: { dsId: 'a', dsName: 'A', database: 'd', schema: 's', table: 't1', kind: 'table' } }
const rTab = { type: 'table', t: { dsId: 'r', dsName: 'R', database: 'db3', schema: '', table: 'db3', kind: 'redis', engine: 'redis', db: 3 } }
const rConsole = { type: 'console', c: { id: 'c9', title: 'R console', dsId: 'r', dsName: 'R', database: 'db3', engine: 'redis', db: 3 } }
const KEYR = 't|redis|r|3'

describe('session with Redis tabs', () => {
  it('Redis tabs and consoles survive a reload with their db index', async () => {
    const m = await load({ v: 1, tabs: [pgTab, rTab, rConsole], active: KEYR })
    expect(m.initialSession.tabs).toEqual([pgTab, rTab, rConsole])
    expect(m.initialSession.active).toBe(KEYR)
    expect(m.tabKey(m.initialSession.tabs[1])).toBe(KEYR)
  })

  it('different databases of one source are different tabs; the same one twice de-duplicates', async () => {
    const other = { type: 'table', t: { ...rTab.t, database: 'db4', table: 'db4', db: 4 } }
    expect((await load({ v: 1, tabs: [rTab, other] })).initialSession.tabs).toHaveLength(2)
    expect((await load({ v: 1, tabs: [rTab, rTab] })).initialSession.tabs).toHaveLength(1)
  })

  it.each([-1, 256, 1.5, '3', null, undefined])('a Redis tab / console with an invalid db (%j) is dropped', async (db) => {
    const m = await load({
      v: 1,
      tabs: [pgTab, { type: 'table', t: { ...rTab.t, db } }, { type: 'console', c: { ...rConsole.c, db } }]
    })
    expect(m.initialSession.tabs).toEqual([pgTab])
  })

  it('a Redis tab never keeps a stray schema / region and the console keeps no schema', async () => {
    const m = await load({
      v: 1,
      tabs: [
        { type: 'table', t: { ...rTab.t, schema: 'x', region: 'r' } },
        { type: 'console', c: { ...rConsole.c, schema: 'x', region: 'r' } }
      ]
    })
    expect(m.initialSession.tabs[0]).toEqual(rTab)
    expect(m.initialSession.tabs[1]).toEqual(rConsole)
  })

  it('saveTabs persists db, console drafts and the pattern / type filter of the key browser', async () => {
    const m = await load()
    m.setConsoleSql('c9', 'GET a')
    m.setTableView(KEYR, { page: 0, pageSize: 100, sort: null, where: 'user:*', orderExpr: 'hash' })
    m.setTableView('t|redis|r|9', { page: 0, pageSize: 100, sort: null, where: 'x', orderExpr: '' })
    m.saveTabs([rTab, rConsole] as never, KEYR)
    flush()
    const s = stored()
    expect(s.tabs[0]).toEqual(rTab)
    expect(s.tabs[1].c).toMatchObject({ engine: 'redis', db: 3 })
    expect(s.consoleSql).toEqual({ c9: 'GET a' })
    expect(Object.keys(s.views)).toEqual([KEYR])
    const again = await load(s)
    expect(again.initialSession.tabs).toHaveLength(2)
    expect(again.getTableView(KEYR)).toMatchObject({ where: 'user:*', orderExpr: 'hash' })
  })

  it('sessions saved before Redis support load unchanged', async () => {
    const m = await load({ v: 1, tabs: [pgTab], active: 't|a|d|s|t1' })
    expect(m.initialSession.tabs).toEqual([pgTab])
  })
})

describe('session with Redis key tabs', () => {
  const kTab = { type: 'table', t: { dsId: 'r', dsName: 'R', database: 'db3', schema: '', table: 'user:42:name', kind: 'redis', engine: 'redis', db: 3, redisKey: 'user:42:name' } }
  const KEYK = 't|rkey|r|3|user:42:name'

  it('a key tab survives a reload (data source, db and key), next to the key browser of the same db', async () => {
    const m = await load({ v: 1, tabs: [rTab, kTab], active: KEYK })
    expect(m.initialSession.tabs).toEqual([rTab, kTab])
    expect(m.initialSession.active).toBe(KEYK)
    expect(m.tabKey(m.initialSession.tabs[1])).toBe(KEYK)
  })

  it('different keys / dbs are different tabs; the same one twice de-duplicates', async () => {
    const other = { type: 'table', t: { ...kTab.t, table: 'z', redisKey: 'z' } }
    const otherDb = { type: 'table', t: { ...kTab.t, database: 'db4', db: 4 } }
    expect((await load({ v: 1, tabs: [kTab, other, otherDb] })).initialSession.tabs).toHaveLength(3)
    expect((await load({ v: 1, tabs: [kTab, kTab] })).initialSession.tabs).toHaveLength(1)
  })

  it.each([-1, 256, 1.5, '3', null, undefined])('a key tab with an invalid db (%j) is dropped', async (db) => {
    const m = await load({ v: 1, tabs: [rTab, { type: 'table', t: { ...kTab.t, db } }] })
    expect(m.initialSession.tabs).toEqual([rTab])
  })

  it('keys with odd characters round-trip (unicode, separators, binary names)', async () => {
    const keys = ['用户:名 😀', 'a|b/c', '', '\u0000b64:/wBB']
    const tabs = keys.map((k) => ({ type: 'table', t: { ...kTab.t, table: k, redisKey: k } }))
    const m = await load({ v: 1, tabs: tabs.filter((t) => t.t.redisKey !== '') })
    expect(m.initialSession.tabs.map((t) => (t as { t: { redisKey: string } }).t.redisKey)).toEqual(keys.filter(Boolean))
  })

  it('an empty / non-text redisKey makes it a key BROWSER tab again (never a key tab with no key)', async () => {
    const m = await load({ v: 1, tabs: [{ type: 'table', t: { ...kTab.t, redisKey: '' } }, { type: 'table', t: { ...kTab.t, table: 'db4', database: 'db4', db: 4, redisKey: 5 } }] })
    expect(m.initialSession.tabs.every((t) => !('redisKey' in (t as { t: object }).t))).toBe(true)
  })

  it('saveTabs keeps key tabs, and never stores the one-off key-browser prefill from the tree', async () => {
    const m = await load()
    const filtered = { type: 'table', t: { ...rTab.t, redisFilter: { pattern: 'user:*', type: 'string', n: 1 } } }
    m.saveTabs([kTab, filtered] as never, KEYK)
    flush()
    const s = stored()
    expect(s.tabs[0]).toEqual(kTab)
    expect(JSON.stringify(s)).not.toContain('redisFilter')
    const again = await load(s)
    expect(again.initialSession.tabs).toEqual([kTab, rTab])
  })

  it('closing a key tab drops nothing else (view state of the browser stays)', async () => {
    const m = await load()
    m.setTableView(KEYR, { page: 0, pageSize: 100, sort: null, where: 'a*', orderExpr: '' })
    m.saveTabs([rTab, kTab] as never, KEYK)
    m.saveTabs([rTab] as never, KEYR)
    flush()
    expect(Object.keys(stored().views)).toEqual([KEYR])
  })
})
