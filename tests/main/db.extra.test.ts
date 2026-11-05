import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, RowsQuery, NewColumn } from '../../src/shared'

// A richer fake `pg` than db.test.ts: Pool.query can throw coded errors, Client is recorded, runQuery results scripted.
const h = vi.hoisted(() => {
  type Call = { pool: string; text: string; values?: unknown }
  const state = {
    calls: [] as Call[],
    poolOpts: [] as Record<string, unknown>[],
    clients: [] as { opts: Record<string, unknown>; log: string[]; ended: boolean; connected: boolean }[],
    poolRespond: (_text: string, _db: string): { rows: unknown[] } | Error => ({ rows: [] }),
    connRespond: (_text: string): unknown => ({ rows: [] }),
    connLog: [] as { text: unknown; values?: unknown[] }[],
    clientFailConnect: false,
    clientFailQuery: false,
    released: 0,
    poolEnded: 0,
    failEnd: false
  }
  return state
})

vi.mock('pg', () => {
  class Pool {
    opts: Record<string, unknown>
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      h.poolOpts.push(opts)
    }
    on(): this {
      return this
    }
    async query(text: string, values?: unknown): Promise<unknown> {
      h.calls.push({ pool: String(this.opts.database), text, values })
      const r = h.poolRespond(text, String(this.opts.database))
      if (r instanceof Error) throw r
      return r
    }
    async connect(): Promise<unknown> {
      return {
        query: async (text: unknown, values?: unknown[]) => {
          h.connLog.push({ text, values })
          return h.connRespond(typeof text === 'string' ? text : (text as { text: string }).text)
        },
        release: () => void h.released++
      }
    }
    async end(): Promise<void> {
      h.poolEnded++
      if (h.failEnd) throw new Error('end failed')
    }
  }
  class Client {
    rec: { opts: Record<string, unknown>; log: string[]; ended: boolean; connected: boolean }
    constructor(opts: Record<string, unknown>) {
      this.rec = { opts, log: [], ended: false, connected: false }
      h.clients.push(this.rec)
    }
    async connect(): Promise<void> {
      if (h.clientFailConnect) throw new Error('connect failed')
      this.rec.connected = true
    }
    async query(text: string): Promise<void> {
      this.rec.log.push(text)
      if (h.clientFailQuery) throw new Error('client query failed')
    }
    async end(): Promise<void> {
      this.rec.ended = true
    }
  }
  return { Pool, Client, default: { Pool, Client } }
})

import {
  addColumn, applyChanges, buildChangeStatements, buildRowsSql, closeAll, createDatabase, createSchema, createTable,
  dropDatabase, dropTable, fetchRows, getColumns, getIndexes, listAllSchemas, listDatabases, listRoles, listSchemas,
  listTablespaces, listTables, q, renameTable, runQuery, schemaTotal, tableNames, testConnection
} from '../../src/main/db'

const ds = (over: Partial<DataSource> = {}): DataSource => ({
  id: 'dsX', name: 'x', host: 'h', port: 5432, user: 'u', password: 'p', database: 'postgres', ssl: false, ...over
})
const rq = (over: Partial<RowsQuery> = {}): RowsQuery => ({
  dsId: 'dsX', database: 'd', schema: 's', table: 't', limit: 100, offset: 0, ...over
})
const col = (over: Partial<NewColumn> = {}): NewColumn => ({ name: 'a', type: 'int', nullable: true, isPk: false, ...over })

beforeEach(async () => {
  await closeAll()
  h.calls.length = 0
  h.poolOpts.length = 0
  h.clients.length = 0
  h.connLog.length = 0
  h.poolRespond = () => ({ rows: [] })
  h.connRespond = () => ({ rows: [] })
  h.clientFailConnect = false
  h.clientFailQuery = false
  h.released = 0
  h.poolEnded = 0
  h.failEnd = false
})

