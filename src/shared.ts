export type DbSort = 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc'

/** What a data source connects to. A saved source without `kind` is PostgreSQL (see `dsKind`). */
export type DsKind = 'postgres' | 'dynamodb' | 'redis'
/** default = AWS CLI / env / SSO / instance role (SDK provider chain); profile = a named profile; keys = static access key. */
export type DynamoAuthMode = 'default' | 'profile' | 'keys'

export interface DynamoConfig {
  /** empty = let the SDK resolve it (AWS_REGION / profile); `us-east-1` for access keys or a custom endpoint */
  region: string
  authMode: DynamoAuthMode
  profile?: string
  /** not a secret: stored in plain text */
  accessKeyId?: string
  /** custom endpoint for DynamoDB Local / LocalStack, e.g. http://localhost:8000 */
  endpoint?: string
  /**
   * Secrets. Write-only from the renderer: `secretAccessKey` blank/undefined = keep the saved one, text = replace.
   * `sessionToken` undefined = keep, '' = remove, text = replace. On disk both are encrypted (`enc:` / `raw:`);
   * the renderer never receives them back (see `hasSecret` / `hasSessionToken`).
   */
  secretAccessKey?: string
  sessionToken?: string
  /** runtime only (main -> renderer): a secret access key / session token is saved */
  hasSecret?: boolean
  hasSessionToken?: boolean
}

export interface RedisConfig {
  host: string
  port: number
  /** ACL user (Redis 6+); empty = the default user */
  username?: string
  /** logical database the data source opens by default (0-255) */
  db: number
  /** connect over TLS (certificates are verified) */
  tls: boolean
  /**
   * Secret. Write-only from the renderer: blank/undefined = keep the saved one, text = replace. On disk it is encrypted
   * (`enc:` / `raw:`); the renderer never receives it back (see `hasPassword`).
   */
  password?: string
  /** write-only: remove the saved password (a blank `password` alone keeps it) */
  clearPassword?: boolean
  /** runtime only (main -> renderer): a password is saved */
  hasPassword?: boolean
  /** separator that groups keys into folders in the explorer (default `:`); blank = no grouping */
  keyDelimiter?: string
}

export interface DataSource {
  id: string
  name: string
  /** missing = 'postgres' (sources saved before DynamoDB support) */
  kind?: DsKind
  /** DynamoDB settings (kind === 'dynamodb'); the Postgres connection fields below are then unused (empty) */
  dynamo?: DynamoConfig
  /** Redis settings (kind === 'redis'); the Postgres connection fields below are then unused (empty) */
  redis?: RedisConfig
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl: boolean
  folderId?: string | null
  /** how databases are ordered in the explorer (default: name A-Z) */
  dbSort?: DbSort
  /** databases shown in the explorer; null/undefined = all */
  visibleDbs?: string[] | null
  /** per database: schemas shown in the explorer; missing = default (everything except system schemas) */
  schemaFilter?: Record<string, string[]>
  /** per `${database}/${schema}`: which tables are shown; missing = all. A rule (pattern) wins over an explicit list. */
  tableFilter?: Record<string, TableFilter>
  /** runtime only: a password is saved but could not be decrypted (e.g. macOS Keychain access denied) */
  passwordUnavailable?: boolean
}

export type RuleMode = 'starts' | 'contains' | 'ends' | 'regex'
export interface PatternRule {
  mode: RuleMode
  pattern: string
}
export interface TableFilter {
  list?: string[]
  rule?: PatternRule
}

/** Case-insensitive pattern match; an invalid regex matches nothing. */
export function matchRule(rule: PatternRule, name: string): boolean {
  const p = rule.pattern
  if (!p) return true
  const n = name.toLowerCase()
  const l = p.toLowerCase()
  switch (rule.mode) {
    case 'starts': return n.startsWith(l)
    case 'ends': return n.endsWith(l)
    case 'contains': return n.includes(l)
    case 'regex':
      try {
        return new RegExp(p, 'i').test(name)
      } catch {
        return false
      }
  }
}

/** Names that pass a table filter (undefined filter = everything). */
export function applyTableFilter(filter: TableFilter | undefined, names: string[]): string[] {
  if (!filter) return names
  if (filter.rule) return names.filter((n) => matchRule(filter.rule!, n))
  if (filter.list) return names.filter((n) => filter.list!.includes(n))
  return names
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
}

