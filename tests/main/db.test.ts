import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, RowsQuery } from '../../src/shared'

// ---- fake `pg`: every Pool shares one query log / scripted responses ----
const h = vi.hoisted(() => {
  type Call = { pool: string; text: string; values?: unknown[] }
  const state = {
    calls: [] as Call[],
    pools: [] as { opts: Record<string, unknown>; ended: boolean }[],
    respond: (_text: string): { rows: unknown[] } => ({ rows: [] }),
    clientLog: [] as { text: string; values?: unknown[] }[],
    failOn: null as RegExp | null,
    released: 0
  }
  return state
})

vi.mock('pg', () => {
  class Pool {
    opts: Record<string, unknown>
    rec: { opts: Record<string, unknown>; ended: boolean }
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      this.rec = { opts, ended: false }
      h.pools.push(this.rec)
    }
    on(): this {
      return this
    }
    async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
      h.calls.push({ pool: String(this.opts.database), text, values })
      return h.respond(text)
    }
    async connect(): Promise<unknown> {
      return {
        query: async (text: string, values?: unknown[]) => {
          h.clientLog.push({ text, values })
          if (h.failOn?.test(text)) throw new Error('boom')
          return h.respond(text)
        },
        release: () => void h.released++
      }
    }
    async end(): Promise<void> {
      this.rec.ended = true
    }
  }
  class Client {}
  return { Pool, Client, default: { Pool, Client } }
})

import {
  applyChanges,
  buildChangeStatements,
  buildRowsSql,
  closeAll,
  createTable,
  dropTable,
  fetchRows,
  listDatabases,
  listTables,
  q
} from '../../src/main/db'

const ds = (over: Partial<DataSource> = {}): DataSource => ({
  id: 'ds1', name: 'x', host: 'h', port: 5432, user: 'u', password: 'p', database: 'postgres', ssl: false, ...over
})
const rq = (over: Partial<RowsQuery> = {}): RowsQuery => ({
  dsId: 'ds1', database: 'd', schema: 's', table: 't', limit: 100, offset: 0, ...over
})

beforeEach(() => {
  h.calls.length = 0
  h.clientLog.length = 0
  h.pools.length = 0
  h.failOn = null
  h.released = 0
  h.respond = () => ({ rows: [] })
})

describe('q (identifier quoting)', () => {
  it.each([
    ['a', '"a"'],
    ['a b', '"a b"'],
    ['a"b', '"a""b"'],
    ['""', '""""""'],
    ['public', '"public"']
  ])('%j -> %s', (i, o) => expect(q(i)).toBe(o))
})