describe('buildRowsSql – precedence & edge cases', () => {
  it('filters + typed ORDER BY + header sort + limit/offset: typed expression wins, header ignored, binds stay $1/$2', () => {
    const b = buildRowsSql(rq({ where: 'a > 1', orderExpr: 'b desc', orderBy: { column: 'c', desc: true } }))
    // REGRESSION: typed ORDER BY sorts in an inner query over the real columns (a bare `order by id` would
    // otherwise bind to the text-cast output column and sort 99 > 250)
    expect(b.rowsSql(['a'])).toBe('select t."a"::text as "a" from (select t.* from "s"."t" as t where a > 1 order by b desc limit $1 offset $2) as t')
    expect(b.order).toBe(' order by b desc')
    expect(b.raw).toBe(true)
    expect(b.countSql).toBe('select count(*)::int as n from "s"."t" as t where a > 1 limit $1')
  })

  it('header sort alone is not raw; WHERE alone is raw; ORDER BY alone is raw', () => {
    expect(buildRowsSql(rq({ orderBy: { column: 'c', desc: false } })).raw).toBe(false)
    expect(buildRowsSql(rq({ where: 'x' })).raw).toBe(true)
    expect(buildRowsSql(rq({ orderExpr: 'x' })).raw).toBe(true)
    expect(buildRowsSql(rq({ where: '   ', orderExpr: '   ' })).raw).toBe(false)
  })

  it.each([
    ['semicolon', 'a; drop table t'],
    ['line comment', 'a -- hi'],
    ['block comment open', 'a /* hi'],
    ['block comment close', 'a */'],
    ['trailing semicolon', 'a;'],
    ['prefixed order by then semicolon', 'order by a; select 1']
  ])('ORDER BY with %s throws', (_n, expr) => {
    expect(() => buildRowsSql(rq({ orderExpr: expr }))).toThrow(/must not contain/)
  })

  it('unicode, quotes and very long ORDER BY expressions pass (only ; and comments are blocked)', () => {
    expect(buildRowsSql(rq({ orderExpr: '"naïve ☃" desc, lower(名前)' })).order).toBe(' order by "naïve ☃" desc, lower(名前)')
    const long = Array.from({ length: 5000 }, (_, i) => `c${i}`).join(', ')
    expect(buildRowsSql(rq({ orderExpr: long })).order).toBe(` order by ${long}`)
  })

  it('"ORDER   BY" with odd whitespace/case is stripped; "order byx" is not', () => {
    expect(buildRowsSql(rq({ orderExpr: 'ORDER\n  BY\tid' })).order).toBe(' order by id')
    expect(buildRowsSql(rq({ orderExpr: 'order byx' })).order).toBe(' order by order byx')
  })

  it('WHERE is passed through verbatim (even with injection text: it runs read-only with bind params)', () => {
    const b = buildRowsSql(rq({ where: "1=1; drop table t; --" }))
    expect(b.where).toBe(' where 1=1; drop table t; --')
  })

  it('column / table names with quotes, spaces, uppercase and reserved words are quoted', () => {
    const b = buildRowsSql(rq({ schema: 'My"S', table: 'select', orderBy: { column: 'Weird "col"', desc: true } }))
    expect(b.from).toBe('"My""S"."select"')
    expect(b.order).toBe(' order by t."Weird ""col""" desc')
    expect(b.rowsSql(['Order', 'a"b'])).toContain('t."Order"::text as "Order", t."a""b"::text as "a""b"')
  })

  it('empty column list still produces the template (callers always pass columns)', () => {
    expect(buildRowsSql(rq()).rowsSql([])).toMatch(/^select\s+from/)
  })
})

describe('REGRESSION: typed ORDER BY on a column sorts by the real type, not the ::text output alias', () => {
  it('typed expression: inner query orders/pages, outer only casts; binds unchanged', () => {
    const b = buildRowsSql(rq({ orderExpr: 'id desc' }))
    expect(b.rowsSql(['id', 'x'])).toBe(
      'select t."id"::text as "id", t."x"::text as "x" from (select t.* from "s"."t" as t order by id desc limit $1 offset $2) as t'
    )
  })

  it('no typed expression: the flat query shape is kept (header sort is qualified, so it is safe)', () => {
    expect(buildRowsSql(rq({ orderBy: { column: 'id', desc: false } })).rowsSql(['id'])).toBe(
      'select t."id"::text as "id" from "s"."t" as t order by t."id" asc limit $1 offset $2'
    )
    expect(buildRowsSql(rq()).rowsSql(['id'])).not.toContain('(select')
  })
})

