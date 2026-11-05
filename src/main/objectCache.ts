import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { CACHE_MAX_BYTES, CACHE_MAX_KEY, CACHE_VERSION, cacheKeys, dsKind } from '../shared'
import type { CacheEntry, DataSource } from '../shared'

/**
 * Persistent local cache of the lists the explorer builds its tree from (databases, schemas, table names, DynamoDB tables,
 * Redis databases and key trees). One JSON file per data source: `<dir>/<dsId>.json`.
 *
 * Reads come from memory (a file is loaded once, lazily); writes are debounced and atomic (temp file + rename) and are
 * flushed synchronously on quit. A file with an unknown version or corrupt JSON is deleted and ignored. A source's file
 * never exceeds `maxBytes`: an entry that would not fit is simply not cached. Nothing here knows about Electron.
 */

/** data source ids are file names: only this alphabet (UUIDs and the ids tests use) is ever touched on disk */
export const validCacheDsId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
/** keys are short plain strings (see `cacheKeys`) */
export const validCacheKey = (k: unknown): k is string =>
  typeof k === 'string' && k.length > 0 && k.length <= CACHE_MAX_KEY && !/[\u0000-\u001f\u007f]/.test(k)
export const validCachePrefix = (p: unknown): p is string => typeof p === 'string' && p.length <= CACHE_MAX_KEY && !/[\u0000-\u001f\u007f]/.test(p)

export interface ObjectCacheOptions {
  /** the cache directory (resolved lazily: `app.getPath` is not available before `ready`) */
  dir: string | (() => string)
  maxBytes?: number
  debounceMs?: number
  now?: () => number
  onError?: (msg: string) => void
}

export interface ObjectCache {
  get(dsId: string, key: string): CacheEntry | undefined
  /** false = not stored (invalid input, not serialisable, or over the size cap); an older entry for the key is dropped then */
  set(dsId: string, key: string, data: unknown): boolean
  /** deletes the entries whose key starts with `prefix` (all entries when omitted); returns how many */
  delete(dsId: string, prefix?: string): number
  /** removes one data source's cache (its file too), or every source's when `dsId` is omitted */
  clear(dsId?: string): void
  /** entries of the given sources whose key starts with one of `prefixes` (all when omitted) */
  all(dsIds: string[], prefixes?: string[]): Record<string, Record<string, CacheEntry>>
  /** writes everything that is pending, synchronously (quit) */
  flush(): void
  /** bytes of the cache files on disk (pending changes are flushed first) */
  size(): number
  /** number of sources with unwritten changes */
  pending(): number
}

interface Source {
  entries: Map<string, CacheEntry>
  sizes: Map<string, number>
  bytes: number
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  firstDirty: number
  /** bumped by every change: an async write only renames its temp file when nothing newer was written meanwhile */
  seq: number
  written: number
}

const entryBytes = (key: string, json: string): number => key.length + Buffer.byteLength(json) + 24

