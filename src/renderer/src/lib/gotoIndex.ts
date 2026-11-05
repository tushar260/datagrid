import { STORAGE_PREFIX, applyTableFilter, cacheKeys, dsKind, type CacheEntry, type DataSource, type RedisDatabases } from '../../../shared'
import type { TableRef } from '../Explorer'
import { cached } from './objectCache'

/**
 * The ⌘O search index: every database and table name known locally (the persistent cache + what the explorer has loaded),
 * for all data sources, with the explorer's own visibility rules applied (visible databases, schema filter, table filter,
 * system schemas hidden) so the search never offers something the tree hides.
 */

export const SYSTEM_SCHEMAS = ['information_schema', 'pg_catalog']

export type GotoKind = 'table' | 'view' | 'matview' | 'foreign' | 'database'

export interface GotoEntry {
  /** unique and stable (also what the recent list stores) */
  id: string
  dsId: string
  dsName: string
  engine: 'postgres' | 'dynamodb' | 'redis'
  kind: GotoKind
  /** the matched text: a database / table name (Redis: `db0`) */
  name: string
  lower: string
  /** PostgreSQL: the database (and the schema of a table); Redis: the db index; DynamoDB: the region */
  database?: string
  schema?: string
  db?: number
  region?: string
}

/** `orders  table public [prod-pg]`: what is dimmed after the name (kind, where it lives, the data source in brackets) */
export function entrySuffix(e: GotoEntry): string {
  const where = e.engine === 'postgres' ? (e.kind === 'database' ? '' : `${e.database}.${e.schema}`) : ''
  return `${e.kind}${where ? ' ' + where : ''} [${e.dsName}]`
}

export const entryId = (e: Pick<GotoEntry, 'dsId' | 'kind' | 'name' | 'database' | 'schema'>): string =>
  [e.dsId, e.kind === 'database' ? 'd' : 't', e.database ?? '', e.schema ?? '', e.name].join('|')

const make = (ds: DataSource, p: Omit<GotoEntry, 'id' | 'dsId' | 'dsName' | 'lower'>): GotoEntry => {
  const base = { ...p, dsId: ds.id, dsName: ds.name, lower: p.name.toLowerCase() }
  return { ...base, id: entryId(base) }
}

type Peek = (dsId: string) => ReadonlyMap<string, CacheEntry> | undefined
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)
const rows = (v: unknown): { name: string; kind: string }[] | null =>
  Array.isArray(v) && v.every((x) => x && typeof (x as { name?: unknown }).name === 'string') ? (v as { name: string; kind: string }[]) : null

/** the databases / schemas / tables of a PostgreSQL source that the explorer would show and that are known locally */
function postgresEntries(ds: DataSource, m: ReadonlyMap<string, CacheEntry>): GotoEntry[] {
  const out: GotoEntry[] = []
  const dbs = strings(m.get(cacheKeys.pgDbs)?.data)
  if (!dbs) return out
  for (const db of ds.visibleDbs ? dbs.filter((n) => ds.visibleDbs!.includes(n)) : dbs) {
    out.push(make(ds, { engine: 'postgres', kind: 'database', name: db, database: db }))
    const schemas = strings(m.get(cacheKeys.pgSchemas(db))?.data)
    if (!schemas) continue
    const saved = ds.schemaFilter?.[db]
    for (const sc of schemas.filter((n) => (saved ? saved.includes(n) : !SYSTEM_SCHEMAS.includes(n)))) {
      const list = rows(m.get(cacheKeys.pgTables(db, sc))?.data)
      if (!list) continue
      const keep = new Set(applyTableFilter(ds.tableFilter?.[`${db}/${sc}`], list.map((t) => t.name)))
      for (const t of list) {
        if (keep.has(t.name)) out.push(make(ds, { engine: 'postgres', kind: (t.kind || 'table') as GotoKind, name: t.name, database: db, schema: sc }))
      }
    }
  }
  return out
}

