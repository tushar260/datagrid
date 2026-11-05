import { CACHE_INDEX_PREFIXES, type CacheEntry } from '../../../shared'
import { getSettings } from './settings'

/**
 * Renderer side of the local object cache (the lists the explorer shows: databases, schemas, tables, DynamoDB tables,
 * Redis databases and key trees). Everything goes through `cached(...)`:
 *
 *  - a hit is answered from the persistent cache (main process) without touching the network;
 *  - a miss, a forced call (`force`) or a key marked stale by a Refresh (`markStale`) runs the fetcher and stores the result;
 *  - two parallel calls for the same key share one fetch, and a result that was superseded by a newer call (a refresh
 *    started while an older fetch was still running) is returned to its caller but never stored or indexed;
 *  - errors are never cached (and a failed refresh keeps the old entry);
 *  - with Settings > "Cache database objects locally" off the cache is neither read nor written (the in-memory name index
 *    for ⌘O still follows what was loaded).
 */

export interface CacheMeta {
  /** when the list was fetched from the server (or, for a hit, when it was fetched back then) */
  at: number
  fromCache: boolean
}

interface Codec<T> {
  /** what is stored (default: the value as is) */
  encode?: (v: T) => unknown
  /** the stored value back; null = unusable (treated as a miss) */
  decode?: (raw: unknown) => T | null
}
export interface CachedOpts<T> extends Codec<T> {
  /** skip the cache: fetch, then update the stored entry */
  force?: boolean
  /** false = use the fetched value but do not store it (default: store) */
  store?: (v: T) => boolean
}

const fk = (dsId: string, key: string): string => dsId + '\u0000' + key
const isIndexKey = (key: string): boolean => CACHE_INDEX_PREFIXES.some((p) => key.startsWith(p))

let epoch = 0
let tokenSeq = 0
const latest = new Map<string, number>() // key -> token of the newest call (older calls may not write)
const inflight = new Map<string, { promise: Promise<unknown>; token: number; epoch: number }>()
const written = new Map<string, number>() // key -> epoch its stored value was fetched at
const markers: { dsId: string; prefix: string; epoch: number }[] = []
const metas = new Map<string, CacheMeta>()
const index = new Map<string, Map<string, CacheEntry>>() // dsId -> key -> list (only the keys the ⌘O index is built from)
const listeners = new Set<() => void>()

const enabled = (): boolean => getSettings().cacheObjects !== false
const notify = (): void => listeners.forEach((l) => l())

function indexPut(dsId: string, key: string, at: number, data: unknown): void {
  if (!isIndexKey(key)) return
  let m = index.get(dsId)
  if (!m) index.set(dsId, (m = new Map()))
  m.set(key, { at, data })
  notify()
}

/** is the stored value of `key` older than a Refresh that covers it? (`since` = the epoch it was fetched at) */
function staleSince(dsId: string, key: string, since: number): boolean {
  return markers.some((m) => m.dsId === dsId && key.startsWith(m.prefix) && since < m.epoch)
}

/**
 * Marks everything of `dsId` whose key starts with `prefix` (all keys when omitted) as needing a refetch: the next `cached`
 * call for such a key skips the stored value and fetches again, and the fresh result replaces it. Unlike `invalidate` the old
 * entry survives until the new one arrives (a failed refresh keeps showing the cached list).
 */
export function markStale(dsId: string, prefix = ''): void {
  epoch++
  for (let i = markers.length - 1; i >= 0; i--) if (markers[i].dsId === dsId && markers[i].prefix.startsWith(prefix)) markers.splice(i, 1)
  markers.push({ dsId, prefix, epoch })
  if (markers.length > 200) markers.splice(0, markers.length - 200)
}

/** Reads a stored entry; failures count as a miss. */
async function readStored(dsId: string, key: string): Promise<CacheEntry | null> {
  try {
    const e = await window.api.cache?.get(dsId, key)
    return e && typeof e.at === 'number' && 'data' in e && e.data !== undefined ? e : null
  } catch {
    return null
  }
}

export function cached<T>(dsId: string, key: string, fetcher: () => Promise<T>, opts: CachedOpts<T> = {}): Promise<T> {
  const k = fk(dsId, key)
  const force = !!opts.force
  const cur = inflight.get(k)
  if (cur && !force && !staleSince(dsId, key, cur.epoch)) return cur.promise as Promise<T>
  const token = ++tokenSeq
  const startEpoch = epoch
  latest.set(k, token)
  const p = (async (): Promise<T> => {
    const on = enabled()
    if (on && !force && !staleSince(dsId, key, written.get(k) ?? 0)) {
      const hit = await readStored(dsId, key)
      if (hit) {
        const v = opts.decode ? opts.decode(hit.data) : (hit.data as T)
        if (v !== null && !staleSince(dsId, key, written.get(k) ?? 0)) {
          if (latest.get(k) === token) {
            metas.set(k, { at: hit.at, fromCache: true })
            indexPut(dsId, key, hit.at, hit.data)
          }
          return v
        }
      }
    }
    const data = await fetcher() // a rejection propagates: nothing is stored
    if (latest.get(k) === token) {
      const at = Date.now()
      metas.set(k, { at, fromCache: false })
      written.set(k, startEpoch)
      // the index sees the plain list (a stored form may be a compact encoding: those lists are not indexed anyway)
      if (!opts.encode) indexPut(dsId, key, at, data)
      if (on && (!opts.store || opts.store(data))) void window.api.cache?.set(dsId, key, opts.encode ? opts.encode(data) : data)?.catch?.(() => undefined)
    }
    return data
  })()
  const tracked = p.finally(() => {
    if (inflight.get(k)?.token === token) inflight.delete(k)
  })
  inflight.set(k, { promise: tracked, token, epoch: startEpoch })
  return tracked
}