export function createObjectCache(opts: ObjectCacheOptions): ObjectCache {
  const maxBytes = opts.maxBytes ?? CACHE_MAX_BYTES
  const debounceMs = opts.debounceMs ?? 1500
  const now = opts.now ?? Date.now
  const sources = new Map<string, Source>()
  let tmpN = 0
  const dir = (): string => (typeof opts.dir === 'function' ? opts.dir() : opts.dir)
  const fileOf = (id: string): string => join(dir(), id + '.json')
  const err = (m: string): void => opts.onError?.(m)

  const blank = (): Source => ({ entries: new Map(), sizes: new Map(), bytes: 0, dirty: false, timer: null, firstDirty: 0, seq: 0, written: 0 })

  /** loads (once) the file of a source; unreadable / unknown-version files are deleted */
  function load(id: string): Source {
    const have = sources.get(id)
    if (have) return have
    const s = blank()
    sources.set(id, s)
    const f = fileOf(id)
    let text: string | null = null
    try {
      if (existsSync(f)) text = readFileSync(f, 'utf8')
    } catch {
      text = null
    }
    if (text === null) return s
    let ok = false
    try {
      const j = JSON.parse(text) as { v?: unknown; entries?: unknown }
      if (j && typeof j === 'object' && j.v === CACHE_VERSION && j.entries && typeof j.entries === 'object' && !Array.isArray(j.entries)) {
        ok = true
        for (const [k, e] of Object.entries(j.entries as Record<string, unknown>)) {
          const en = e as Partial<CacheEntry> | null
          if (!validCacheKey(k) || !en || typeof en !== 'object' || typeof en.at !== 'number' || !Number.isFinite(en.at) || !('data' in en) || en.data === undefined) continue
          const size = entryBytes(k, JSON.stringify(en.data))
          if (s.bytes + size > maxBytes) continue
          s.entries.set(k, { at: en.at, data: en.data })
          s.sizes.set(k, size)
          s.bytes += size
        }
      }
    } catch {
      ok = false
    }
    if (!ok) {
      try {
        unlinkSync(f)
      } catch {
        /* ignore */
      }
      s.entries.clear()
      s.sizes.clear()
      s.bytes = 0
    }
    return s
  }

  const serialize = (s: Source): string => JSON.stringify({ v: CACHE_VERSION, entries: Object.fromEntries(s.entries) })

  function writeSync(id: string, s: Source): void {
    const f = fileOf(id)
    try {
      if (!s.entries.size) {
        if (existsSync(f)) unlinkSync(f)
      } else {
        mkdirSync(dir(), { recursive: true })
        const tmp = `${f}.${process.pid}.${++tmpN}.tmp`
        writeFileSync(tmp, serialize(s))
        renameSync(tmp, f)
      }
      s.dirty = false
      s.written = s.seq
    } catch (e) {
      err(`cache write failed: ${(e as Error).message}`)
    }
  }

  async function writeAsync(id: string, s: Source): Promise<void> {
    const f = fileOf(id)
    const seq = s.seq
    try {
      if (!s.entries.size) {
        await fsp.rm(f, { force: true })
      } else {
        const text = serialize(s)
        await fsp.mkdir(dir(), { recursive: true })
        const tmp = `${f}.${process.pid}.${++tmpN}.tmp`
        await fsp.writeFile(tmp, text)
        if (s.seq !== seq) {
          await fsp.rm(tmp, { force: true }) // something newer was written (or is queued) meanwhile
          return
        }
        await fsp.rename(tmp, f)
      }
      if (s.seq === seq) {
        s.dirty = false
        s.written = seq
      }
    } catch (e) {
      err(`cache write failed: ${(e as Error).message}`)
    }
  }

  function touch(id: string, s: Source): void {
    s.dirty = true
    s.seq++
    const t = now()
    if (!s.firstDirty) s.firstDirty = t
    if (s.timer) clearTimeout(s.timer)
    // trailing debounce, but a steady stream of changes still reaches the disk (max wait = 5 x debounce)
    const wait = Math.max(0, Math.min(debounceMs, s.firstDirty + debounceMs * 5 - t))
    s.timer = setTimeout(() => {
      s.timer = null
      s.firstDirty = 0
      if (s.dirty) void writeAsync(id, s)
    }, wait)
    s.timer.unref?.()
  }

  return {
    get(dsId, key) {
      if (!validCacheDsId(dsId) || !validCacheKey(key)) return undefined
      return load(dsId).entries.get(key)
    },
    set(dsId, key, data) {
      if (!validCacheDsId(dsId) || !validCacheKey(key) || data === undefined) return false
      const s = load(dsId)
      let json: string
      try {
        json = JSON.stringify(data)
      } catch {
        return false
      }
      if (typeof json !== 'string') return false
      const size = entryBytes(key, json)
      const old = s.sizes.get(key) ?? 0
      if (s.bytes - old + size > maxBytes) {
        // it does not fit: no entry is better than an outdated one
        if (s.entries.delete(key)) {
          s.bytes -= old
          s.sizes.delete(key)
          touch(dsId, s)
        }
        return false
      }
      s.entries.set(key, { at: now(), data: JSON.parse(json) })
      s.sizes.set(key, size)
      s.bytes += size - old
      touch(dsId, s)
      return true
    },
    delete(dsId, prefix) {
      if (!validCacheDsId(dsId) || (prefix !== undefined && !validCachePrefix(prefix))) return 0
      const s = load(dsId)
      let n = 0
      for (const k of [...s.entries.keys()]) {
        if (prefix && !k.startsWith(prefix)) continue
        s.entries.delete(k)
        s.bytes -= s.sizes.get(k) ?? 0
        s.sizes.delete(k)
        n++
      }
      if (n) touch(dsId, s)
      return n
    },
    clear(dsId) {
      const drop = (id: string): void => {
        const s = sources.get(id)
        if (s?.timer) clearTimeout(s.timer)
        sources.delete(id)
        try {
          unlinkSync(fileOf(id))
        } catch {
          /* not there */
        }
      }
      if (dsId !== undefined) {
        if (validCacheDsId(dsId)) drop(dsId)
        return
      }
      for (const id of [...sources.keys()]) drop(id)
      try {
        for (const f of readdirSync(dir())) if (f.endsWith('.json') || f.endsWith('.tmp')) unlinkSync(join(dir(), f))
      } catch {
        /* no directory yet */
      }
    },
    all(dsIds, prefixes) {
      const out: Record<string, Record<string, CacheEntry>> = {}
      for (const id of dsIds) {
        if (!validCacheDsId(id)) continue
        const s = load(id)
        const part: Record<string, CacheEntry> = {}
        for (const [k, e] of s.entries) if (!prefixes || prefixes.some((p) => k.startsWith(p))) part[k] = e
        if (Object.keys(part).length) out[id] = part
      }
      return out
    },
    flush() {
      for (const [id, s] of sources) {
        if (s.timer) {
          clearTimeout(s.timer)
          s.timer = null
          s.firstDirty = 0
        }
        if (s.dirty) writeSync(id, s)
      }
    },
    size() {
      this.flush()
      let total = 0
      try {
        for (const f of readdirSync(dir())) if (f.endsWith('.json')) total += statSync(join(dir(), f)).size
      } catch {
        /* no directory yet */
      }
      return total
    },
    pending() {
      let n = 0
      for (const s of sources.values()) if (s.dirty) n++
      return n
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// what makes a cache stale
// ---------------------------------------------------------------------------------------------------------------

/**
 * The part of a data source's settings that decides WHAT it connects to. When it changes, every cached list of that
 * source is wrong: host / port / user / database (PostgreSQL), region / endpoint / profile / auth mode / access key id
 * (DynamoDB), host / port / user / db / TLS (Redis). Names, folders, filters and secrets are not part of it.
 */
export function cacheIdentity(d: Partial<DataSource> | null | undefined): string {
  if (!d) return ''
  const kind = dsKind(d as DataSource)
  if (kind === 'dynamodb') {
    const c = d.dynamo
    return JSON.stringify(['dynamodb', c?.region ?? '', c?.endpoint ?? '', c?.profile ?? '', c?.authMode ?? 'default', c?.accessKeyId ?? ''])
  }
  if (kind === 'redis') {
    const c = d.redis
    return JSON.stringify(['redis', c?.host ?? '', c?.port ?? 0, c?.username ?? '', c?.db ?? 0, !!c?.tls])
  }
  return JSON.stringify(['postgres', d.host ?? '', d.port ?? 0, d.user ?? '', d.database ?? ''])
}

const WRITE_SQL = /(^|;)\s*(create|drop|alter)\s/i
/** strips SQL comments and string literals well enough to spot a DDL statement */
const stripSql = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''")

/** Does this console script (probably) change which databases / schemas / tables exist? */
export function isDdl(sql: unknown): boolean {
  return typeof sql === 'string' && WRITE_SQL.test(stripSql(sql))
}

/** Redis commands that never change the key space: everything else invalidates the cached key tree of that database. */
const REDIS_READ = new Set([
  'GET', 'MGET', 'GETRANGE', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'EXPIRETIME', 'PEXPIRETIME', 'SCAN', 'SSCAN', 'HSCAN', 'ZSCAN',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'LRANGE', 'LLEN', 'LINDEX', 'SMEMBERS', 'SCARD', 'SISMEMBER',
  'SRANDMEMBER', 'ZRANGE', 'ZCARD', 'ZSCORE', 'ZRANK', 'ZCOUNT', 'XLEN', 'XRANGE', 'XREVRANGE', 'XREAD', 'XINFO', 'DBSIZE', 'KEYS',
  'INFO', 'PING', 'ECHO', 'TIME', 'CLIENT', 'CONFIG', 'COMMAND', 'MEMORY', 'OBJECT', 'DEBUG', 'SLOWLOG', 'LATENCY', 'SELECT', 'HELP',
  'RANDOMKEY', 'SUBSCRIBE', 'MONITOR', 'DUMP', 'PUBLISH', 'WAIT', 'AUTH', 'HELLO', 'ROLE', 'LASTSAVE', 'BGSAVE', 'SAVE', 'SORT_RO'
])
export function redisCommandWrites(text: unknown): boolean {
  if (typeof text !== 'string') return false
  return text.split(/\r?\n/).some((line) => {
    const w = line.trim().split(/\s+/)[0]
    return !!w && !w.startsWith('#') && !REDIS_READ.has(w.toUpperCase())
  })
}

/**
 * The cache key prefixes to drop after a successful IPC call that changes the structure (`args` = the call's arguments
 * after the data source id). Pure, so it is unit tested without Electron.
 */
export function invalidationsFor(channel: string, args: unknown[]): string[] {
  const s = (i: number): string => (typeof args[i] === 'string' ? (args[i] as string) : '')
  const n = (i: number): number => (typeof args[i] === 'number' && Number.isInteger(args[i]) ? (args[i] as number) : -1)
  const wholeDb = (d: string): string[] => [cacheKeys.pgSchemas(d), cacheKeys.pgTableNames(d), cacheKeys.pgTablesOf(d)]
  switch (channel) {
    case 'db:createDatabase':
      return [cacheKeys.pgDbs]
    case 'db:dropDatabase':
      return [cacheKeys.pgDbs, ...wholeDb(s(0))]
    case 'db:createSchema':
      return [cacheKeys.pgSchemas(s(0)), cacheKeys.pgTableNames(s(0))]
    case 'db:createTable':
    case 'db:renameTable':
    case 'db:dropTable':
      return [cacheKeys.pgTables(s(0), s(1)), cacheKeys.pgTableNames(s(0))]
    case 'db:query':
      return isDdl(s(2)) ? [cacheKeys.pgDbs, ...wholeDb(s(0))] : []
    case 'redis:delete':
    case 'redis:rename':
    case 'redis:create':
    case 'redis:setString':
      return n(0) >= 0 ? [cacheKeys.redisTree(n(0)), cacheKeys.redisDbs] : []
    case 'redis:command':
      return n(0) >= 0 && redisCommandWrites(s(1)) ? [cacheKeys.redisTree(n(0)), cacheKeys.redisDbs] : []
    default:
      return []
  }
}
