import { describe, expect, it } from 'vitest'
import { cycleTab, moveTabBy, reorderTabs, restoreTabs, tabsUpTo } from '../../src/renderer/src/lib/tabs'
import type { SavedTab } from '../../src/renderer/src/session'

type T = { k: string }
const key = (x: T): string => x.k
const mk = (...ks: string[]): T[] => ks.map((k) => ({ k }))
const keys = (ts: T[]): string => ts.map(key).join('')

describe('reorderTabs', () => {
  const ts = mk('a', 'b', 'c', 'd')

  it.each([
    ['d before a (move to start)', 'd', 'a', false, 'dabc'],
    ['a after d', 'a', 'd', true, 'bcda'],
    ['a to the end (to = null)', 'a', null, true, 'bcda'],
    ['b before d', 'b', 'd', false, 'acbd'],
    ['b after c', 'b', 'c', true, 'acbd'],
    ['c before b', 'c', 'b', false, 'acbd'],
    ['d after a', 'd', 'a', true, 'adbc']
  ])('%s', (_name, from, to, after, expected) => {
    expect(keys(reorderTabs(ts, key, from, to, after))).toBe(expected)
  })

  it('returns the SAME array for no-op drops (so the UI can hide the drop indicator)', () => {
    expect(reorderTabs(ts, key, 'b', 'b', false)).toBe(ts) // onto itself
    expect(reorderTabs(ts, key, 'b', 'a', true)).toBe(ts) // right after its left neighbour = same place
    expect(reorderTabs(ts, key, 'a', 'b', false)).toBe(ts) // right before its right neighbour
    expect(reorderTabs(ts, key, 'd', null, true)).toBe(ts) // last tab to the end
    expect(reorderTabs(ts, key, 'a', 'a', true)).toBe(ts)
  })

  it('unknown source or target leaves the order alone', () => {
    expect(reorderTabs(ts, key, 'zzz', 'a', false)).toBe(ts)
    expect(reorderTabs(ts, key, 'a', 'zzz', false)).toBe(ts)
  })

  it('does not mutate its input and keeps tab identity', () => {
    const before = [...ts]
    const out = reorderTabs(ts, key, 'a', null, true)
    expect(ts).toEqual(before)
    expect(out[3]).toBe(ts[0])
  })
})

describe('moveTabBy (Move Left / Move Right)', () => {
  const ts = mk('a', 'b', 'c')
  it('swaps with the neighbour', () => {
    expect(keys(moveTabBy(ts, key, 'b', -1))).toBe('bac')
    expect(keys(moveTabBy(ts, key, 'b', 1))).toBe('acb')
    expect(keys(moveTabBy(ts, key, 'a', 1))).toBe('bac')
  })
  it('is a no-op (same array) at the edges or for unknown keys', () => {
    expect(moveTabBy(ts, key, 'a', -1)).toBe(ts)
    expect(moveTabBy(ts, key, 'c', 1)).toBe(ts)
    expect(moveTabBy(ts, key, 'zzz', 1)).toBe(ts)
    expect(moveTabBy([], key, 'a', 1)).toEqual([])
  })
})

