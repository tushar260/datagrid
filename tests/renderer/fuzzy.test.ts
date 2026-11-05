import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyMatch } from '../../src/renderer/src/lib/fuzzy'
import { AWS_REGIONS } from '../../src/shared'
import { REGION_NAMES } from '../../src/renderer/src/RegionInput'

const top = (q: string, n = 3): string[] =>
  fuzzyFilter(q, AWS_REGIONS, (r) => (REGION_NAMES[r] ? [r, REGION_NAMES[r]] : [r])).slice(0, n).map((m) => m.item)

describe('fuzzyMatch', () => {
  it('matches subsequences, case-insensitively', () => {
    expect(fuzzyMatch('ue1', 'us-east-1')).not.toBeNull()
    expect(fuzzyMatch('UEAST', 'us-east-1')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'us-east-1')).toBeNull()
    expect(fuzzyMatch('1e', 'us-east-1')).toBeNull() // order matters
  })
  it('empty query matches everything with score 0; spaces and dashes in the query are ignored', () => {
    expect(fuzzyMatch('', 'abc')).toEqual({ score: 0, positions: [] })
    expect(fuzzyMatch('  - ', 'abc')).toEqual({ score: 0, positions: [] })
    expect(fuzzyMatch('us east', 'us-east-1')).not.toBeNull()
    expect(fuzzyMatch('us-east', 'us-east-1')!.positions).toEqual([0, 1, 3, 4, 5, 6])
  })
  it('reports matched positions', () => {
    expect(fuzzyMatch('ue1', 'us-east-1')!.positions).toEqual([0, 3, 8])
  })
  it('prefers consecutive and word-start matches', () => {
    const consecutive = fuzzyMatch('east', 'us-east-1')!.score
    const scattered = fuzzyMatch('east', 'exaxsxt')!.score
    expect(consecutive).toBeGreaterThan(scattered)
    expect(fuzzyMatch('eu', 'eu-west-1')!.score).toBeGreaterThan(fuzzyMatch('eu', 'sa-east-1-europe-x')!.score)
  })
  it('a query longer than the target does not match', () => {
    expect(fuzzyMatch('abcd', 'abc')).toBeNull()
  })
})

