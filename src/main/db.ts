import { Pool, Client, type QueryResult as PgResult } from 'pg'
import type { DataSource, Column, RowsQuery, RowsResult, Changes, QueryResult, NewColumn } from '../shared'
import { validateNewTable, buildCreateTable, buildAddColumn } from '../shared'

const pools = new Map<string, Pool>()
export const q = (id: string): string => '"' + id.replace(/"/g, '""') + '"'

function poolFor(ds: DataSource, database?: string): Pool {
  const db = database || ds.database || 'postgres'
  const key = `${ds.id}|${db}|${ds.host}|${ds.port}|${ds.user}|${ds.password}`
  let p = pools.get(key)
  if (!p) {
    p = new Pool({
      host: ds.host,
      port: ds.port,
      user: ds.user,
      password: ds.password,
      database: db,
      ssl: ds.ssl ? { rejectUnauthorized: false } : false,
      max: 4,
      connectionTimeoutMillis: 8000,
      // pg's default 10s idle timeout closes the connection, so the next click (e.g. Submit) paid for a
      // fresh TCP/TLS/auth handshake; keep warm connections around instead
      idleTimeoutMillis: 10 * 60_000,
      keepAlive: true
    })
    p.on('error', () => {}) // idle clients can error (server restart); the pool drops them
    pools.set(key, p)
  }
  return p
}

export async function closeAll(dsId?: string): Promise<void> {
  for (const [k, p] of pools) {
    if (!dsId || k.startsWith(dsId + '|')) {
      pools.delete(k)
      await p.end().catch(() => {})
    }
  }
}

export async function testConnection(ds: DataSource): Promise<string> {
  const p = new Pool({
    host: ds.host, port: ds.port, user: ds.user, password: ds.password,
    database: ds.database || 'postgres',
    ssl: ds.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000, max: 1
  })
  try {
    const r = await p.query('select version() as v')
    return r.rows[0].v as string
  } finally {
    await p.end()
  }
}

export async function listDatabases(ds: DataSource): Promise<string[]> {
  const sort = ds.dbSort ?? 'name-asc'
  // pg_database_size needs CONNECT privilege, so guard it per database
  const size = `case when has_database_privilege(datname, 'CONNECT') then pg_database_size(datname) end`
  const order =
    sort === 'name-desc' ? 'datname desc'
    : sort === 'size-desc' ? `${size} desc nulls last, datname`
    : sort === 'size-asc' ? `${size} asc nulls last, datname`
    : 'datname'
  const r = await poolFor(ds).query(
    `select datname from pg_database where not datistemplate and datallowconn order by ${order}`
  )
  return r.rows.map((x) => x.datname)
}

export async function listSchemas(ds: DataSource, database: string): Promise<string[]> {
  const r = await poolFor(ds, database).query(
    `select schema_name from information_schema.schemata
     where schema_name <> 'information_schema' and schema_name not like 'pg\\_%'
     order by schema_name`
  )
  return r.rows.map((x) => x.schema_name)
}

export async function listTables(
  ds: DataSource, database: string, schema: string
): Promise<{ name: string; kind: string }[]> {
  const r = await poolFor(ds, database).query(
    `select c.relname as name,
            case c.relkind when 'v' then 'view' when 'm' then 'matview'
                 when 'f' then 'foreign' when 'p' then 'table' else 'table' end as kind
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r','v','m','f','p')
     order by c.relname`,
    [schema]
  )
  return r.rows
}

/** Every table / view of a database in one query, grouped by schema (what the ⌘O indexer reads; same kinds as `listTables`). */
export async function tablesAll(ds: DataSource, database: string): Promise<Record<string, { name: string; kind: string }[]>> {
  const r = await poolFor(ds, database).query(
    `select n.nspname as schema, c.relname as name,
            case c.relkind when 'v' then 'view' when 'm' then 'matview'
                 when 'f' then 'foreign' when 'p' then 'table' else 'table' end as kind
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r','v','m','f','p') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
     order by c.relname`
  )
  const out: Record<string, { name: string; kind: string }[]> = {}
  for (const x of r.rows) (out[x.schema] ??= []).push({ name: x.name, kind: x.kind })
  return out
}

export async function getColumns(
  ds: DataSource, database: string, schema: string, table: string
): Promise<Column[]> {
  const r = await poolFor(ds, database).query(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
            not a.attnotnull as nullable,
            coalesce(a.attnum = any(i.indkey), false) as is_pk
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_index i on i.indrelid = c.oid and i.indisprimary
     where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
     order by a.attnum`,
    [schema, table]
  )
  return r.rows.map((x) => ({ name: x.name, type: x.type, nullable: x.nullable, isPk: x.is_pk }))
}

export async function getIndexes(
  ds: DataSource, database: string, schema: string, table: string
): Promise<{ name: string; definition: string }[]> {
  const r = await poolFor(ds, database).query(
    'select indexname as name, indexdef as definition from pg_indexes where schemaname=$1 and tablename=$2',
    [schema, table]
  )
  return r.rows
}

/** Pure: the SQL pieces of a rows query. `raw` = user-typed WHERE / ORDER BY text is involved. Throws on a bad ORDER BY. */
export function buildRowsSql(a: RowsQuery): {
  from: string
  where: string
  order: string
  raw: boolean
  countSql: string
  /** SELECT for the given column names (limit = $1, offset = $2) */
  rowsSql: (columnNames: string[]) => string
} {
  const from = `${q(a.schema)}.${q(a.table)}`
  const where = a.where?.trim() ? ` where ${a.where}` : ''
  // raw ORDER BY expression typed by the user (takes precedence over the header-click sort)
  const expr = (a.orderExpr ?? '').trim().replace(/^order\s+by(\s+|$)/i, '').trim()
  if (/;|--|\/\*|\*\//.test(expr)) throw new Error('ORDER BY must not contain ";" or SQL comments (-- or /* */)')
  const order = expr
    ? ` order by ${expr}`
    : a.orderBy ? ` order by t.${q(a.orderBy.column)} ${a.orderBy.desc ? 'desc' : 'asc'}` : ''
  return {
    from, where, order,
    raw: !!(where || expr),
    countSql: `select count(*)::int as n from ${from} as t${where} limit $1`,
    rowsSql: (names) => {
      const cols = names.map((n) => `t.${q(n)}::text as ${q(n)}`).join(', ')
      // A typed ORDER BY that names a column (`order by id desc`) would bind to the text-cast OUTPUT column of the
      // same name and sort numbers/dates as text ('99' > '250'). Sort and page in an inner query over the real
      // columns instead; the outer query only casts to text. (Header sort is qualified `t."col"`: no such issue.)
      return expr
        ? `select ${cols} from (select t.* from ${from} as t${where}${order} limit $1 offset $2) as t`
        : `select ${cols} from ${from} as t${where}${order} limit $1 offset $2`
    }
  }
}

export async function fetchRows(ds: DataSource, a: RowsQuery): Promise<RowsResult> {
  const pool = poolFor(ds, a.database)
  const { raw, countSql, rowsSql } = buildRowsSql(a)
  // user-typed SQL (WHERE / ORDER BY) runs in a read-only transaction, and every statement carries a bind
  // parameter so it goes through the extended protocol, which rejects multiple statements ("a; b")
  const run = async (text: string, values: unknown[]): Promise<PgResult> => {
    if (!raw) return pool.query(text, values)
    const c = await pool.connect()
    try {
      await c.query('begin read only')
      return await c.query(text, values)
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
  }
  // the count doesn't depend on the column list: run it in parallel with columns -> rows (saves a round trip)
  const totalP = run(countSql, [1])
  totalP.catch(() => {})
  const columns = await getColumns(ds, a.database, a.schema, a.table)
  const rows = await run(rowsSql(columns.map((c) => c.name)), [a.limit, a.offset])
  const total = await totalP
  return { columns, rows: rows.rows, total: total.rows[0].n }
}

/** Pure: `col::text = $n` conditions for a primary-key match (null -> `is null`, no bind value). */
function pkCond(pk: Record<string, unknown>, start: number): { sql: string; vals: unknown[] } {
  const keys = Object.keys(pk)
  if (!keys.length) throw new Error('Table has no primary key; cannot edit/delete rows')
  const vals: unknown[] = []
  const sql = keys
    .map((k) => {
      if (pk[k] === null) return `${q(k)} is null`
      vals.push(pk[k])
      return `${q(k)}::text = $${start + vals.length - 1}`
    })
    .join(' and ')
  return { sql, vals }
}

/** Pure: one parametrised statement per change, in execution order (updates, inserts, deletes). */
export function buildChangeStatements(schema: string, table: string, ch: Changes): { text: string; values?: unknown[] }[] {
  const from = `${q(schema)}.${q(table)}`
  const out: { text: string; values?: unknown[] }[] = []
  for (const u of ch.updates) {
    const keys = Object.keys(u.set)
    const w = pkCond(u.pk, keys.length + 1)
    out.push({
      text: `update ${from} set ${keys.map((k, i) => `${q(k)} = $${i + 1}`).join(', ')} where ${w.sql}`,
      values: [...keys.map((k) => u.set[k]), ...w.vals]
    })
  }
  for (const row of ch.inserts) {
    const keys = Object.keys(row)
    if (!keys.length) out.push({ text: `insert into ${from} default values` })
    else
      out.push({
        text: `insert into ${from} (${keys.map(q).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        values: keys.map((k) => row[k])
      })
  }
  for (const pk of ch.deletes) {
    const w = pkCond(pk, 1)
    out.push({ text: `delete from ${from} where ${w.sql}`, values: w.vals })
  }
  return out
}

export async function applyChanges(
  ds: DataSource, database: string, schema: string, table: string, ch: Changes
): Promise<void> {
  const client = await poolFor(ds, database).connect()
  try {
    await client.query('begin')
    for (const s of buildChangeStatements(schema, table, ch)) await client.query(s.text, s.values)
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

const MAX_ROWS = 5000

function show(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export async function runQuery(
  ds: DataSource, database: string, schema: string | undefined, sql: string
): Promise<QueryResult> {
  const client = await poolFor(ds, database).connect()
  const t0 = Date.now()
  try {
    if (schema) await client.query(`set search_path to ${q(schema)}, public`)
    const raw = (await client.query({ text: sql, rowMode: 'array' })) as unknown as PgResult | PgResult[]
    const list = Array.isArray(raw) ? raw : [raw]
    return {
      durationMs: Date.now() - t0,
      results: list.map((r) => ({
        command: r.command ?? '',
        rowCount: r.rowCount,
        fields: (r.fields ?? []).map((f) => f.name),
        rows: ((r.rows ?? []) as unknown[][]).slice(0, MAX_ROWS).map((row) => row.map(show)),
        truncated: (r.rows?.length ?? 0) > MAX_ROWS
      }))
    }
  } finally {
    await client.query('reset search_path').catch(() => {})
    client.release()
  }
}

export async function renameTable(
  ds: DataSource, database: string, schema: string, table: string, to: string
): Promise<void> {
  await poolFor(ds, database).query(`alter table ${q(schema)}.${q(table)} rename to ${q(to)}`)
}

export async function dropTable(
  ds: DataSource, database: string, schema: string, table: string, kind: string
): Promise<void> {
  const what = kind === 'view' ? 'view' : kind === 'matview' ? 'materialized view' : kind === 'foreign' ? 'foreign table' : 'table'
  await poolFor(ds, database).query(`drop ${what} ${q(schema)}.${q(table)}`)
}

export async function dropDatabase(ds: DataSource, database: string): Promise<void> {
  // end our own pools on that database first, then drop it from a different one
  for (const [k, p] of pools) {
    if (k.startsWith(`${ds.id}|${database}|`)) {
      pools.delete(k)
      await p.end().catch(() => {})
    }
  }
  const admin = database === 'postgres' ? 'template1' : 'postgres'
  await poolFor(ds, admin).query(`drop database ${q(database)}`)
}

/** Table/view names of every schema in a database in one query (for the cheap per-schema count pill). */
export async function tableNames(ds: DataSource, database: string): Promise<Record<string, string[]>> {
  const r = await poolFor(ds, database).query(
    `select n.nspname as schema, c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r','v','m','f','p') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
     order by c.relname`
  )
  const out: Record<string, string[]> = {}
  for (const x of r.rows) (out[x.schema] ??= []).push(x.name)
  return out
}

/** Schemas that exist in a database, excluding Postgres-internal toast/temp ones (matches DataGrip's "n of total"). */
export async function schemaTotal(ds: DataSource, database: string): Promise<number> {
  const r = await poolFor(ds, database).query(
    `select count(*)::int as n from pg_namespace
     where nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp%'`
  )
  return r.rows[0].n
}

export async function listRoles(ds: DataSource): Promise<string[]> {
  const r = await poolFor(ds).query('select rolname from pg_roles order by rolname')
  return r.rows.map((x) => x.rolname)
}

export async function listTablespaces(ds: DataSource): Promise<string[]> {
  const r = await poolFor(ds).query('select spcname from pg_tablespace order by spcname')
  return r.rows.map((x) => x.spcname)
}

/** Every schema (including information_schema / pg_catalog), without Postgres-internal toast/temp ones. */
export async function listAllSchemas(ds: DataSource, database: string): Promise<string[]> {
  const r = await poolFor(ds, database).query(
    `select nspname from pg_namespace
     where nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp%'
     order by nspname`
  )
  return r.rows.map((x) => x.nspname)
}

export async function createDatabase(ds: DataSource, name: string, owner?: string): Promise<void> {
  if (!name.trim()) throw new Error('Database name is required')
  const sql = `create database ${q(name.trim())}${owner?.trim() ? ` owner ${q(owner.trim())}` : ''}`
  // CREATE DATABASE cannot run inside a transaction or on the new database; use "postgres", else "template1"
  try {
    await poolFor(ds, 'postgres').query(sql)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code !== '3D000' && code !== '42501') throw e
    const c = new Client({
      host: ds.host, port: ds.port, user: ds.user, password: ds.password, database: 'template1',
      ssl: ds.ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 8000
    })
    await c.connect()
    try {
      await c.query(sql)
    } finally {
      await c.end().catch(() => {})
    }
  }
}

export async function createSchema(ds: DataSource, database: string, name: string, owner?: string): Promise<void> {
  if (!name.trim()) throw new Error('Schema name is required')
  await poolFor(ds, database).query(
    `create schema ${q(name.trim())}${owner?.trim() ? ` authorization ${q(owner.trim())}` : ''}`
  )
}

export async function createTable(
  ds: DataSource, database: string, schema: string, name: string, columns: NewColumn[]
): Promise<void> {
  const err = validateNewTable(name, columns)
  if (err) throw new Error(err)
  await poolFor(ds, database).query(buildCreateTable(schema, name, columns))
}

export async function addColumn(
  ds: DataSource, database: string, schema: string, table: string, column: NewColumn
): Promise<void> {
  const err = validateNewTable(table, [column])
  if (err) throw new Error(err)
  await poolFor(ds, database).query(buildAddColumn(schema, table, column))
}
