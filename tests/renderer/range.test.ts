import { describe, expect, it } from 'vitest'
import { MAX_LIMIT, parseRange } from '../../src/renderer/src/lib/range'

const ok = (o: number, l: number): { offset: number; limit: number } => ({ offset: o, limit: l })

describe('parseRange (row range editor)', () => {
  it.each([
    ['1-100', 50, 1000, ok(0, 100)],
    ['101-250', 50, 1000, ok(100, 150)],
    ['1-1', 50, 1000, ok(0, 1)],
    ['500', 100, 1000, ok(499, 100)], // single number: from there, keep current size
    ['500-', 25, 1000, ok(499, 25)], // open-ended: same
    ['  10 - 20 ', 50, 1000, ok(9, 11)], // whitespace
    ['1,000-2,000', 50, 5000, ok(999, 1001)], // thousands separators
    ['1_000-1_100', 50, 5000, ok(999, 101)],
    ['5–10', 50, 100, ok(4, 6)], // en dash
    ['5—10', 50, 100, ok(4, 6)], // em dash
    ['5..10', 50, 100, ok(4, 6)],
    ['5:10', 50, 100, ok(4, 6)],
    ['5 .. 10', 50, 100, ok(4, 6)]
  ])('%j (limit %i, total %i)', (text, cur, total, expected) => {
    expect(parseRange(text, cur, total)).toEqual(expected)
  })

  it('clamps the upper end to the total', () => {
    expect(parseRange('900-5000', 50, 1000)).toEqual(ok(899, 101))
    expect(parseRange('1-99999', 50, 1000)).toEqual(ok(0, 1000))
  })

  it('does not clamp when the total is unknown (0)', () => {
    expect(parseRange('1-250', 50, 0)).toEqual(ok(0, 250))
    expect(parseRange('9999', 50, 0)).toEqual(ok(9998, 50))
  })

  it('a start past the end is an error (known total only)', () => {
    expect(parseRange('1001', 50, 1000)).toBe('Start row is past the end (1000)')
    expect(parseRange('1000', 50, 1000)).toEqual(ok(999, 50))
  })

  it('enforces the max limit of 10000 rows', () => {
    expect(parseRange(`1-${MAX_LIMIT}`, 50, 0)).toEqual(ok(0, MAX_LIMIT))
    expect(parseRange(`1-${MAX_LIMIT + 1}`, 50, 0)).toBe(`At most ${MAX_LIMIT} rows at once`)
    expect(parseRange('1-20000', 50, 50000)).toBe(`At most ${MAX_LIMIT} rows at once`)
    expect(MAX_LIMIT).toBe(10000)
  })

  it('limit check applies after clamping (a huge "to" on a small table is fine)', () => {
    expect(parseRange('1-1000000', 50, 300)).toEqual(ok(0, 300))
  })

  it('rejects an end before the start, and a zero start', () => {
    expect(parseRange('20-10', 50, 100)).toBe('End row must be at least the start row')
    expect(parseRange('0', 50, 100)).toBe('Start row must be at least 1')
    expect(parseRange('0-10', 50, 100)).toBe('Start row must be at least 1')
  })

  it.each(['', '   ', 'abc', '-5', '1-2-3', '1.5', '1 to 5', '1-a', '--', '1;2', '1-5; drop', '-', '+3', '1e3', '١٢'])(
    'rejects invalid input %j',
    (text) => {
      expect(parseRange(text, 50, 100)).toBe('Use e.g. 1-100, 500 or 500-')
    }
  )
})
