/**
 * More integration tests against a REAL PostgreSQL (see db.int.test.ts). Run with `npm run test:int`.
 * Creates (and ALWAYS drops) its own scratch databases named dgl_it_<random>; never touches other databases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userInfo } from 'os'
import { randomBytes } from 'crypto'
import type { DataSource, RowsQuery } from '../../src/shared'
import {
  addColumn, applyChanges, closeAll, createDatabase, createSchema, createTable, dropDatabase, dropTable, fetchRows,
  getColumns, getIndexes, listAllSchemas, listDatabases, listRoles, listSchemas, listTablespaces, listTables, renameTable,
  runQuery, schemaTotal, tableNames, testConnection
} from '../../src/main/db'

const url = process.env.PG_TEST_URL ? new URL(process.env.PG_TEST_URL) : null
const base: DataSource = {
  id: 'int2-base',
  name: 'int2',
  host: url?.hostname || 'localhost',
  port: Number(url?.port) || 5432,
  user: decodeURIComponent(url?.username || '') || userInfo().username,
  password: decodeURIComponent(url?.password || ''),
  database: 'postgres',
  ssl: false
}
const rnd = (): string => randomBytes(4).toString('hex')
const DB = `dgl_it_${rnd()}`
const DB2 = `dgl_it_${rnd()}`
const scratch: DataSource = { ...base, id: 'int2-scratch', database: DB }
const created: string[] = []

const rq = (table: string, over: Partial<RowsQuery> = {}): RowsQuery => ({
  dsId: scratch.id, database: DB, schema: 'public', table, limit: 100, offset: 0, ...over
})
const sql = (s: string): ReturnType<typeof runQuery> => runQuery(scratch, DB, 'public', s)
const noChanges = { updates: [], inserts: [], deletes: [] }

beforeAll(async () => {
  await createDatabase(base, DB)
  created.push(DB)
  await sql(`
    create extension if not exists pgcrypto;
    create table authors (id integer primary key, name text not null);
    create table books (
      id uuid primary key default gen_random_uuid(),
      author_id integer not null references authors(id),
      title text,
      pages integer
    );
    create table link (a integer, b integer, note text, primary key (a, b));
    create table nopk (x integer, y text);
    create table "Weird ""Name"" tbl" ("Select" integer primary key, "col space" text);
    create table nums (n integer primary key);
    insert into authors values (1,'Ann'),(2,'Bob'),(3,'Cy');
    insert into link values (1,1,'a'),(1,2,'b'),(2,1,'c');
    insert into nopk values (1,'a'),(1,'a'),(2,null);
    insert into "Weird ""Name"" tbl" values (1,'x'),(2,'y');
    insert into nums select g from generate_series(1, 250) g;
    create view v_authors as select * from authors;
    create materialized view mv_authors as select * from authors;
  `)
})

afterAll(async () => {
  await closeAll(scratch.id)
  for (const name of created) await dropDatabase(base, name).catch(() => {})
  await closeAll(base.id)
})

describe('listing', () => {
  it('listTables distinguishes tables, views and materialized views and sorts by name', async () => {
    const t = await listTables(scratch, DB, 'public')
    const kind = Object.fromEntries(t.map((x) => [x.name, x.kind]))
    expect(kind).toMatchObject({ authors: 'table', books: 'table', v_authors: 'view', mv_authors: 'matview' })
    expect(t.map((x) => x.name)).toEqual([...t.map((x) => x.name)].sort())
    expect(t.find((x) => x.name === 'Weird "Name" tbl')).toBeTruthy()
  })

  it('listTables for an empty / unknown schema is []', async () => {
    expect(await listTables(scratch, DB, 'nope')).toEqual([])
  })

  it('listSchemas hides information_schema and pg_*; listAllSchemas shows them (minus toast/temp)', async () => {
    const s = await listSchemas(scratch, DB)
    expect(s).toContain('public')
    expect(s).not.toContain('information_schema')
    expect(s.some((x) => x.startsWith('pg_'))).toBe(false)
    const all = await listAllSchemas(scratch, DB)
    expect(all).toEqual(expect.arrayContaining(['public', 'information_schema', 'pg_catalog']))
    expect(all.some((x) => x.startsWith('pg_toast') || x.startsWith('pg_temp'))).toBe(false)
  })

  it('schemaTotal counts non-toast/temp namespaces and equals listAllSchemas().length', async () => {
    expect(await schemaTotal(scratch, DB)).toBe((await listAllSchemas(scratch, DB)).length)
  })

  it('tableNames groups every relation by schema in one query', async () => {
    const m = await tableNames(scratch, DB)
    expect(m.public).toEqual(expect.arrayContaining(['authors', 'books', 'v_authors', 'mv_authors', 'link', 'nopk']))
    expect(Object.keys(m).some((k) => k.startsWith('pg_toast'))).toBe(false)
    expect(m.pg_catalog).toContain('pg_class')
  })

  it('roles include the connecting user; tablespaces include pg_default', async () => {
    expect(await listRoles(base)).toContain(base.user)
    expect(await listTablespaces(base)).toEqual(expect.arrayContaining(['pg_default', 'pg_global']))
  })

  it('testConnection to a wrong database fails with a server message', async () => {
    await expect(testConnection({ ...base, database: 'dgl_does_not_exist_' + rnd() })).rejects.toThrow(/does not exist/)
  })

  it('listDatabases excludes templates and sorts by every mode', async () => {
    for (const dbSort of ['name-asc', 'name-desc', 'size-asc', 'size-desc'] as const) {
      const l = await listDatabases({ ...base, dbSort })
      expect(l).toContain(DB)
      expect(l).not.toContain('template0')
      expect(l).not.toContain('template1')
    }
  })

  it('getColumns: pk flags (single, composite), nullability, quoted names; views have no pk; unknown table -> []', async () => {
    expect(await getColumns(scratch, DB, 'public', 'link')).toEqual([
      { name: 'a', type: 'integer', nullable: false, isPk: true },
      { name: 'b', type: 'integer', nullable: false, isPk: true },
      { name: 'note', type: 'text', nullable: true, isPk: false }
    ])
    expect((await getColumns(scratch, DB, 'public', 'nopk')).every((c) => !c.isPk)).toBe(true)
    expect((await getColumns(scratch, DB, 'public', 'v_authors')).map((c) => c.name)).toEqual(['id', 'name'])
    expect((await getColumns(scratch, DB, 'public', 'Weird "Name" tbl')).map((c) => c.name)).toEqual(['Select', 'col space'])
    expect(await getColumns(scratch, DB, 'public', 'ghost')).toEqual([])
    const books = await getColumns(scratch, DB, 'public', 'books')
    expect(books[0]).toMatchObject({ name: 'id', type: 'uuid', isPk: true })
  })

  it('getIndexes lists pk index; none for tables without indexes', async () => {
    expect((await getIndexes(scratch, DB, 'public', 'link')).map((i) => i.name)).toEqual(['link_pkey'])
    expect(await getIndexes(scratch, DB, 'public', 'nopk')).toEqual([])
    await sql('create index idx_nopk_x on nopk (x)')
    const idx = await getIndexes(scratch, DB, 'public', 'nopk')
    expect(idx).toHaveLength(1)
    expect(idx[0].definition).toMatch(/CREATE INDEX idx_nopk_x ON public\.nopk/)
  })
})

describe('fetchRows', () => {
  it('pages through 250 rows with a stable header sort; total is constant', async () => {
    const seen: string[] = []
    for (let off = 0; off < 250; off += 100) {
      const r = await fetchRows(scratch, rq('nums', { limit: 100, offset: off, orderBy: { column: 'n', desc: false } }))
      expect(r.total).toBe(250)
      seen.push(...r.rows.map((x) => x.n as string))
    }
    expect(seen).toHaveLength(250)
    expect(seen.map(Number)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1))
  })

  it('offset past the end -> no rows but total is right; limit 0 -> no rows', async () => {
    const r = await fetchRows(scratch, rq('nums', { offset: 1000 }))
    expect(r.rows).toEqual([])
    expect(r.total).toBe(250)
    expect((await fetchRows(scratch, rq('nums', { limit: 0 }))).rows).toEqual([])
  })

  it('descending header sort', async () => {
    const r = await fetchRows(scratch, rq('nums', { limit: 3, orderBy: { column: 'n', desc: true } }))
    expect(r.rows.map((x) => x.n)).toEqual(['250', '249', '248'])
  })

  it('ORDER BY expression takes precedence over the header sort; accepts desc/multi-column/functions and a leading "order by"', async () => {
    const r1 = await fetchRows(scratch, rq('nums', { limit: 3, orderBy: { column: 'n', desc: false }, orderExpr: 'n desc' }))
    expect(r1.rows.map((x) => x.n)).toEqual(['250', '249', '248'])
    const r2 = await fetchRows(scratch, rq('link', { orderExpr: 'ORDER BY a desc, b desc' }))
    expect(r2.rows.map((x) => `${x.a}${x.b}`)).toEqual(['21', '12', '11'])
    const r3 = await fetchRows(scratch, rq('authors', { orderExpr: 'length(name), name desc' }))
    expect(r3.rows.map((x) => x.name)).toEqual(['Cy', 'Bob', 'Ann'])
  })

  it('REGRESSION: typed ORDER BY on an integer column sorts numerically, not as text', async () => {
    const asc = await fetchRows(scratch, rq('nums', { orderExpr: 'n', limit: 12 }))
    expect(asc.rows.map((x) => x.n)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)))
    const desc = await fetchRows(scratch, rq('nums', { orderExpr: 'n desc', limit: 3, offset: 1 }))
    expect(desc.rows.map((x) => x.n)).toEqual(['249', '248', '247'])
    const qualified = await fetchRows(scratch, rq('nums', { orderExpr: 't.n desc', limit: 2 }))
    expect(qualified.rows.map((x) => x.n)).toEqual(['250', '249'])
  })

  it('WHERE + ORDER BY + paging together; total reflects the WHERE only', async () => {
    const r = await fetchRows(scratch, rq('nums', { where: 'n % 2 = 0', orderExpr: 'n desc', limit: 5, offset: 2 }))
    expect(r.total).toBe(125)
    expect(r.rows.map((x) => x.n)).toEqual(['246', '244', '242', '240', '238'])
  })

  it('WHERE that matches nothing -> total 0', async () => {
    const r = await fetchRows(scratch, rq('nums', { where: 'n < 0' }))
    expect(r).toMatchObject({ total: 0, rows: [] })
    expect(r.columns).toHaveLength(1)
  })

  it('WHERE can reference the table alias "t" and columns with odd names', async () => {
    expect((await fetchRows(scratch, rq('Weird "Name" tbl', { where: `t."col space" = 'y'` }))).rows).toEqual([{ Select: '2', 'col space': 'y' }])
  })

  it('uuid LIKE error message is the server\'s, and the ::text fix works', async () => {
    await sql(`insert into authors values (10,'U')`)
    await sql(`insert into books (id, author_id, title) values ('11111111-2222-3333-4444-555555555555', 10, 't')`)
    await expect(fetchRows(scratch, rq('books', { where: `id like '1111%'` }))).rejects.toThrow(/operator does not exist: uuid ~~ unknown/)
    const ok = await fetchRows(scratch, rq('books', { where: `id::text like '1111%'` }))
    expect(ok.total).toBe(1)
    expect(ok.rows[0].id).toBe('11111111-2222-3333-4444-555555555555')
    await sql(`delete from books; delete from authors where id = 10`)
  })

  it('NOT LIKE / ILIKE / IN / IS NULL operate on text columns', async () => {
    expect((await fetchRows(scratch, rq('authors', { where: `name ilike 'a%'` }))).total).toBe(1)
    expect((await fetchRows(scratch, rq('authors', { where: `name not like 'A%'` }))).total).toBe(2)
    expect((await fetchRows(scratch, rq('authors', { where: `id in (1,3)` }))).total).toBe(2)
    expect((await fetchRows(scratch, rq('nopk', { where: `y is null` }))).total).toBe(1)
  })

  it('every value is returned as text; NULL stays null', async () => {
    const r = await fetchRows(scratch, rq('nopk', { orderExpr: 'x, y nulls last' }))
    expect(r.rows).toEqual([{ x: '1', y: 'a' }, { x: '1', y: 'a' }, { x: '2', y: null }])
  })

  it('works for views and materialized views', async () => {
    expect((await fetchRows(scratch, rq('v_authors'))).total).toBe(3)
    expect((await fetchRows(scratch, rq('mv_authors'))).total).toBe(3)
  })

  it('missing table -> server error', async () => {
    await expect(fetchRows(scratch, rq('ghost'))).rejects.toThrow(/does not exist|no columns/i)
  })

  describe('injection attempts', () => {
    const attempts = [
      'true; drop table nums',
      '1=1; drop table nums; --',
      `1=1) union select 1 --`,
      `n > 0 and (select count(*) from (delete from nums returning 1) d) = 0`,
      `n in (select 1); drop table nums`,
      `true; commit; drop table nums`
    ]
    it.each(attempts)('WHERE %j never writes', async (where) => {
      await fetchRows(scratch, rq('nums', { where })).catch(() => {})
      expect((await fetchRows(scratch, rq('nums'))).total).toBe(250)
      expect((await listTables(scratch, DB, 'public')).some((t) => t.name === 'nums')).toBe(true)
    })

    it('"true; drop table x" in WHERE is rejected by the extended protocol (cannot insert multiple commands)', async () => {
      await expect(fetchRows(scratch, rq('nums', { where: 'true; drop table nums' }))).rejects.toThrow(/multiple commands|syntax/i)
    })

    it('data-modifying CTE tricks are rejected inside the read-only transaction', async () => {
      await expect(
        fetchRows(scratch, rq('nums', { where: 'n in (with d as (delete from nums returning n) select n from d)' }))
      ).rejects.toThrow()
      expect((await fetchRows(scratch, rq('nums'))).total).toBe(250)
    })

    it.each(['n; drop table nums', 'n -- x', 'n /* x */'])('ORDER BY %j is rejected before reaching the server', async (orderExpr) => {
      await expect(fetchRows(scratch, rq('nums', { orderExpr }))).rejects.toThrow(/ORDER BY must not contain/)
    })

    it('after a failed raw query the pool still works (transaction rolled back, client released)', async () => {
      for (let i = 0; i < 12; i++) await fetchRows(scratch, rq('nums', { where: 'syntax error here' })).catch(() => {})
      expect((await fetchRows(scratch, rq('nums'))).total).toBe(250)
    })
  })
})

