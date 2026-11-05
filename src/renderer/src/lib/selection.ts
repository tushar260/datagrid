/**
 * Pure: the ids between `a` and `b` (inclusive, in either direction) out of the visible row ids, in tree order.
 * Falls back to just `[b]` when either end isn't visible (e.g. collapsed away).
 */
export function rangeBetween(ids: string[], a: string, b: string): string[] {
  const i = ids.indexOf(a)
  const j = ids.indexOf(b)
  if (i < 0 || j < 0) return [b]
  return ids.slice(Math.min(i, j), Math.max(i, j) + 1)
}