describe('buildChangeStatements – more edge cases', () => {
  it('empty changes -> no statements', () => {
    expect(buildChangeStatements('s', 't', { updates: [], inserts: [], deletes: [] })).toEqual([])
  })

  it('composite primary keys on update and delete: AND-ed, parameters numbered after the SET list', () => {
    const [u] = buildChangeStatements('s', 't', { updates: [{ pk: { a: '1', b: '2' }, set: { c: 'x', d: 'y' } }], inserts: [], deletes: [] })
    expect(u.text).toBe('update "s"."t" set "c" = $1, "d" = $2 where "a"::text = $3 and "b"::text = $4')
    expect(u.values).toEqual(['x', 'y', '1', '2'])
    const [d] = buildChangeStatements('s', 't', { updates: [], inserts: [], deletes: [{ a: '1', b: '2' }] })
    expect(d.text).toBe('delete from "s"."t" where "a"::text = $1 and "b"::text = $2')
    expect(d.values).toEqual(['1', '2'])
  })

  it('mixed null/non-null composite pk: null skips a placeholder and later params stay contiguous', () => {
    const [d] = buildChangeStatements('s', 't', { updates: [], inserts: [], deletes: [{ a: null, b: '2', c: null, d: '4' }] })
    expect(d.text).toBe('delete from "s"."t" where "a" is null and "b"::text = $1 and "c" is null and "d"::text = $2')
    expect(d.values).toEqual(['2', '4'])
  })

  it('all-null pk is a legal (if odd) delete with no bind values', () => {
    const [d] = buildChangeStatements('s', 't', { updates: [], inserts: [], deletes: [{ a: null }] })
    expect(d.values).toEqual([])
  })

  it('weird identifiers are doubled-quoted everywhere', () => {
    const out = buildChangeStatements('Sch"ema', 'Table Name', {
      updates: [{ pk: { 'I"d': '1' }, set: { 'Select': 'v', 'col space': null } }],
      inserts: [{ 'UPPER': '1', 'a"b': null }],
      deletes: [{ 'I"d': '9' }]
    })
    expect(out[0].text).toBe('update "Sch""ema"."Table Name" set "Select" = $1, "col space" = $2 where "I""d"::text = $3')
    expect(out[1].text).toBe('insert into "Sch""ema"."Table Name" ("UPPER", "a""b") values ($1, $2)')
    expect(out[1].values).toEqual(['1', null])
    expect(out[2].text).toBe('delete from "Sch""ema"."Table Name" where "I""d"::text = $1')
  })

  it('update with an empty SET and a pk produces invalid-looking SQL only if called that way (guard: keys empty)', () => {
    const [u] = buildChangeStatements('s', 't', { updates: [{ pk: { id: '1' }, set: {} }], inserts: [], deletes: [] })
    // documented current behaviour: callers never send empty updates; the statement is still parametrised
    expect(u.values).toEqual(['1'])
  })

  it('an update with an empty pk object refuses (no table-wide update); so does a delete', () => {
    expect(() => buildChangeStatements('s', 't', { updates: [{ pk: {}, set: { a: 1 } }], inserts: [], deletes: [] })).toThrow(/no primary key/)
    expect(() => buildChangeStatements('s', 't', { updates: [], inserts: [], deletes: [{}] })).toThrow(/no primary key/)
  })

  it('values of any JS type are passed through untouched (null, number, boolean, object)', () => {
    const obj = { a: 1 }
    const [i] = buildChangeStatements('s', 't', { updates: [], inserts: [{ a: null, b: 0, c: false, d: obj, e: '' }], deletes: [] })
    expect(i.values).toEqual([null, 0, false, obj, ''])
  })

  it('insert order: statements for many rows keep their order and each restarts at $1', () => {
    const out = buildChangeStatements('s', 't', { updates: [], inserts: [{ a: '1' }, {}, { b: '2', c: '3' }], deletes: [] })
    expect(out.map((s) => s.text)).toEqual([
      'insert into "s"."t" ("a") values ($1)',
      'insert into "s"."t" default values',
      'insert into "s"."t" ("b", "c") values ($1, $2)'
    ])
    expect(out[1].values).toBeUndefined()
  })
})

