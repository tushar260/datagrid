import { describe, expect, it } from 'vitest'
import { compareNames, sortSources, sourcesIn } from '../../src/renderer/src/lib/sortSources'
import type { DataSource } from '../../src/shared'

const ds = (id: string, name: string, folderId: string | null = null): DataSource => ({
  id, name, host: 'h', port: 5432, user: 'u', password: '', database: 'd', ssl: false, folderId
})
const names = (l: { name: string }[]): string[] => l.map((x) => x.name)

describe('compareNames', () => {
  it('ignores case, is numeric aware', () => {
    expect(compareNames('apple', 'Banana')).toBeLessThan(0)
    expect(compareNames('db2', 'db10')).toBeLessThan(0)
    expect(compareNames('DB', 'db')).toBe(0)
  })
})

describe('sortSources', () => {
  it('sorts alphabetically, case-insensitively', () => {
    expect(names(sortSources([ds('1', 'zeta'), ds('2', 'Alpha'), ds('3', 'beta'), ds('4', 'Gamma')]))).toEqual(['Alpha', 'beta', 'Gamma', 'zeta'])
  })
  it('orders numbers naturally: db2 < db10', () => {
    expect(names(sortSources([ds('1', 'db10'), ds('2', 'db2'), ds('3', 'DB1')]))).toEqual(['DB1', 'db2', 'db10'])
  })
  it('has a deterministic tiebreak (exact name, then id) independent of input order', () => {
    const a = ds('b', 'prod'), b = ds('a', 'prod'), c = ds('c', 'Prod')
    const expected = ['c', 'a', 'b'] // 'Prod' < 'prod' by code point, then id a < b
    expect(sortSources([a, b, c]).map((x) => x.id)).toEqual(expected)
    expect(sortSources([c, b, a]).map((x) => x.id)).toEqual(expected)
  })
  it('does not mutate the input', () => {
    const input = [ds('1', 'b'), ds('2', 'a')]
    sortSources(input)
    expect(names(input)).toEqual(['b', 'a'])
  })
})

describe('sourcesIn', () => {
  const all = [ds('1', 'zz', 'f1'), ds('2', 'Beta'), ds('3', 'aa', 'f1'), ds('4', 'Alpha'), ds('5', 'db10', 'f1'), ds('6', 'db2', 'f1'), ds('7', 'x', 'f2')]
  it('sorts the sources of a folder', () => {
    expect(names(sourcesIn(all, 'f1'))).toEqual(['aa', 'db2', 'db10', 'zz'])
    expect(names(sourcesIn(all, 'f2'))).toEqual(['x'])
    expect(sourcesIn(all, 'nope')).toEqual([])
  })
  it('keeps root sources in their stored order (undefined folderId counts as root)', () => {
    const list = [ds('2', 'Beta'), { ...ds('4', 'Alpha'), folderId: undefined }, ds('1', 'zz', 'f1')]
    expect(names(sourcesIn(list, null))).toEqual(['Beta', 'Alpha'])
  })
})