describe('applyChanges', () => {
  it('multi-delete executes in one transaction', async () => {
    await applyChanges(scratch, DB, 'public', 'nums', { ...noChanges, deletes: [{ n: '1' }, { n: '2' }, { n: '3' }] })
    expect((await fetchRows(scratch, rq('nums'))).total).toBe(247)
    await applyChanges(scratch, DB, 'public', 'nums', { ...noChanges, inserts: [{ n: '1' }, { n: '2' }, { n: '3' }] })
    expect((await fetchRows(scratch, rq('nums'))).total).toBe(250)
  })

  it('multi-delete where one fails (FK violation) rolls the whole set back', async () => {
    await sql(`insert into books (author_id, title) values (1, 'b1')`)
    await expect(
      applyChanges(scratch, DB, 'public', 'authors', { ...noChanges, deletes: [{ id: '3' }, { id: '1' }] })
    ).rejects.toThrow(/foreign key|violates/i)
    expect((await fetchRows(scratch, rq('authors'))).total).toBe(3) // author 3 delete rolled back too
    await sql(`delete from books`)
  })

  it('FK violation on insert rolls back earlier updates in the same batch', async () => {
    await expect(
      applyChanges(scratch, DB, 'public', 'books', {
        updates: [],
        inserts: [{ author_id: '1', title: 'ok' }, { author_id: '999', title: 'bad' }],
        deletes: []
      })
    ).rejects.toThrow(/foreign key/i)
    expect((await fetchRows(scratch, rq('books'))).total).toBe(0)
  })

  it('composite primary keys: update and delete address a single row', async () => {
    await applyChanges(scratch, DB, 'public', 'link', { ...noChanges, updates: [{ pk: { a: '1', b: '2' }, set: { note: 'changed' } }] })
    const rows = (await fetchRows(scratch, rq('link', { orderExpr: 'a, b' }))).rows
    expect(rows.map((r) => r.note)).toEqual(['a', 'changed', 'c'])
    await applyChanges(scratch, DB, 'public', 'link', { ...noChanges, deletes: [{ a: '1', b: '1' }] })
    expect((await fetchRows(scratch, rq('link'))).total).toBe(2)
    await applyChanges(scratch, DB, 'public', 'link', { ...noChanges, inserts: [{ a: '1', b: '1', note: 'a' }] })
  })

  it('updating the pk value itself works (pk compared as text against the old value)', async () => {
    await applyChanges(scratch, DB, 'public', 'authors', { ...noChanges, updates: [{ pk: { id: '3' }, set: { id: '30' } }] })
    expect((await fetchRows(scratch, rq('authors', { where: 'id = 30' }))).total).toBe(1)
    await applyChanges(scratch, DB, 'public', 'authors', { ...noChanges, updates: [{ pk: { id: '30' }, set: { id: '3' } }] })
  })

  it('uuid primary key is matched through ::text', async () => {
    await sql(`insert into books (id, author_id, title) values ('aaaaaaaa-0000-0000-0000-000000000001', 1, 'u')`)
    await applyChanges(scratch, DB, 'public', 'books', { ...noChanges, updates: [{ pk: { id: 'aaaaaaaa-0000-0000-0000-000000000001' }, set: { title: 'u2', pages: '5' } }] })
    expect((await fetchRows(scratch, rq('books'))).rows[0]).toMatchObject({ title: 'u2', pages: '5' })
    await applyChanges(scratch, DB, 'public', 'books', { ...noChanges, deletes: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }] })
    expect((await fetchRows(scratch, rq('books'))).total).toBe(0)
  })

  it('tables without a primary key: updates/deletes are refused, inserts work, nothing changes on refusal', async () => {
    await expect(applyChanges(scratch, DB, 'public', 'nopk', { ...noChanges, deletes: [{}] })).rejects.toThrow(/no primary key/)
    await expect(applyChanges(scratch, DB, 'public', 'nopk', { ...noChanges, updates: [{ pk: {}, set: { y: 'z' } }] })).rejects.toThrow(/no primary key/)
    expect((await fetchRows(scratch, rq('nopk'))).total).toBe(3)
    await applyChanges(scratch, DB, 'public', 'nopk', { ...noChanges, inserts: [{ x: '9', y: 'new' }] })
    expect((await fetchRows(scratch, rq('nopk'))).total).toBe(4)
    await sql(`delete from nopk where x = 9`)
  })

  it('weird identifiers (quotes, spaces, reserved words) in table and column names', async () => {
    await applyChanges(scratch, DB, 'public', 'Weird "Name" tbl', {
      updates: [{ pk: { Select: '1' }, set: { 'col space': "o'brien" } }],
      inserts: [{ Select: '3', 'col space': 'z' }],
      deletes: [{ Select: '2' }]
    })
    const r = await fetchRows(scratch, rq('Weird "Name" tbl', { orderBy: { column: 'Select', desc: false } }))
    expect(r.rows).toEqual([{ Select: '1', 'col space': "o'brien" }, { Select: '3', 'col space': 'z' }])
    await applyChanges(scratch, DB, 'public', 'Weird "Name" tbl', { ...noChanges, deletes: [{ Select: '3' }], inserts: [{ Select: '2', 'col space': 'y' }], updates: [{ pk: { Select: '1' }, set: { 'col space': 'x' } }] })
  })

  it('NOT NULL violation rolls back; setting null on a nullable column works', async () => {
    await expect(applyChanges(scratch, DB, 'public', 'authors', { ...noChanges, updates: [{ pk: { id: '1' }, set: { name: null } }] })).rejects.toThrow(/null value/)
    await applyChanges(scratch, DB, 'public', 'link', { ...noChanges, updates: [{ pk: { a: '2', b: '1' }, set: { note: null } }] })
    expect((await fetchRows(scratch, rq('link', { where: 'note is null' }))).total).toBe(1)
    await applyChanges(scratch, DB, 'public', 'link', { ...noChanges, updates: [{ pk: { a: '2', b: '1' }, set: { note: 'c' } }] })
  })

  it('type errors (text into an integer column) surface as server errors and roll back', async () => {
    await expect(applyChanges(scratch, DB, 'public', 'nums', { ...noChanges, inserts: [{ n: '1000' }, { n: 'abc' }] })).rejects.toThrow(/invalid input syntax/)
    expect((await fetchRows(scratch, rq('nums', { where: 'n = 1000' }))).total).toBe(0)
  })

  it('a pk of null matches via IS NULL (nullable unique-less table cannot be edited though: no pk)', async () => {
    await expect(applyChanges(scratch, DB, 'public', 'link', { ...noChanges, deletes: [{ a: null, b: null }] })).resolves.toBeUndefined()
    expect((await fetchRows(scratch, rq('link'))).total).toBe(3)
  })

  it('empty changes are a no-op commit', async () => {
    await expect(applyChanges(scratch, DB, 'public', 'nums', noChanges)).resolves.toBeUndefined()
  })
})