describe('simple listing queries', () => {
  it('testConnection returns the version and ends its own pool even when the query fails', async () => {
    h.poolRespond = () => ({ rows: [{ v: 'PostgreSQL 16' }] })
    expect(await testConnection(ds({ database: '' }))).toBe('PostgreSQL 16')
    expect(h.poolOpts.at(-1)).toMatchObject({ database: 'postgres', max: 1, ssl: false })
    expect(h.poolEnded).toBe(1)
    h.poolRespond = () => new Error('nope')
    await expect(testConnection(ds({ ssl: true }))).rejects.toThrow('nope')
    expect(h.poolEnded).toBe(2)
    expect(h.poolOpts.at(-1)).toMatchObject({ ssl: { rejectUnauthorized: false } })
  })

  it('pool options: keepalive, idle timeout, ssl on', async () => {
    await listDatabases(ds({ ssl: true }))
    expect(h.poolOpts[0]).toMatchObject({ max: 4, keepAlive: true, idleTimeoutMillis: 600000, ssl: { rejectUnauthorized: false } })
  })

  it('falls back to the "postgres" database when the data source has none', async () => {
    await listDatabases(ds({ database: '' }))
    expect(h.poolOpts[0]).toMatchObject({ database: 'postgres' })
  })

  it('listSchemas / listAllSchemas / schemaTotal / roles / tablespaces map rows', async () => {
    h.poolRespond = (t) =>
      /schema_name/.test(t) ? { rows: [{ schema_name: 'a' }, { schema_name: 'b' }] }
      : /nspname from/.test(t) ? { rows: [{ nspname: 'pg_catalog' }, { nspname: 'public' }] }
      : /count\(\*\)/.test(t) ? { rows: [{ n: 7 }] }
      : /rolname/.test(t) ? { rows: [{ rolname: 'r1' }] }
      : { rows: [{ spcname: 'pg_default' }] }
    expect(await listSchemas(ds(), 'd')).toEqual(['a', 'b'])
    expect(await listAllSchemas(ds(), 'd')).toEqual(['pg_catalog', 'public'])
    expect(await schemaTotal(ds(), 'd')).toBe(7)
    expect(await listRoles(ds())).toEqual(['r1'])
    expect(await listTablespaces(ds())).toEqual(['pg_default'])
  })

  it('listSchemas excludes information_schema and pg_* in SQL', async () => {
    await listSchemas(ds(), 'd')
    expect(h.calls[0].text).toMatch(/<> 'information_schema'/)
    expect(h.calls[0].text).toContain("not like 'pg\\_%'")
  })

  it('tableNames groups by schema', async () => {
    h.poolRespond = () => ({ rows: [{ schema: 'a', name: 't1' }, { schema: 'b', name: 'x' }, { schema: 'a', name: 't2' }] })
    expect(await tableNames(ds(), 'd')).toEqual({ a: ['t1', 't2'], b: ['x'] })
    h.poolRespond = () => ({ rows: [] })
    expect(await tableNames(ds(), 'd')).toEqual({})
  })

  it('getColumns maps is_pk -> isPk and binds schema/table', async () => {
    h.poolRespond = () => ({ rows: [{ name: 'id', type: 'integer', nullable: false, is_pk: true }] })
    expect(await getColumns(ds(), 'd', 's', 't')).toEqual([{ name: 'id', type: 'integer', nullable: false, isPk: true }])
    expect(h.calls[0].values).toEqual(['s', 't'])
  })

  it('getIndexes returns rows as-is and binds schema/table', async () => {
    h.poolRespond = () => ({ rows: [{ name: 'i', definition: 'CREATE INDEX' }] })
    expect(await getIndexes(ds(), 'd', 's', 't')).toEqual([{ name: 'i', definition: 'CREATE INDEX' }])
    expect(h.calls[0].values).toEqual(['s', 't'])
  })

  it('listTables classifies view / matview / foreign / partitioned in SQL', async () => {
    await listTables(ds(), 'd', 's')
    expect(h.calls[0].text).toContain("when 'v' then 'view'")
    expect(h.calls[0].text).toContain("when 'm' then 'matview'")
    expect(h.calls[0].text).toContain("when 'f' then 'foreign'")
    expect(h.calls[0].text).toContain("when 'p' then 'table'")
  })
})

