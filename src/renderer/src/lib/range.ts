export const MAX_LIMIT = 10000

/**
 * Pure: parse the row-range editor text: "1-100", "101-250", "500" (from 500, keep current size), "500-" (same).
 * Returns the new 0-based offset + limit, or an error message. `total` (0 = unknown/empty) clamps the upper end.
 */
export function parseRange(text: string, curLimit: number, total: number): { offset: number; limit: number } | string {
  const m = /^(\d+)\s*(?:(-|–|—|\.\.|:)\s*(\d*))?$/.exec(text.replace(/[\s,_]/g, ''))
  if (!m) return 'Use e.g. 1-100, 500 or 500-'
  const from = Number(m[1])
  if (from < 1) return 'Start row must be at least 1'
  if (total > 0 && from > total) return `Start row is past the end (${total})`
  if (!m[3]) return { offset: from - 1, limit: curLimit } // "500" / "500-": keep the current page size
  let to = Number(m[3])
  if (to < from) return 'End row must be at least the start row'
  if (total > 0) to = Math.min(to, total)
  const limit = to - from + 1
  if (limit > MAX_LIMIT) return `At most ${MAX_LIMIT} rows at once`
  return { offset: from - 1, limit }
}