describe('buildRowsSql', () => {
  it('plain table: no where, no order, not raw', () => {
    const b = buildRowsSql(rq())
    expect(b.raw).toBe(false)
    expect(b.countSql).toBe('select count(*)::int as n from "s"."t" as t limit $1')
    expect(b.rowsSql(['id', 'na"me'])).toBe(
      'select t."id"::text as "id", t."na""me"::text as "na""me" from "s"."t" as t limit $1 offset $2'
    )
  })

  it('quotes schema and table', () => {
    const b = buildRowsSql(rq({ schema: 'we"ird', table: 'my table' }))
    expect(b.from).toBe('"we""ird"."my table"')
  })

  it('WHERE is appended verbatim to both count and rows queries and marks the query raw', () => {
    const b = buildRowsSql(rq({ where: "  id > 5 and name like 'a%'  " }))
    expect(b.raw).toBe(true)
    expect(b.countSql).toContain(` as t where   id > 5 and name like 'a%'   limit $1`)
    expect(b.rowsSql(['id'])).toContain(` where   id > 5 and name like 'a%'   limit $1 offset $2`)
  })

  it('blank WHERE is ignored', () => {
    const b = buildRowsSql(rq({ where: '   ' }))
    expect(b.where).toBe('')
    expect(b.raw).toBe(false)
  })

  describe('ORDER BY', () => {
    it('header sort asc/desc quotes the column and is not raw', () => {
      expect(buildRowsSql(rq({ orderBy: { column: 'na"me', desc: false } })).order).toBe(' order by t."na""me" asc')
      const d = buildRowsSql(rq({ orderBy: { column: 'id', desc: true } }))
      expect(d.order).toBe(' order by t."id" desc')
      expect(d.raw).toBe(false)
    })

    it('typed expression takes precedence over header sort and marks the query raw', () => {
      const b = buildRowsSql(rq({ orderExpr: 'name desc, id', orderBy: { column: 'id', desc: false } }))
      expect(b.order).toBe(' order by name desc, id')
      expect(b.raw).toBe(true)
    })

    it.each([
      ['order by name', 'name'],
      ['ORDER BY name', 'name'],
      ['  Order   By   name desc  ', 'name desc'],
      ['order\tby\nname', 'name']
    ])('strips a leading "order by": %j', (input, expected) => {
      expect(buildRowsSql(rq({ orderExpr: input })).order).toBe(` order by ${expected}`)
    })

    it('does not strip "order by" in the middle / a column called orderby', () => {
      expect(buildRowsSql(rq({ orderExpr: 'orderby' })).order).toBe(' order by orderby')
    })

    it('blank expression falls back to the header sort', () => {
      const b = buildRowsSql(rq({ orderExpr: '  ', orderBy: { column: 'id', desc: true } }))
      expect(b.order).toBe(' order by t."id" desc')
      expect(b.raw).toBe(false)
    })

    it('"order by" alone is treated as empty', () => {
      expect(buildRowsSql(rq({ orderExpr: 'order by ' })).order).toBe('')
    })

    it.each([
      'id; drop table users',
      'id -- comment',
      'id /* c */',
      'id */',
      'order by id; select 1',
      '(select 1) --'
    ])('rejects injection-ish ORDER BY %j', (expr) => {
      expect(() => buildRowsSql(rq({ orderExpr: expr }))).toThrow(/ORDER BY must not contain/)
    })

    it('the injection check also applies when header sort is set (typed text always validated)', () => {
      expect(() => buildRowsSql(rq({ orderExpr: 'a;b', orderBy: { column: 'id', desc: false } }))).toThrow()
    })

    it('header-sort column names with SQL metacharacters are safely quoted', () => {
      const b = buildRowsSql(rq({ orderBy: { column: 'x"; drop table t; --', desc: false } }))
      expect(b.order).toBe(' order by t."x""; drop table t; --" asc')
    })
  })
})

describe('fetchRows', () => {
  const columnsRow = { name: 'id', type: 'integer', nullable: false, is_pk: true }

  it('runs count and rows with bind parameters; limit/offset are values, never interpolated', async () => {
    h.respond = (text) =>
      /count\(\*\)/.test(text) ? { rows: [{ n: 42 }] }
      : /pg_attribute/.test(text) ? { rows: [columnsRow] }
      : { rows: [{ id: '1' }] }
    const r = await fetchRows(ds(), rq({ limit: 25, offset: 50 }))
    expect(r.total).toBe(42)
    expect(r.columns).toEqual([{ name: 'id', type: 'integer', nullable: false, isPk: true }])
    expect(r.rows).toEqual([{ id: '1' }])
    const sel = h.calls.find((c) => c.text.startsWith('select t."id"'))!
    expect(sel.values).toEqual([25, 50])
    expect(sel.text).not.toMatch(/25|50/)
    expect(h.calls.find((c) => /count\(\*\)/.test(c.text))!.values).toEqual([1])
  })

  it('user-typed WHERE runs in a read-only transaction that is always rolled back', async () => {
    h.respond = (text) => (/count\(\*\)/.test(text) ? { rows: [{ n: 0 }] } : /pg_attribute/.test(text) ? { rows: [columnsRow] } : { rows: [] })
    await fetchRows(ds(), rq({ where: 'id = 1' }))
    const log = h.clientLog.map((l) => l.text)
    expect(log.filter((t) => t === 'begin read only')).toHaveLength(2)
    expect(log.filter((t) => t === 'rollback')).toHaveLength(2)
    expect(log.some((t) => /^commit/.test(t))).toBe(false)
    expect(h.released).toBe(2)
  })

  it('rejects a bad ORDER BY before touching the database', async () => {
    await expect(fetchRows(ds(), rq({ orderExpr: 'id; drop table t' }))).rejects.toThrow(/ORDER BY/)
    expect(h.calls.filter((c) => /select t\./.test(c.text))).toHaveLength(0)
  })
})

