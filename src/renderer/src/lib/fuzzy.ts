/** Small fuzzy matcher (subsequence match with scoring), used by the region combobox. */

export interface FuzzyMatch {
  score: number
  /** indexes into the target of the matched characters (for highlighting) */
  positions: number[]
}

const isSep = (c: string): boolean => c === '-' || c === ' ' || c === '_' || c === '.' || c === '/' || c === '(' || c === ')'

/**
 * Matches `query` against `target` as a case-insensitive subsequence ("ue1" matches "us-east-1"). Spaces and dashes in the
 * query are ignored. Returns null when it does not match. Higher scores are better: consecutive characters, a match at the
 * start of the target and matches at word starts ("eu-c" -> "eu-central") are rewarded; gaps and a late start cost points.
 * An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/[\s-]+/g, '')
  if (!q) return { score: 0, positions: [] }
  const t = target.toLowerCase()
  // greedy forward pass to see if it matches at all (cheap reject)
  let ti = 0
  for (const ch of q) {
    ti = t.indexOf(ch, ti)
    if (ti < 0) return null
    ti++
  }
  // best alignment via DP over (query index, target index): O(q * t), both are tiny here
  const n = q.length
  const m = t.length
  const NEG = -1e9
  // best[i][j]: best score matching q[0..i] with q[i] placed at t[j]
  const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(NEG))
  const from: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1))
  for (let i = 0; i < n; i++) {
    for (let j = i; j < m; j++) {
      if (t[j] !== q[i]) continue
      const boundary = j === 0 || isSep(t[j - 1])
      const here = 1 + (boundary ? 6 : 0) + (j === 0 ? 4 : 0)
      if (i === 0) {
        best[i][j] = here - Math.min(j, 8) * 0.25 // later starts are slightly worse
        continue
      }
      let bs = NEG
      let bk = -1
      for (let k = i - 1; k < j; k++) {
        if (best[i - 1][k] === NEG) continue
        const gap = j - k - 1
        const s = best[i - 1][k] + (gap === 0 ? 5 : -Math.min(gap, 6) * 0.5)
        if (s > bs) {
          bs = s
          bk = k
        }
      }
      if (bk >= 0) {
        best[i][j] = bs + here
        from[i][j] = bk
      }
    }
  }
  let bj = -1
  let bscore = NEG
  for (let j = 0; j < m; j++) if (best[n - 1][j] > bscore) {
    bscore = best[n - 1][j]
    bj = j
  }
  if (bj < 0) return null
  const positions: number[] = new Array<number>(n)
  for (let i = n - 1, j = bj; i >= 0; i--) {
    positions[i] = j
    j = from[i][j]
  }
  return { score: bscore, positions }
}

/**
 * Ranks `items` by their best fuzzy match over `keys(item)` (e.g. the code and the human name). Non-matches are dropped;
 * ties keep the original order. With an empty query every item is returned unchanged.
 */
export function fuzzyFilter<T>(query: string, items: readonly T[], keys: (item: T) => string[]): { item: T; score: number; positions: number[] }[] {
  const out: { item: T; score: number; positions: number[]; i: number }[] = []
  items.forEach((item, i) => {
    let best: FuzzyMatch | null = null
    const ks = keys(item)
    ks.forEach((k, ki) => {
      const r = fuzzyMatch(query, k)
      // matches in the primary key (index 0) rank slightly higher than in secondary ones
      if (r && (!best || r.score - ki * 0.5 > best.score)) best = { score: r.score - ki * 0.5, positions: ki === 0 ? r.positions : [] }
    })
    if (best) out.push({ item, score: (best as FuzzyMatch).score, positions: (best as FuzzyMatch).positions, i })
  })
  out.sort((a, b) => b.score - a.score || a.i - b.i)
  return out.map(({ item, score, positions }) => ({ item, score, positions }))
}

// ---------------------------------------------------------------------------------------------------------------
// ranking many names at once (⌘O): cheap pre-filter + greedy score for everything, the exact DP only for the best few
// ---------------------------------------------------------------------------------------------------------------

export interface RankTarget {
  /** the text that is matched and shown */
  name: string
  /** `name.toLowerCase()`, computed once when the index is built */
  lower: string
}
export interface Ranked<T> {
  item: T
  score: number
  /** indexes into `item.name` of the matched characters */
  positions: number[]
}

/** The query as the matcher sees it: lower case, blanks and dashes dropped (same as `fuzzyMatch`). */
export const normalizeQuery = (query: string): string => query.toLowerCase().replace(/[\s-]+/g, '')

/** Greedy left-to-right alignment score (an approximation of the DP score): -1 when `q` is not a subsequence of `t`. */
function quickScore(q: string, t: string): number {
  let ti = -1
  let score = 0
  let prev = -2
  for (let i = 0; i < q.length; i++) {
    ti = t.indexOf(q[i], ti + 1)
    if (ti < 0) return -1
    const boundary = ti === 0 || isSep(t[ti - 1])
    score += 1 + (boundary ? 6 : 0) + (ti === 0 ? 4 : 0) + (ti === prev + 1 ? 5 : 0)
    if (i === 0) score -= Math.min(ti, 8) * 0.25
    prev = ti
  }
  return score + shapeBonus(q, t) - (t.length - q.length) * 0.02 // among equals the shorter name first
}

/** An exact name, a name that starts with the query or one that contains it as is beats any amount of boundary-hopping. */
function shapeBonus(q: string, t: string): number {
  if (t === q) return 1000
  const at = t.indexOf(q)
  if (at < 0) return 0
  return at === 0 ? 60 : isSep(t[at - 1]) ? 30 : 15
}

/**
 * Fuzzy-ranks `items` by `query` (subsequence, case-insensitive, boundary / consecutive bonuses) and returns the best `limit`:
 * by score, then shorter name, then alphabetical. Every item gets the cheap greedy score; only the best ~3x`limit` are
 * re-scored exactly (and get their highlight positions), so 20k names stay well under a frame. An empty query returns [].
 */
export function rankFuzzy<T extends RankTarget>(query: string, items: readonly T[], limit = 200): Ranked<T>[] {
  const q = normalizeQuery(query)
  if (!q) return []
  const cheap: { item: T; s: number }[] = []
  for (const item of items) {
    const s = quickScore(q, item.lower)
    if (s >= 0) cheap.push({ item, s })
  }
  cheap.sort((a, b) => b.s - a.s)
  const out: Ranked<T>[] = []
  for (const { item } of cheap.slice(0, Math.max(limit * 3, 300))) {
    const m = fuzzyMatch(q, item.name)
    if (m) out.push({ item, score: m.score + shapeBonus(q, item.lower), positions: m.positions })
  }
  out.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length || (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0))
  return out.slice(0, limit)
}