export interface Column {
  name: string
  type: string
  nullable: boolean
  isPk: boolean
}

export interface RowsQuery {
  dsId: string
  database: string
  schema: string
  table: string
  where?: string
  orderBy?: { column: string; desc: boolean }
  /** raw user-typed ORDER BY expression (e.g. `name desc, id`); takes precedence over `orderBy` when non-empty */
  orderExpr?: string
  limit: number
  offset: number
}

export interface RowsResult {
  columns: Column[]
  rows: Record<string, unknown>[]
  total: number
}

export interface Changes {
  updates: { pk: Record<string, unknown>; set: Record<string, unknown> }[]
  inserts: Record<string, unknown>[]
  deletes: Record<string, unknown>[]
}

export interface QueryResult {
  /** one entry per statement, in order */
  results: {
    command: string
    rowCount: number | null
    fields: string[]
    rows: (string | null)[][]
    truncated: boolean
  }[]
  durationMs: number
}

// ---- CREATE helpers (shared by the renderer's DDL preview and the main process) ----

export interface NewColumn {
  name: string
  /** free text, validated by validateNewTable */
  type: string
  nullable: boolean
  isPk: boolean
  /** optional default expression, free text */
  default?: string
}

export const quoteIdent = (id: string): string => '"' + id.replace(/"/g, '""') + '"'

const TYPE_RE = /^[A-Za-z_][\w ,()[\]]*$/

function balanced(s: string): boolean {
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) return false
  }
  return depth === 0
}

/** Returns an error message, or null when the table definition is acceptable. */
export function validateNewTable(name: string, cols: NewColumn[]): string | null {
  if (!name.trim()) return 'Table name is required'
  if (!cols.length) return 'Add at least one column'
  const seen = new Set<string>()
  for (const [i, c] of cols.entries()) {
    const n = c.name.trim()
    if (!n) return `Column ${i + 1}: name is required`
    if (seen.has(n)) return `Duplicate column name "${n}"`
    seen.add(n)
    const t = c.type.trim()
    if (!t) return `Column "${n}": type is required`
    if (!TYPE_RE.test(t) || !balanced(t)) return `Column "${n}": invalid type "${t}"`
    const d = (c.default ?? '').trim()
    if (d && (d.includes(';') || d.includes('--') || d.includes('/*') || d.includes('*/')))
      return `Column "${n}": default must not contain ';' or comments`
  }
  return null
}

/** CREATE TABLE statement for the given definition (call validateNewTable first). */
export function buildCreateTable(schema: string, name: string, cols: NewColumn[]): string {
  const lines = cols.map((c) => {
    const d = (c.default ?? '').trim()
    return (
      `  ${quoteIdent(c.name.trim())} ${c.type.trim()}` +
      (d ? ` default ${d}` : '') +
      (!c.nullable || c.isPk ? ' not null' : '')
    )
  })
  const pks = cols.filter((c) => c.isPk).map((c) => quoteIdent(c.name.trim()))
  if (pks.length) lines.push(`  primary key (${pks.join(', ')})`)
  return `create table ${quoteIdent(schema)}.${quoteIdent(name.trim())} (\n${lines.join(',\n')}\n);`
}

/** ALTER TABLE ... ADD COLUMN statement (call validateNewTable on the column first). */
export function buildAddColumn(schema: string, table: string, c: NewColumn): string {
  const d = (c.default ?? '').trim()
  return (
    `alter table ${quoteIdent(schema)}.${quoteIdent(table)} add column ${quoteIdent(c.name.trim())} ${c.type.trim()}` +
    (d ? ` default ${d}` : '') +
    (!c.nullable ? ' not null' : '') +
    ';'
  )
}

/** Browser-style zoom range (percent); the main process steps through Chrome's table, the renderer only needs the ends. */
export const ZOOM_MIN_PERCENT = 25
export const ZOOM_MAX_PERCENT = 500

// ---- DynamoDB helpers (shared by the renderer's dialog / views and the main process) ----

/** Kind of a data source; sources saved before DynamoDB support have no `kind` and are PostgreSQL. */
export const dsKind = (d: { kind?: DsKind } | null | undefined): DsKind =>
  d?.kind === 'dynamodb' ? 'dynamodb' : d?.kind === 'redis' ? 'redis' : 'postgres'

