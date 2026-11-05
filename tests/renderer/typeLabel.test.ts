import { describe, expect, it } from 'vitest'
import { typeLabel } from '../../src/renderer/src/lib/typeLabel'

describe('typeLabel (icon tooltip)', () => {
  it.each([
    ['table', 'Table'],
    ['view', 'View'],
    ['matview', 'Materialized View'],
    ['foreign', 'Foreign Table'],
    ['schema', 'Schema'],
    ['database', 'Database'],
    ['ds', 'Data Source'],
    ['folder', 'Folder'],
    ['server', 'Server Objects'],
    ['roles', 'Roles'],
    ['role', 'Role'],
    ['tablespaces', 'Tablespaces'],
    ['tablespace', 'Tablespace'],
    ['console', 'Query Console'],
    [undefined, 'Table'],
    ['weird', 'Table']
  ])('%s -> %s', (k, label) => {
    expect(typeLabel(k)).toBe(label)
  })
})
