import { describe, expect, it } from 'vitest'
import {
  cleanDbError, suggestColumnCaseFix, suggestHint, suggestInvalidInput, suggestLikeCastFix
} from '../../src/renderer/src/lib/whereFix'
import type { Column } from '../../src/shared'

const col = (name: string, type: string): Column => ({ name, type, nullable: true, isPk: false })
const cols = [col('id', 'integer'), col('name', 'text'), col('teamId', 'uuid'), col('created', 'timestamp without time zone')]
const err = (t: string, op = '~~'): string => `error: operator does not exist: ${t} ${op} unknown`

describe('cleanDbError', () => {
  it('strips the IPC wrapper and the error: prefix, capitalises', () => {
    expect(cleanDbError(new Error("Error invoking remote method 'rows': error: operator does not exist: uuid ~~ unknown")))
      .toBe('Operator does not exist: uuid ~~ unknown')
    expect(cleanDbError('error: column "x" does not exist')).toBe('Column "x" does not exist')
    expect(cleanDbError("Error invoking remote method 'x': Error: boom")).toBe('Boom')
    expect(cleanDbError('')).toBe('')
  })
})

describe('suggestLikeCastFix', () => {
  it('the screenshot case: quoted mixed-case column on uuid', () => {
    const r = suggestLikeCastFix(`"teamId" like 'tushar'`, err('uuid'), cols)!
    expect(r.fixedWhere).toBe(`"teamId"::text like 'tushar'`)
    expect(r.message).toBe('`"teamId"` is of type uuid; LIKE only works on text. Cast it: `"teamId"::text like \'tushar\'`')
  })
  it('works without column metadata (uses the type from the error)', () => {
    const r = suggestLikeCastFix(`"teamId" like 'x'`, err('uuid'), [])!
    expect(r.fixedWhere).toBe(`"teamId"::text like 'x'`)
    expect(r.message).toContain('is of type uuid')
  })
  it('uses the real type name from the loaded columns', () => {
    const r = suggestLikeCastFix(`created like '2020%'`, err('timestamp'), cols)!
    expect(r.fixedWhere).toBe(`created::text like '2020%'`)
    expect(r.message).toContain('timestamp without time zone')
  })
  it('handles table / alias prefixes', () => {
    expect(suggestLikeCastFix(`t."teamId" like 'x'`, err('uuid'), cols)!.fixedWhere).toBe(`t."teamId"::text like 'x'`)
    expect(suggestLikeCastFix(`public.users.id like '1%'`, err('integer'), cols)!.fixedWhere).toBe(`public.users.id::text like '1%'`)
  })
  it('is case-insensitive on the keyword and handles ILIKE / NOT LIKE / NOT ILIKE', () => {
    expect(suggestLikeCastFix(`id LIKE '1%'`, err('integer'), cols)!.fixedWhere).toBe(`id::text LIKE '1%'`)
    const il = suggestLikeCastFix(`id ILike '1%'`, err('integer', '~~*'), cols)!
    expect(il.fixedWhere).toBe(`id::text ILike '1%'`)
    expect(il.message).toContain('ILIKE only works')
    const nl = suggestLikeCastFix(`id not like '1%'`, err('integer', '!~~'), cols)!
    expect(nl.fixedWhere).toBe(`id::text not like '1%'`)
    expect(nl.message).toContain('NOT LIKE only works')
    expect(suggestLikeCastFix(`id NOT   ILIKE '1%'`, err('integer', '!~~*'), cols)!.fixedWhere).toBe(`id::text NOT   ILIKE '1%'`)
  })
  it('fixes only the offending operand among several conditions', () => {
    const w = `name like 'a%' and "teamId" like 'x' or id > 3`
    expect(suggestLikeCastFix(w, err('uuid'), cols)!.fixedWhere).toBe(`name like 'a%' and "teamId"::text like 'x' or id > 3`)
  })
  it('without metadata, an already-cast first operand is skipped', () => {
    const w = `a::text like 'a%' and b like 'x'`
    expect(suggestLikeCastFix(w, err('uuid'), [])!.fixedWhere).toBe(`a::text like 'a%' and b::text like 'x'`)
  })
  it('leaves the other operator kinds alone', () => {
    const w = `a ilike 'a%' and b like 'x'`
    expect(suggestLikeCastFix(w, err('uuid'), [])!.fixedWhere).toBe(`a ilike 'a%' and b::text like 'x'`)
  })
  it('does not touch string literals', () => {
    expect(suggestLikeCastFix(`name = 'x like y' and id like '1'`, err('integer'), cols)!.fixedWhere)
      .toBe(`name = 'x like y' and id::text like '1'`)
    expect(suggestLikeCastFix(`name = 'id like ''x'''`, err('integer'), cols)).toBeNull()
  })
  it('is careful with parentheses', () => {
    expect(suggestLikeCastFix(`(id like '1%' or id like '2%')`, err('integer'), cols)!.fixedWhere)
      .toBe(`(id::text like '1%' or id like '2%')`)
    expect(suggestLikeCastFix(`name = 'a' and (id like '1%')`, err('integer'), cols)!.fixedWhere)
      .toBe(`name = 'a' and (id::text like '1%')`)
    expect(suggestLikeCastFix(`(id) like '1%'`, err('integer'), cols)).toBeNull()
  })
  it('does not recast an already cast column', () => {
    expect(suggestLikeCastFix(`"teamId"::text like 'x'`, err('uuid'), cols)).toBeNull()
  })
  it('prefers the operand whose known type matches the error', () => {
    const w = `id like '1%' and "teamId" like 'x'`
    expect(suggestLikeCastFix(w, err('uuid'), cols)!.fixedWhere).toBe(`id like '1%' and "teamId"::text like 'x'`)
  })
  it('skips operands known to be text', () => {
    expect(suggestLikeCastFix(`name like 'a%'`, err('uuid'), cols)).toBeNull()
  })
  it('ignores unrelated errors and text types', () => {
    expect(suggestLikeCastFix(`id like 'x'`, 'error: column "id" does not exist', cols)).toBeNull()
    expect(suggestLikeCastFix(`id like 'x'`, err('text'), cols)).toBeNull()
    expect(suggestLikeCastFix(``, err('uuid'), cols)).toBeNull()
  })
  it('accepts jsonb / boolean types', () => {
    expect(suggestLikeCastFix(`data like '%x%'`, err('jsonb'), [])!.fixedWhere).toBe(`data::text like '%x%'`)
    expect(suggestLikeCastFix(`flag like 't'`, err('boolean'), [])!.fixedWhere).toBe(`flag::text like 't'`)
  })
})

