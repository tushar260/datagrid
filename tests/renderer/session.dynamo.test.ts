// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('../../src/renderer/src/session')
const KEY = 'datagrip-lite:session'

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
const ddbTab = { type: 'table', t: { dsId: 'b', dsName: 'B', database: '', schema: '', table: 't1', kind: 'table', engine: 'dynamodb', region: 'eu-west-1' } }
const ddbConsole = { type: 'console', c: { id: 'c1', title: 'B console', dsId: 'b', dsName: 'B', database: '', engine: 'dynamodb', region: 'us-east-2' } }
const pgConsole = { type: 'console', c: { id: 'c2', title: 'console', dsId: 'a', dsName: 'A', database: 'd', schema: 's' } }

describe('session with DynamoDB tabs', () => {
  it('a session saved before DynamoDB support loads unchanged (no engine, no region)', async () => {
    const m = await load({ v: 1, tabs: [pgTab, pgConsole], active: 't|a|d|s|t1', consoleN: 1 })
    expect(m.initialSession.tabs).toEqual([
      { type: 'table', t: { dsId: 'a', dsName: 'A', database: 'd', schema: 's', table: 't1', kind: 'table' } },
      { type: 'console', c: { id: 'c2', title: 'console', dsId: 'a', dsName: 'A', database: 'd', schema: 's' } }
    ])
    expect(m.initialSession.tabs.every((x) => !('engine' in (x.type === 'table' ? x.t : x.c)))).toBe(true)
    expect(m.initialSession.active).toBe('t|a|d|s|t1')
  })

  it('DynamoDB tabs keep their engine and region; keys cannot collide with Postgres ones', async () => {
    const m = await load({ v: 1, tabs: [pgTab, ddbTab, ddbConsole], active: 't|ddb|b|eu-west-1|t1' })
    expect(m.initialSession.tabs).toHaveLength(3)
    expect(m.initialSession.tabs[1]).toEqual(ddbTab)
    expect(m.initialSession.tabs[2]).toEqual(ddbConsole)
    expect(m.initialSession.active).toBe('t|ddb|b|eu-west-1|t1')
    expect(m.tabKey(m.initialSession.tabs[0])).toBe('t|a|d|s|t1')
    expect(m.tabKey(m.initialSession.tabs[1])).toBe('t|ddb|b|eu-west-1|t1')
  })

  it('same table in two regions are two tabs; the same region twice de-duplicates', async () => {
    const other = { type: 'table', t: { ...ddbTab.t, region: 'us-east-1' } }
    const m = await load({ v: 1, tabs: [ddbTab, other, ddbTab] })
    expect(m.initialSession.tabs).toHaveLength(2)
  })

  it('a DynamoDB tab without a region string gets an empty region; a malformed engine is treated as Postgres', async () => {
    const m = await load({
      v: 1,
      tabs: [
        { type: 'table', t: { ...ddbTab.t, region: 5 } },
        { type: 'table', t: { ...pgTab.t, table: 'x', engine: 'mysql', region: 'r' } },
        { type: 'console', c: { ...ddbConsole.c, region: undefined } }
      ]
    })
    expect(m.initialSession.tabs[0]).toMatchObject({ t: { engine: 'dynamodb', region: '' } })
    expect((m.initialSession.tabs[1] as any).t).not.toHaveProperty('engine')
    expect((m.initialSession.tabs[1] as any).t).not.toHaveProperty('region')
    expect(m.initialSession.tabs[2]).toMatchObject({ c: { engine: 'dynamodb', region: '' } })
  })

  it('saveTabs persists engine / region, consoles keep their draft in consoleSql, and view state follows the DynamoDB key', async () => {
    const m = await load()
    m.setConsoleSql('c1', 'SELECT * FROM "t1"')
    m.setTableView('t|ddb|b|eu-west-1|t1', { page: 0, pageSize: 25, sort: null, where: 'pk = 1', orderExpr: '' })
    m.setTableView('t|ddb|b|eu-west-1|other', { page: 0, pageSize: 25, sort: null, where: '', orderExpr: '' })
    m.saveTabs([ddbTab, ddbConsole] as never, 't|ddb|b|eu-west-1|t1')
    flush()
    const s = stored()
    expect(s.tabs[0]).toEqual(ddbTab)
    expect(s.tabs[1].c).toMatchObject({ engine: 'dynamodb', region: 'us-east-2' })
    expect(s.tabs[1].c.sql).toBeUndefined()
    expect(s.consoleSql).toEqual({ c1: 'SELECT * FROM "t1"' })
    expect(Object.keys(s.views)).toEqual(['t|ddb|b|eu-west-1|t1']) // the closed tab's state is dropped
    expect(s.views['t|ddb|b|eu-west-1|t1'].where).toBe('pk = 1')
    // round trip
    const again = await load(s)
    expect(again.initialSession.tabs).toHaveLength(2)
    expect(again.getTableView('t|ddb|b|eu-west-1|t1')!.where).toBe('pk = 1')
  })
})