describe('buildChangeStatements', () => {
  it('update: SET params first, then pk params, compared via ::text', () => {
    const [s] = buildChangeStatements('s', 't', {
      updates: [{ pk: { id: 7, tenant: 'a' }, set: { name: 'bob', age: 3 } }],
      inserts: [], deletes: []
    })
    expect(s.text).toBe(
      'update "s"."t" set "name" = $1, "age" = $2 where "id"::text = $3 and "tenant"::text = $4'
    )
    expect(s.values).toEqual(['bob', 3, 7, 'a'])
  })

  it('setting a column to null passes a real null value (SET col = $n)', () => {
    const [s] = buildChangeStatements('s', 't', { updates: [{ pk: { id: 1 }, set: { note: null } }], inserts: [], deletes: [] })
    expect(s.text).toContain('"note" = $1')
    expect(s.values).toEqual([null, 1])
  })

  it('null pk values use IS NULL and do not consume a parameter slot', () => {
    const [u, d] = buildChangeStatements('s', 't', {
      updates: [{ pk: { a: null, b: 'x' }, set: { c: 1 } }],
      inserts: [],
      deletes: [{ a: null, b: 'x', c: 'y' }]
    })
    expect(u.text).toBe('update "s"."t" set "c" = $1 where "a" is null and "b"::text = $2')
    expect(u.values).toEqual([1, 'x'])
    expect(d.text).toBe('delete from "s"."t" where "a" is null and "b"::text = $1 and "c"::text = $2')
    expect(d.values).toEqual(['x', 'y'])
  })

  it('insert: quoted column list + numbered placeholders; empty row -> default values', () => {
    const out = buildChangeStatements('s', 't', { updates: [], inserts: [{ 'we"ird': 1, b: null }, {}], deletes: [] })
    expect(out[0].text).toBe('insert into "s"."t" ("we""ird", "b") values ($1, $2)')
    expect(out[0].values).toEqual([1, null])
    expect(out[1]).toEqual({ text: 'insert into "s"."t" default values' })
  })

  it('delete by pk with ::text comparison', () => {
    const [s] = buildChangeStatements('s', 't', { updates: [], inserts: [], deletes: [{ id: 5 }] })
    expect(s.text).toBe('delete from "s"."t" where "id"::text = $1')
    expect(s.values).toEqual([5])
  })

  it('runs updates, then inserts, then deletes', () => {
    const out = buildChangeStatements('s', 't', {
      deletes: [{ id: 1 }], inserts: [{ a: 1 }], updates: [{ pk: { id: 2 }, set: { a: 2 } }]
    })
    expect(out.map((s) => s.text.split(' ')[0])).toEqual(['update', 'insert', 'delete'])
  })

  it('refuses to update/delete without a primary key (no accidental table-wide change)', () => {
    expect(() => buildChangeStatements('s', 't', { updates: [{ pk: {}, set: { a: 1 } }], inserts: [], deletes: [] })).toThrow(/no primary key/)
    expect(() => buildChangeStatements('s', 't', { updates: [], inserts: [], deletes: [{}] })).toThrow(/no primary key/)
  })

  it('column names are quoted so values / names cannot inject SQL', () => {
    const [s] = buildChangeStatements('s', 't', {
      updates: [{ pk: { id: "1' or '1'='1" }, set: { 'a"; drop table t; --': 'x' } }], inserts: [], deletes: []
    })
    expect(s.text).toContain('"a""; drop table t; --" = $1')
    expect(s.text).not.toContain("1' or")
    expect(s.values).toEqual(['x', "1' or '1'='1"])
  })
})

