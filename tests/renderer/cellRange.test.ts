import { describe, expect, it } from 'vitest'
import { colBounds, copyPayload, inColRange } from '../../src/renderer/src/lib/cellRange'

const names = ['id', 'name', 'note']
const data = [
  { id: 1, name: 'a', note: null },
  { id: 2, name: 'b', note: 'x' },
  { id: 3, name: 'c', note: 'y' }
] as Record<string, unknown>[]
const val = (lin: number, c: number): unknown => data[lin]?.[names[c]]

describe('colBounds / inColRange', () => {
  it('orders the bounds regardless of drag direction', () => {
    expect(colBounds({ a: 2, b: 0 }, 1)).toEqual([0, 2])
    expect(colBounds({ a: 0, b: 2 }, 1)).toEqual([0, 2])
  })
  it('falls back to the focused column when there is no range', () => {
    expect(colBounds(null, 4)).toEqual([4, 4])
  })
  it('inColRange: null means every column, otherwise inclusive bounds', () => {
    expect(inColRange(null, 9)).toBe(true)
    expect(inColRange({ a: 2, b: 1 }, 1)).toBe(true)
    expect(inColRange({ a: 2, b: 1 }, 2)).toBe(true)
    expect(inColRange({ a: 2, b: 1 }, 0)).toBe(false)
    expect(inColRange({ a: 2, b: 1 }, 3)).toBe(false)
  })
})

describe('copyPayload', () => {
  it('single cell: plain text', () => {
    expect(copyPayload(names, [1], null, 1, val)).toBe('b')
    expect(copyPayload(names, [0], { a: 0, b: 0 }, 0, val)).toBe('1')
  })
  it('single NULL cell: empty string', () => {
    expect(copyPayload(names, [0], null, 2, val)).toBe('')
  })
  it('no rows selected: empty string', () => {
    expect(copyPayload(names, [], null, 0, val)).toBe('')
  })
  it('several rows of one column: array of single-key objects', () => {
    expect(JSON.parse(copyPayload(names, [0, 1, 2], null, 1, val))).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
  })
  it('one row, several columns: array with one object', () => {
    expect(JSON.parse(copyPayload(names, [1], { a: 0, b: 2 }, 0, val))).toEqual([{ id: 2, name: 'b', note: 'x' }])
  })
  it('rectangle: rows are sorted and NULL stays null', () => {
    expect(JSON.parse(copyPayload(names, [2, 0], { a: 2, b: 1 }, 1, val))).toEqual([
      { name: 'a', note: null }, { name: 'c', note: 'y' }
    ])
  })
  it('serializes bigint values as strings', () => {
    const out = copyPayload(['n'], [0, 1], null, 0, (l) => BigInt(l) + 9007199254740993n)
    expect(JSON.parse(out)).toEqual([{ n: '9007199254740993' }, { n: '9007199254740994' }])
  })
  it('is pretty-printed JSON', () => {
    expect(copyPayload(['a'], [0, 1], null, 0, () => 1)).toBe('[\n  {\n    "a": 1\n  },\n  {\n    "a": 1\n  }\n]')
  })
})