describe('renameTable / dropTable / dropDatabase', () => {
  it('rename quotes everything', async () => {
    await renameTable(ds(), 'd', 'S"1', 'old t', 'new"t')
    expect(h.calls[0].text).toBe('alter table "S""1"."old t" rename to "new""t"')
  })

  it.each([
    ['table', 'table'], ['view', 'view'], ['matview', 'materialized view'], ['foreign', 'foreign table'], ['whatever', 'table'], ['', 'table']
  ])('dropTable kind %j -> drop %s', async (kind, what) => {
    await dropTable(ds(), 'd', 's', 't"x', kind)
    expect(h.calls[0].text).toBe(`drop ${what} "s"."t""x"`)
  })

  it('dropDatabase runs from "postgres" (or template1 for "postgres") and ends pools on the target first', async () => {
    await listTables(ds(), 'victim', 's') // open a pool on victim
    await listTables(ds(), 'keeper', 's')
    const before = h.poolEnded
    await dropDatabase(ds(), 'victim')
    expect(h.poolEnded).toBe(before + 1) // only the victim pool
    expect(h.calls.at(-1)).toMatchObject({ pool: 'postgres', text: 'drop database "victim"' })
    await dropDatabase(ds(), 'postgres')
    expect(h.calls.at(-1)).toMatchObject({ pool: 'template1', text: 'drop database "postgres"' })
  })

  it('dropDatabase survives a failing pool.end()', async () => {
    await listTables(ds(), 'victim', 's')
    h.failEnd = true
    await expect(dropDatabase(ds(), 'victim')).resolves.toBeUndefined()
  })

  it('closeAll(dsId) only ends that data source; a prefix-sharing id is not matched by accident', async () => {
    await listTables(ds({ id: 'a' }), 'd', 's')
    await listTables(ds({ id: 'ab' }), 'd', 's')
    await closeAll('a')
    expect(h.poolEnded).toBe(1)
    await closeAll()
    expect(h.poolEnded).toBe(2)
  })
})

describe('createDatabase', () => {
  it('rejects an empty/blank name before touching the server', async () => {
    await expect(createDatabase(ds(), '')).rejects.toThrow('Database name is required')
    await expect(createDatabase(ds(), '   ')).rejects.toThrow('Database name is required')
    expect(h.calls).toHaveLength(0)
  })

  it('trims and quotes the name; no owner clause by default', async () => {
    await createDatabase(ds(), '  My "DB" ')
    expect(h.calls[0]).toMatchObject({ pool: 'postgres', text: 'create database "My ""DB"""' })
  })

  it('owner is trimmed, quoted and appended; blank owner is ignored', async () => {
    await createDatabase(ds(), 'x', ' Ro"le ')
    expect(h.calls[0].text).toBe('create database "x" owner "Ro""le"')
    await createDatabase(ds(), 'y', '   ')
    expect(h.calls[1].text).toBe('create database "y"')
  })

  it.each(['3D000', '42501'])('falls back to a template1 connection on error code %s', async (code) => {
    h.poolRespond = () => Object.assign(new Error('no db'), { code })
    await createDatabase(ds({ ssl: true }), 'newdb', 'me')
    expect(h.clients).toHaveLength(1)
    expect(h.clients[0].opts).toMatchObject({ database: 'template1', host: 'h', port: 5432, ssl: { rejectUnauthorized: false } })
    expect(h.clients[0].log).toEqual(['create database "newdb" owner "me"'])
    expect(h.clients[0].ended).toBe(true)
  })

  it('other errors (e.g. duplicate_database 42P04) are rethrown without a fallback', async () => {
    h.poolRespond = () => Object.assign(new Error('already exists'), { code: '42P04' })
    await expect(createDatabase(ds(), 'x')).rejects.toThrow('already exists')
    expect(h.clients).toHaveLength(0)
  })

  it('errors without a code are rethrown', async () => {
    h.poolRespond = () => new Error('plain')
    await expect(createDatabase(ds(), 'x')).rejects.toThrow('plain')
  })

  it('fallback: a failing statement still ends the client and propagates the error', async () => {
    h.poolRespond = () => Object.assign(new Error('x'), { code: '3D000' })
    h.clientFailQuery = true
    await expect(createDatabase(ds(), 'x')).rejects.toThrow('client query failed')
    expect(h.clients[0].ended).toBe(true)
  })

  it('fallback: a failing connect propagates', async () => {
    h.poolRespond = () => Object.assign(new Error('x'), { code: '42501' })
    h.clientFailConnect = true
    await expect(createDatabase(ds(), 'x')).rejects.toThrow('connect failed')
  })
})

