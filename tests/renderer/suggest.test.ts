import { describe, expect, it } from 'vitest'
import {
  candidates, needsQuote, ORDER_KEYWORDS, quoteName, WHERE_KEYWORDS, wordAt, type Ctx
} from '../../src/renderer/src/lib/suggest'
import type { Column } from '../../src/shared'

const col = (name: string, over: Partial<Column> = {}): Column => ({ name, type: 'text', nullable: true, isPk: false, ...over })
const ctx = (word: string, over: Partial<Ctx> = {}): Ctx => ({ start: 0, end: word.length, word, alias: false, forced: false, ...over })
const labels = (items: { label: string }[]): string[] => items.map((i) => i.label)

describe('needsQuote / quoteName', () => {
  it.each([
    ['id', 'id'],
    ['user_name', 'user_name'],
    ['_x1', '_x1'],
    ['Name', '"Name"'], // uppercase must be quoted to match
    ['first name', '"first name"'],
    ['1abc', '"1abc"'],
    ['a-b', '"a-b"'],
    ['order', '"order"'], // reserved
    ['user', '"user"'],
    ['group', '"group"'],
    ['select', '"select"'],
    ['limit', '"limit"'],
    ['we"ird', '"we""ird"'],
    ['', '""']
  ])('%j -> %s', (name, out) => {
    expect(quoteName(name)).toBe(out)
    expect(needsQuote(name)).toBe(out !== name)
  })

  it('non-reserved keywords that are valid column names stay bare', () => {
    for (const n of ['name', 'type', 'value', 'status', 'key', 'data', 'count']) expect(needsQuote(n)).toBe(false)
  })
})

describe('wordAt (word under the caret)', () => {
  it('finds the identifier before the caret', () => {
    expect(wordAt('na', 2)).toEqual({ start: 0, end: 2, word: 'na', alias: false })
    expect(wordAt('id = 1 and na', 13)).toEqual({ start: 11, end: 13, word: 'na', alias: false })
  })

  it('swallows the rest of the identifier after the caret (replace range)', () => {
    expect(wordAt('name', 2)).toEqual({ start: 0, end: 4, word: 'na', alias: false })
    expect(wordAt('id=na_me+1', 5)).toEqual({ start: 3, end: 8, word: 'na', alias: false })
  })

  it('empty word right after an operator / space', () => {
    expect(wordAt('id = ', 5)).toEqual({ start: 5, end: 5, word: '', alias: false })
    expect(wordAt('', 0)).toEqual({ start: 0, end: 0, word: '', alias: false })
  })

  it('detects an alias prefix `t.` / `alias.`', () => {
    expect(wordAt('t.na', 4)).toEqual({ start: 2, end: 4, word: 'na', alias: true })
    expect(wordAt('t.', 2)).toEqual({ start: 2, end: 2, word: '', alias: true })
    expect(wordAt('x and my_alias.i', 16)).toMatchObject({ word: 'i', alias: true })
  })

  it('is disabled inside an unterminated string literal', () => {
    expect(wordAt("name = 'ab", 10)).toBeNull()
    expect(wordAt("name = 'a' and na", 17)).toMatchObject({ word: 'na' }) // literal closed
    expect(wordAt("a = 'it''s' and b", 17)).toMatchObject({ word: 'b' }) // doubled quote = still balanced
    expect(wordAt("a = 'x", 2)).toMatchObject({ word: '' }) // caret before the quote is outside the literal
  })

  it('ignores words that start with a digit (numbers)', () => {
    expect(wordAt('id = 12', 7)).toBeNull()
    expect(wordAt('id = 1abc', 9)).toBeNull()
    expect(wordAt('col1', 4)).toMatchObject({ word: 'col1' })
  })
})

