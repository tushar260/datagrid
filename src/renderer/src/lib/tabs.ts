import type { SavedTab } from '../session'

/**
 * Pure: move the item with key `from` next to the item with key `to` (before it, or after it when `after`);
 * `to === null` = the end of the strip. Returns the SAME array when nothing would change.
 */
export function reorderTabs<T>(ts: T[], keyOf: (x: T) => string, from: string, to: string | null, after: boolean): T[] {
  const item = ts.find((x) => keyOf(x) === from)
  if (!item || to === from) return ts
  const rest = ts.filter((x) => keyOf(x) !== from)
  let at = rest.length
  if (to !== null) {
    const i = rest.findIndex((x) => keyOf(x) === to)
    if (i < 0) return ts
    at = i + (after ? 1 : 0)
  }
  const out = [...rest.slice(0, at), item, ...rest.slice(at)]
  return out.every((x, i) => x === ts[i]) ? ts : out
}

/** Pure: swap a tab with its neighbour (`delta` -1 = left, +1 = right); unchanged (same array) at the edges. */
export function moveTabBy<T>(ts: T[], keyOf: (x: T) => string, k: string, delta: number): T[] {
  const i = ts.findIndex((x) => keyOf(x) === k)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ts.length) return ts
  const out = [...ts]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/**
 * Pure: key of the tab Ctrl+Tab (`dir` 1) / Ctrl+Shift+Tab (`dir` -1) activates: the next/previous tab, wrapping
 * around. Tabs for which `skip(key)` is true (e.g. ones animating out) are passed over. Null when there is nothing
 * to switch to (no tabs, only the active one left). An unknown `active` starts at the first (dir 1) / last (-1) tab.
 */
export function cycleTab<T>(ts: T[], keyOf: (x: T) => string, active: string | null, dir: 1 | -1, skip?: (k: string) => boolean): string | null {
  const n = ts.length
  const at = active === null ? -1 : ts.findIndex((x) => keyOf(x) === active)
  const from = at < 0 ? (dir > 0 ? -1 : 0) : at
  for (let s = 1; s <= n; s++) {
    const k = keyOf(ts[(((from + dir * s) % n) + n) % n])
    if (k !== active && !skip?.(k)) return k
  }
  return null
}

/** Pure: tabs that remain after "Close Tabs to the Right" of `k` (null when `k` is unknown). */
export function tabsUpTo<T>(ts: T[], keyOf: (x: T) => string, k: string): T[] | null {
  const i = ts.findIndex((x) => keyOf(x) === k)
  return i < 0 ? null : ts.slice(0, i + 1)
}

/**
 * Pure: turn the saved tabs into live ones. Tabs whose data source no longer exists are dropped, the data
 * source name is refreshed, and console tabs get their saved SQL draft back.
 */
export function restoreTabs(saved: SavedTab[], consoleSql: Record<string, string>, names: Map<string, string>): SavedTab[] {
  const back: SavedTab[] = []
  for (const x of saved) {
    const dsName = names.get(x.type === 'table' ? x.t.dsId : x.c.dsId)
    if (dsName === undefined) continue // data source no longer exists
    if (x.type === 'table') back.push({ type: 'table', t: { ...x.t, dsName } })
    else back.push({ type: 'console', c: { ...x.c, dsName, sql: consoleSql[x.c.id] ?? '' } })
  }
  return back
}
