import { describe, expect, it } from 'vitest'
import { rangeBetween } from '../../src/renderer/src/lib/selection'

const ids = ['ds1', 'ds1/db1', 'ds1/db1/public', 'ds1/db1/public/users', 'ds1/db1/public/orders', 'ds2']

describe('rangeBetween (shift-click selection in the explorer)', () => {
  it('is inclusive and in tree order', () => {
    expect(rangeBetween(ids, 'ds1/db1', 'ds1/db1/public/users')).toEqual([
      'ds1/db1', 'ds1/db1/public', 'ds1/db1/public/users'
    ])
  })
  it('works upwards too (anchor below the clicked row)', () => {
    expect(rangeBetween(ids, 'ds1/db1/public/orders', 'ds1/db1/public/users')).toEqual([
      'ds1/db1/public/users', 'ds1/db1/public/orders'
    ])
  })
  it('anchor === target selects just that row', () => {
    expect(rangeBetween(ids, 'ds2', 'ds2')).toEqual(['ds2'])
  })
  it('selects everything between first and last', () => {
    expect(rangeBetween(ids, 'ds1', 'ds2')).toEqual(ids)
  })
  it('falls back to the clicked row when either end is not visible (e.g. collapsed)', () => {
    expect(rangeBetween(ids, 'gone', 'ds2')).toEqual(['ds2'])
    expect(rangeBetween(ids, 'ds1', 'gone')).toEqual(['gone'])
    expect(rangeBetween([], 'a', 'b')).toEqual(['b'])
  })
})
