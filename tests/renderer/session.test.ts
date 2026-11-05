// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('../../src/renderer/src/session')
const KEY = 'datagrid:session'

/** session.ts reads localStorage at import time, so each test imports a fresh copy. */
async function load(stored?: unknown): Promise<Mod> {
  localStorage.clear()
  if (stored !== undefined) localStorage.setItem(KEY, typeof stored === 'string' ? stored : JSON.stringify(stored))
  vi.resetModules()
  return import('../../src/renderer/src/session')
}
const stored = (): Record<string, any> => JSON.parse(localStorage.getItem(KEY)!)
const flush = (): boolean => window.dispatchEvent(new Event('pagehide'))

const table = (dsId = 'a', t = 't1'): any => ({
  type: 'table', t: { dsId, dsName: 'A', database: 'd', schema: 's', table: t, kind: 'table' }
})
const cons = (id = 'c1', dsId = 'a'): any => ({ type: 'console', c: { id, title: 'console', dsId, dsName: 'A', database: 'd' } })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('defaults and corrupt data', () => {
  const defaults = {
    v: 1, tabs: [], active: null, width: 300, sidebarHidden: false, consoleN: 0, consoleSql: {}, views: {}, expanded: [], folders: []
  }

  it('starts empty when nothing is stored', async () => {
    expect((await load()).initialSession).toEqual(defaults)
  })

  it.each([
    ['not json', '{oops'],
    ['json null', 'null'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['a number', '5'],
    ['version mismatch (old)', { v: 0, tabs: [table()] }],
    ['version mismatch (future)', { v: 2, tabs: [table()] }],
    ['missing version', { tabs: [table()] }]
  ])('falls back to defaults on %s', async (_n, raw) => {
    expect((await load(raw)).initialSession).toEqual(defaults)
  })

  it('falls back to defaults when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.resetModules()
    expect((await import('../../src/renderer/src/session')).initialSession.tabs).toEqual([])
  })
})

describe('loading (validation / sanitising)', () => {
  it('restores a valid session', async () => {
    const m = await load({
      v: 1, tabs: [table(), cons()], active: 't|a|d|s|t1', width: 420, sidebarHidden: true, consoleN: 3,
      consoleSql: { c1: 'select 1' },
      views: { 't|a|d|s|t1': { page: 2, pageSize: 100, offset: 250, sort: { column: 'id', desc: true }, where: 'id > 1', orderExpr: 'id desc' } },
      expanded: ['a', 'a/d'], folders: ['f1']
    })
    const s = m.initialSession
    expect(s.tabs).toHaveLength(2)
    expect(s).toMatchObject({ active: 't|a|d|s|t1', width: 420, sidebarHidden: true, consoleN: 3, expanded: ['a', 'a/d'], folders: ['f1'] })
    expect(s.consoleSql).toEqual({ c1: 'select 1' })
    expect(s.views['t|a|d|s|t1']).toEqual({ page: 2, pageSize: 100, offset: 250, sort: { column: 'id', desc: true }, where: 'id > 1', orderExpr: 'id desc' })
  })

  it('drops malformed tabs and de-duplicates by key', async () => {
    const bad = { type: 'table', t: { dsId: 'a' } }
    const { initialSession: s } = await load({
      v: 1, tabs: [table(), bad, null, 5, { type: 'x' }, table(), cons(), { type: 'console', c: { id: 1 } }]
    })
    expect(s.tabs.map((x: any) => (x.type === 'table' ? x.t.table : x.c.id))).toEqual(['t1', 'c1'])
  })

  it('only keeps `active` when it names a restored tab', async () => {
    expect((await load({ v: 1, tabs: [table()], active: 'nope' })).initialSession.active).toBeNull()
    expect((await load({ v: 1, tabs: [], active: 't|a|d|s|t1' })).initialSession.active).toBeNull()
    expect((await load({ v: 1, tabs: [table()], active: 5 })).initialSession.active).toBeNull()
    expect((await load({ v: 1, tabs: [table(), cons()], active: 'c|c1' })).initialSession.active).toBe('c|c1')
  })

  it.each([
    [100, 180], [5000, 700], [-1, 180], [250, 250], [180, 180], [700, 700]
  ])('clamps sidebar width %i -> %i', async (w, out) => {
    expect((await load({ v: 1, width: w })).initialSession.width).toBe(out)
  })

  it.each(['300', null, NaN, {}])('ignores non-numeric width %j', async (w) => {
    expect((await load({ v: 1, width: w })).initialSession.width).toBe(300)
  })

  it('only accepts non-negative integer consoleN and strict-true sidebarHidden', async () => {
    expect((await load({ v: 1, consoleN: 1.5, sidebarHidden: 'yes' })).initialSession).toMatchObject({ consoleN: 0, sidebarHidden: false })
    expect((await load({ v: 1, consoleN: -2 })).initialSession.consoleN).toBe(0)
  })

  it('filters non-string values from lists / console drafts', async () => {
    const { initialSession: s } = await load({ v: 1, expanded: ['a', 1, null, 'b'], folders: 'nope', consoleSql: { a: 'x', b: 5 } })
    expect(s.expanded).toEqual(['a', 'b'])
    expect(s.folders).toEqual([])
    expect(s.consoleSql).toEqual({ a: 'x' })
  })

  it('validates per-table view state', async () => {
    const { initialSession: s } = await load({
      v: 1,
      views: {
        ok: { page: 0, pageSize: 50, sort: null, where: 5, orderExpr: undefined },
        zeroSize: { page: 0, pageSize: 0, sort: null },
        negPage: { page: -1, pageSize: 50 },
        floatPage: { page: 1.5, pageSize: 50 },
        notObj: 'x',
        badSort: { page: 0, pageSize: 10, sort: { column: 1, desc: true }, offset: -5 }
      }
    })
    expect(Object.keys(s.views).sort()).toEqual(['badSort', 'ok'])
    expect(s.views.ok).toEqual({ page: 0, pageSize: 50, offset: undefined, sort: null, where: '', orderExpr: '' })
    expect(s.views.badSort.sort).toBeNull()
    expect(s.views.badSort.offset).toBeUndefined()
  })
})

