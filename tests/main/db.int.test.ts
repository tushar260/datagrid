/**
 * Integration tests against a REAL PostgreSQL. Excluded from `npm test`; run with
 *   npm run test:int            (RUN_PG_TESTS=1, defaults to localhost:5432 as the OS user, trust auth)
 *   PG_TEST_URL=postgres://user:pw@host:5432/postgres npx vitest run tests/main/db.int.test.ts
 * Creates (and always drops) its own scratch database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userInfo } from 'os'
import type { DataSource } from '../../src/shared'
import {
  addColumn, applyChanges, closeAll, createDatabase, createTable, dropDatabase, fetchRows, getColumns, getIndexes,
  listDatabases, listTables, runQuery, tablesAll, testConnection
} from '../../src/main/db'

const url = process.env.PG_TEST_URL ? new URL(process.env.PG_TEST_URL) : null
const base: DataSource = {
  id: 'int-test',
  name: 'int',
  host: url?.hostname || 'localhost',
  port: Number(url?.port) || 5432,
  user: decodeURIComponent(url?.username || '') || userInfo().username,
  password: decodeURIComponent(url?.password || ''),
  database: 'postgres',
  ssl: false
}
const DB = `dgl_test_${process.pid}_${Date.now()}`
const scratch: DataSource = { ...base, id: 'int-test-scratch', database: DB }

beforeAll(async () => {
  await createDatabase(base, DB)
  await createTable(scratch, DB, 'public', 'people', [
    { name: 'id', type: 'integer', nullable: false, isPk: true },
    { name: 'Full Name', type: 'text', nullable: true, isPk: false },
    { name: 'age', type: 'integer', nullable: true, isPk: false, default: '18' }
  ])
  await runQuery(scratch, DB, 'public', `insert into people (id, "Full Name", age) values (1,'Ann',30),(2,'Bob',25),(3,'Cy',null),(4,'Dee',41)`)
})

afterAll(async () => {
  await closeAll(scratch.id)
  await dropDatabase(base, DB).catch(() => {})
  await closeAll(base.id)
})

describe('postgres integration', () => {
  it('connects', async () => {
    expect(await testConnection(base)).toMatch(/PostgreSQL/)
  })

  it('lists the scratch database, sorted by name or size without errors', async () => {
    for (const dbSort of ['name-asc', 'name-desc', 'size-desc', 'size-asc'] as const) {
      const dbs = await listDatabases({ ...base, dbSort })
      expect(dbs).toContain(DB)
      expect(dbs).not.toContain('template0')
    }
    const asc = await listDatabases({ ...base, dbSort: 'name-asc' })
    const desc = await listDatabases({ ...base, dbSort: 'name-desc' })
    expect(desc).toEqual([...asc].reverse())
  })

  it('creates tables with quoting, defaults and primary keys; reports them via getColumns / getIndexes', async () => {
    expect(await listTables(scratch, DB, 'public')).toEqual([{ name: 'people', kind: 'table' }])
    const cols = await getColumns(scratch, DB, 'public', 'people')
    expect(cols).toEqual([
      { name: 'id', type: 'integer', nullable: false, isPk: true },
      { name: 'Full Name', type: 'text', nullable: true, isPk: false },
      { name: 'age', type: 'integer', nullable: true, isPk: false }
    ])
    expect((await getIndexes(scratch, DB, 'public', 'people')).map((i) => i.name)).toEqual(['people_pkey'])
  })

  it('tablesAll: every table / view of the database in one query, grouped by schema, same kinds as listTables (the ⌘O indexer)', async () => {
    await runQuery(scratch, DB, 'public', `create schema if not exists extra_s; create table extra_s.t2 (id int); create view public.people_v as select id from people; create materialized view public.people_mv as select id from people`)
    const all = await tablesAll(scratch, DB)
    expect(Object.keys(all)).toEqual(expect.arrayContaining(['public', 'extra_s']))
    expect(all['extra_s']).toEqual([{ name: 't2', kind: 'table' }])
    const sortByName = (l: { name: string }[]): { name: string }[] => [...l].sort((a, b) => a.name.localeCompare(b.name))
    expect(sortByName(all['public'])).toEqual(sortByName(await listTables(scratch, DB, 'public')))
    expect(all['public']).toEqual(expect.arrayContaining([{ name: 'people', kind: 'table' }, { name: 'people_v', kind: 'view' }, { name: 'people_mv', kind: 'matview' }]))
    expect(Object.keys(all).some((n) => n.startsWith('pg_toast'))).toBe(false)
    await runQuery(scratch, DB, 'public', 'drop materialized view people_mv; drop view people_v; drop schema extra_s cascade')
  })

  it('rejects invalid table definitions before they reach the server', async () => {
    await expect(createTable(scratch, DB, 'public', 'x', [{ name: 'a', type: 'int); drop table people; --', nullable: true, isPk: false }])).rejects.toThrow(/invalid type/)
    expect((await getColumns(scratch, DB, 'public', 'people')).length).toBe(3)
  })

  it('addColumn works, including not null with default', async () => {
    await addColumn(scratch, DB, 'public', 'people', { name: 'active', type: 'boolean', nullable: false, isPk: false, default: 'true' })
    expect((await getColumns(scratch, DB, 'public', 'people')).map((c) => c.name)).toContain('active')
  })

  describe('fetchRows', () => {
    const q = { dsId: scratch.id, database: DB, schema: 'public', table: 'people', limit: 100, offset: 0 }

    it('returns text-cast rows, columns and the total', async () => {
      const r = await fetchRows(scratch, q)
      expect(r.total).toBe(4)
      expect(r.rows).toHaveLength(4)
      expect(r.rows[0]).toMatchObject({ id: '1', 'Full Name': 'Ann', age: '30' })
      expect(r.rows[2].age).toBeNull()
    })

    it('limit / offset page the rows but the total stays the full count', async () => {
      const r = await fetchRows(scratch, { ...q, limit: 2, offset: 1, orderBy: { column: 'id', desc: false } })
      expect(r.rows.map((x) => x.id)).toEqual(['2', '3'])
      expect(r.total).toBe(4)
    })

    it('WHERE narrows both rows and total', async () => {
      const r = await fetchRows(scratch, { ...q, where: `"Full Name" like 'B%' or age > 40` })
      expect(r.rows.map((x) => x['Full Name']).sort()).toEqual(['Bob', 'Dee'])
      expect(r.total).toBe(2)
    })

    it('header sort and typed ORDER BY (which takes precedence)', async () => {
      const byHeader = await fetchRows(scratch, { ...q, orderBy: { column: 'age', desc: true } })
      expect(byHeader.rows[0].id).toBe('3') // desc: nulls first
      const typed = await fetchRows(scratch, { ...q, orderBy: { column: 'age', desc: true }, orderExpr: 'order by "Full Name" desc' })
      expect(typed.rows.map((x) => x.id)).toEqual(['4', '3', '2', '1'])
    })

    it('rejects stacked statements in WHERE (extended protocol) and never writes', async () => {
      await expect(fetchRows(scratch, { ...q, where: '1=1; delete from people' })).rejects.toThrow()
      await expect(fetchRows(scratch, { ...q, where: `id in (select 1) and (select count(*) from (delete from people returning 1) d) = 0` })).rejects.toThrow()
      expect((await fetchRows(scratch, q)).total).toBe(4)
    })

    it('rejects comment / semicolon ORDER BY text', async () => {
      await expect(fetchRows(scratch, { ...q, orderExpr: 'id; drop table people' })).rejects.toThrow(/ORDER BY/)
      await expect(fetchRows(scratch, { ...q, orderExpr: 'id -- x' })).rejects.toThrow(/ORDER BY/)
    })

    it('a malformed WHERE gives a server error', async () => {
      await expect(fetchRows(scratch, { ...q, where: 'nope nope' })).rejects.toThrow()
    })
  })

  describe('applyChanges', () => {
    const q = { dsId: scratch.id, database: DB, schema: 'public', table: 'people', limit: 100, offset: 0, orderBy: { column: 'id', desc: false } }
    const names = async (): Promise<unknown[]> => (await fetchRows(scratch, q)).rows.map((r) => r['Full Name'])

    it('applies updates, inserts and deletes atomically (pk compared as text)', async () => {
      await applyChanges(scratch, DB, 'public', 'people', {
        updates: [{ pk: { id: '1' }, set: { 'Full Name': 'Anna', age: null } }],
        inserts: [{ id: '5', 'Full Name': 'Eve' }, { id: '6' }],
        deletes: [{ id: '2' }]
      })
      expect(await names()).toEqual(['Anna', 'Cy', 'Dee', 'Eve', null])
      const r = await fetchRows(scratch, q)
      expect(r.rows[0]).toMatchObject({ id: '1', age: null })
      expect(r.rows.find((x) => x.id === '5')!.age).toBe('18') // column default applied on insert
    })

    it('rolls everything back when one statement fails', async () => {
      const before = (await fetchRows(scratch, q)).total
      await expect(
        applyChanges(scratch, DB, 'public', 'people', {
          updates: [{ pk: { id: '1' }, set: { 'Full Name': 'ROLLED BACK' } }],
          inserts: [{ id: '3' }], // duplicate primary key
          deletes: []
        })
      ).rejects.toThrow(/duplicate key/)
      expect((await fetchRows(scratch, q)).total).toBe(before)
      expect(await names()).not.toContain('ROLLED BACK')
    })

    it('SQL in values is just data', async () => {
      await applyChanges(scratch, DB, 'public', 'people', { updates: [{ pk: { id: '1' }, set: { 'Full Name': "x'); drop table people; --" } }], inserts: [], deletes: [] })
      expect((await names())[0]).toBe("x'); drop table people; --")
    })

    it('a delete with a pk that matches nothing is harmless', async () => {
      const before = (await fetchRows(scratch, q)).total
      await applyChanges(scratch, DB, 'public', 'people', { updates: [], inserts: [], deletes: [{ id: '9999' }] })
      expect((await fetchRows(scratch, q)).total).toBe(before)
    })
  })

  it('runQuery returns one result per statement with stringified values', async () => {
    const r = await runQuery(scratch, DB, 'public', `select 1 as a, now()::date as d; select id from people where id = 1`)
    expect(r.results).toHaveLength(2)
    expect(r.results[0].fields).toEqual(['a', 'd'])
    expect(r.results[1].rows).toEqual([['1']])
  })
})