describe('createSchema', () => {
  it('validates, trims and quotes; authorization clause for owner', async () => {
    await expect(createSchema(ds(), 'd', '  ')).rejects.toThrow('Schema name is required')
    await createSchema(ds(), 'd', ' s"1 ', ' o ')
    expect(h.calls[0]).toMatchObject({ pool: 'd', text: 'create schema "s""1" authorization "o"' })
    await createSchema(ds(), 'd', 'plain')
    expect(h.calls[1].text).toBe('create schema "plain"')
  })

  it('server errors propagate', async () => {
    h.poolRespond = () => new Error('already exists')
    await expect(createSchema(ds(), 'd', 'x')).rejects.toThrow('already exists')
  })
})

describe('createTable / addColumn', () => {
  it('rejects every validation failure before running SQL', async () => {
    const bad: [string, NewColumn[]][] = [
      ['', [col()]],
      ['t', []],
      ['t', [col({ name: ' ' })]],
      ['t', [col(), col()]],
      ['t', [col({ type: '' })]],
      ['t', [col({ type: 'int); drop table x; --' })]],
      ['t', [col({ type: 'varchar(' })]],
      ['t', [col({ default: '1; select 1' })]],
      ['t', [col({ default: '1 -- c' })]],
      ['t', [col({ default: '/* c */ 1' })]]
    ]
    for (const [n, cols] of bad) await expect(createTable(ds(), 'd', 's', n, cols)).rejects.toThrow()
    expect(h.calls).toHaveLength(0)
  })

  it('builds quoted DDL with pk / not null / default', async () => {
    await createTable(ds(), 'd', 'S"x', ' T t ', [
      col({ name: 'id', type: 'bigint', nullable: true, isPk: true }),
      col({ name: ' Select ', type: 'varchar(10)', default: "'a'" , nullable: false }),
      col({ name: 'n', type: 'numeric(10, 2)' })
    ])
    expect(h.calls[0].text).toBe(
      'create table "S""x"."T t" (\n  "id" bigint not null,\n  "Select" varchar(10) default \'a\' not null,\n  "n" numeric(10, 2),\n  primary key ("id")\n);'
    )
  })

  it('composite pk lists every pk column in order', async () => {
    await createTable(ds(), 'd', 's', 't', [col({ name: 'a', isPk: true }), col({ name: 'b', isPk: true })])
    expect(h.calls[0].text).toContain('primary key ("a", "b")')
  })

  it('addColumn validates and quotes; reserved/uppercase names ok; not-null with default', async () => {
    await addColumn(ds(), 'd', 's', 'My T', col({ name: 'Order', type: 'text', nullable: false, default: "'x'" }))
    expect(h.calls[0].text).toBe(`alter table "s"."My T" add column "Order" text default 'x' not null;`)
    await expect(addColumn(ds(), 'd', 's', 't', col({ type: 'bad;type' }))).rejects.toThrow(/invalid type/)
    await expect(addColumn(ds(), 'd', 's', '', col())).rejects.toThrow('Table name is required')
    expect(h.calls).toHaveLength(1)
  })

  it('addColumn ignores the pk flag (only nullable matters)', async () => {
    await addColumn(ds(), 'd', 's', 't', col({ isPk: true, nullable: true }))
    expect(h.calls[0].text).toBe('alter table "s"."t" add column "a" int;')
  })
})