describe('keys', () => {
  it('table / console / tab keys', async () => {
    const m = await load()
    expect(m.tableKey(table().t)).toBe('t|a|d|s|t1')
    expect(m.consoleKey({ id: 'x' })).toBe('c|x')
    expect(m.tabKey(table())).toBe('t|a|d|s|t1')
    expect(m.tabKey(cons('z'))).toBe('c|z')
  })
})

describe('saving', () => {
  it('writes are debounced (300ms) and flushed on pagehide', async () => {
    const m = await load()
    m.patchSession({ width: 333 })
    m.patchSession({ sidebarHidden: true })
    expect(localStorage.getItem(KEY)).toBeNull()
    vi.advanceTimersByTime(299)
    expect(localStorage.getItem(KEY)).toBeNull()
    vi.advanceTimersByTime(2)
    expect(stored()).toMatchObject({ v: 1, width: 333, sidebarHidden: true })

    m.patchSession({ width: 400 })
    flush()
    expect(stored().width).toBe(400)
    vi.advanceTimersByTime(1000) // nothing further pending
    expect(stored().width).toBe(400)
  })

  it('save -> load roundtrip', async () => {
    const m = await load()
    m.saveTabs([table(), cons('c1')], 'c|c1')
    m.setConsoleSql('c1', 'select now()')
    m.setTableView('t|a|d|s|t1', { page: 1, pageSize: 100, offset: 100, sort: { column: 'id', desc: false }, where: 'x', orderExpr: '' })
    m.patchSession({ width: 350, consoleN: 2, expanded: ['a'], folders: ['f'] })
    flush()
    const raw = localStorage.getItem(KEY)!

    const m2 = await load(raw)
    const s = m2.initialSession
    expect(s.tabs).toHaveLength(2)
    expect(s.active).toBe('c|c1')
    expect(s.consoleSql).toEqual({ c1: 'select now()' })
    expect(m2.getTableView('t|a|d|s|t1')).toMatchObject({ page: 1, pageSize: 100, offset: 100, where: 'x' })
    expect(s).toMatchObject({ width: 350, consoleN: 2, expanded: ['a'], folders: ['f'] })
  })

  it('saveTabs prunes console drafts and table views of closed tabs and strips SQL from the tab record', async () => {
    const m = await load()
    m.saveTabs([table(), cons('c1'), cons('c2')], null)
    m.setConsoleSql('c1', 'one')
    m.setConsoleSql('c2', 'two')
    m.setTableView('t|a|d|s|t1', { page: 0, pageSize: 50, sort: null, where: '', orderExpr: '' })
    m.setTableView('t|a|d|s|gone', { page: 0, pageSize: 50, sort: null, where: '', orderExpr: '' })
    m.saveTabs([table(), { ...cons('c2'), c: { ...cons('c2').c, sql: 'two' } }], 'c|c2')
    flush()
    const s = stored()
    expect(s.consoleSql).toEqual({ c2: 'two' })
    expect(Object.keys(s.views)).toEqual(['t|a|d|s|t1'])
    expect(s.tabs[1].c).not.toHaveProperty('sql')
    expect(s.active).toBe('c|c2')
  })

  it('setConsoleSql with an unchanged value does not schedule a write', async () => {
    const m = await load()
    m.setConsoleSql('c1', 'x')
    flush()
    localStorage.removeItem(KEY)
    m.setConsoleSql('c1', 'x')
    vi.advanceTimersByTime(1000)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('swallows storage errors (quota)', async () => {
    const m = await load()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    m.patchSession({ width: 300 })
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
  })

  it('patchSession always stamps the current version', async () => {
    const m = await load()
    m.patchSession({ v: 99, width: 200 })
    flush()
    expect(stored().v).toBe(1)
  })

  it('initialSession is a snapshot of what was on disk, unaffected by later changes', async () => {
    const m = await load({ v: 1, width: 222 })
    m.patchSession({ width: 500 })
    expect(m.initialSession.width).toBe(222)
  })
})
