import { describe, expect, it } from 'vitest'
import { analyze, lex, parseTableRefs, resolveQualifier, statementRange, type SqlCtx } from '../../src/renderer/src/lib/sqlContext'
import { buildItems, matchRank, neededLookups, type SqlMeta } from '../../src/renderer/src/lib/sqlCandidates'
import { quoteName } from '../../src/renderer/src/lib/suggest'
import type { Column } from '../../src/shared'

const col = (name: string, over: Partial<Column> = {}): Column => ({ name, type: 'text', nullable: true, isPk: false, ...over })

const COLS: Record<string, Column[]> = {
  'public.users': [col('id', { type: 'integer', isPk: true }), col('email'), col('Created At'), col('order')],
  'public.orders': [col('id', { type: 'integer', isPk: true }), col('user_id', { type: 'integer' }), col('total', { type: 'numeric' })],
  'sales.invoices': [col('number'), col('amount', { type: 'numeric' })]
}
const meta: SqlMeta = {
  defaultSchema: 'public',
  schemas: ['public', 'sales', 'pg_catalog'],
  tables: {
    public: [{ name: 'users', kind: 'table' }, { name: 'orders', kind: 'table' }, { name: 'active_users', kind: 'view' }],
    sales: [{ name: 'invoices', kind: 'table' }],
    pg_catalog: [{ name: 'pg_class', kind: 'table' }]
  },
  tablesOf: (s) => meta.tables[s]?.map((t) => t.name),
  columns: (s, t) => COLS[`${s}.${t}`]
}

/** analyze with the caret marked by `|` */
const at = (sqlWithCaret: string, forced = false): { ctx: SqlCtx | null; sql: string } => {
  const caret = sqlWithCaret.indexOf('|')
  const sql = sqlWithCaret.replace('|', '')
  return { ctx: analyze(sql, caret, forced), sql }
}
const items = (s: string, forced = false): string[] => {
  const { ctx } = at(s, forced)
  return ctx ? buildItems(ctx, meta).map((i) => i.label) : []
}

describe('lex', () => {
  it('handles strings, quoted identifiers, comments and dollar quotes', () => {
    const t = lex(`select 'it''s', "a""b" -- c\n/* x /* y */ z */ $$ body ; $$ x`)
    expect(t.map((k) => k.t)).toEqual(['word', 'str', 'p', 'qid', 'comment', 'comment', 'str', 'word'])
    expect(t[3].value).toBe('a"b')
  })
})

describe('literal / comment suppression', () => {
  it.each([
    ["select 'ab|"],
    ["select 'a' + 'b|c' from t"],
    ['select "My Ta|'],
    ['select 1 -- comm|ent'],
    ['select /* sel| */ 1'],
    ['select $$ ab| $$']
  ])('no popup inside %s', (s) => {
    expect(at(s).ctx).toBeNull()
    expect(at(s, true).ctx).toBeNull()
  })
  it('works right after a closed string and on the next line of a line comment', () => {
    expect(at("select 'a' fr|").ctx?.word).toBe('fr')
    expect(at('select 1 -- c\nsel|').ctx?.word).toBe('sel')
  })
  it('no popup right after a number or a $ parameter, nor with nothing typed', () => {
    expect(at('select 12|').ctx).toBeNull()
    expect(at('limit 1|0').ctx).toBeNull()
    expect(at('where id = $1|').ctx).toBeNull()
    expect(at('select 1.|').ctx).toBeNull()
    expect(at('select |').ctx).toBeNull()
    expect(at('select |', true).ctx).not.toBeNull()
  })
})

describe('word range', () => {
  it('replaces the whole identifier around the caret, or only the part after the dot', () => {
    const a = at('select us|ers from t')
    expect([a.ctx!.start, a.ctx!.end, a.ctx!.word]).toEqual([7, 12, 'us'])
    const b = at('select u.em| from users u')
    expect(b.sql.slice(b.ctx!.start, b.ctx!.end)).toBe('em')
    expect(b.ctx!.qualifier).toEqual(['u'])
  })
})

describe('statement + table refs', () => {
  it('splits on ; outside literals', () => {
    const sql = "select ';' ; select 2"
    expect(statementRange(lex(sql), sql.length, sql.length)).toEqual([12, sql.length])
  })
  it('parses from / join / aliases / comma lists / schema qualification', () => {
    const sql =
      'select * from public.users as u, sales.invoices i left join orders o on o.user_id = u.id join "My T" using (id) where x'
    const refs = parseTableRefs(lex(sql))
    expect(refs).toEqual([
      { schema: 'public', table: 'users', alias: 'u' },
      { schema: 'sales', table: 'invoices', alias: 'i' },
      { table: 'orders', alias: 'o' },
      { table: 'My T' }
    ])
  })
  it('does not treat keywords as aliases and skips subqueries / functions', () => {
    expect(parseTableRefs(lex('select 1 from users where a'))).toEqual([{ table: 'users' }])
    expect(parseTableRefs(lex('select * from (select 1) s join generate_series(1,3) g on true'))).toEqual([])
    expect(parseTableRefs(lex('select extract(year from created_at) from users u'))).toEqual([{ table: 'users', alias: 'u' }])
  })
  it('update / insert into / delete', () => {
    expect(parseTableRefs(lex('update users u set a = 1'))).toEqual([{ table: 'users', alias: 'u' }])
    expect(parseTableRefs(lex('insert into sales.invoices (a) values (1)'))).toEqual([{ schema: 'sales', table: 'invoices' }])
    expect(parseTableRefs(lex('delete from users where id = 1'))).toEqual([{ table: 'users' }])
  })
  it('normalizes unquoted names to lower case', () => {
    expect(parseTableRefs(lex('select * from Public.Users U'))).toEqual([{ schema: 'public', table: 'users', alias: 'u' }])
  })
})

