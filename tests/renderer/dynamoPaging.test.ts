import { describe, expect, it } from 'vitest'
import { appendPage } from '../../src/renderer/src/lib/dynamoPaging'
import type { DynamoPage } from '../../src/shared'

const page = (over: Partial<DynamoPage> = {}): DynamoPage => ({
  items: [{ pk: 'a', n: 1 }], columns: [{ name: 'pk', types: ['S'], key: 'HASH' }, { name: 'n', types: ['N'] }], rows: [['a', '1']], next: 't1', columnsCapped: false, ...over
})

describe('appendPage (console "Load more")', () => {
  it('appends rows and items and takes the next cursor of the new page', () => {
    const out = appendPage(page(), page({ items: [{ pk: 'b', n: 2 }], rows: [['b', '2']], next: null }))
    expect(out.rows).toEqual([['a', '1'], ['b', '2']])
    expect(out.items).toEqual([{ pk: 'a', n: 1 }, { pk: 'b', n: 2 }])
    expect(out.next).toBeNull()
    expect(out.columns.map((c) => c.name)).toEqual(['pk', 'n'])
  })

  it('new attributes become new columns; older rows are padded with null', () => {
    const next = page({
      items: [{ pk: 'b', extra: true }], columns: [{ name: 'pk', types: ['S'] }, { name: 'extra', types: ['BOOL'] }], rows: [['b', 'true']], next: null
    })
    const out = appendPage(page(), next)
    expect(out.columns.map((c) => c.name)).toEqual(['pk', 'n', 'extra'])
    expect(out.rows).toEqual([['a', '1', null], ['b', null, 'true']])
  })

  it('cells of the new page are re-aligned to the merged column order', () => {
    const next = page({ columns: [{ name: 'n', types: ['N'] }, { name: 'pk', types: ['S'] }], rows: [['2', 'b']], next: null })
    expect(appendPage(page(), next).rows).toEqual([['a', '1'], ['b', '2']])
  })

  it('merges type lists, keeps the key marker, ORs the capped flag, and does not mutate its inputs', () => {
    const a = page()
    const b = page({ columns: [{ name: 'pk', types: ['S', 'N'], key: 'HASH' }, { name: 'n', types: ['S'], key: 'RANGE' }], columnsCapped: true })
    const snapshot = JSON.stringify(a)
    const out = appendPage(a, b)
    expect(out.columns[0].types).toEqual(['S', 'N'])
    expect(out.columns[1]).toEqual({ name: 'n', types: ['N', 'S'], key: 'RANGE' })
    expect(out.columnsCapped).toBe(true)
    expect(JSON.stringify(a)).toBe(snapshot)
  })

  it('works from an empty first page and keeps extra fields of the result (command, duration)', () => {
    const first = { ...page({ items: [], columns: [], rows: [] }), command: 'SELECT', durationMs: 5 }
    const out = appendPage(first, page({ next: null }))
    expect(out.rows).toEqual([['a', '1']])
    expect(out.command).toBe('SELECT')
    expect(out.durationMs).toBe(5)
  })
})
