import { describe, expect, it } from 'vitest'
import { findMatches, firstFrom, stepIndex } from '../../src/renderer/src/lib/gridFind'

const data = [['Alpha', 'beta', null], ['gamma', 'ALPHA', 'x'], ['alp', '', 'Alphabet']]
const at = (r: number, c: number): string | null => data[r][c]

describe('findMatches', () => {
  it('is case-insensitive by default and row-major', () => {
    expect(findMatches(3, 3, at, 'alpha', false)).toEqual([[0, 0], [1, 1], [2, 2]])
  })
  it('honours case sensitivity', () => {
    expect(findMatches(3, 3, at, 'Alpha', true)).toEqual([[0, 0], [2, 2]])
  })
  it('matches substrings and skips NULL cells', () => {
    expect(findMatches(3, 3, at, 'a', false).some(([r, c]) => r === 0 && c === 2)).toBe(false)
    expect(findMatches(3, 3, at, 'alp', false)).toHaveLength(4)
  })
  it('empty query or no hits → no matches', () => {
    expect(findMatches(3, 3, at, '', false)).toEqual([])
    expect(findMatches(3, 3, at, 'zzz', false)).toEqual([])
  })
})

describe('stepIndex / firstFrom', () => {
  it('wraps both ways and tolerates zero matches', () => {
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })
  it('firstFrom picks the first match at/after the focused cell, else wraps to the first', () => {
    const m: [number, number][] = [[0, 1], [2, 0], [2, 3]]
    expect(firstFrom(m, 0, 0)).toBe(0)
    expect(firstFrom(m, 2, 1)).toBe(2)
    expect(firstFrom(m, 5, 0)).toBe(0)
  })
})