describe('clause detection', () => {
  it.each([
    ['select * from |', 'table'],
    ['select * from users u join |', 'table'],
    ['select * from users, |', 'table'],
    ['insert into |', 'table'],
    ['update |', 'table'],
    ['drop table |', 'table'],
    ['create index i on |', 'table'],
    ['select * from users u wh|', 'afterTable'],
    ['select | from users', 'column'],
    ['select count(|) from users', 'column'],
    ['select * from users where |', 'column'],
    ['select * from users u join orders o on |', 'column'],
    ['select * from users group by |', 'column'],
    ['select * from users order by |', 'column'],
    ['update users set |', 'column'],
    ['insert into users (|', 'column'],
    ['select extract(year from |', 'column'],
    ['select * from users where id in (select |', 'column'],
    ['sel|', 'start'],
    ['select 1; sel|', 'start'],
    ['select * from (|', 'start']
  ])('%s → %s', (s, clause) => {
    expect(at(s, true).ctx?.clause).toBe(clause)
  })
  it('only looks at the current statement', () => {
    expect(at('select * from users; |', true).ctx?.clause).toBe('start')
    expect(at('select a from users; select | from orders', true).ctx?.refs).toEqual([{ table: 'orders' }])
  })
})

describe('qualifier resolution', () => {
  it('resolves aliases, table names, schemas and schema.table', () => {
    const refs = parseTableRefs(lex('select * from users u join sales.invoices on true'))
    expect(resolveQualifier(['u'], refs, meta)).toEqual({ kind: 'table', schema: 'public', table: 'users' })
    expect(resolveQualifier(['invoices'], refs, meta)).toEqual({ kind: 'table', schema: 'sales', table: 'invoices' })
    expect(resolveQualifier(['sales'], refs, meta)).toEqual({ kind: 'schema', schema: 'sales' })
    expect(resolveQualifier(['orders'], [], meta)).toEqual({ kind: 'table', schema: 'public', table: 'orders' })
    expect(resolveQualifier(['sales', 'invoices'], [], meta)).toEqual({ kind: 'table', schema: 'sales', table: 'invoices' })
    expect(resolveQualifier(['nope'], [], meta)).toBeNull()
  })
  it('an alias shadows a schema of the same name', () => {
    expect(resolveQualifier(['sales'], parseTableRefs(lex('from users sales')), meta)).toEqual({ kind: 'table', schema: 'public', table: 'users' })
  })
})

