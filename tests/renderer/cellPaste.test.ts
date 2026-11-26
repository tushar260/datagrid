import { describe, expect, it } from 'vitest'
import { planPaste } from '../../src/renderer/src/lib/cellPaste'

const cols = ['id', 'name', 'note']
const plan = (t: string, start = { lin: 1, col: 1 }, sel = [1], sc: [number, number] = [1, 1], rows = 5) =>
  planPaste(t, cols, rows, start, sel, sc)

describe('planPaste', () => {
  it('single value → the focused cell', () => {
    expect(plan('hello')).toEqual([{ lin: 1, col: 1, value: 'hello' }])
  })
  it('single value over a multi-cell selection fills the rectangle', () => {
    expect(plan('x', { lin: 1, col: 0 }, [1, 2], [0, 1])).toHaveLength(4)
  })
  it('TSV block starts at the top-left cell and keeps empty cells', () => {
    expect(plan('a\tb\nc\t\n', { lin: 0, col: 0 }, [0], [0, 0])).toEqual([
      { lin: 0, col: 0, value: 'a' }, { lin: 0, col: 1, value: 'b' },
      { lin: 1, col: 0, value: 'c' }, { lin: 1, col: 1, value: '' }
    ])
  })
  it('handles Windows line endings', () => {
    expect(plan('a\r\nb', { lin: 0, col: 0 })).toHaveLength(2)
  })
  it('cells outside the loaded rows / columns are skipped', () => {
    expect(plan('a\tb\tc\td', { lin: 4, col: 1 })).toEqual([{ lin: 4, col: 1, value: 'a' }, { lin: 4, col: 2, value: 'b' }])
    expect(plan('a\nb\nc', { lin: 3, col: 0 })).toHaveLength(2)
  })
  it('a JSON array of objects (what Cmd+C produces) maps keys to columns, one object per row', () => {
    const j = JSON.stringify([{ name: 'n1', note: null }, { name: 'n2', nope: 1 }])
    expect(plan(j, { lin: 2, col: 0 })).toEqual([
      { lin: 2, col: 1, value: 'n1' }, { lin: 2, col: 2, value: null }, { lin: 3, col: 1, value: 'n2' }
    ])
  })
  it('invalid JSON that starts with [ is pasted as plain text', () => {
    expect(plan('[not json')).toEqual([{ lin: 1, col: 1, value: '[not json' }])
  })
  it('nested JSON values are stringified', () => {
    expect(plan('[{"note":{"a":1}}]', { lin: 0, col: 0 })).toEqual([{ lin: 0, col: 2, value: '{"a":1}' }])
  })
})
