import { isIP } from 'net'
import { createHash } from 'crypto'
import { Redis } from 'ioredis'
import { REDIS_BIN_PREFIX, REDIS_KEYTREE_MAX, REDIS_MAX_DB, validateRedisConfig } from '../shared'
import type {
  DataSource, RedisCommandEntry, RedisCommandResult, RedisConfig, RedisDatabases, RedisDbInfo, RedisItemOp, RedisKeyDetail,
  RedisKeyInfo, RedisKeyTree, RedisKeyTreeOpts, RedisNewKey, RedisPageOpts, RedisScanOpts, RedisScanResult, RedisTreeType, RedisValue
} from '../shared'
import { blockedReason, commandLines, isReplyError, isUtf8, normalizeReply, splitArgs, errorReply } from './redisCommand'

/**
 * Redis support (ioredis). One lazily opened connection per data source AND database index (SELECT is per connection, so
 * databases never share one), plus a separate connection per database for the console. Connections give up quickly
 * (short connect timeout, one retry) so a wrong host errors fast instead of hanging. The password reaches this module
 * decrypted inside `ds.redis` and is only handed to ioredis: never logged, never returned. Only SCAN is used to list
 * keys (never KEYS) and nothing here can flush a database.
 */

/** SCAN COUNT / key limit bounds, page size bound, other input bounds */
export const MAX_SCAN_LIMIT = 5000
export const MAX_PAGE_LIMIT = 1000
export const DEFAULT_SCAN_LIMIT = 200
export const DEFAULT_PAGE_LIMIT = 200
export const MAX_KEY_BYTES = 65_536
/** a string value is read up to this size (the rest is flagged `truncated`) */
export const MAX_STRING_BYTES = 1_048_576
export const MAX_VALUE_BYTES = 16 * 1_048_576
export const MAX_DELETE_KEYS = 5000
export const MAX_PATTERN_CHARS = 1024
const MAX_COMMAND_TEXT = 1_048_576
const MAX_COMMAND_LINES = 1000
const SCAN_BUDGET_MS = 2500
const SCAN_MAX_STEPS = 400
export const CONNECT_TIMEOUT_MS = 5000
const COMMAND_TIMEOUT_MS = 15_000
const CONSOLE_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------------------------------------------
// names (keys / fields / members): UTF-8 text as is, anything else as REDIS_BIN_PREFIX + base64
// ---------------------------------------------------------------------------------------------------------------

/** The string form of key / field / member bytes (see REDIS_BIN_PREFIX). */
export function encodeName(b: Buffer): string {
  const s = b.toString('utf8')
  return isUtf8(b) && !s.startsWith(REDIS_BIN_PREFIX) ? s : REDIS_BIN_PREFIX + b.toString('base64')
}

/** The exact bytes of a name made by `encodeName`. */
export function decodeName(s: string): Buffer {
  return s.startsWith(REDIS_BIN_PREFIX) ? Buffer.from(s.slice(REDIS_BIN_PREFIX.length), 'base64') : Buffer.from(s, 'utf8')
}

function bad(m: string): never {
  throw new Error(m)
}

/** A key / field / member name from the renderer as bytes (non-empty, bounded). */
function nameBytes(s: unknown, what = 'Key'): Buffer {
  if (typeof s !== 'string' || !s) return bad(`${what} must not be empty`)
  const b = decodeName(s)
  if (!b.length) return bad(`${what} must not be empty`)
  if (b.length > MAX_KEY_BYTES) return bad(`${what} is too long (more than ${MAX_KEY_BYTES} bytes)`)
  return b
}

function valueBytes(s: unknown): Buffer {
  if (typeof s !== 'string') return bad('Value must be text')
  const b = Buffer.from(s, 'utf8')
  if (b.length > MAX_VALUE_BYTES) return bad(`Value is too large (more than ${MAX_VALUE_BYTES / 1_048_576} MB)`)
  return b
}

/** An item (hash value, list element, set / zset member) as bytes: binary-safe like names, bounded like values. */
function itemBytes(s: unknown, what = 'Value'): Buffer {
  if (typeof s !== 'string') return bad(`${what} must be text`)
  const b = decodeName(s)
  if (b.length > MAX_VALUE_BYTES) return bad(`${what} is too large (more than ${MAX_VALUE_BYTES / 1_048_576} MB)`)
  return b
}

export function checkDb(db: unknown): number {
  if (typeof db !== 'number' || !Number.isInteger(db) || db < 0 || db > REDIS_MAX_DB) {
    return bad(`Database must be a whole number between 0 and ${REDIS_MAX_DB}`)
  }
  return db
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : def
  return Math.max(min, Math.min(max, n))
}

// ---------------------------------------------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------------------------------------------