describe('DDL: create / rename / drop', () => {
  it('createSchema + owner; schema shows in lists; tables go there', async () => {
    const s = 'sch_' + rnd()
    await createSchema(scratch, DB, s, base.user)
    expect(await listSchemas(scratch, DB)).toContain(s)
    await createTable(scratch, DB, s, 'T 1', [{ name: 'Id', type: 'serial', nullable: false, isPk: true }, { name: 'v', type: 'varchar(5)', nullable: true, isPk: false, default: "'x'" }])
    expect(await listTables(scratch, DB, s)).toEqual([{ name: 'T 1', kind: 'table' }])
    await applyChanges(scratch, DB, s, 'T 1', { ...noChanges, inserts: [{}] })
    expect((await fetchRows(scratch, { ...rq('T 1'), schema: s })).rows).toEqual([{ Id: '1', v: 'x' }])
  })

  it('createSchema: duplicate -> error; weird names quoted; blank -> validation error', async () => {
    await expect(createSchema(scratch, DB, 'public')).rejects.toThrow(/already exists/)
    const s = 'Odd "S" ' + rnd()
    await createSchema(scratch, DB, s)
    expect(await listSchemas(scratch, DB)).toContain(s)
    await expect(createSchema(scratch, DB, '  ')).rejects.toThrow('Schema name is required')
  })

  it('createSchema with a non-existent owner fails with the server message', async () => {
    await expect(createSchema(scratch, DB, 's_' + rnd(), 'no_such_role_' + rnd())).rejects.toThrow(/does not exist/)
  })

  it('createTable: composite pk, defaults, not null; duplicate table errors', async () => {
    await createTable(scratch, DB, 'public', 'ct1', [
      { name: 'a', type: 'int', nullable: true, isPk: true },
      { name: 'b', type: 'text', nullable: true, isPk: true },
      { name: 'c', type: 'numeric(10, 2)', nullable: false, isPk: false, default: '0' },
      { name: 'd', type: 'int[]', nullable: true, isPk: false },
      { name: 'e', type: 'timestamp with time zone', nullable: true, isPk: false, default: 'now()' }
    ])
    const cols = await getColumns(scratch, DB, 'public', 'ct1')
    expect(cols.map((c) => [c.name, c.isPk, c.nullable])).toEqual([['a', true, false], ['b', true, false], ['c', false, false], ['d', false, true], ['e', false, true]])
    expect(cols[2].type).toBe('numeric(10,2)')
    await expect(createTable(scratch, DB, 'public', 'ct1', [{ name: 'a', type: 'int', nullable: true, isPk: false }])).rejects.toThrow(/already exists/)
  })

  it('createTable with a bad (but regex-valid) type gives the server error; nothing is created', async () => {
    await expect(createTable(scratch, DB, 'public', 'ct_bad', [{ name: 'a', type: 'nonexistent_type', nullable: true, isPk: false }])).rejects.toThrow(/does not exist/)
    expect((await listTables(scratch, DB, 'public')).some((t) => t.name === 'ct_bad')).toBe(false)
  })

  it('addColumn: nullable, default, not null with default (backfills existing rows)', async () => {
    await createTable(scratch, DB, 'public', 'ac1', [{ name: 'id', type: 'int', nullable: false, isPk: true, default: undefined }])
    await applyChanges(scratch, DB, 'public', 'ac1', { ...noChanges, inserts: [{ id: '1' }, { id: '2' }] })
    await addColumn(scratch, DB, 'public', 'ac1', { name: 'Order', type: 'text', nullable: false, isPk: false, default: "'n/a'" })
    await addColumn(scratch, DB, 'public', 'ac1', { name: 'maybe', type: 'int', nullable: true, isPk: false })
    expect((await fetchRows(scratch, rq('ac1'))).rows.map((r) => r.Order)).toEqual(['n/a', 'n/a'])
    await expect(addColumn(scratch, DB, 'public', 'ac1', { name: 'Order', type: 'text', nullable: true, isPk: false })).rejects.toThrow(/already exists/)
    await expect(addColumn(scratch, DB, 'public', 'ac1', { name: 'nn', type: 'int', nullable: false, isPk: false })).rejects.toThrow(/contains null values|not-null/i)
  })

  it('renameTable then dropTable per kind', async () => {
    await sql('create table rn1 (id int primary key)')
    await renameTable(scratch, DB, 'public', 'rn1', 'rn "2"')
    expect((await listTables(scratch, DB, 'public')).map((t) => t.name)).toContain('rn "2"')
    await dropTable(scratch, DB, 'public', 'rn "2"', 'table')
    await sql('create view dv as select 1 as a; create materialized view dm as select 1 as a')
    await dropTable(scratch, DB, 'public', 'dv', 'view')
    await dropTable(scratch, DB, 'public', 'dm', 'matview')
    const names = (await listTables(scratch, DB, 'public')).map((t) => t.name)
    expect(names).not.toEqual(expect.arrayContaining(['dv']))
    expect(names).not.toContain('dm')
    expect(names).not.toContain('rn "2"')
    await expect(dropTable(scratch, DB, 'public', 'dv', 'view')).rejects.toThrow(/does not exist/)
  })

  it('dropTable with a mismatching kind is refused by the server (drop table on a view)', async () => {
    await expect(dropTable(scratch, DB, 'public', 'v_authors', 'table')).rejects.toThrow(/is not a table|view/i)
  })

  it('dropTable refuses when other objects depend on it (no CASCADE)', async () => {
    await expect(dropTable(scratch, DB, 'public', 'authors', 'table')).rejects.toThrow(/depend/i)
  })

  it('renameTable onto an existing name fails', async () => {
    await expect(renameTable(scratch, DB, 'public', 'nums', 'authors')).rejects.toThrow(/already exists/)
  })

  it('createDatabase with owner; duplicate errors; blank rejected; dropDatabase removes it (even with an open pool)', async () => {
    await createDatabase(base, DB2, base.user)
    created.push(DB2)
    expect(await listDatabases(base)).toContain(DB2)
    await expect(createDatabase(base, DB2)).rejects.toThrow(/already exists/)
    await expect(createDatabase(base, '   ')).rejects.toThrow('Database name is required')
    const s2 = { ...base, id: 'int2-db2', database: DB2 }
    await listSchemas(s2, DB2) // keep a pool open on it
    await dropDatabase(s2, DB2)
    expect(await listDatabases(base)).not.toContain(DB2)
    created.pop()
    await closeAll(s2.id)
  })

  it('createDatabase with unknown owner fails and leaves nothing behind', async () => {
    const n = 'dgl_it_' + rnd()
    await expect(createDatabase(base, n, 'no_such_role_' + rnd())).rejects.toThrow(/does not exist/)
    expect(await listDatabases(base)).not.toContain(n)
  })
})