describe('cycleTab (Ctrl+Tab / Ctrl+Shift+Tab)', () => {
  const ts = mk('a', 'b', 'c')
  it('goes to the next / previous tab', () => {
    expect(cycleTab(ts, key, 'a', 1)).toBe('b')
    expect(cycleTab(ts, key, 'b', 1)).toBe('c')
    expect(cycleTab(ts, key, 'c', -1)).toBe('b')
    expect(cycleTab(ts, key, 'b', -1)).toBe('a')
  })
  it('wraps around at both ends', () => {
    expect(cycleTab(ts, key, 'c', 1)).toBe('a')
    expect(cycleTab(ts, key, 'a', -1)).toBe('c')
  })
  it('is null for no tabs or a single tab', () => {
    expect(cycleTab([], key, null, 1)).toBeNull()
    expect(cycleTab([], key, 'a', -1)).toBeNull()
    expect(cycleTab(mk('a'), key, 'a', 1)).toBeNull()
    expect(cycleTab(mk('a'), key, 'a', -1)).toBeNull()
  })
  it('skips tabs that are closing, wrapping if needed', () => {
    const closing = new Set(['b'])
    const skip = (k: string): boolean => closing.has(k)
    expect(cycleTab(ts, key, 'a', 1, skip)).toBe('c')
    expect(cycleTab(ts, key, 'c', -1, skip)).toBe('a')
    expect(cycleTab(ts, key, 'c', 1, skip)).toBe('a')
    expect(cycleTab(ts, key, 'b', 1, skip)).toBe('c') // the active tab itself may be the closing one
  })
  it('is null when every other tab is closing', () => {
    expect(cycleTab(ts, key, 'a', 1, (k) => k !== 'a')).toBeNull()
    expect(cycleTab(ts, key, 'a', 1, () => true)).toBeNull()
  })
  it('an unknown or missing active key starts at the first (next) / last (previous) tab', () => {
    expect(cycleTab(ts, key, 'zzz', 1)).toBe('a')
    expect(cycleTab(ts, key, 'zzz', -1)).toBe('c')
    expect(cycleTab(ts, key, null, 1)).toBe('a')
    expect(cycleTab(ts, key, null, -1)).toBe('c')
    expect(cycleTab(mk('a'), key, 'zzz', 1)).toBe('a')
  })
  it('does not mutate its input', () => {
    const before = [...ts]
    cycleTab(ts, key, 'a', 1)
    expect(ts).toEqual(before)
  })
})

describe('tabsUpTo (Close Tabs to the Right)', () => {
  const ts = mk('a', 'b', 'c')
  it('keeps everything up to and including the tab', () => {
    expect(keys(tabsUpTo(ts, key, 'b')!)).toBe('ab')
    expect(keys(tabsUpTo(ts, key, 'c')!)).toBe('abc')
    expect(keys(tabsUpTo(ts, key, 'a')!)).toBe('a')
  })
  it('null for an unknown tab', () => expect(tabsUpTo(ts, key, 'x')).toBeNull())
})

describe('restoreTabs (session restore)', () => {
  const table = (dsId: string, table = 't'): SavedTab => ({
    type: 'table', t: { dsId, dsName: 'old', database: 'd', schema: 's', table, kind: 'table' }
  })
  const consoleTab = (id: string, dsId: string): SavedTab => ({
    type: 'console', c: { id, title: 'c', dsId, dsName: 'old', database: 'd' }
  })

  it('drops tabs of data sources that no longer exist, keeping order', () => {
    const out = restoreTabs(
      [table('a', 't1'), table('gone', 't2'), consoleTab('c1', 'gone'), consoleTab('c2', 'b'), table('b', 't3')],
      {},
      new Map([['a', 'A'], ['b', 'B']])
    )
    expect(out.map((x) => (x.type === 'table' ? x.t.table : x.c.id))).toEqual(['t1', 'c2', 't3'])
  })

  it('refreshes the data source name (it may have been renamed)', () => {
    const [t, c] = restoreTabs([table('a'), consoleTab('c1', 'a')], {}, new Map([['a', 'Renamed']]))
    expect(t.type === 'table' && t.t.dsName).toBe('Renamed')
    expect(c.type === 'console' && c.c.dsName).toBe('Renamed')
  })

  it('restores console SQL drafts (empty string when none)', () => {
    const out = restoreTabs([consoleTab('c1', 'a'), consoleTab('c2', 'a')], { c1: 'select 1' }, new Map([['a', 'A']]))
    expect(out.map((x) => (x.type === 'console' ? x.c.sql : null))).toEqual(['select 1', ''])
  })

  it('returns an empty list when there is nothing to restore / no data sources', () => {
    expect(restoreTabs([], {}, new Map())).toEqual([])
    expect(restoreTabs([table('a')], {}, new Map())).toEqual([])
  })
})