/** Regions offered in the data source dialog (free text is accepted too). */
export const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'af-south-1', 'ap-east-1', 'ap-south-1', 'ap-south-2',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3',
  'ap-southeast-4', 'ca-central-1', 'ca-west-1', 'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-west-3',
  'eu-north-1', 'eu-south-1', 'eu-south-2', 'il-central-1', 'me-south-1', 'me-central-1', 'sa-east-1',
  'us-gov-east-1', 'us-gov-west-1', 'cn-north-1', 'cn-northwest-1'
]

/** Region names are used to build hostnames: letters, digits and dashes only (`us-east-1`, `local`). */
export const isValidRegion = (r: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(r)

/** Profile names are only looked up as ini section names, never used as paths: no separators / traversal. */
export const isValidProfile = (p: string): boolean => /^[A-Za-z0-9_@+=,:.-]{1,128}$/.test(p) && !p.includes('..')

/** The endpoint as a normalised http(s) URL string, or null when it is not one (no embedded credentials). */
export function parseEndpoint(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  try {
    const u = new URL(s)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null
    return s.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Returns an error message, or null when the DynamoDB settings are acceptable. `hasSavedSecret`: a secret key is already stored. */
export function validateDynamoConfig(d: DynamoConfig, hasSavedSecret: boolean): string | null {
  const region = (d.region ?? '').trim()
  if (region && !isValidRegion(region)) return `Invalid region "${region}" (expected e.g. us-east-1)`
  const ep = (d.endpoint ?? '').trim()
  if (ep && !parseEndpoint(ep)) return 'Endpoint URL must be an http:// or https:// URL (e.g. http://localhost:8000)'
  if (d.authMode === 'profile') {
    const p = (d.profile ?? '').trim()
    if (!p) return 'Choose or type a profile name'
    if (!isValidProfile(p)) return `Invalid profile name "${p}"`
  }
  if (d.authMode === 'keys') {
    if (!(d.accessKeyId ?? '').trim()) return 'Access key ID is required'
    if (!d.secretAccessKey && !hasSavedSecret) return 'Secret access key is required'
  }
  return null
}

/** PartiQL `SELECT * FROM "table" [WHERE cond]`; the table name is quoted with embedded double quotes doubled. */
export function selectAllPartiql(table: string, where?: string, index?: string): string {
  const w = where?.trim()
  const from = index ? `${quoteIdent(table)}.${quoteIdent(index)}` : quoteIdent(table) // "table"."index" queries a secondary index
  return `SELECT * FROM ${from}${w ? ` WHERE ${w}` : ''}`
}

/** Splits console text into statements at `;` outside 'strings' and "quoted names". Blank statements are dropped. */
export function splitStatements(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      cur += c
      if (c === q) {
        if (text[i + 1] === q) cur += text[++i]
        else q = null
      }
    } else if (c === "'" || c === '"') {
      q = c
      cur += c
    } else if (c === ';') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** JSON-serialisable form of a DynamoDB value (sets -> arrays, binary -> base64, numbers beyond 2^53 -> strings). */
export type DdbJson = null | boolean | number | string | DdbJson[] | { [k: string]: DdbJson }

export interface DynamoColumn {
  name: string
  /** DynamoDB type letters seen in this page (S, N, B, BOOL, NULL, SS, NS, BS, M, L) */
  types: string[]
  key?: 'HASH' | 'RANGE'
}

/** One page of items: the full items (for copy-as-JSON) plus the grid view (columns / stringified cells). */
export interface DynamoPage {
  items: Record<string, DdbJson>[]
  columns: DynamoColumn[]
  /** cells aligned with `columns`; null = attribute missing / NULL */
  rows: (string | null)[][]
  /** opaque cursor for the next page, null when there is none */
  next: string | null
  /** more than the column cap (200) distinct attributes were present */
  columnsCapped: boolean
}

export interface DynamoStatementResult extends DynamoPage {
  /** SELECT / INSERT / UPDATE / DELETE ... (first word, upper-cased) */
  command: string
  durationMs: number
}

export interface DynamoKeyDef {
  name: string
  /** HASH = partition key, RANGE = sort key */
  keyType: 'HASH' | 'RANGE'
  /** S | N | B (from the attribute definitions) */
  attrType: string
}

export interface DynamoIndexInfo {
  name: string
  kind: 'GSI' | 'LSI'
  status?: string
  keys: DynamoKeyDef[]
  projection: string
  nonKeyAttributes: string[]
  itemCount?: number
  sizeBytes?: number
  rcu?: number
  wcu?: number
}

export interface DynamoTableInfo {
  name: string
  arn: string
  status: string
  billingMode: string
  rcu?: number
  wcu?: number
  itemCount: number
  sizeBytes: number
  createdAt: string | null
  keySchema: DynamoKeyDef[]
  attributes: { name: string; type: string }[]
  indexes: DynamoIndexInfo[]
  stream: { enabled: boolean; viewType?: string; arn?: string }
  /** best effort (DescribeTimeToLive); null when it could not be read */
  ttl: { status: string; attribute?: string } | null
  tableClass?: string
  deletionProtection?: boolean
}

// ---- Redis helpers (shared by the renderer's dialog / views and the main process) ----

export const REDIS_DEFAULT_PORT = 6379
export const REDIS_MAX_DB = 255
export const REDIS_DEFAULT_DELIMITER = '' // like DataGrip: a flat key list per type until a key separator is set
export const REDIS_MAX_DELIMITER = 8
/** most keys the explorer's key tree loads for one database */
export const REDIS_KEYTREE_MAX = 100_000

/** The delimiter in effect for a config: undefined (legacy sources) = `:`, blank = no grouping. */
export const redisDelimiter = (c: { keyDelimiter?: string } | undefined | null): string =>
  c?.keyDelimiter === undefined ? REDIS_DEFAULT_DELIMITER : c.keyDelimiter

/** Returns an error message, or null when the Redis settings are acceptable. */
export function validateRedisConfig(c: Pick<RedisConfig, 'host' | 'port' | 'db'> & Partial<RedisConfig>): string | null {
  const host = (c.host ?? '').trim() // surrounding spaces (pasted text) are trimmed on save
  if (!host) return 'Host is required'
  if (/\s/.test(host)) return 'Host must not contain spaces'
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return 'Port must be a number between 1 and 65535'
  if (!Number.isInteger(c.db) || c.db < 0 || c.db > REDIS_MAX_DB) return `Database must be a whole number between 0 and ${REDIS_MAX_DB}`
  if (c.keyDelimiter !== undefined && typeof c.keyDelimiter !== 'string') return 'Key delimiter must be text'
  if ((c.keyDelimiter ?? '').length > REDIS_MAX_DELIMITER) return `Key delimiter can have at most ${REDIS_MAX_DELIMITER} characters`
  if (/[\r\n\u0000]/.test(c.keyDelimiter ?? '')) return 'Key delimiter must not contain line breaks'
  return null
}

/**
 * Keys / fields / members can be arbitrary bytes but cross the IPC boundary as strings. Text that is valid UTF-8 is sent
 * as is; anything else is sent as this prefix + base64, which the main process turns back into the exact bytes.
 */
export const REDIS_BIN_PREFIX = '\u0000b64:'
export const isRedisBinaryName = (s: string): boolean => s.startsWith(REDIS_BIN_PREFIX)

/** Human-readable form of a name: text as is, binary names as `\xNN` escapes (like redis-cli). */
export function redisDisplayName(s: string): string {
  if (!isRedisBinaryName(s)) return s
  let bin = ''
  try {
    bin = atob(s.slice(REDIS_BIN_PREFIX.length))
  } catch {
    return s
  }
  let out = ''
  for (let i = 0; i < bin.length; i++) {
    const c = bin.charCodeAt(i)
    out += c >= 32 && c < 127 && c !== 92 && c !== 34 ? bin[i] : c === 92 ? '\\\\' : c === 34 ? '\\"' : c === 10 ? '\\n' : c === 13 ? '\\r' : c === 9 ? '\\t' : '\\x' + c.toString(16).padStart(2, '0')
  }
  return out
}

/** A database (logical db index) that holds keys. */
export interface RedisDbInfo {
  db: number
  keys: number
  expires: number
}

export interface RedisDatabases {
  /** databases with keys (INFO keyspace), always including the configured default one */
  databases: RedisDbInfo[]
  /** `CONFIG GET databases`; null when the server did not allow it (or cluster mode) */
  count: number | null
  cluster: boolean
}

export interface RedisKeyInfo {
  key: string
  type: string
  /** remaining time to live in milliseconds, -1 = no expiry */
  ttl: number
}

export interface RedisScanOpts {
  /** Redis glob; empty = `*` */
  pattern?: string
  /** SCAN COUNT hint per step (clamped) */
  count?: number
  /** soft cap on the keys returned by one call (clamped to 5000; a SCAN reply is never split) */
  limit?: number
  cursor?: string | null
  type?: string
}

export interface RedisScanResult {
  keys: RedisKeyInfo[]
  /** continue with this cursor, null when the iteration is complete */
  cursor: string | null
}

/** What the explorer needs of a key: its name and a coarse type (module / unknown types are `other`). */
export type RedisTreeType = 'string' | 'list' | 'set' | 'zset' | 'hash' | 'stream' | 'other'

export interface RedisKeyTreeOpts {
  /** most keys to return (clamped to 1..REDIS_KEYTREE_MAX) */
  max?: number
}

export interface RedisKeyTree {
  keys: { key: string; type: RedisTreeType }[]
  /** false = the key space was not fully read (cap reached, time budget used or superseded by a newer scan) */
  complete: boolean
  /** DBSIZE when the scan started */
  dbsize: number
}

export interface RedisPageOpts {
  /** list / zset: index of the first item */
  offset?: number
  /** hash / set: SCAN cursor; stream: id of the first entry */
  cursor?: string | null
  limit?: number
}

export type RedisValue =
  | { kind: 'none' }
  | { kind: 'unsupported'; type: string }
  | { kind: 'string'; text: string; binary: boolean; base64: string; bytes: number; truncated: boolean }
  | { kind: 'hash'; items: { field: string; value: string }[]; next: string | null }
  | { kind: 'list'; items: string[]; offset: number; next: number | null }
  | { kind: 'set'; items: string[]; next: string | null }
  | { kind: 'zset'; items: { member: string; score: string }[]; offset: number; next: number | null }
  | { kind: 'stream'; entries: { id: string; fields: { field: string; value: string }[] }[]; next: string | null }

export interface RedisKeyDetail {
  key: string
  type: string
  /** milliseconds, -1 = no expiry, -2 = the key does not exist */
  ttl: number
  /** MEMORY USAGE in bytes (best effort) */
  size: number | null
  /** STRLEN / HLEN / LLEN / SCARD / ZCARD / XLEN */
  length: number | null
  encoding?: string
  value: RedisValue
}

export type RedisItemOp =
  | { op: 'hset'; field: string; value: string }
  | { op: 'hdel'; field: string }
  | { op: 'lset'; index: number; value: string }
  | { op: 'lpush' | 'rpush'; value: string }
  | { op: 'lrem'; value: string; count?: number }
  | { op: 'sadd' | 'srem'; member: string }
  | { op: 'zadd'; member: string; score: number | string }
  | { op: 'zrem'; member: string }

export type RedisNewKey =
  | { type: 'string'; value: string }
  | { type: 'hash'; field: string; value: string }
  | { type: 'list'; value: string }
  | { type: 'set'; member: string }
  | { type: 'zset'; member: string; score: number | string }

/** A normalised reply of a console command. */
export type RedisReply =
  | { kind: 'status'; value: string }
  | { kind: 'integer'; value: number }
  | { kind: 'bulk'; value: string }
  | { kind: 'nil' }
  | { kind: 'array'; items: RedisReply[] }
  | { kind: 'error'; message: string }

export interface RedisCommandEntry {
  /** the command line as typed */
  line: string
  /** first word, upper-cased */
  command: string
  reply: RedisReply
  durationMs: number
}

export interface RedisCommandResult {
  /** one entry per executed line; the run stops at the first error reply */
  results: RedisCommandEntry[]
  durationMs: number
}

// ---------------------------------------------------------------------------------------------------------------
// local cache of the lists the explorer shows (main: src/main/objectCache.ts, renderer: lib/objectCache.ts)
// ---------------------------------------------------------------------------------------------------------------

/** One cached list: when it was fetched (epoch ms) and the data as the explorer got it. Never rows, values or secrets. */
export interface CacheEntry {
  at: number
  data: unknown
}
export const CACHE_VERSION = 1
/** a data source's cache file never grows beyond this; an entry that would exceed it is simply not cached */
export const CACHE_MAX_BYTES = 40 * 1024 * 1024
export const CACHE_MAX_KEY = 512

const ce = encodeURIComponent
/** The cache keys (names are URI-encoded so a `:` in a database / schema name cannot blur two keys). */
export const cacheKeys = {
  pgDbs: 'pg:dbs',
  pgRoles: 'pg:roles',
  pgTablespaces: 'pg:tablespaces',
  pgSchemas: (db: string): string => `pg:schemas:${ce(db)}`,
  /** one entry per database: `{ schema: [table names] }` (the schema count pills) */
  pgTableNames: (db: string): string => `pg:tablenames:${ce(db)}`,
  pgTables: (db: string, schema: string): string => `pg:tables:${ce(db)}:${ce(schema)}`,
  /** prefix of every `pgTables` key of one database */
  pgTablesOf: (db: string): string => `pg:tables:${ce(db)}:`,
  ddbTables: 'ddb:tables',
  redisDbs: 'redis:dbs',
  redisTree: (db: number): string => `redis:tree:${db}`
} as const
/** the keys the ⌘O index is built from (`cache:all` only returns these, never the big key trees) */
export const CACHE_INDEX_PREFIXES: readonly string[] = ['pg:dbs', 'pg:schemas:', 'pg:tables:', 'ddb:tables', 'redis:dbs']

/** A Redis key tree stored compactly: key names grouped by type (no repeated `{key,type}` objects). */
export interface CompactKeyTree {
  complete: boolean
  dbsize: number
  types: Partial<Record<RedisTreeType, string[]>>
}
export function compactKeyTree(t: RedisKeyTree): CompactKeyTree {
  const types: Partial<Record<RedisTreeType, string[]>> = {}
  for (const k of t.keys) (types[k.type] ??= []).push(k.key)
  return { complete: t.complete, dbsize: t.dbsize, types }
}
/** Inverse of `compactKeyTree`; anything malformed gives null (treated as a cache miss). */
export function expandKeyTree(c: unknown): RedisKeyTree | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Partial<CompactKeyTree>
  if (typeof o.complete !== 'boolean' || typeof o.dbsize !== 'number' || !o.types || typeof o.types !== 'object') return null
  const keys: RedisKeyTree['keys'] = []
  for (const [type, list] of Object.entries(o.types)) {
    if (!Array.isArray(list)) return null
    for (const key of list) {
      if (typeof key !== 'string') return null
      keys.push({ key, type: type as RedisTreeType })
    }
  }
  return { keys, complete: o.complete, dbsize: o.dbsize }
}

// ---------------------------------------------------------------------------------------------------------------
// Settings > Backup & restore (main: src/main/backup.ts + backupService.ts, renderer: BackupSection.tsx + lib/backup.ts)
// ---------------------------------------------------------------------------------------------------------------

/** Reset parentId to root for folders that sit on a parent cycle (keeps every folder; returns a new array only if changed). */
export function breakFolderCycles(list: Folder[]): Folder[] {
  const parentOf = new Map(list.map((f) => [f.id, f.parentId ?? null]))
  const inCycle = new Set<string>()
  const done = new Set<string>()
  for (const f of list) {
    const path: string[] = []
    const onPath = new Set<string>()
    let cur: string | null = f.id
    while (cur && !done.has(cur) && parentOf.has(cur)) {
      if (onPath.has(cur)) {
        for (const id of path.slice(path.indexOf(cur))) inCycle.add(id)
        break
      }
      onPath.add(cur)
      path.push(cur)
      cur = parentOf.get(cur) ?? null
    }
    for (const id of path) done.add(id)
  }
  return inCycle.size ? list.map((f) => (inCycle.has(f.id) ? { ...f, parentId: null } : f)) : list
}

export const BACKUP_FORMAT = 'datagrid-backup'
export const BACKUP_VERSION = 1
export const BACKUP_EXT = '.datagrid-backup.json'
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024
export const BACKUP_MAX_ITEMS = 5000
export const BACKUP_MIN_PASSPHRASE = 8
export const BACKUP_MAX_PASSPHRASE = 1024

/** Keys that are never accepted as object keys / ids anywhere in a backup. */
export const isHostileKey = (k: string): boolean => k === '__proto__' || k === 'constructor' || k === 'prototype'

const LAYOUT_EXACT = ['datagrip-lite:console-split', 'datagrip-lite:filter-split', 'datagrip-lite:redis-split']
const LAYOUT_PICKER = 'datagrip-lite:picker-size:'
/**
 * UI layout preferences that travel in a backup (split ratios, picker sizes). Never the open-tabs session, console SQL
 * text, or any cache. ('datagrip-lite:' is the legacy persisted prefix.)
 */
export const isBackupLayoutKey = (k: unknown): k is string =>
  typeof k === 'string' && (LAYOUT_EXACT.includes(k) || (k.startsWith(LAYOUT_PICKER) && /^[A-Za-z0-9_-]{1,40}$/.test(k.slice(LAYOUT_PICKER.length))))

export interface BackupCounts {
  folders: number
  sources: number
  byKind: Record<DsKind, number>
}

/** What the import preview shows (never any secret). */
export interface BackupSummary {
  fileName: string
  createdAt: string
  appVersion: string
  platform: string
  counts: BackupCounts
  hasSettings: boolean
  hasLayout: boolean
  hasSession: boolean
  /** at least one saved password / secret is inside the backup */
  hasSecrets: boolean
  encrypted: boolean
}

export interface BackupExportRequest {
  includeSecrets: boolean
  /** only when includeSecrets (min 8 characters); never stored or logged */
  passphrase?: string
  /** the renderer's `datagrip-lite:settings` values */
  settings?: unknown
  /** whitelisted localStorage layout entries (key -> raw string) */
  layout?: Record<string, string>
  /** the open-tabs session (console SQL text is dropped); only when the user ticked "Include open tabs and layout" */
  session?: unknown
}

export type BackupExportResult =
  | { ok: true; path: string; bytes: number; encrypted: boolean; counts: BackupCounts; secrets: boolean; /** sources whose saved password could not be read (Keychain denied): exported without it */ unreadable?: number }
  | { ok: false; canceled?: boolean; error?: string }

export type BackupPickResult =
  | { ok: false; canceled?: boolean; error?: string }
  | { ok: true; importId: string; fileName: string; needsPassphrase: true }
  | { ok: true; importId: string; fileName: string; needsPassphrase: false; summary: BackupSummary }

export type BackupUnlockResult =
  | { ok: true; summary: BackupSummary }
  | { ok: false; error: string; /** the import is gone (expired / cancelled): pick the file again */ expired?: boolean }

export type BackupMode = 'merge' | 'replace'

export interface BackupApplyOptions {
  mode: BackupMode
  applySettings: boolean
  applyLayout: boolean
  applySession: boolean
  /** the renderer's current settings / layout / session, saved into the automatic safety backup (so Undo can restore them) */
  current?: { settings?: unknown; layout?: Record<string, string>; session?: unknown }
}

export interface BackupApplyResult {
  ok: true
  mode: BackupMode
  foldersAdded: number
  sourcesAdded: number
  /** backup items that were already there (same id, name and connection): not imported again */
  skipped: number
  /** colliding items imported as "(imported)" copies */
  renamed: number
  /** 'applied' secrets were re-encrypted for this Mac; 'none' the backup had none; 'unavailable' Keychain could not be used */
  secrets: 'applied' | 'none' | 'unavailable'
  /** the values the renderer must apply now (only what was asked for and present in the backup) */
  settings?: Record<string, string | number | boolean>
  layout?: Record<string, string>
  session?: unknown
  /** an automatic backup of the previous state exists: `backup:undo` restores it */
  undoAvailable: boolean
}
export type BackupApplyOutcome = BackupApplyResult | { ok: false; error: string; expired?: boolean }

/** Raw (still Keychain-encrypted, `enc:`) secret blobs of one data source: only ever inside this Mac's automatic backups. */
export interface DeviceSecrets {
  password?: string
  secretAccessKey?: string
  sessionToken?: string
}

/** One entry of the final data source list when a backup is applied: an existing stored record, or one built from the backup. */
export type StateItem =
  | { keep: string }
  | { add: DataSource; inheritFrom?: string; deviceSecrets?: DeviceSecrets }