describe('runQuery (mocked)', () => {
  const field = (name: string): { name: string } => ({ name })

  it('sets and resets search_path for the schema, releases the client', async () => {
    h.connRespond = () => ({ command: 'SELECT', rowCount: 1, fields: [field('a')], rows: [[1]] })
    const r = await runQuery(ds(), 'd', 'my"s', 'select 1')
    expect(h.connLog[0].text).toBe('set search_path to "my""s", public')
    expect(h.connLog.at(-1)!.text).toBe('reset search_path')
    expect(h.released).toBe(1)
    expect(r.results[0]).toEqual({ command: 'SELECT', rowCount: 1, fields: ['a'], rows: [['1']], truncated: false })
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('no schema: no set search_path', async () => {
    h.connRespond = () => ({ command: 'SELECT', rowCount: 0, fields: [], rows: [] })
    await runQuery(ds(), 'd', undefined, 'select 1')
    expect(h.connLog.some((c) => /^set search_path/.test(String(c.text)))).toBe(false)
  })

  it('stringifies null/undefined/Date/Buffer/object/boolean/number', async () => {
    const d = new Date('2020-01-02T03:04:05.678Z')
    h.connRespond = () => ({ command: 'SELECT', rowCount: 1, fields: [], rows: [[null, undefined, d, Buffer.from([0, 255, 16]), { a: [1] }, true, 1.5, 'x']] })
    const r = await runQuery(ds(), 'd', undefined, 'q')
    expect(r.results[0].rows[0]).toEqual([null, null, '2020-01-02T03:04:05.678Z', '\\x00ff10', '{"a":[1]}', 'true', '1.5', 'x'])
  })

  it('multi-statement: an array result becomes one entry per statement', async () => {
    h.connRespond = () => [
      { command: 'SELECT', rowCount: 1, fields: [field('a')], rows: [[1]] },
      { command: 'UPDATE', rowCount: 3, fields: [], rows: [] }
    ]
    const r = await runQuery(ds(), 'd', 's', 'select 1; update t set a=1')
    expect(r.results.map((x) => x.command)).toEqual(['SELECT', 'UPDATE'])
    expect(r.results[1].rowCount).toBe(3)
  })

  it('caps rows at 5000 and flags truncation', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => [i])
    h.connRespond = () => ({ command: 'SELECT', rowCount: 5001, fields: [field('i')], rows })
    const r = await runQuery(ds(), 'd', undefined, 'q')
    expect(r.results[0].rows).toHaveLength(5000)
    expect(r.results[0].truncated).toBe(true)
    h.connRespond = () => ({ command: 'SELECT', rowCount: 5000, fields: [field('i')], rows: rows.slice(0, 5000) })
    expect((await runQuery(ds(), 'd', undefined, 'q')).results[0].truncated).toBe(false)
  })

  it('missing command / fields / rows are tolerated', async () => {
    h.connRespond = () => ({ rowCount: null })
    const r = await runQuery(ds(), 'd', undefined, 'q')
    expect(r.results[0]).toEqual({ command: '', rowCount: null, fields: [], rows: [], truncated: false })
  })

  it('errors propagate, but search_path is still reset and the client released', async () => {
    h.connRespond = (t) => {
      if (t === 'bad sql') throw new Error('syntax error')
      return { rows: [] }
    }
    await expect(runQuery(ds(), 'd', 's', 'bad sql')).rejects.toThrow('syntax error')
    expect(h.connLog.at(-1)!.text).toBe('reset search_path')
    expect(h.released).toBe(1)
  })
})

