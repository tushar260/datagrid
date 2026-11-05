import { describe, expect, it } from 'vitest'
import { computeDelete, effectiveSelection, linOf, NO_ROWS, rangeSet, selectedLins, toggleLin } from '../../src/renderer/src/lib/rowSelection'

describe('row selection helpers', () => {
  it('linOf puts new rows after the loaded rows', () => {
    expect(linOf({ kind: 'row', i: 3 }, 10)).toBe(3)
    expect(linOf({ kind: 'new', i: 2 }, 10)).toBe(12)
  })
  it('selectedLins falls back to the focused cell row', () => {
    expect([...selectedLins(NO_ROWS, { kind: 'row', i: 4 }, 10)]).toEqual([4])
    expect(selectedLins(NO_ROWS, null, 10).size).toBe(0)
    expect([...selectedLins(new Set([1, 2]), { kind: 'row', i: 4 }, 10)]).toEqual([1, 2])
  })
  it('effectiveSelection is like selectedLins but honours the Escape-cleared state', () => {
    expect([...effectiveSelection(NO_ROWS, { kind: 'row', i: 4 }, 10, false)]).toEqual([4])
    expect(effectiveSelection(NO_ROWS, { kind: 'row', i: 4 }, 10, true).size).toBe(0)
    expect(effectiveSelection(new Set([1, 2]), { kind: 'row', i: 4 }, 10, true).size).toBe(0)
    expect([...effectiveSelection(new Set([1, 2]), null, 10, false)]).toEqual([1, 2])
  })
  it('rangeSet is inclusive and direction independent', () => {
    expect([...rangeSet(2, 5)]).toEqual([2, 3, 4, 5])
    expect([...rangeSet(5, 2)].sort()).toEqual([2, 3, 4, 5])
    expect([...rangeSet(3, 3)]).toEqual([3])
  })
  it('toggleLin adds and removes without mutating', () => {
    const a = new Set([1, 2])
    expect([...toggleLin(a, 5)].sort()).toEqual([1, 2, 5])
    expect([...toggleLin(a, 2)]).toEqual([1])
    expect([...a]).toEqual([1, 2])
  })
})

describe('computeDelete', () => {
  it('marks every selected loaded row as deleted', () => {
    const r = computeDelete([1, 2, 7], 10, new Set(), true)
    expect([...r.deleted].sort()).toEqual([1, 2, 7])
    expect(r.dropNew.size).toBe(0)
    expect(r.noPk).toBe(false)
  })
  it('drops selected pending-insert rows instead of marking them', () => {
    const r = computeDelete([3, 10, 11], 10, new Set(), true)
    expect([...r.deleted]).toEqual([3])
    expect([...r.dropNew].sort()).toEqual([0, 1])
  })
  it('toggles back off when all selected loaded rows are already pending deletes', () => {
    const r = computeDelete([1, 2], 10, new Set([1, 2, 5]), true)
    expect([...r.deleted]).toEqual([5])
  })
  it('marks the rest when only some are already deleted', () => {
    const r = computeDelete([1, 2], 10, new Set([1]), true)
    expect([...r.deleted].sort()).toEqual([1, 2])
  })
  it('force never toggles off (used by ⌘-click delete+submit)', () => {
    const r = computeDelete([1, 2], 10, new Set([1, 2]), true, true)
    expect([...r.deleted].sort()).toEqual([1, 2])
  })
  it('refuses loaded rows without a primary key but still drops new rows', () => {
    const r = computeDelete([1, 10], 10, new Set(), false)
    expect(r.noPk).toBe(true)
    expect(r.deleted.size).toBe(0)
    expect([...r.dropNew]).toEqual([0])
  })
  it('only new rows in a table without pk is fine', () => {
    expect(computeDelete([10], 10, new Set(), false).noPk).toBe(false)
  })
})
