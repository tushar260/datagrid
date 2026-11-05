import { describe, expect, it } from 'vitest'
import {
  applyTableFilter,
  buildAddColumn,
  buildCreateTable,
  matchRule,
  quoteIdent,
  validateNewTable,
  type NewColumn,
  type PatternRule
} from '../src/shared'

const col = (over: Partial<NewColumn> = {}): NewColumn => ({
  name: 'id',
  type: 'integer',
  nullable: true,
  isPk: false,
  ...over
})

describe('quoteIdent', () => {
  it.each([
    ['users', '"users"'],
    ['Mixed Case', '"Mixed Case"'],
    ['we"ird', '"we""ird"'],
    ['"', '""""'],
    ['', '""'],
    ['a;drop table x', '"a;drop table x"']
  ])('%j -> %s', (input, out) => {
    expect(quoteIdent(input)).toBe(out)
  })

  it('cannot be broken out of by an embedded quote', () => {
    const q = quoteIdent('x"; drop table users; --')
    // every inner quote is doubled, so the identifier stays one token
    expect(q).toBe('"x""; drop table users; --"')
    expect(q.slice(1, -1).replace(/""/g, '')).not.toContain('"')
  })
})

describe('validateNewTable', () => {
  it('accepts a normal definition', () => {
    expect(validateNewTable('t', [col(), col({ name: 'name', type: 'varchar(20)' })])).toBeNull()
  })

  it('requires a table name and at least one column', () => {
    expect(validateNewTable('', [col()])).toBe('Table name is required')
    expect(validateNewTable('   ', [col()])).toBe('Table name is required')
    expect(validateNewTable('t', [])).toBe('Add at least one column')
  })

  it('rejects empty column names / types, reporting the 1-based position', () => {
    expect(validateNewTable('t', [col(), col({ name: '  ' })])).toBe('Column 2: name is required')
    expect(validateNewTable('t', [col({ type: ' ' })])).toBe('Column "id": type is required')
  })

  it('rejects duplicate column names (after trimming)', () => {
    expect(validateNewTable('t', [col({ name: 'a' }), col({ name: ' a ' })])).toBe('Duplicate column name "a"')
  })

  it.each([
    'integer',
    'varchar(255)',
    'numeric(10, 2)',
    'timestamp with time zone',
    'character varying(10)',
    'int[]',
    'text[]',
    '_int4',
    'my_enum'
  ])('accepts type %j', (type) => {
    expect(validateNewTable('t', [col({ type })])).toBeNull()
  })

  it.each([
    'int; drop table x',
    'int -- comment',
    'int/*x*/',
    'int)',
    '(int',
    'numeric(10,2',
    'numeric((10,2)',
    '1int',
    'int"',
    "int'",
    'int\nint2',
    'int = 1',
    'int$'
  ])('rejects type %j', (type) => {
    expect(validateNewTable('t', [col({ type })])).toBe(`Column "id": invalid type "${type.trim()}"`)
  })

  it.each([
    ["now(); drop table x", ';'],
    ["'a' -- x", '--'],
    ["1 /* x", '/*'],
    ["1 */", '*/']
  ])('rejects default %j containing %s', (d) => {
    expect(validateNewTable('t', [col({ default: d })])).toMatch(/default must not contain/)
  })

  it.each(["now()", "'x'", "0", "gen_random_uuid()", "(1 + 2)", "'ab'"])('accepts default %j', (d) => {
    expect(validateNewTable('t', [col({ default: d })])).toBeNull()
  })

  it('treats an absent or blank default as "no default"', () => {
    expect(validateNewTable('t', [col({ default: undefined })])).toBeNull()
    expect(validateNewTable('t', [col({ default: '   ' })])).toBeNull()
  })
})