describe('candidates', () => {
  it('after alias. suggests only that table\'s columns, with type + PK', () => {
    const { ctx } = at('select u.| from users u join orders o on o.user_id = u.id')
    const out = buildItems(ctx!, meta)
    expect(out.map((i) => i.label)).toEqual(['id', 'email', 'Created At', 'order'])
    expect(out[0].col?.isPk).toBe(true)
    expect(out[0].detail).toBe('integer')
    expect(items('select o.us| from users u join orders o on true')).toEqual(['user_id'])
    expect(items('select sales.invoices.| from users')).toEqual(['number', 'amount'])
  })
  it('after schema. suggests its tables', () => {
    expect(items('select * from sales.|')).toEqual(['invoices'])
  })
  it('after FROM/JOIN: tables first, then schemas, other-schema tables, keywords', () => {
    const out = items('select * from |', true)
    expect(out.slice(0, 3)).toEqual(['users', 'orders', 'active_users'])
    expect(out).toContain('sales.invoices')
    expect(out).not.toContain('pg_catalog.pg_class') // system schemas are only reachable via `pg_catalog.`
    expect(out.indexOf('sales')).toBeLessThan(out.indexOf('sales.invoices'))
    expect(out.indexOf('sales.invoices')).toBeLessThan(out.indexOf('select'))
  })
  it('table kinds map to table / view', () => {
    const { ctx } = at('select * from act|')
    expect(buildItems(ctx!, meta)[0]).toMatchObject({ kind: 'view', label: 'active_users' })
  })
  it('select list: columns of the statement tables (even those after the caret), then keywords, then tables', () => {
    const out = items('select e| from users u join orders o on true', false)
    expect(out.slice(0, 2)).toEqual(['email', 'Created At']) // prefix first, then contains
    const all = items('select | from users u join orders o on true', true)
    expect(all.slice(0, 7)).toEqual(['id', 'email', 'Created At', 'order', 'id', 'user_id', 'total'])
    expect(all.indexOf('select')).toBeGreaterThan(6)
    expect(all.indexOf('users')).toBeGreaterThan(all.indexOf('select'))
  })
  it('multi-table select list tags each column with its alias', () => {
    const { ctx } = at('select tot| from users u join orders o on true')
    expect(buildItems(ctx!, meta)[0]).toMatchObject({ label: 'total', src: 'o' })
    const { ctx: one } = at('select ema| from users u')
    expect(buildItems(one!, meta)[0].src).toBeUndefined()
  })
  it('prefix matches before contains matches, case-insensitive', () => {
    const out = items('select * from users where EM|')
    expect(out[0]).toBe('email')
    expect(matchRank('Created At', 'ate')).toBe(1)
    expect(matchRank('Created At', 'CRE')).toBe(0)
    expect(matchRank('abc', 'x')).toBe(-1)
  })
  it('quotes identifiers that need it', () => {
    const { ctx } = at('select u.| from users u')
    const out = buildItems(ctx!, meta)
    expect(out.find((i) => i.label === 'Created At')!.insert).toBe('"Created At"')
    expect(out.find((i) => i.label === 'order')!.insert).toBe('"order"')
    expect(out.find((i) => i.label === 'email')!.insert).toBe('email')
    expect(quoteName('MixedCase')).toBe('"MixedCase"')
  })
  it('schema items insert `schema.`; other-schema tables insert quoted qualified names', () => {
    const { ctx } = at('select * from sal|')
    expect(buildItems(ctx!, meta)[0]).toMatchObject({ kind: 'schema', insert: 'sales.' })
    const { ctx: c2 } = at('select * from inv|')
    expect(buildItems(c2!, meta)[0]).toMatchObject({ label: 'sales.invoices', insert: 'sales.invoices' })
  })
  it('keywords: lower-case by default, match typed case / case of the statement so far', () => {
    expect(items('sel|')[0]).toBe('select')
    expect(items('SEL|')[0]).toBe('SELECT')
    expect(items('Sel|')[0]).toBe('select')
    expect(items('SELECT * FROM users |', true)[0]).toBe('SELECT')
    expect(items('select * from users |', true)[0]).toBe('select')
    const ctx = at('SEL|').ctx!
    expect(buildItems(ctx, meta)[0].insert).toBe('SELECT ')
  })
  it('multi-word keywords and functions', () => {
    expect(items('select * from users u le|')).toContain('left join')
    expect(items('select * from users u gr|')[0]).toBe('group by')
    const { ctx } = at('select cou|')
    expect(buildItems(ctx!, meta).find((i) => i.label === 'count')).toMatchObject({ kind: 'fn', insert: 'count()', caretBack: 1 })
    const { ctx: c2 } = at('select curr|')
    expect(buildItems(c2!, meta).find((i) => i.label === 'current_date')!.insert).toBe('current_date')
  })
  it('after a table reference only continuation keywords are offered (Ctrl+Space: everything)', () => {
    expect(items('select * from users u z|')).toEqual([]) // no `primary key` hijacking Enter while typing an alias
    expect(items('select * from users u wh|')).toEqual(['where'])
    expect(items('select * from users u |', true).length).toBeGreaterThan(30)
  })
  it('closes when the word is complete and exactly equal', () => {
    expect(items('select * from orders where total|')).toEqual([])
    expect(items('select * from user|')).toContain('users')
    expect(items('select * from orders|')).toEqual([]) // only candidate is exactly `orders`
    expect(items('select * from users|')).toEqual(['users', 'active_users']) // others still match
  })
  it('unknown qualifier → nothing', () => {
    expect(items('select zz.| from users')).toEqual([])
  })
  it('Ctrl+Space with a non-matching word falls back to everything', () => {
    expect(items('select * from zzz|', true).length).toBeGreaterThan(10)
    expect(items('select * from zzz|')).toEqual([])
  })
})

describe('neededLookups (lazy metadata)', () => {
  it('only asks for columns of referenced, known tables', () => {
    const { ctx } = at('select | from users u join nope n on true join sales.invoices', true)
    expect(neededLookups(ctx!, meta).columns).toEqual([
      { schema: 'public', table: 'users' },
      { schema: 'sales', table: 'invoices' }
    ])
  })
  it('qualifier → that table; schema qualifier → schema listing; FROM context → nothing', () => {
    expect(neededLookups(at('select u.| from users u').ctx!, meta).columns).toEqual([{ schema: 'public', table: 'users' }])
    expect(neededLookups(at('select * from sales.|').ctx!, meta).schemaTables).toEqual(['sales'])
    expect(neededLookups(at('select * from |', true).ctx!, meta)).toEqual({ columns: [], schemaTables: [] })
  })
})