/** Every searchable entry of every data source, from what `peek` knows (the object cache's in-memory index). */
export function buildGotoEntries(sources: readonly DataSource[], peek: Peek): GotoEntry[] {
  const out: GotoEntry[] = []
  for (const ds of sources) {
    const m = peek(ds.id)
    if (!m) continue
    const kind = dsKind(ds)
    if (kind === 'dynamodb') {
      const names = strings(m.get(cacheKeys.ddbTables)?.data)
      if (!names) continue
      const keep = new Set(applyTableFilter(ds.tableFilter?.['dynamodb'], names))
      for (const n of names) if (keep.has(n)) out.push(make(ds, { engine: 'dynamodb', kind: 'table', name: n, region: ds.dynamo?.region ?? '' }))
    } else if (kind === 'redis') {
      const r = m.get(cacheKeys.redisDbs)?.data as RedisDatabases | undefined
      if (!r || !Array.isArray(r.databases)) continue
      for (const d of r.databases) out.push(make(ds, { engine: 'redis', kind: 'database', name: `db${d.db}`, db: d.db }))
    } else out.push(...postgresEntries(ds, m))
  }
  return out
}

/** Does the explorer / cache know everything the search could know about this source? (Redis: only its databases, never keys.) */
export function isIndexed(ds: DataSource, m: ReadonlyMap<string, CacheEntry> | undefined): boolean {
  if (!m) return false
  const kind = dsKind(ds)
  if (kind === 'dynamodb') return !!strings(m.get(cacheKeys.ddbTables)?.data)
  if (kind === 'redis') return !!(m.get(cacheKeys.redisDbs)?.data as RedisDatabases | undefined)?.databases
  const dbs = strings(m.get(cacheKeys.pgDbs)?.data)
  if (!dbs) return false
  for (const db of ds.visibleDbs ? dbs.filter((n) => ds.visibleDbs!.includes(n)) : dbs) {
    const schemas = strings(m.get(cacheKeys.pgSchemas(db))?.data)
    if (!schemas) return false
    const saved = ds.schemaFilter?.[db]
    for (const sc of schemas.filter((n) => (saved ? saved.includes(n) : !SYSTEM_SCHEMAS.includes(n)))) {
      if (!rows(m.get(cacheKeys.pgTables(db, sc))?.data)) return false
    }
  }
  return true
}

/** The tab to open for a table entry (same shape the explorer passes to `onOpen`, so tabs dedupe / focus identically). */
export function tableRefOf(e: GotoEntry): TableRef {
  return e.engine === 'dynamodb'
    ? { dsId: e.dsId, dsName: e.dsName, database: '', schema: '', table: e.name, kind: 'table', engine: 'dynamodb', region: e.region }
    : { dsId: e.dsId, dsName: e.dsName, database: e.database ?? '', schema: e.schema ?? '', table: e.name, kind: e.kind }
}

/** The explorer node that represents a database entry (what ⌘O selects and expands). */
export const databaseNodeId = (e: GotoEntry): string => (e.engine === 'redis' ? `${e.dsId}/db${e.db}` : `${e.dsId}/${e.database}`)

// ---------------------------------------------------------------------------------------------------------------
// recently opened (empty query)
// ---------------------------------------------------------------------------------------------------------------

export const RECENT_KEY = `${STORAGE_PREFIX}goto-recent`
export const RECENT_MAX = 20

type Recent = Pick<GotoEntry, 'dsId' | 'engine' | 'kind' | 'name' | 'database' | 'schema' | 'db' | 'region'>

export function loadRecent(): Recent[] {
  try {
    const j: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(j)) return []
    return j
      .filter((r): r is Recent => !!r && typeof r.dsId === 'string' && typeof r.name === 'string' && ['postgres', 'dynamodb', 'redis'].includes(r.engine) && typeof r.kind === 'string')
      .slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** Remembers an opened entry (most recent first, no duplicates, at most RECENT_MAX). */
export function recordRecent(e: Recent): void {
  const r: Recent = { dsId: e.dsId, engine: e.engine, kind: e.kind, name: e.name, database: e.database, schema: e.schema, db: e.db, region: e.region }
  const id = entryId(r)
  const list = [r, ...loadRecent().filter((x) => entryId(x) !== id)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* quota / unavailable */
  }
}

/** The recent list as entries of the current data sources (those that were removed are skipped). */
export function recentEntries(sources: readonly DataSource[]): GotoEntry[] {
  const byId = new Map(sources.map((s) => [s.id, s]))
  const out: GotoEntry[] = []
  for (const r of loadRecent()) {
    const ds = byId.get(r.dsId)
    if (ds) out.push(make(ds, { engine: r.engine, kind: r.kind, name: r.name, database: r.database, schema: r.schema, db: r.db, region: r.region }))
  }
  return out
}

/** A table the user opened (from the explorer, ⌘O or a restored tab): goes into the recent list. */
export function recordOpenedTable(t: TableRef): void {
  if (t.engine === 'redis') return // key browsers / key tabs are not tables
  recordRecent({
    dsId: t.dsId,
    engine: t.engine === 'dynamodb' ? 'dynamodb' : 'postgres',
    kind: (t.kind || 'table') as GotoKind,
    name: t.table,
    database: t.engine === 'dynamodb' ? undefined : t.database,
    schema: t.engine === 'dynamodb' ? undefined : t.schema,
    region: t.region
  })
}

// ---------------------------------------------------------------------------------------------------------------
// indexing the data sources that were never introspected
// ---------------------------------------------------------------------------------------------------------------

export interface IndexProgress {
  done: number
  total: number
}
export interface IndexOptions {
  signal: { aborted: boolean }
  /** sources processed at the same time (default 3) */
  concurrency?: number
  /** a fetch that takes longer than this is given up on (default 20 s); its result is still cached when it arrives */
  timeoutMs?: number
  onProgress?: (p: IndexProgress) => void
  /** a source failed (unreachable, bad credentials...); the others go on */
  onError?: (ds: DataSource, message: string) => void
}

const cleanError = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    )
  })
}

