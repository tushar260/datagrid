/** Local "find in grid" (Cmd/Ctrl+F): which of the loaded cells contain the query. */

/** Matching cells as [linear row index, column index] pairs in row-major order. NULL / undefined cells never match. */
export function findMatches(
  nRows: number, nCols: number, textAt: (lin: number, col: number) => string | null,
  query: string, caseSensitive: boolean
): [number, number][] {
  if (!query) return []
  const q = caseSensitive ? query : query.toLowerCase()
  const out: [number, number][] = []
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const t = textAt(r, c)
      if (t === null) continue
      if ((caseSensitive ? t : t.toLowerCase()).includes(q)) out.push([r, c])
    }
  }
  return out
}

/** Wrap-around step through `n` matches (dir = 1 next, -1 previous). */
export const stepIndex = (cur: number, dir: 1 | -1, n: number): number => (n === 0 ? 0 : (cur + dir + n) % n)

/** The match to land on when the query changes: the first one at/after the focused cell (row-major), wrapping to 0. */
export function firstFrom(matches: readonly [number, number][], lin: number, col: number): number {
  const i = matches.findIndex(([r, c]) => r > lin || (r === lin && c >= col))
  return i < 0 ? 0 : i
}