type Role = 'main' | 'console'

interface Entry {
  sig: string
  client: Redis
  ready: Promise<void>
  lastError?: Error
}

const pool = new Map<string, Entry>()
const poolKey = (id: string, db: number, role: Role): string => `${id}|${db}|${role}`

function configOf(ds: DataSource): RedisConfig {
  if (!ds.redis) throw new Error('Not a Redis data source')
  return ds.redis
}

/** Fingerprint of everything that shapes a connection (hashed: the password is not kept in a readable key). */
const signature = (cfg: RedisConfig, db: number): string =>
  createHash('sha256').update(JSON.stringify([cfg.host, cfg.port, cfg.username ?? '', cfg.password ?? '', cfg.tls, db])).digest('hex')

/** ioredis settings: fail fast, never resend unfulfilled writes, RESP2 so replies have one fixed shape. */
export function clientOptions(cfg: RedisConfig, commandTimeout = COMMAND_TIMEOUT_MS): Record<string, unknown> {
  const host = cfg.host.trim()
  return {
    host,
    port: cfg.port,
    ...(cfg.username?.trim() ? { username: cfg.username.trim() } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
    // no `db` option: ioredis swallows a failed SELECT and would carry on in database 0. We SELECT ourselves after connecting.
    ...(cfg.tls ? { tls: isIP(host) ? {} : { servername: host } } : {}),
    protocol: 2,
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout,
    maxRetriesPerRequest: 1,
    // one quick retry (a dropped idle connection), then give up: the next call opens a fresh client
    retryStrategy: (times: number) => (times > 1 ? null : 150),
    autoResendUnfulfilledCommands: false,
    disableClientInfo: true
  }
}

/** A new (unconnected) client for a Redis data source and database (not pooled; see `connection`). */
export function makeClient(ds: DataSource, commandTimeout?: number): Redis {
  return new Redis(clientOptions(configOf(ds), commandTimeout) as never)
}

function open(ds: DataSource, db: number, role: Role, k: string, sig: string): Entry {
  const client = makeClient(ds, role === 'console' ? CONSOLE_TIMEOUT_MS : COMMAND_TIMEOUT_MS)
  const entry: Entry = { sig, client, ready: Promise.resolve() }
  // without a listener ioredis prints every connection error; we keep the last one: it is the real reason of "Connection is closed"
  client.on('error', (e: Error) => {
    entry.lastError = e
  })
  entry.ready = client.connect().then(
    () => (db > 0 ? client.callBuffer('SELECT', db).then(() => undefined) : undefined),
    (e: unknown) => {
      if (pool.get(k) === entry) pool.delete(k)
      client.disconnect()
      throw entry.lastError ?? e
    }
  )
  return entry
}

/** The pooled connection of a data source + database (opened on first use, replaced when it ended or its settings changed). */
export async function connection(ds: DataSource, db: number, role: Role = 'main'): Promise<Redis> {
  checkDb(db)
  const cfg = configOf(ds)
  const k = poolKey(ds.id, db, role)
  const sig = signature(cfg, db)
  let entry = pool.get(k)
  if (entry && (entry.sig !== sig || entry.client.status === 'end')) {
    entry.client.disconnect()
    pool.delete(k)
    entry = undefined
  }
  if (!entry) {
    entry = open(ds, db, role, k, sig)
    pool.set(k, entry)
  }
  await entry.ready
  return entry.client
}

/** Closes the pooled connection(s) of one data source (edit / delete / disconnect), or all of them (quit). */
export async function closeAll(dsId?: string): Promise<void> {
  for (const k of treeRuns.keys()) if (!dsId || k.startsWith(dsId + '|')) treeRuns.set(k, (treeRuns.get(k) ?? 0) + 1) // stop running tree scans
  for (const [k, e] of pool) {
    if (dsId && !k.startsWith(dsId + '|')) continue
    pool.delete(k)
    e.client.disconnect()
  }
}

/** Number of open pooled connections (tests). */
export const poolSize = (): number => pool.size

// ---------------------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------------------

interface NetErr {
  name?: string
  message?: string
  code?: string
  cause?: unknown
}

const NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED'])

function netCode(e: NetErr): string | undefined {
  for (let x: NetErr | undefined = e, n = 0; x && n < 4; x = x.cause as NetErr | undefined, n++) {
    if (x.code && (NET_CODES.has(x.code) || /^(ERR_SSL|ERR_TLS|EPROTO|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH)/.test(x.code))) return x.code
    const m = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b/.exec(x.message ?? '')
    if (m) return m[1]
  }
  return undefined
}

/** A short, actionable message for a Redis / network / TLS error (never contains the password). */
export function cleanRedisError(e: unknown, ctx: { host?: string; port?: number } = {}): string {
  const err = (e ?? {}) as NetErr
  const raw = (err.message ?? String(e)).trim()
  const msg = raw.replace(/^ERR /, '')
  const where = ctx.host ? `${ctx.host}:${ctx.port ?? 6379}` : 'the Redis server'
  const code = netCode(err)
  if (/WRONGPASS|invalid username-password pair|invalid password/i.test(raw)) return 'Authentication failed: wrong username or password.'
  if (/NOAUTH|Authentication required/i.test(raw)) return 'Authentication required: this server needs a password. Enter it in Edit Data Source.'
  if (/AUTH.*without any password configured|no password is set/i.test(raw)) {
    return 'The server has no password set, but one was sent. Clear the password in Edit Data Source.'
  }
  if (/NOPERM|no permissions to/i.test(raw)) return `Permission denied: ${msg}`
  if (/WRONGTYPE/i.test(raw)) return 'Wrong type: the key holds a different kind of value than this operation expects.'
  if (/DB index is out of range/i.test(raw)) return 'Database index out of range: the server has fewer databases than that.'
  if (/SELECT is not allowed in cluster mode/i.test(raw)) return 'This server runs in cluster mode: only database 0 exists.'
  if (/^LOADING/i.test(raw)) return 'Redis is still loading its dataset into memory. Try again in a moment.'
  if (/ERR_SSL|ERR_TLS|EPROTO|certificate|self[- ]signed|handshake|wrong version number|hostname\/ip does not match/i.test(`${code ?? ''} ${raw}`)) {
    return `TLS error talking to ${where}: ${msg}. Check that the server accepts TLS on this port (or untick "Use TLS").`
  }
  if (code === 'ECONNREFUSED') return `Could not connect to ${where} (connection refused). Is Redis running, and are the host and port right?`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Could not resolve host "${ctx.host ?? ''}". Check the host name.`
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || /connect ETIMEDOUT|Connection timeout|timed out connecting/i.test(raw)) {
    return `Timed out connecting to ${where}. Check the host, the port, your network and any firewall.`
  }
  if (/Command timed out/i.test(raw)) return 'The command timed out: the server did not answer in time.'
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || /Connection is closed|Stream isn't writeable|Socket closed unexpectedly/i.test(raw)) {
    return `The connection to ${where} was closed. If the server needs TLS tick "Use TLS"; otherwise it may have restarted.`
  }
  return msg || err.name || 'Unknown Redis error'
}

async function guarded<T>(ds: DataSource, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const cfg = ds.redis
    throw new Error(cleanRedisError(e, { host: cfg?.host.trim(), port: cfg?.port }))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------------------------------------------

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(str(v)))

/** `key:value` lines of an INFO section. */
function infoFields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  return out
}

/** `db3:keys=10,expires=2,avg_ttl=0` lines of INFO keyspace. */
export function parseKeyspace(text: string): RedisDbInfo[] {
  const out: RedisDbInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^db(\d+):(.*)$/.exec(line.trim())
    if (!m) continue
    const f = Object.fromEntries(m[2].split(',').map((p) => p.split('=') as [string, string]))
    out.push({ db: Number(m[1]), keys: Number(f.keys) || 0, expires: Number(f.expires) || 0 })
  }
  return out.sort((a, b) => a.db - b.db)
}

/** PING + server version and mode, over a throwaway connection (never the pool). Resolves with a one-line summary. */
export async function testConnection(ds: DataSource): Promise<string> {
  const cfg = configOf(ds)
  const problem = validateRedisConfig(cfg)
  if (problem) throw new Error(problem)
  const client = makeClient(ds, 8000)
  let last: Error | undefined
  client.on('error', (e: Error) => {
    last = e
  })
  try {
    await client.connect()
    if (cfg.db > 0) await client.callBuffer('SELECT', cfg.db)
    const t0 = Date.now()
    const pong = str(await client.callBuffer('PING'))
    const ms = Date.now() - t0
    let version = ''
    let mode = 'standalone'
    let product = 'Redis'
    try {
      const f = infoFields(str(await client.callBuffer('INFO', 'server')))
      version = f.redis_version ?? ''
      mode = f.redis_mode ?? mode
      if (f.server_name) product = f.server_name[0].toUpperCase() + f.server_name.slice(1)
    } catch {
      /* INFO can be disabled by ACLs: the PING is the test */
    }
    return `${product}${version ? ' ' + version : ''} (${mode}), db${cfg.db}, ${pong} in ${ms} ms`
  } catch (e) {
    throw new Error(cleanRedisError(last ?? e, { host: cfg.host.trim(), port: cfg.port }))
  } finally {
    client.disconnect()
  }
}

/** The databases that hold keys (INFO keyspace, always incl. the configured one) and the server's database count. */
export function listDatabases(ds: DataSource): Promise<RedisDatabases> {
  return guarded(ds, async () => {
    const cfg = configOf(ds)
    const c = await connection(ds, cfg.db)
    const [ks, cl, conf] = await Promise.allSettled([
      c.callBuffer('INFO', 'keyspace'),
      c.callBuffer('INFO', 'cluster'),
      c.callBuffer('CONFIG', 'GET', 'databases')
    ])
    if (ks.status === 'rejected') throw ks.reason
    const databases = parseKeyspace(str(ks.value))
    const cluster = cl.status === 'fulfilled' && infoFields(str(cl.value)).cluster_enabled === '1'
    if (!databases.some((d) => d.db === cfg.db)) databases.push({ db: cfg.db, keys: 0, expires: 0 })
    databases.sort((a, b) => a.db - b.db)
    let count: number | null = null
    if (cluster) count = 1
    else if (conf.status === 'fulfilled' && Array.isArray(conf.value) && conf.value.length >= 2) {
      const n = parseInt(str(conf.value[1]), 10)
      count = Number.isFinite(n) ? n : null
    }
    return { databases, count, cluster }
  })
}

/** DBSIZE of one database (approximate count of its keys). */
export function dbSize(ds: DataSource, db: number): Promise<number> {
  return guarded(ds, async () => num(await (await connection(ds, checkDb(db))).callBuffer('DBSIZE')))
}

/** Pipeline helper: the replies of `cmds` (errors become null). */
async function pipe(c: Redis, cmds: (string | Buffer | number)[][]): Promise<unknown[]> {
  if (!cmds.length) return []
  const p = c.pipeline()
  for (const [name, ...args] of cmds) p.callBuffer(name as string, ...(args as (string | Buffer | number)[]))
  const res = (await p.exec()) ?? []
  return res.map(([err, v]) => (err ? null : v))
}

/**
 * One call = a loop of SCAN steps (never KEYS) until `limit` keys were found (a soft cap: a reply is never split), the
 * iteration ended, or a small time / step budget ran out. Returns the keys with type + TTL and the cursor to continue.
 */
export function scanKeys(ds: DataSource, db: number, opts: RedisScanOpts = {}): Promise<RedisScanResult> {
  return guarded(ds, async () => {
    checkDb(db)
    const limit = clampInt(opts.limit, 1, MAX_SCAN_LIMIT, DEFAULT_SCAN_LIMIT)
    const count = clampInt(opts.count, 10, 10_000, 500)
    const pattern = typeof opts.pattern === 'string' && opts.pattern !== '' ? opts.pattern : '*'
    if (pattern.length > MAX_PATTERN_CHARS) bad(`Pattern is too long (more than ${MAX_PATTERN_CHARS} characters)`)
    // a pattern for binary key names arrives like a name (REDIS_BIN_PREFIX + base64 of the glob's bytes)
    const matchArg: string | Buffer = pattern.startsWith(REDIS_BIN_PREFIX) ? decodeName(pattern) : pattern
    const want = opts.type ? String(opts.type).toLowerCase() : ''
    if (want && !/^[a-z0-9_-]{1,32}$/.test(want)) bad(`Invalid key type "${opts.type}"`)
    const start = opts.cursor == null || opts.cursor === '' ? '0' : String(opts.cursor)
    if (!/^\d{1,20}$/.test(start)) bad('Invalid cursor')
    const c = await connection(ds, db)
    const found = new Map<string, Buffer>()
    let cursor = start
    let useType = !!want
    const t0 = Date.now()
    for (let step = 0; step < SCAN_MAX_STEPS; step++) {
      const args: (string | number | Buffer)[] = [cursor]
      if (pattern !== '*') args.push('MATCH', matchArg)
      args.push('COUNT', count)
      if (useType) args.push('TYPE', want)
      let reply: unknown
      try {
        reply = await c.callBuffer('SCAN', ...args)
      } catch (e) {
        // SCAN ... TYPE needs Redis 6: older servers get the type filter applied client-side below
        if (useType && /syntax error/i.test((e as Error).message)) {
          useType = false
          continue
        }
        throw e
      }
      const [next, batch] = reply as [Buffer, Buffer[]]
      for (const k of batch) found.set(encodeName(k), k)
      cursor = str(next)
      if (cursor === '0' || found.size >= limit || Date.now() - t0 > SCAN_BUDGET_MS) break
    }
    const names = [...found.keys()]
    const keys: RedisKeyInfo[] = []
    for (let i = 0; i < names.length; i += 500) {
      const chunk = names.slice(i, i + 500)
      const res = await pipe(c, chunk.flatMap((n) => [['TYPE', found.get(n)!], ['PTTL', found.get(n)!]]))
      chunk.forEach((key, j) => {
        const type = str(res[j * 2])
        if (!type || type === 'none') return // expired / deleted since SCAN returned it
        if (want && !useType && type.toLowerCase() !== want) return
        keys.push({ key, type, ttl: num(res[j * 2 + 1] ?? -1) })
      })
    }
    return { keys, cursor: cursor === '0' ? null : cursor }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// key tree (explorer): every key of a database with its type, read with SCAN + pipelined TYPE
// ---------------------------------------------------------------------------------------------------------------

const TREE_SCAN_COUNT = 1000
const TREE_BUDGET_MS = 60_000
/** per data source + database: the id of the newest tree scan (an older one stops as soon as it notices) */
const treeRuns = new Map<string, number>()
const treeRunKey = (ds: DataSource, db: number): string => `${ds.id}|${db}`

/** Coarse type for the explorer's folders: module / unknown types are `other`, a vanished key (`none`) is null. */
export function treeType(t: string): RedisTreeType | null {
  switch (t.toLowerCase()) {
    case 'none':
    case '':
      return null
    case 'string':
    case 'list':
    case 'set':
    case 'zset':
    case 'hash':
    case 'stream':
      return t.toLowerCase() as RedisTreeType
    default:
      return 'other'
  }
}

/** Stops a running key-tree scan of this database (the explorer node was collapsed or refreshed). */
export function cancelKeyTree(ds: DataSource, db: number): void {
  const k = treeRunKey(ds, checkDb(db))
  treeRuns.set(k, (treeRuns.get(k) ?? 0) + 1)
}

/**
 * All keys of one database (up to `max`, at most REDIS_KEYTREE_MAX): SCAN COUNT 1000, the types of each batch in one
 * pipeline. A newer scan of the same database, a cancel, or a time budget ends the loop early with `complete: false`.
 */
export function keyTree(ds: DataSource, db: number, opts: RedisKeyTreeOpts = {}): Promise<RedisKeyTree> {
  return guarded(ds, async () => {
    checkDb(db)
    const max = clampInt(opts?.max, 1, REDIS_KEYTREE_MAX, REDIS_KEYTREE_MAX)
    const rk = treeRunKey(ds, db)
    const run = (treeRuns.get(rk) ?? 0) + 1
    treeRuns.set(rk, run)
    const c = await connection(ds, db)
    const dbsize = num(await c.callBuffer('DBSIZE'))
    const seen = new Set<string>() // SCAN may return a key more than once
    const keys: RedisKeyTree['keys'] = []
    let cursor = '0'
    let complete = false
    const t0 = Date.now()
    while (treeRuns.get(rk) === run && Date.now() - t0 <= TREE_BUDGET_MS) {
      const [next, batch] = (await c.callBuffer('SCAN', cursor, 'COUNT', TREE_SCAN_COUNT)) as [Buffer, Buffer[]]
      cursor = str(next)
      const fresh: { name: string; raw: Buffer }[] = []
      for (const raw of batch) {
        const name = encodeName(raw)
        if (!seen.has(name)) {
          seen.add(name)
          fresh.push({ name, raw })
        }
      }
      const room = max - keys.length
      const take = fresh.slice(0, room)
      const res = await pipe(c, take.map((f) => ['TYPE', f.raw]))
      take.forEach((f, i) => {
        const t = treeType(str(res[i]))
        if (t) keys.push({ key: f.name, type: t }) // null: gone since SCAN returned it
      })
      if (fresh.length > room) break // cap reached with keys left over
      if (cursor === '0') {
        complete = true
        break
      }
      if (keys.length >= max) break
    }
    if (treeRuns.get(rk) !== run) complete = false
    return { keys, complete, dbsize }
  })
}

/** Longest prefix of `b` that ends on a UTF-8 character boundary (a cut-off read must not look binary). */
function trimToBoundary(b: Buffer): Buffer {
  for (let cut = 0; cut <= 3 && cut < b.length; cut++) {
    const part = b.subarray(0, b.length - cut)
    if (isUtf8(part)) return part
  }
  return b
}

const pairs = (flat: unknown[]): [Buffer, Buffer][] => {
  const out: [Buffer, Buffer][] = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i] as Buffer, flat[i + 1] as Buffer])
  return out
}

/** SSCAN / HSCAN steps until `limit` entries (soft cap) or the end; `cursor` null = from the start. */
async function scanSteps(c: Redis, cmd: 'HSCAN' | 'SSCAN', key: Buffer, cursor: string | null | undefined, limit: number): Promise<{ items: Buffer[]; next: string | null }> {
  const per = cmd === 'HSCAN' ? 2 : 1 // HSCAN replies are flat field / value pairs
  let cur = cursor == null || cursor === '' ? '0' : String(cursor)
  if (!/^\d{1,20}$/.test(cur)) bad('Invalid cursor')
  const items: Buffer[] = []
  for (let step = 0; step < 200; step++) {
    const [next, batch] = (await c.callBuffer(cmd, key, cur, 'COUNT', limit)) as [Buffer, Buffer[]]
    items.push(...batch)
    cur = str(next)
    if (cur === '0' || items.length >= limit * per) break
  }
  return { items, next: cur === '0' ? null : cur }
}

async function bestEffort<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch {
    return null
  }
}

/** A key's metadata and one page of its value, shaped by type. */
export function getKey(ds: DataSource, db: number, name: string, opts: RedisPageOpts = {}): Promise<RedisKeyDetail> {
  return guarded(ds, async () => {
    const key = nameBytes(name)
    checkDb(db)
    const limit = clampInt(opts.limit, 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT)
    const offset = clampInt(opts.offset, 0, Number.MAX_SAFE_INTEGER, 0)
    const c = await connection(ds, db)
    const [t, ttl] = await pipe(c, [['TYPE', key], ['PTTL', key]])
    const type = str(t)
    const base = { key: name, type, ttl: num(ttl ?? -2) }
    if (!type || type === 'none') return { ...base, type: 'none', ttl: -2, size: null, length: null, value: { kind: 'none' as const } }
    const [mem, enc] = await Promise.all([
      bestEffort(c.callBuffer('MEMORY', 'USAGE', key, 'SAMPLES', 5)),
      bestEffort(c.callBuffer('OBJECT', 'ENCODING', key))
    ])
    const size = mem === null || mem === undefined ? null : num(mem)
    const encoding = enc ? str(enc) : undefined
    const detail = (length: number | null, value: RedisValue): RedisKeyDetail => ({
      ...base, size: size !== null && Number.isFinite(size) ? size : null, length, ...(encoding ? { encoding } : {}), value
    })
    switch (type) {
      case 'string': {
        const bytes = num(await c.callBuffer('STRLEN', key))
        const raw = bytes === 0 ? Buffer.alloc(0) : ((await c.callBuffer('GETRANGE', key, 0, MAX_STRING_BYTES - 1)) as Buffer | null) ?? Buffer.alloc(0)
        const truncated = bytes > MAX_STRING_BYTES
        const buf = truncated ? trimToBoundary(raw) : raw
        const binary = !isUtf8(buf)
        return detail(bytes, {
          kind: 'string', text: binary ? '' : buf.toString('utf8'), binary, base64: binary ? buf.toString('base64') : '', bytes, truncated
        })
      }
      case 'hash': {
        const len = num(await c.callBuffer('HLEN', key))
        const { items, next } = await scanSteps(c, 'HSCAN', key, opts.cursor, limit)
        return detail(len, { kind: 'hash', items: pairs(items).map(([f, v]) => ({ field: encodeName(f), value: encodeName(v) })), next })
      }
      case 'set': {
        const len = num(await c.callBuffer('SCARD', key))
        const { items, next } = await scanSteps(c, 'SSCAN', key, opts.cursor, limit)
        return detail(len, { kind: 'set', items: [...new Set(items.map(encodeName))], next }) // SSCAN may repeat members
      }
      case 'list': {
        const len = num(await c.callBuffer('LLEN', key))
        const items = (await c.callBuffer('LRANGE', key, offset, offset + limit - 1)) as Buffer[]
        const end = offset + items.length
        return detail(len, { kind: 'list', items: items.map(encodeName), offset, next: end < len ? end : null })
      }
      case 'zset': {
        const len = num(await c.callBuffer('ZCARD', key))
        const flat = (await c.callBuffer('ZRANGE', key, offset, offset + limit - 1, 'WITHSCORES')) as Buffer[]
        const items = pairs(flat).map(([m, s]) => ({ member: encodeName(m), score: str(s) }))
        const end = offset + items.length
        return detail(len, { kind: 'zset', items, offset, next: end < len ? end : null })
      }
      case 'stream': {
        const len = num(await c.callBuffer('XLEN', key))
        const first = opts.cursor && /^\d+(-\d+)?$/.test(opts.cursor) ? opts.cursor : '-'
        const raw = (await c.callBuffer('XRANGE', key, first, '+', 'COUNT', limit + 1)) as [Buffer, Buffer[]][]
        const entries = raw.slice(0, limit).map(([id, flat]) => ({
          id: str(id), fields: pairs(flat).map(([f, v]) => ({ field: encodeName(f), value: encodeName(v) }))
        }))
        return detail(len, { kind: 'stream', entries, next: raw.length > limit ? str(raw[limit][0]) : null })
      }
      default:
        return detail(null, { kind: 'unsupported', type })
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// writing (only these; nothing here can flush a database)
// ---------------------------------------------------------------------------------------------------------------

function ttlSeconds(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 3_153_600_000) bad('TTL must be a whole number of seconds (at least 1)')
  return v as number
}

/** Replaces the text of an existing string key. `keepTtl` keeps its expiry; otherwise the key becomes persistent (like SET). */
export function setString(ds: DataSource, db: number, name: string, value: string, opts: { keepTtl?: boolean } = {}): Promise<void> {
  return guarded(ds, async () => {
    const key = nameBytes(name)
    const val = valueBytes(value)
    const c = await connection(ds, checkDb(db))
    const type = str(await c.callBuffer('TYPE', key))
    if (type === 'none') bad('The key no longer exists')
    if (type !== 'string') bad(`The key holds a ${type}, not a string`)
    if (!opts.keepTtl) {
      await c.callBuffer('SET', key, val)
      return
    }
    try {
      await c.callBuffer('SET', key, val, 'KEEPTTL')
    } catch (e) {
      // KEEPTTL needs Redis 6: older servers get PTTL + SET + PEXPIRE
      if (!/syntax error/i.test((e as Error).message)) throw e
      const pttl = num(await c.callBuffer('PTTL', key))
      await c.callBuffer('SET', key, val)
      if (pttl > 0) await c.callBuffer('PEXPIRE', key, pttl)
    }
  })
}

/** Sets the expiry in seconds, or removes it (PERSIST) with null. */
export function setTtl(ds: DataSource, db: number, name: string, seconds: number | null): Promise<void> {
  return guarded(ds, async () => {
    const key = nameBytes(name)
    const secs = seconds === null ? null : ttlSeconds(seconds)
    const c = await connection(ds, checkDb(db))
    if (secs === null) {
      await c.callBuffer('PERSIST', key)
      return
    }
    if (num(await c.callBuffer('EXPIRE', key, secs)) === 0) bad('The key does not exist')
  })
}

/** Deletes keys (UNLINK, DEL on servers older than 4.0). Resolves with how many existed. */
export function deleteKeys(ds: DataSource, db: number, names: string[]): Promise<number> {
  return guarded(ds, async () => {
    if (!Array.isArray(names) || !names.length) return 0
    if (names.length > MAX_DELETE_KEYS) bad(`Too many keys at once (the limit is ${MAX_DELETE_KEYS})`)
    const keys = names.map((n) => nameBytes(n))
    const c = await connection(ds, checkDb(db))
    let n = 0
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500)
      try {
        n += num(await c.callBuffer('UNLINK', ...chunk))
      } catch (e) {
        if (!/unknown command/i.test((e as Error).message)) throw e
        n += num(await c.callBuffer('DEL', ...chunk))
      }
    }
    return n
  })
}

/** RENAMENX: refuses to overwrite an existing key. */
export function renameKey(ds: DataSource, db: number, name: string, newName: string): Promise<void> {
  return guarded(ds, async () => {
    const from = nameBytes(name)
    const to = nameBytes(newName, 'New key')
    if (from.equals(to)) bad('The new name is the same as the current one')
    const c = await connection(ds, checkDb(db))
    let moved: number
    try {
      moved = num(await c.callBuffer('RENAMENX', from, to))
    } catch (e) {
      if (/no such key/i.test((e as Error).message)) bad('The key does not exist (it may have expired or been deleted)')
      throw e
    }
    if (!moved) bad(`A key named "${newName}" already exists. It was not overwritten; delete it first or pick another name.`)
  })
}

const numOrInf = (v: unknown): string => {
  const s = String(v).trim()
  if (/^[+-]?inf$/i.test(s)) return s.toLowerCase().replace(/^\+/, '')
  const n = Number(s)
  if (s === '' || !Number.isFinite(n)) return bad(`"${s}" is not a valid score`)
  return String(n)
}

/** Creates a key of any of the editable types; refuses when it exists (SET NX / existence check). */
export function createKey(ds: DataSource, db: number, name: string, spec: RedisNewKey, opts: { ttl?: number | null } = {}): Promise<void> {
  return guarded(ds, async () => {
    const key = nameBytes(name)
    const secs = opts.ttl == null ? null : ttlSeconds(opts.ttl)
    const c = await connection(ds, checkDb(db))
    const exists = (): Error => new Error(`A key named "${name}" already exists. It was not overwritten.`)
    switch (spec.type) {
      case 'string': {
        const args: (string | number | Buffer)[] = [key, valueBytes(spec.value), 'NX']
        if (secs !== null) args.push('EX', secs)
        if ((await c.callBuffer('SET', ...args)) === null) throw exists()
        return
      }
      case 'hash':
      case 'list':
      case 'set':
      case 'zset': {
        if (num(await c.callBuffer('EXISTS', key))) throw exists()
        if (spec.type === 'hash') await c.callBuffer('HSET', key, nameBytes(spec.field, 'Field'), itemBytes(spec.value))
        else if (spec.type === 'list') await c.callBuffer('RPUSH', key, itemBytes(spec.value))
        else if (spec.type === 'set') await c.callBuffer('SADD', key, itemBytes(spec.member, 'Member'))
        else await c.callBuffer('ZADD', key, numOrInf(spec.score), itemBytes(spec.member, 'Member'))
        if (secs !== null) await c.callBuffer('EXPIRE', key, secs)
        return
      }
      default:
        bad('Only string, hash, list, set and zset keys can be created here')
    }
  })
}

/** Item-level edits of hash / list / set / zset keys. Resolves with the number of changed items (as the server reports it). */
export function itemOp(ds: DataSource, db: number, name: string, op: RedisItemOp): Promise<number> {
  return guarded(ds, async () => {
    const key = nameBytes(name)
    if (!op || typeof op !== 'object') bad('Invalid operation')
    const c = await connection(ds, checkDb(db))
    switch (op.op) {
      case 'hset':
        return num(await c.callBuffer('HSET', key, nameBytes(op.field, 'Field'), itemBytes(op.value)))
      case 'hdel':
        return num(await c.callBuffer('HDEL', key, nameBytes(op.field, 'Field')))
      case 'lset': {
        if (!Number.isInteger(op.index) || op.index < 0) bad('Invalid list index')
        await c.callBuffer('LSET', key, op.index, itemBytes(op.value))
        return 1
      }
      case 'lpush':
        return num(await c.callBuffer('LPUSH', key, itemBytes(op.value)))
      case 'rpush':
        return num(await c.callBuffer('RPUSH', key, itemBytes(op.value)))
      case 'lrem': {
        const n = op.count === undefined ? 1 : op.count
        if (!Number.isInteger(n)) bad('Invalid count')
        return num(await c.callBuffer('LREM', key, n, itemBytes(op.value)))
      }
      case 'sadd':
        return num(await c.callBuffer('SADD', key, itemBytes(op.member, 'Member')))
      case 'srem':
        return num(await c.callBuffer('SREM', key, itemBytes(op.member, 'Member')))
      case 'zadd':
        return num(await c.callBuffer('ZADD', key, numOrInf(op.score), itemBytes(op.member, 'Member')))
      case 'zrem':
        return num(await c.callBuffer('ZREM', key, itemBytes(op.member, 'Member')))
      default:
        return bad('Unknown operation')
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------------------------------------------

/**
 * Runs the console text on the console's own connection to that database: one command per non-empty line (`#` lines are
 * comments), in order, stopping at the first error. Commands that cannot work on a pooled connection are refused with a
 * message instead of being sent. A server error is a reply (kind 'error'), not an exception.
 */
export async function runCommands(ds: DataSource, db: number, text: string): Promise<RedisCommandResult> {
  const t0 = Date.now()
  checkDb(db)
  if (typeof text !== 'string' || text.length > MAX_COMMAND_TEXT) throw new Error('The command text is too large')
  const lines = commandLines(text)
  if (!lines.length) throw new Error('Nothing to run: type a command (one per line)')
  if (lines.length > MAX_COMMAND_LINES) throw new Error(`Too many commands at once (the limit is ${MAX_COMMAND_LINES})`)
  const results: RedisCommandEntry[] = []
  const cfg = configOf(ds)
  let c: Redis | null = null
  for (const line of lines) {
    const started = Date.now()
    const entry = (command: string, reply: RedisCommandEntry['reply']): RedisCommandEntry => ({ line, command, reply, durationMs: Date.now() - started })
    let args: Buffer[]
    try {
      args = splitArgs(line)
    } catch (e) {
      results.push(entry('', { kind: 'error', message: (e as Error).message }))
      break
    }
    if (!args.length) continue
    const command = args[0].toString('utf8').toUpperCase()
    const why = blockedReason(args)
    if (why) {
      results.push(entry(command, { kind: 'error', message: why }))
      break
    }
    try {
      c ??= await connection(ds, db, 'console')
      const raw = await c.callBuffer(command, ...args.slice(1))
      results.push(entry(command, normalizeReply(raw, command)))
    } catch (e) {
      results.push(entry(command, isReplyError(e) ? errorReply(e as Error) : { kind: 'error', message: cleanRedisError(e, { host: cfg.host.trim(), port: cfg.port }) }))
      break
    }
  }
  return { results, durationMs: Date.now() - t0 }
}