describe('runQuery', () => {
  it('multi-statement scripts: one result per statement with command, rowCount, fields', async () => {
    const r = await sql(`create temp table tt (a int); insert into tt values (1),(2); select a from tt order by a; update tt set a = a + 1; delete from tt`)
    expect(r.results.map((x) => x.command)).toEqual(['CREATE', 'INSERT', 'SELECT', 'UPDATE', 'DELETE'])
    expect(r.results[1].rowCount).toBe(2)
    expect(r.results[2]).toMatchObject({ fields: ['a'], rows: [['1'], ['2']], truncated: false })
    expect(r.results[3].rowCount).toBe(2)
  })

  it('values are rendered: null, bool, numeric, date, timestamptz, json, bytea, arrays', async () => {
    const r = await sql(`select null::text n, true b, 1.50::numeric num, date '2020-01-02' d, '{"a":[1,2]}'::jsonb j, '\\x00ff'::bytea by, array[1,2] arr, 'x'::text t`)
    const row = r.results[0].rows[0]
    expect(row[0]).toBeNull()
    expect(row[1]).toBe('true')
    expect(row[2]).toBe('1.50')
    expect(row[3]).toMatch(/^2020-01-0[12]T/)
    expect(row[4]).toBe('{"a":[1,2]}')
    expect(row[5]).toBe('\\x00ff')
    expect(row[6]).toBe('[1,2]')
    expect(row[7]).toBe('x')
  })

  it('search_path is set to the chosen schema (then public) and reset afterwards', async () => {
    const s = 'sp_' + rnd()
    await createSchema(scratch, DB, s)
    await runQuery(scratch, DB, s, 'create table only_here (a int)')
    const inSchema = await runQuery(scratch, DB, s, 'select count(*) from only_here')
    expect(inSchema.results[0].rows).toEqual([['0']])
    await expect(runQuery(scratch, DB, 'public', 'select count(*) from only_here')).rejects.toThrow(/does not exist/)
    // public tables still resolve from a custom schema (search_path "s", public)
    expect((await runQuery(scratch, DB, s, 'select count(*) from authors')).results[0].rows).toEqual([['3']])
    // after the call the pooled connection's search_path is back to default
    const sp = await runQuery(scratch, DB, undefined, 'show search_path')
    expect(sp.results[0].rows[0][0]).not.toContain(s)
  })

  it('caps at 5000 rows and flags truncated', async () => {
    const r = await sql('select g from generate_series(1, 5001) g')
    expect(r.results[0].rows).toHaveLength(5000)
    expect(r.results[0].truncated).toBe(true)
    const r2 = await sql('select g from generate_series(1, 5000) g')
    expect(r2.results[0].truncated).toBe(false)
  })

  it('error messages are the server\'s; the connection is reusable afterwards', async () => {
    await expect(sql('selec 1')).rejects.toThrow(/syntax error at or near "selec"/)
    await expect(sql('select 1/0')).rejects.toThrow(/division by zero/)
    await expect(sql('select * from nonexistent_tbl')).rejects.toThrow(/relation "nonexistent_tbl" does not exist/)
    expect((await sql('select 1')).results[0].rows).toEqual([['1']])
  })

  it('a failing statement mid-script: earlier statements in the implicit transaction are rolled back', async () => {
    await expect(sql('insert into nums values (9001); select 1/0')).rejects.toThrow(/division by zero/)
    expect((await fetchRows(scratch, rq('nums', { where: 'n = 9001' }))).total).toBe(0)
  })

  it('empty query text yields a result without rows (or an empty result list) and does not throw', async () => {
    const r = await sql('')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('unicode and comments in SQL', async () => {
    const r = await sql(`-- comment\nselect 'ünïcödé ☃' as "名前" /* c */`)
    expect(r.results[0]).toMatchObject({ fields: ['名前'], rows: [['ünïcödé ☃']] })
  })

  it('$1 style text and dollar quoting are just SQL text', async () => {
    const r = await sql(`select $$it's $1; fine$$ as s`)
    expect(r.results[0].rows).toEqual([[`it's $1; fine`]])
  })
})