describe('applyChanges', () => {
  it('wraps statements in begin/commit and releases the client', async () => {
    await applyChanges(ds(), 'd', 's', 't', { updates: [], inserts: [{ a: 1 }], deletes: [{ id: 1 }] })
    expect(h.clientLog.map((l) => l.text.split(' ')[0])).toEqual(['begin', 'insert', 'delete', 'commit'])
    expect(h.released).toBe(1)
  })

  it('rolls back and rethrows when a statement fails', async () => {
    h.failOn = /^insert/
    await expect(applyChanges(ds(), 'd', 's', 't', { updates: [], inserts: [{ a: 1 }], deletes: [] })).rejects.toThrow('boom')
    const log = h.clientLog.map((l) => l.text)
    expect(log).toContain('rollback')
    expect(log).not.toContain('commit')
    expect(h.released).toBe(1)
  })

  it('a table without a pk rolls back instead of committing', async () => {
    await expect(applyChanges(ds(), 'd', 's', 't', { updates: [], inserts: [], deletes: [{}] })).rejects.toThrow(/primary key/)
    expect(h.clientLog.map((l) => l.text)).toEqual(['begin', 'rollback'])
  })
})

describe('listDatabases ordering (dbSort)', () => {
  const orderOf = async (dbSort?: DataSource['dbSort']): Promise<string> => {
    h.calls.length = 0
    h.respond = () => ({ rows: [{ datname: 'a' }, { datname: 'b' }] })
    const names = await listDatabases(ds({ id: 'ord-' + String(dbSort), dbSort }))
    expect(names).toEqual(['a', 'b'])
    return /order by (.*)$/s.exec(h.calls[0].text)![1]
  }

  it('default and name-asc: by name', async () => {
    expect(await orderOf()).toBe('datname')
    expect(await orderOf('name-asc')).toBe('datname')
  })
  it('name-desc', async () => expect(await orderOf('name-desc')).toBe('datname desc'))
  it('size-desc puts unreadable (null) sizes last, ties by name', async () =>
    expect(await orderOf('size-desc')).toMatch(/pg_database_size\(datname\) end desc nulls last, datname$/))
  it('size-asc', async () => expect(await orderOf('size-asc')).toMatch(/ asc nulls last, datname$/))
  it('guards pg_database_size with has_database_privilege', async () => {
    await orderOf('size-desc')
    expect(h.calls[0].text).toContain("has_database_privilege(datname, 'CONNECT')")
  })
  it('skips templates / non-connectable databases', async () => {
    await orderOf()
    expect(h.calls[0].text).toContain('not datistemplate and datallowconn')
  })
})

describe('other function-level behaviour', () => {
  it('listTables passes the schema as a bind parameter', async () => {
    h.respond = () => ({ rows: [{ name: 't1', kind: 'table' }] })
    expect(await listTables(ds(), 'd', "s'; drop")).toEqual([{ name: 't1', kind: 'table' }])
    expect(h.calls[0].values).toEqual(["s'; drop"])
    expect(h.calls[0].text).not.toContain('drop')
  })

  it.each([
    ['table', 'drop table "s"."t"'],
    ['view', 'drop view "s"."t"'],
    ['matview', 'drop materialized view "s"."t"'],
    ['foreign', 'drop foreign table "s"."t"'],
    ['whatever', 'drop table "s"."t"']
  ])('dropTable kind %s', async (kind, sql) => {
    await dropTable(ds(), 'd', 's', 't', kind)
    expect(h.calls[0].text).toBe(sql)
  })

  it('createTable validates before running anything', async () => {
    await expect(createTable(ds(), 'd', 's', 't', [{ name: 'a', type: 'int; drop', nullable: true, isPk: false }])).rejects.toThrow(/invalid type/)
    expect(h.calls).toHaveLength(0)
    await createTable(ds(), 'd', 's', 't', [{ name: 'a', type: 'int', nullable: true, isPk: false }])
    expect(h.calls[0].text).toBe('create table "s"."t" (\n  "a" int\n);')
  })

  it('pools are reused per data source/database and closeAll ends them', async () => {
    const d = ds({ id: 'pool-test' })
    await listTables(d, 'd1', 's')
    await listTables(d, 'd1', 's')
    await listTables(d, 'd2', 's')
    expect(h.pools).toHaveLength(2)
    await closeAll('pool-test')
    expect(h.pools.every((p) => p.ended)).toBe(true)
  })
})