describe('fetchRows (mocked)', () => {
  it('non-raw queries use the pool directly (no transaction)', async () => {
    h.poolRespond = (t) =>
      /attname/.test(t) ? { rows: [{ name: 'id', type: 'int', nullable: false, is_pk: true }] }
      : /count\(\*\)/.test(t) ? { rows: [{ n: 42 }] }
      : { rows: [{ id: '1' }] }
    const r = await fetchRows(ds(), rq({ orderBy: { column: 'id', desc: true } }))
    expect(r.total).toBe(42)
    expect(r.rows).toEqual([{ id: '1' }])
    expect(h.connLog).toHaveLength(0)
    const rowsCall = h.calls.find((c) => /offset \$2/.test(c.text))!
    expect(rowsCall.values).toEqual([100, 0])
    expect(h.calls.find((c) => /count\(\*\)/.test(c.text))!.values).toEqual([1])
  })

  it('raw: begin read only … rollback for both statements; client always released', async () => {
    h.poolRespond = () => ({ rows: [{ name: 'id', type: 'int', nullable: false, is_pk: true }] })
    h.connRespond = (t) => (/count/.test(t) ? { rows: [{ n: 3 }] } : { rows: [] })
    const r = await fetchRows(ds(), rq({ where: 'id > 1', orderExpr: 'id' }))
    expect(r.total).toBe(3)
    const texts = h.connLog.map((c) => String(c.text))
    expect(texts.filter((t) => t === 'begin read only')).toHaveLength(2)
    expect(texts.filter((t) => t === 'rollback')).toHaveLength(2)
    expect(h.released).toBe(2)
  })

  it('a server error from a user WHERE propagates after rollback + release', async () => {
    h.poolRespond = () => ({ rows: [{ name: 'id', type: 'int', nullable: false, is_pk: true }] })
    h.connRespond = (t) => {
      if (/count/.test(t) || /select t\./.test(t)) throw new Error('operator does not exist: uuid ~~ unknown')
      return { rows: [] }
    }
    await expect(fetchRows(ds(), rq({ where: "id like 'a%'" }))).rejects.toThrow(/operator does not exist/)
    expect(h.released).toBe(2)
  })

  it('count injection attempt is only data: stays inside the WHERE clause text, never executed as a separate statement', async () => {
    const b = buildRowsSql(rq({ where: 'true; drop table x' }))
    expect(b.countSql).toBe('select count(*)::int as n from "s"."t" as t where true; drop table x limit $1')
    // fetchRows always passes a bind value so pg uses the extended protocol (multi-statement is rejected by the server)
    h.poolRespond = () => ({ rows: [{ name: 'id', type: 'int', nullable: false, is_pk: true }] })
    await fetchRows(ds(), rq({ where: 'true; drop table x' })).catch(() => {})
    expect(h.connLog.filter((c) => /drop table/.test(String(c.text))).every((c) => (c.values?.length ?? 0) > 0)).toBe(true)
  })
})

describe('applyChanges (mocked) – ordering', () => {
  it('multi-delete runs inside a single transaction', async () => {
    await applyChanges(ds(), 'd', 's', 't', { updates: [], inserts: [], deletes: [{ id: '1' }, { id: '2' }, { id: '3' }] })
    const texts = h.connLog.map((c) => String(c.text))
    expect(texts[0]).toBe('begin')
    expect(texts.at(-1)).toBe('commit')
    expect(texts.filter((t) => t.startsWith('delete'))).toHaveLength(3)
    expect(h.released).toBe(1)
  })

  it('empty changes still begin/commit and release', async () => {
    await applyChanges(ds(), 'd', 's', 't', { updates: [], inserts: [], deletes: [] })
    expect(h.connLog.map((c) => c.text)).toEqual(['begin', 'commit'])
    expect(h.released).toBe(1)
  })

  it('q handles empty and unicode', () => {
    expect(q('')).toBe('""')
    expect(q('名前')).toBe('"名前"')
  })
})
