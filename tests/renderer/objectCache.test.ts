// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ageText, cacheMeta, cacheNote, cached, clearAllCached, handleInvalidated, indexedSources, initObjectCache, invalidate, markStale, peekIndex, primeIndex,
  resetObjectCache, subscribeIndex
} from '../../src/renderer/src/lib/objectCache'
import { resetSettings, updateSettings } from '../../src/renderer/src/lib/settings'
import { cacheKeys } from '../../src/shared'
import { cacheFake, installApi, type MockApi } from './helpers/mockApi'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)))
  return { promise, resolve, reject }
}

let fake: ReturnType<typeof cacheFake>
let api: MockApi
const setup = (initial: Parameters<typeof cacheFake>[0] = {}): void => {
  fake = cacheFake(initial)
  api = installApi({ cache: fake })
}
const stored = (dsId: string, key: string): unknown => fake.entries.get(dsId + '\u0000' + key)?.data

beforeEach(() => {
  localStorage.clear()
  resetSettings()
  setup()
})
afterEach(() => {
  vi.useRealTimers()
  resetSettings()
})

describe('cached(): hit / miss', () => {
  it('a miss fetches and stores the result', async () => {
    const fetcher = vi.fn(async () => ['a', 'b'])
    expect(await cached('d1', cacheKeys.pgDbs, fetcher)).toEqual(['a', 'b'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    await flush()
    expect(stored('d1', cacheKeys.pgDbs)).toEqual(['a', 'b'])
    expect(cacheMeta('d1', cacheKeys.pgDbs)).toMatchObject({ fromCache: false })
  })

  it('a hit never calls the fetcher', async () => {
    setup({ d1: { [cacheKeys.pgDbs]: { at: Date.now() - 3 * 3600_000, data: ['x'] } } })
    const fetcher = vi.fn(async () => ['fresh'])
    expect(await cached('d1', cacheKeys.pgDbs, fetcher)).toEqual(['x'])
    expect(fetcher).not.toHaveBeenCalled()
    expect(cacheMeta('d1', cacheKeys.pgDbs)).toMatchObject({ fromCache: true })
    expect(fake.set).not.toHaveBeenCalled() // reading does not rewrite
  })

  it('keys and sources are separate entries', async () => {
    setup({ d1: { 'pg:dbs': { at: 1, data: ['one'] } } })
    expect(await cached('d2', 'pg:dbs', async () => ['two'])).toEqual(['two'])
    expect(await cached('d1', 'pg:roles', async () => ['r'])).toEqual(['r'])
    expect(await cached('d1', 'pg:dbs', async () => ['no'])).toEqual(['one'])
  })

  it('force skips the stored value, fetches and replaces it', async () => {
    setup({ d1: { 'pg:dbs': { at: 1, data: ['old'] } } })
    const fetcher = vi.fn(async () => ['new'])
    expect(await cached('d1', 'pg:dbs', fetcher, { force: true })).toEqual(['new'])
    await flush()
    expect(fake.get).not.toHaveBeenCalled()
    expect(stored('d1', 'pg:dbs')).toEqual(['new'])
    expect(cacheMeta('d1', 'pg:dbs')!.fromCache).toBe(false)
  })

  it('an unusable stored entry (no data / wrong type of at) is a miss', async () => {
    api = installApi({ cache: { get: async () => ({ at: 'x', data: [] }) } })
    expect(await cached('d1', 'k', async () => ['f'])).toEqual(['f'])
    api = installApi({ cache: { get: async () => ({ at: 1 }) } })
    expect(await cached('d1', 'k', async () => ['g'])).toEqual(['g'])
  })

  it('a cache that throws is a miss; a cache that rejects the write does not fail the load', async () => {
    api = installApi({ cache: { get: async () => { throw new Error('ipc') }, set: async () => { throw new Error('disk') } } })
    await expect(cached('d1', 'k', async () => [1])).resolves.toEqual([1])
    await flush()
  })

  it('works without a cache API at all (old preload)', async () => {
    api = installApi()
    delete (window.api as unknown as Record<string, unknown>).cache
    expect(await cached('d1', 'k', async () => [1])).toEqual([1])
  })

  it('an empty list is a legitimate hit (no refetch of "no tables")', async () => {
    await cached('d1', 'pg:tables:a:b', async () => [])
    await flush()
    const fetcher = vi.fn(async () => ['x'])
    resetObjectCache()
    expect(await cached('d1', 'pg:tables:a:b', fetcher)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('cached(): errors are never cached', () => {
  it('a failing fetch rejects, stores nothing, and the next call tries again', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(['ok'])
    await expect(cached('d1', 'k', fetcher)).rejects.toThrow('boom')
    await flush()
    expect(fake.set).not.toHaveBeenCalled()
    expect(cacheMeta('d1', 'k')).toBeUndefined()
    expect(await cached('d1', 'k', fetcher)).toEqual(['ok'])
  })

  it('a failed refresh keeps the previous entry (the list stays usable offline)', async () => {
    setup({ d1: { k: { at: 1, data: ['kept'] } } })
    await expect(cached('d1', 'k', async () => { throw new Error('offline') }, { force: true })).rejects.toThrow('offline')
    await flush()
    expect(stored('d1', 'k')).toEqual(['kept'])
    expect(await cached('d1', 'k', async () => ['x'])).toEqual(['kept'])
  })
})

describe('cached(): parallel calls and races', () => {
  it('parallel calls for one key share one fetch', async () => {
    const d = deferred<string[]>()
    const fetcher = vi.fn(() => d.promise)
    const a = cached('d1', 'k', fetcher)
    const b = cached('d1', 'k', fetcher)
    await flush()
    d.resolve(['v'])
    expect(await Promise.all([a, b])).toEqual([['v'], ['v']])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fake.set).toHaveBeenCalledTimes(1)
  })

  it('different keys do not share', async () => {
    const f = vi.fn(async () => [1])
    await Promise.all([cached('d1', 'a', f), cached('d1', 'b', f), cached('d2', 'a', f)])
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('a forced call does not join an older in-flight fetch, and the older, slower result never overwrites the newer', async () => {
    const slow = deferred<string[]>()
    const first = cached('d1', 'k', () => slow.promise)
    await flush()
    const second = cached('d1', 'k', async () => ['new'], { force: true })
    expect(await second).toEqual(['new'])
    await flush()
    slow.resolve(['old'])
    expect(await first).toEqual(['old']) // its caller still gets what it asked for
    await flush()
    expect(stored('d1', 'k')).toEqual(['new'])
    expect(cacheMeta('d1', 'k')).toMatchObject({ fromCache: false })
    expect(peekIndex('d1')).toBeUndefined() // 'k' is not an index key; nothing leaked there either
  })

  it('a result that was superseded by invalidate() is not stored', async () => {
    const slow = deferred<string[]>()
    const p = cached('d1', 'pg:dbs', () => slow.promise)
    await flush()
    invalidate('d1', 'pg:dbs')
    slow.resolve(['stale'])
    expect(await p).toEqual(['stale'])
    await flush()
    expect(stored('d1', 'pg:dbs')).toBeUndefined()
    expect(peekIndex('d1')?.get('pg:dbs')).toBeUndefined()
  })

  it('a hit that comes back after a refresh started is not used as the "current" state', async () => {
    const get = deferred<unknown>()
    api = installApi({ cache: { ...fake, get: () => get.promise } })
    const a = cached('d1', 'pg:dbs', async () => ['from-fetch'])
    await flush()
    const b = cached('d1', 'pg:dbs', async () => ['forced'], { force: true })
    get.resolve({ at: 1, data: ['from-disk'] })
    await a
    expect(await b).toEqual(['forced'])
    await flush()
    expect(peekIndex('d1')!.get('pg:dbs')!.data).toEqual(['forced'])
  })
})

describe('markStale(): Refresh', () => {
  it('the next call for a covered key fetches again, the fresh result replaces the stored one', async () => {
    setup({ d1: { 'pg:dbs': { at: 1, data: ['old'] } } })
    markStale('d1')
    const f = vi.fn(async () => ['new'])
    expect(await cached('d1', 'pg:dbs', f)).toEqual(['new'])
    await flush()
    expect(stored('d1', 'pg:dbs')).toEqual(['new'])
    // ... and only once: the very next call is a normal hit again
    const g = vi.fn(async () => ['x'])
    resetObjectCache() // (a new session reads the store)
    expect(await cached('d1', 'pg:dbs', g)).toEqual(['new'])
    expect(g).not.toHaveBeenCalled()
  })

  it('after the refetch the key is fresh: a second call in the same session is a hit, not another fetch', async () => {
    setup({ d1: { k: { at: 1, data: ['old'] } } })
    markStale('d1')
    const f = vi.fn(async () => ['new'])
    await cached('d1', 'k', f)
    await flush()
    expect(await cached('d1', 'k', f)).toEqual(['new'])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a prefix covers only the keys below it', async () => {
    setup({ d1: { 'pg:schemas:app': { at: 1, data: ['s'] }, 'pg:schemas:other': { at: 1, data: ['t'] }, 'pg:dbs': { at: 1, data: ['d'] } } })
    markStale('d1', 'pg:schemas:app')
    const f = vi.fn(async () => ['new'])
    expect(await cached('d1', 'pg:schemas:app', f)).toEqual(['new'])
    expect(await cached('d1', 'pg:schemas:other', f)).toEqual(['t'])
    expect(await cached('d1', 'pg:dbs', f)).toEqual(['d'])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('only the marked source is affected', async () => {
    setup({ d1: { k: { at: 1, data: ['one'] } }, d2: { k: { at: 1, data: ['two'] } } })
    markStale('d1')
    expect(await cached('d2', 'k', async () => ['x'])).toEqual(['two'])
  })

  it('a fetch that started before the marker is refetched (its answer may predate the change)', async () => {
    const slow = deferred<string[]>()
    const f1 = vi.fn(() => slow.promise)
    const a = cached('d1', 'k', f1)
    await flush()
    markStale('d1')
    const f2 = vi.fn(async () => ['after'])
    const b = cached('d1', 'k', f2)
    expect(await b).toEqual(['after'])
    expect(f2).toHaveBeenCalledTimes(1)
    slow.resolve(['before'])
    await a
    await flush()
    expect(stored('d1', 'k')).toEqual(['after'])
  })

  it('a failed refresh keeps the stale entry and the key stays marked (next try fetches again)', async () => {
    setup({ d1: { k: { at: 1, data: ['old'] } } })
    markStale('d1')
    await expect(cached('d1', 'k', async () => { throw new Error('x') })).rejects.toThrow()
    expect(stored('d1', 'k')).toEqual(['old'])
    expect(await cached('d1', 'k', async () => ['fresh'])).toEqual(['fresh'])
  })
})

describe('invalidate / handleInvalidated / clear', () => {
  it('invalidate() forgets the in-memory state and asks main to delete the prefix', async () => {
    await cached('d1', 'pg:dbs', async () => ['a'])
    expect(peekIndex('d1')!.get('pg:dbs')).toBeTruthy()
    invalidate('d1', 'pg:dbs')
    expect(peekIndex('d1')).toBeUndefined()
    expect(cacheMeta('d1', 'pg:dbs')).toBeUndefined()
    expect(fake.delete).toHaveBeenCalledWith('d1', 'pg:dbs')
  })

  it('handleInvalidated() (main already deleted them) drops memory only, by prefix', async () => {
    await cached('d1', cacheKeys.pgDbs, async () => ['a'])
    await cached('d1', cacheKeys.pgSchemas('app'), async () => ['public'])
    await cached('d1', cacheKeys.pgSchemas('x'), async () => ['public'])
    handleInvalidated('d1', [cacheKeys.pgSchemas('app')])
    expect([...peekIndex('d1')!.keys()].sort()).toEqual([cacheKeys.pgDbs, cacheKeys.pgSchemas('x')].sort())
    expect(fake.delete).not.toHaveBeenCalled()
  })

  it("handleInvalidated('d1', ['']) wipes the whole source and not the others", async () => {
    await cached('d1', 'pg:dbs', async () => ['a'])
    await cached('d2', 'pg:dbs', async () => ['b'])
    handleInvalidated('d1', [''])
    expect(indexedSources()).toEqual(['d2'])
  })

  it('after an invalidation the next call fetches (main deleted the stored copy)', async () => {
    await cached('d1', 'pg:dbs', async () => ['a'])
    await flush()
    fake.entries.clear() // what main does
    handleInvalidated('d1', ['pg:'])
    const f = vi.fn(async () => ['b'])
    expect(await cached('d1', 'pg:dbs', f)).toEqual(['b'])
  })

  it('clearAllCached() empties the store', async () => {
    await cached('d1', 'pg:dbs', async () => ['a'])
    await cached('d2', 'ddb:tables', async () => ['b'])
    await flush()
    await clearAllCached()
    expect(fake.entries.size).toBe(0)
    expect(fake.clear).toHaveBeenCalled()
    const f = vi.fn(async () => ['again'])
    resetObjectCache()
    expect(await cached('d1', 'pg:dbs', f)).toEqual(['again'])
  })

  it('initObjectCache() subscribes to main\'s notifications; the unsubscribe works', async () => {
    const off = initObjectCache()
    await cached('d1', 'pg:dbs', async () => ['a'])
    expect(api._invalidated).toHaveLength(1)
    api._invalidated[0]('d1', [''])
    expect(peekIndex('d1')).toBeUndefined()
    off()
    expect(api._invalidated).toHaveLength(0)
  })
})

describe('codec and store options (Redis key trees)', () => {
  it('encode is what is stored, decode what is read back', async () => {
    const encode = vi.fn((v: { n: number }) => ({ c: v.n }))
    const decode = (raw: unknown): { n: number } | null => (raw && typeof (raw as { c?: unknown }).c === 'number' ? { n: (raw as { c: number }).c } : null)
    expect(await cached('d1', 'k', async () => ({ n: 7 }), { encode, decode })).toEqual({ n: 7 })
    await flush()
    expect(stored('d1', 'k')).toEqual({ c: 7 })
    const f = vi.fn(async () => ({ n: 0 }))
    resetObjectCache()
    expect(await cached('d1', 'k', f, { encode, decode })).toEqual({ n: 7 })
    expect(f).not.toHaveBeenCalled()
  })

  it('decode returning null (a stale format) is a miss: it fetches and overwrites', async () => {
    setup({ d1: { k: { at: 1, data: 'garbage' } } })
    const f = vi.fn(async () => ({ n: 1 }))
    expect(await cached('d1', 'k', f, { encode: (v) => ({ c: v.n }), decode: () => null })).toEqual({ n: 1 })
    await flush()
    expect(stored('d1', 'k')).toEqual({ c: 1 })
  })

  it('store(v) = false uses the value but does not keep it (an incomplete key scan)', async () => {
    const r = await cached('d1', 'k', async () => ({ complete: false }), { store: (v) => v.complete })
    expect(r).toEqual({ complete: false })
    await flush()
    expect(fake.set).not.toHaveBeenCalled()
    await cached('d1', 'k2', async () => ({ complete: true }), { store: (v) => v.complete })
    await flush()
    expect(stored('d1', 'k2')).toEqual({ complete: true })
  })

  it('encoded entries are not put in the name index', async () => {
    await cached('d1', 'redis:tree:0', async () => ({ n: 1 }), { encode: (v) => v })
    expect(peekIndex('d1')).toBeUndefined()
  })
})

describe('the setting "Cache database objects locally"', () => {
  it('off: nothing is read, nothing is written (and an existing store is left alone)', async () => {
    setup({ d1: { k: { at: 1, data: ['stored'] } } })
    updateSettings({ cacheObjects: false })
    const f = vi.fn(async () => ['live'])
    expect(await cached('d1', 'k', f)).toEqual(['live'])
    await flush()
    expect(fake.get).not.toHaveBeenCalled()
    expect(fake.set).not.toHaveBeenCalled()
    expect(fake.delete).not.toHaveBeenCalled()
    expect(stored('d1', 'k')).toEqual(['stored'])
  })

  it('off: every call fetches (parallel calls still share)', async () => {
    updateSettings({ cacheObjects: false })
    const f = vi.fn(async () => [1])
    await cached('d1', 'k', f)
    await cached('d1', 'k', f)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('off: primeIndex reads nothing', async () => {
    setup({ d1: { 'pg:dbs': { at: 1, data: ['a'] } } })
    updateSettings({ cacheObjects: false })
    await primeIndex()
    expect(fake.all).not.toHaveBeenCalled()
    expect(peekIndex('d1')).toBeUndefined()
  })

  it('turned back on, it caches again', async () => {
    updateSettings({ cacheObjects: false })
    await cached('d1', 'k', async () => [1])
    updateSettings({ cacheObjects: true })
    await cached('d1', 'k2', async () => [2], { force: true })
    await flush()
    expect(stored('d1', 'k2')).toEqual([2])
    expect(stored('d1', 'k')).toBeUndefined()
  })
})

describe('the name index (for ⌘O)', () => {
  it('only the name lists (databases, schemas, tables, DynamoDB tables, Redis databases) are indexed', async () => {
    for (const k of [cacheKeys.pgDbs, cacheKeys.pgSchemas('a'), cacheKeys.pgTables('a', 'b'), cacheKeys.ddbTables, cacheKeys.redisDbs, cacheKeys.pgRoles, cacheKeys.pgTablespaces, cacheKeys.pgTableNames('a')])
      await cached('d1', k, async () => [])
    expect([...peekIndex('d1')!.keys()].sort()).toEqual([cacheKeys.pgDbs, cacheKeys.pgSchemas('a'), cacheKeys.pgTables('a', 'b'), cacheKeys.ddbTables, cacheKeys.redisDbs].sort())
  })

  it('notifies subscribers on changes; unsubscribe stops it', async () => {
    const fn = vi.fn()
    const off = subscribeIndex(fn)
    await cached('d1', 'pg:dbs', async () => ['a'])
    expect(fn).toHaveBeenCalledTimes(1)
    invalidate('d1')
    expect(fn).toHaveBeenCalledTimes(2)
    off()
    await cached('d1', 'pg:dbs', async () => ['a'], { force: true })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('primeIndex() loads what is stored, for every source, with its age; asks only for the index prefixes', async () => {
    setup({
      d1: { 'pg:dbs': { at: 10, data: ['a'] }, 'redis:tree:0': { at: 10, data: { big: 1 } } },
      d2: { 'ddb:tables': { at: 20, data: ['t'] } }
    })
    await primeIndex()
    expect(fake.all).toHaveBeenCalledWith(expect.arrayContaining(['pg:dbs', 'ddb:tables', 'redis:dbs']))
    expect(indexedSources().sort()).toEqual(['d1', 'd2'])
    expect(peekIndex('d1')!.get('pg:dbs')).toEqual({ at: 10, data: ['a'] })
    expect(peekIndex('d1')!.has('redis:tree:0')).toBe(false)
    expect(cacheMeta('d2', 'ddb:tables')).toEqual({ at: 20, fromCache: true })
  })

  it('what was loaded in this session wins over an older stored copy', async () => {
    setup({ d1: { 'pg:dbs': { at: 10, data: ['stored'] } } })
    await cached('d1', 'pg:dbs', async () => ['fresh'], { force: true })
    await primeIndex()
    expect(peekIndex('d1')!.get('pg:dbs')!.data).toEqual(['fresh'])
  })

  it('primeIndex survives a failing cache and malformed entries', async () => {
    api = installApi({ cache: { all: async () => { throw new Error('x') } } })
    await expect(primeIndex()).resolves.toBeUndefined()
    api = installApi({ cache: { all: async () => ({ d1: { 'pg:dbs': null, 'ddb:tables': { at: 'x', data: [] } } }) } })
    await primeIndex()
    expect(peekIndex('d1')).toBeUndefined()
  })

  it('resetObjectCache() forgets everything', async () => {
    await cached('d1', 'pg:dbs', async () => ['a'])
    resetObjectCache()
    expect(indexedSources()).toEqual([])
    expect(cacheMeta('d1', 'pg:dbs')).toBeUndefined()
  })
})

describe('ageText / cacheNote', () => {
  const now = 1_000_000_000_000
  it.each([
    [0, 'just now'], [30_000, 'just now'], [60_000, '1 min'], [5 * 60_000, '5 min'], [59 * 60_000, '59 min'], [3 * 3600_000, '3h'], [47 * 3600_000, '47h'],
    [3 * 86400_000, '3 days'], [-5000, 'just now']
  ])('%i ms -> %s', (ms, text) => expect(ageText(ms)).toBe(text))

  it('says where a list came from', () => {
    expect(cacheNote({ at: now - 3 * 3600_000, fromCache: true }, now)).toBe('Loaded from cache 3h ago — Refresh to update')
    expect(cacheNote({ at: now - 2000, fromCache: true }, now)).toBe('Loaded from cache — Refresh to update')
    expect(cacheNote({ at: now - 2000, fromCache: false }, now)).toBe('Refreshed just now')
    expect(cacheNote({ at: now - 7 * 60_000, fromCache: false }, now)).toBe('Refreshed 7 min ago')
    expect(cacheNote(undefined, now)).toBeUndefined()
  })
})