describe('buildCreateTable', () => {
  it('quotes schema/table/column names and lays out columns one per line', () => {
    const sql = buildCreateTable('public', 'my table', [
      col({ name: 'id', type: 'serial', nullable: false, isPk: true }),
      col({ name: 'Full Name', type: 'text' })
    ])
    expect(sql).toBe(
      'create table "public"."my table" (\n' +
        '  "id" serial not null,\n' +
        '  "Full Name" text,\n' +
        '  primary key ("id")\n' +
        ');'
    )
  })

  it('supports composite primary keys (in column order) and forces NOT NULL on PK columns', () => {
    const sql = buildCreateTable('s', 't', [
      col({ name: 'a', nullable: true, isPk: true }),
      col({ name: 'b' }),
      col({ name: 'c', isPk: true })
    ])
    expect(sql).toContain('  "a" integer not null,')
    expect(sql).toContain('  "b" integer,')
    expect(sql).toContain('  "c" integer not null,')
    expect(sql).toContain('  primary key ("a", "c")')
  })

  it('omits the primary key clause when no column is a PK', () => {
    expect(buildCreateTable('s', 't', [col()])).not.toContain('primary key')
  })

  it('adds trimmed defaults before NOT NULL', () => {
    const sql = buildCreateTable('s', 't', [col({ name: 'n', nullable: false, default: '  0  ' })])
    expect(sql).toContain('  "n" integer default 0 not null')
  })

  it('trims names and types', () => {
    const sql = buildCreateTable('s', '  t  ', [col({ name: '  x ', type: '  text ' })])
    expect(sql).toBe('create table "s"."t" (\n  "x" text\n);')
  })

  it('escapes quotes in schema and table names', () => {
    expect(buildCreateTable('s"s', 't"t', [col()])).toMatch(/^create table "s""s"\."t""t" \(/)
  })
})

describe('buildAddColumn', () => {
  it('builds a plain add column', () => {
    expect(buildAddColumn('public', 'users', col({ name: 'age' }))).toBe(
      'alter table "public"."users" add column "age" integer;'
    )
  })

  it('adds default and not null in that order', () => {
    expect(buildAddColumn('s', 't', col({ name: 'c', type: 'text', nullable: false, default: "'x'" }))).toBe(
      `alter table "s"."t" add column "c" text default 'x' not null;`
    )
  })

  it('does not add NOT NULL for isPk alone (a single column cannot add a PK here)', () => {
    expect(buildAddColumn('s', 't', col({ nullable: true, isPk: true }))).toBe(
      'alter table "s"."t" add column "id" integer;'
    )
  })
})

describe('matchRule', () => {
  const r = (mode: PatternRule['mode'], pattern: string): PatternRule => ({ mode, pattern })

  it.each([
    ['starts', 'scrut_', 'scrut_events', true],
    ['starts', 'scrut_', 'my_scrut_events', false],
    ['starts', 'SCRUT_', 'scrut_events', true], // case-insensitive
    ['contains', 'events', 'scrut_events_2024', true],
    ['contains', 'EVENTS', 'scrut_events_2024', true],
    ['contains', 'zzz', 'scrut_events_2024', false],
    ['ends', '_2024', 'scrut_events_2024', true],
    ['ends', '_2024', 'scrut_events_2024_x', false],
    ['regex', '^scrut_[0-9]+$', 'scrut_123', true],
    ['regex', '^scrut_[0-9]+$', 'scrut_12a', false],
    ['regex', 'EVENTS', 'scrut_events', true], // regex is case-insensitive too
    ['regex', 'a|b', 'xbx', true]
  ] as const)('%s %j vs %j -> %s', (mode, pattern, name, expected) => {
    expect(matchRule(r(mode, pattern), name)).toBe(expected)
  })

  it.each(['starts', 'contains', 'ends', 'regex'] as const)('empty %s pattern matches everything', (mode) => {
    expect(matchRule(r(mode, ''), 'anything')).toBe(true)
  })

  it.each(['(', '[a-', '*abc', 'a{2,1}'])('invalid regex %j matches nothing (and does not throw)', (p) => {
    expect(matchRule(r('regex', p), 'abc')).toBe(false)
  })

  it('treats regex metacharacters literally in non-regex modes', () => {
    expect(matchRule(r('contains', 'a.c'), 'abc')).toBe(false)
    expect(matchRule(r('contains', 'a.c'), 'xa.cx')).toBe(true)
    expect(matchRule(r('starts', '('), '(x')).toBe(true)
  })
})

describe('applyTableFilter', () => {
  const names = ['users', 'orders', 'scrut_a', 'scrut_b', 'Scrut_C']

  it('undefined / empty filter keeps everything (same array)', () => {
    expect(applyTableFilter(undefined, names)).toBe(names)
    expect(applyTableFilter({}, names)).toEqual(names)
  })

  it('explicit list keeps only listed names, in the database order', () => {
    expect(applyTableFilter({ list: ['orders', 'users', 'gone'] }, names)).toEqual(['users', 'orders'])
  })

  it('an empty explicit list hides everything', () => {
    expect(applyTableFilter({ list: [] }, names)).toEqual([])
  })

  it('explicit list is case-sensitive', () => {
    expect(applyTableFilter({ list: ['scrut_c'] }, names)).toEqual([])
    expect(applyTableFilter({ list: ['Scrut_C'] }, names)).toEqual(['Scrut_C'])
  })

  it('a rule wins over the list, and picks up new matching tables', () => {
    const f = { list: ['users'], rule: { mode: 'starts', pattern: 'scrut_' } as PatternRule }
    expect(applyTableFilter(f, names)).toEqual(['scrut_a', 'scrut_b', 'Scrut_C'])
    expect(applyTableFilter(f, [...names, 'scrut_d'])).toContain('scrut_d')
  })

  it('"X of Y" badge: filtered count over total', () => {
    const f = { rule: { mode: 'contains', pattern: 'scrut' } as PatternRule }
    expect(`${applyTableFilter(f, names).length} of ${names.length}`).toBe('3 of 5')
    expect(`${applyTableFilter({ list: ['users'] }, names).length} of ${names.length}`).toBe('1 of 5')
  })

  it('an invalid regex rule hides everything', () => {
    expect(applyTableFilter({ rule: { mode: 'regex', pattern: '(' } }, names)).toEqual([])
  })
})