describe('candidates', () => {
  const cols = [col('id', { isPk: true, type: 'integer' }), col('name'), col('first_name'), col('Created At'), col('order'), col('nickname')]

  it('prefix matches rank before contains matches, preserving column order within each group', () => {
    expect(labels(candidates(ctx('n'), cols, []))).toEqual(['name', 'nickname', 'first_name'])
    expect(labels(candidates(ctx('name'), cols, []))).toEqual(['name', 'first_name', 'nickname'])
  })

  it('matching is case-insensitive', () => {
    expect(labels(candidates(ctx('NAM'), cols, []))).toEqual(['name', 'first_name', 'nickname'])
    expect(labels(candidates(ctx('created'), cols, []))).toEqual(['Created At'])
  })

  it('inserts quoted names where needed (uppercase / spaces / reserved)', () => {
    const items = candidates(ctx('', { forced: true }), cols, [])
    const ins = Object.fromEntries(items.map((i) => [i.label, i.insert]))
    expect(ins).toMatchObject({ id: 'id', name: 'name', 'Created At': '"Created At"', order: '"order"' })
  })

  it('an empty word opens nothing unless forced (Ctrl+Space) or after `alias.`', () => {
    expect(candidates(ctx(''), cols, WHERE_KEYWORDS)).toEqual([])
    expect(candidates(ctx('', { forced: true }), cols, [])).toHaveLength(cols.length)
    expect(candidates(ctx('', { alias: true }), cols, WHERE_KEYWORDS)).toHaveLength(cols.length)
  })

  it('forced + empty word appends the keywords after the columns', () => {
    const out = candidates(ctx('', { forced: true }), cols, ORDER_KEYWORDS)
    expect(labels(out)).toEqual([...cols.map((c) => c.name), ...ORDER_KEYWORDS])
    expect(out.at(-1)).toMatchObject({ kind: 'kw', insert: 'nulls last ' })
  })

  it('keywords are matched by prefix and inserted with a trailing space, after columns', () => {
    const out = candidates(ctx('i'), [col('id'), col('item')], WHERE_KEYWORDS)
    expect(out.map((i) => [i.kind, i.label])).toEqual([
      ['col', 'id'], ['col', 'item'], ['kw', 'ilike'], ['kw', 'in'], ['kw', 'is null'], ['kw', 'is not null']
    ])
    expect(out.find((i) => i.label === 'is null')!.insert).toBe('is null ')
  })

  it('after `alias.` only columns are offered (no keywords)', () => {
    const out = candidates(ctx('n', { alias: true }), cols, WHERE_KEYWORDS)
    expect(out.every((i) => i.kind === 'col')).toBe(true)
  })

  it('forced with no match falls back to all columns', () => {
    expect(labels(candidates(ctx('zzz', { forced: true }), cols, []))).toHaveLength(cols.length)
    expect(candidates(ctx('zzz'), cols, [])).toEqual([])
  })

  it('closes the list when the only candidate is exactly what was typed', () => {
    expect(candidates(ctx('id'), [col('id')], [])).toEqual([])
    expect(candidates(ctx('ID'), [col('id')], [])).toEqual([])
    // but not when there is something more to offer
    expect(labels(candidates(ctx('id'), [col('id'), col('idx')], []))).toEqual(['id', 'idx'])
    expect(candidates(ctx('desc'), [], ORDER_KEYWORDS)).toEqual([])
  })

  it('carries column metadata for the type / PK badges', () => {
    const [first] = candidates(ctx('i'), cols, [])
    expect(first.col).toMatchObject({ name: 'id', isPk: true, type: 'integer' })
  })

  it('works with no columns', () => {
    expect(candidates(ctx('a'), [], WHERE_KEYWORDS).map((i) => i.label)).toEqual(['and'])
  })
})

describe('function arguments (fnArg)', () => {
  const cols = [col('id'), col('name')]
  it('wordAt flags the position right after `fn(`', () => {
    expect(wordAt('begins_with(', 12)).toMatchObject({ word: '', fnArg: true })
    expect(wordAt('a = 1 and contains( ', 20)).toMatchObject({ word: '', fnArg: true })
    expect(wordAt('begins_with(, )', 12)).toMatchObject({ fnArg: true }) // caret between `(` and `,`
  })
  it('is not set for typed words, second arguments, aliases, or non-function parentheses', () => {
    expect(wordAt('begins_with(na', 14)!.fnArg).toBeUndefined()
    expect(wordAt('begins_with(a, ', 15)!.fnArg).toBeUndefined()
    expect(wordAt('begins_with(t.', 14)!.fnArg).toBeUndefined()
    for (const kw of ['id in (', 'a and (', 'a or (', 'not (', 'x between (', 'values (']) expect(wordAt(kw, kw.length)!.fnArg).toBeUndefined()
    expect(wordAt('(', 1)!.fnArg).toBeUndefined()
  })
  it('candidates offers attribute names only (no keywords) for an empty first argument', () => {
    const ctx = { ...wordAt('begins_with(', 12)!, forced: false }
    expect(candidates(ctx, cols, WHERE_KEYWORDS).map((i) => [i.kind, i.label])).toEqual([['col', 'id'], ['col', 'name']])
    expect(candidates({ ...ctx, forced: true }, cols, WHERE_KEYWORDS).every((i) => i.kind === 'col')).toBe(true)
  })
})