describe('fuzzyFilter', () => {
  it('returns every item in the original order for an empty query', () => {
    expect(fuzzyFilter('', ['b', 'a', 'c'], (x) => [x]).map((m) => m.item)).toEqual(['b', 'a', 'c'])
  })
  it('drops non-matches', () => {
    expect(fuzzyFilter('zz', AWS_REGIONS, (r) => [r])).toEqual([])
  })
  it('ranks regions by fuzzy relevance', () => {
    expect(top('useast', 2)).toEqual(['us-east-1', 'us-east-2'])
    expect(top('ue1')[0]).toBe('us-east-1')
    expect(top('euw2')[0]).toBe('eu-west-2')
    expect(top('apne1')[0]).toBe('ap-northeast-1')
    expect(top('us-w')[0]).toBe('us-west-1')
  })
  it('finds regions by their human names', () => {
    expect(top('frankfurt', 1)).toEqual(['eu-central-1'])
    expect(top('tokyo', 1)).toEqual(['ap-northeast-1'])
    expect(top('virginia', 1)).toEqual(['us-east-1'])
    expect(top('mumbai', 1)).toEqual(['ap-south-1'])
    expect(top('sydny', 1)).toEqual(['ap-southeast-2']) // typo-tolerant (subsequence)
  })
  it('only highlights positions of matches in the region code, not the name', () => {
    const r = fuzzyFilter('tokyo', ['ap-northeast-1'], () => ['ap-northeast-1', 'Asia Pacific (Tokyo)'])
    expect(r[0].positions).toEqual([])
    const c = fuzzyFilter('apne', ['ap-northeast-1'], () => ['ap-northeast-1', 'Asia Pacific (Tokyo)'])
    expect(c[0].positions.length).toBe(4)
  })
  it('keeps the original order for equal scores', () => {
    expect(fuzzyFilter('a', ['xa', 'ya'], (x) => [x]).map((m) => m.item)).toEqual(['xa', 'ya'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// rankFuzzy: the ⌘O ranking (score, then shorter, then alphabetical) over a large index
// ---------------------------------------------------------------------------------------------------------------
import { normalizeQuery, rankFuzzy } from '../../src/renderer/src/lib/fuzzy'

const item = (name: string): { name: string; lower: string } => ({ name, lower: name.toLowerCase() })
const rank = (q: string, names: string[], limit?: number): string[] => rankFuzzy(q, names.map(item), limit).map((r) => r.item.name)

describe('rankFuzzy', () => {
  it('an empty or blank query ranks nothing (the caller shows the recent list)', () => {
    expect(rank('', ['a', 'b'])).toEqual([])
    expect(rank('  - ', ['a', 'b'])).toEqual([])
    expect(normalizeQuery(' Us-E ')).toBe('use')
  })
  it('only subsequence matches are returned, case-insensitively', () => {
    expect(rank('usr', ['users', 'orders', 'USER_ROLES', 'accounts']).sort()).toEqual(['USER_ROLES', 'users'])
    expect(rank('zzz', ['users'])).toEqual([])
  })
  it('exact and prefix matches beat scattered ones', () => {
    const r = rank('user', ['super_user_x', 'u_s_e_r', 'users', 'user', 'xuxsxexr'])
    expect(r[0]).toBe('user')
    expect(r[1]).toBe('users')
    expect(r.indexOf('super_user_x')).toBeLessThan(r.indexOf('xuxsxexr')) // a word-start run beats a smear
  })
  it('equal scores: the shorter name first, then alphabetical', () => {
    expect(rank('a', ['ab', 'a', 'ac', 'aa'])).toEqual(['a', 'aa', 'ab', 'ac'])
    expect(rank('t', ['tb', 'ta', 'tc'])).toEqual(['ta', 'tb', 'tc'])
  })
  it('reports where the characters matched (for the bold highlight)', () => {
    const [r] = rankFuzzy('ord', [item('orders')])
    expect(r.positions).toEqual([0, 1, 2])
    const [s] = rankFuzzy('ou', [item('order_users')])
    expect(s.positions[0]).toBe(0)
    expect(s.positions).toHaveLength(2)
  })
  it('respects the limit and returns the best ones', () => {
    const names = Array.from({ length: 1000 }, (_, i) => 'tbl_' + i)
    names.push('t')
    const r = rank('t', names, 5)
    expect(r).toHaveLength(5)
    expect(r[0]).toBe('t')
  })
  it('matches non-ASCII names', () => {
    expect(rank('ünï', ['café', 'ünïcode', 'x'])).toEqual(['ünïcode'])
  })
  it('does not mutate its input and is stable between runs', () => {
    const items = ['b', 'a', 'ab'].map(item)
    const copy = [...items]
    expect(rankFuzzy('a', items).map((r) => r.item.name)).toEqual(rankFuzzy('a', items).map((r) => r.item.name))
    expect(items).toEqual(copy)
  })
  it('20,000 names are ranked in well under a frame', () => {
    const words = ['user', 'order', 'item', 'session', 'audit', 'log', 'event', 'account', 'invoice', 'ledger']
    const names = Array.from({ length: 20_000 }, (_, i) => `${words[i % 10]}_${words[(i * 7) % 10]}_${i}`)
    const items = names.map(item)
    rankFuzzy('usrord', items) // warm up the JIT
    const runs: number[] = []
    for (const q of ['usrord', 'inv', 'e', 'lg1', 'xyz']) {
      const t0 = performance.now()
      const r = rankFuzzy(q, items)
      runs.push(performance.now() - t0)
      expect(r.length).toBeLessThanOrEqual(200)
    }
    // the spec is < ~30 ms per keystroke; leave headroom for a loaded CI machine
    expect(Math.min(...runs)).toBeLessThan(30)
    expect(Math.max(...runs)).toBeLessThan(120)
  })
})