/** When / where the list of a key last came from in this session (for the "Loaded from cache 3h ago" tooltip). */
export const cacheMeta = (dsId: string, key: string): CacheMeta | undefined => metas.get(fk(dsId, key))

/** "3h", "12 min", "just now": a coarse age. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)} days`
}

/** The unobtrusive tooltip line of a node whose list came from `meta`. */
export function cacheNote(meta: CacheMeta | undefined, now = Date.now()): string | undefined {
  if (!meta) return undefined
  const age = ageText(now - meta.at)
  if (meta.fromCache) return age === 'just now' ? 'Loaded from cache — Refresh to update' : `Loaded from cache ${age} ago — Refresh to update`
  return age === 'just now' ? 'Refreshed just now' : `Refreshed ${age} ago`
}

/** Forgets stored lists (and stops in-flight fetches from storing theirs); also deletes them in the main process. */
export function invalidate(dsId: string, prefix?: string): void {
  dropLocal(dsId, prefix)
  void window.api.cache?.delete(dsId, prefix)?.catch?.(() => undefined)
}

function dropLocal(dsId: string, prefix = ''): void {
  const own = (key: string): boolean => key.startsWith(prefix)
  for (const k of [...latest.keys()]) {
    const [d, key] = k.split('\u0000')
    if (d === dsId && own(key)) latest.set(k, ++tokenSeq) // an older fetch may no longer write
  }
  for (const k of [...written.keys()]) {
    const [d, key] = k.split('\u0000')
    if (d === dsId && own(key)) written.delete(k)
  }
  const m = index.get(dsId)
  if (m) {
    let changed = false
    for (const key of [...m.keys()]) if (own(key)) (m.delete(key), (changed = true))
    if (!m.size) index.delete(dsId)
    if (changed) notify()
  }
  for (const k of [...metas.keys()]) {
    const [d, key] = k.split('\u0000')
    if (d === dsId && own(key)) metas.delete(k)
  }
}

/** The main process dropped cached lists (structure change, data source edited / removed); `['']` = everything of the source. */
export function handleInvalidated(dsId: string, prefixes: string[]): void {
  for (const p of prefixes) dropLocal(dsId, p)
}

/** The lists the ⌘O index is built from, per data source (what is loaded now or was read from the cache at startup). */
export const peekIndex = (dsId: string): ReadonlyMap<string, CacheEntry> | undefined => index.get(dsId)
export const indexedSources = (): string[] => [...index.keys()]
export function subscribeIndex(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Puts the cached name lists of every data source into the index (startup). Nothing is read while the cache is off. */
export async function primeIndex(): Promise<void> {
  if (!enabled()) return
  let all: Record<string, Record<string, CacheEntry>> = {}
  try {
    all = (await window.api.cache?.all([...CACHE_INDEX_PREFIXES])) ?? {}
  } catch {
    return
  }
  for (const [dsId, entries] of Object.entries(all)) {
    for (const [key, e] of Object.entries(entries)) {
      if (!e || typeof e.at !== 'number' || index.get(dsId)?.has(key)) continue // what was loaded meanwhile is newer
      const m = metas.get(fk(dsId, key))
      if (!m) metas.set(fk(dsId, key), { at: e.at, fromCache: true })
      indexPut(dsId, key, e.at, e.data)
    }
  }
}

/** Subscribes to the main process' invalidations and primes the index (call once at startup); returns an unsubscribe function. */
export function initObjectCache(): () => void {
  const off = window.api.cache?.onInvalidated?.(handleInvalidated)
  void primeIndex()
  return () => off?.()
}

/** Forgets all in-memory state (tests, and "Clear cached objects"). */
export function resetObjectCache(): void {
  epoch = 0
  tokenSeq = 0
  latest.clear()
  inflight.clear()
  written.clear()
  markers.length = 0
  metas.clear()
  index.clear()
  notify()
}

/** Settings > "Clear cached objects": deletes the stored lists of every data source (what is loaded now stays in the index). */
export async function clearAllCached(): Promise<void> {
  await window.api.cache?.clear()
  written.clear()
  metas.clear()
}