/** Loads the missing lists of one source into the cache (and so into the index): PostgreSQL databases -> schemas -> tables. */
async function indexOne(ds: DataSource, peek: Peek, o: IndexOptions): Promise<void> {
  const ms = o.timeoutMs ?? 20_000
  const stop = (): boolean => o.signal.aborted
  const kind = dsKind(ds)
  if (kind === 'dynamodb') {
    await withTimeout(cached(ds.id, cacheKeys.ddbTables, () => window.api.dynamo.tables(ds.id)), ms, 'Listing tables')
    return
  }
  if (kind === 'redis') {
    await withTimeout(cached(ds.id, cacheKeys.redisDbs, () => window.api.redis.databases(ds.id)), ms, 'Listing databases')
    return
  }
  const dbs = await withTimeout(cached(ds.id, cacheKeys.pgDbs, () => window.api.databases(ds.id) as Promise<string[]>), ms, 'Listing databases')
  let failed = 0
  let lastError = ''
  for (const db of ds.visibleDbs ? dbs.filter((n) => ds.visibleDbs!.includes(n)) : dbs) {
    if (stop()) return
    try {
      const schemas = await withTimeout(cached(ds.id, cacheKeys.pgSchemas(db), () => window.api.schemasAll(ds.id, db) as Promise<string[]>), ms, 'Listing schemas')
      const saved = ds.schemaFilter?.[db]
      const wanted = schemas.filter((n) => (saved ? saved.includes(n) : !SYSTEM_SCHEMAS.includes(n)))
      const have = peek(ds.id)
      if (wanted.every((sc) => rows(have?.get(cacheKeys.pgTables(db, sc))?.data))) continue
      if (stop()) return
      // one query for all the tables of the database; each schema's list is stored under the key the explorer reads
      const all = await withTimeout(window.api.tablesAll(ds.id, db), ms, 'Listing tables')
      for (const sc of wanted) await cached(ds.id, cacheKeys.pgTables(db, sc), () => Promise.resolve(all[sc] ?? []))
    } catch (e) {
      failed++
      lastError = cleanError(e)
    }
  }
  if (failed && failed === dbs.length) throw new Error(lastError)
}

/** Which of `sources` still lack lists? (the footer's "Index N more data sources") */
export const unindexed = (sources: readonly DataSource[], peek: Peek): DataSource[] => sources.filter((ds) => !isIndexed(ds, peek(ds.id)))

/**
 * Loads the missing lists of `sources` with low concurrency; a failing source reports through `onError` and the others go on.
 * Stops starting new fetches once `signal.aborted` is set. Resolves when everything finished (or was abandoned).
 */
export async function indexSources(sources: readonly DataSource[], peek: Peek, o: IndexOptions): Promise<void> {
  const queue = [...sources]
  let done = 0
  const total = queue.length
  o.onProgress?.({ done, total })
  const worker = async (): Promise<void> => {
    for (let ds = queue.shift(); ds; ds = queue.shift()) {
      if (o.signal.aborted) return
      try {
        await indexOne(ds, peek, o)
      } catch (e) {
        o.onError?.(ds, cleanError(e))
      }
      done++
      o.onProgress?.({ done, total })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 3, total)) }, worker))
}