describe('suggestColumnCaseFix', () => {
  const e = (c: string): string => `error: column "${c}" does not exist`
  it('offers the quoted column when it exists with different case', () => {
    const r = suggestColumnCaseFix(`teamid = 'x'`, e('teamid'), cols)!
    expect(r.fixedWhere).toBe(`"teamId" = 'x'`)
    expect(r.message).toContain('`"teamId"`')
  })
  it('rewrites every occurrence, prefixes and quoted wrong-case names, not strings', () => {
    const r = suggestColumnCaseFix(`t.teamid is not null and "teamid" <> 'teamid'`, e('teamid'), cols)!
    expect(r.fixedWhere).toBe(`t."teamId" is not null and "teamId" <> 'teamid'`)
  })
  it('handles the unquoted pg wording `column t.x does not exist`', () => {
    expect(suggestColumnCaseFix(`t.teamid = 1`, 'column t.teamid does not exist', cols)!.fixedWhere).toBe(`t."teamId" = 1`)
  })
  it('plain hint without fix when nothing matches', () => {
    const r = suggestColumnCaseFix(`nope = 1`, e('nope'), cols)!
    expect(r.fixedWhere).toBeUndefined()
    expect(r.message).toMatch(/^Column not found - check the name\/case/)
  })
  it('ignores other errors', () => {
    expect(suggestColumnCaseFix(`x`, 'syntax error', cols)).toBeNull()
  })
})

describe('suggestInvalidInput / suggestHint', () => {
  it('mentions the column type', () => {
    expect(suggestInvalidInput('error: invalid input syntax for type uuid: "tushar"')!.message)
      .toBe("Value doesn't match the column type (uuid).")
    expect(suggestInvalidInput('invalid input syntax for type integer: "a"')!.message).toContain('(integer)')
    expect(suggestInvalidInput('boom')).toBeNull()
  })
  it('suggestHint picks the right helper', () => {
    expect(suggestHint(`"teamId" like 'x'`, err('uuid'), cols)!.fixedWhere).toBe(`"teamId"::text like 'x'`)
    expect(suggestHint(`teamid = 1`, 'column "teamid" does not exist', cols)!.fixedWhere).toBe(`"teamId" = 1`)
    expect(suggestHint(`id = 'a'`, 'invalid input syntax for type integer: "a"', cols)!.fixedWhere).toBeUndefined()
    expect(suggestHint(`x`, 'syntax error at or near "x"', cols)).toBeNull()
  })
})
