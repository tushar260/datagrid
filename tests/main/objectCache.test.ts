import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cacheIdentity, createObjectCache, invalidationsFor, isDdl, redisCommandWrites, validCacheDsId, validCacheKey, validCachePrefix,
  type ObjectCache
} from '../../src/main/objectCache'
import { CACHE_VERSION, cacheKeys, type DataSource } from '../../src/shared'

let root: string
let dir: string
let caches: ObjectCache[] = []
const mk = (o: Partial<Parameters<typeof createObjectCache>[0]> = {}): ObjectCache => {
  const c = createObjectCache({ dir, debounceMs: 15, ...o })
  caches.push(c)
  return c
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const file = (id: string): string => join(dir, id + '.json')
const read = (id: string): { v: number; entries: Record<string, { at: number; data: unknown }> } => JSON.parse(readFileSync(file(id), 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grid-cache-'))
  dir = join(root, 'cache')
  caches = []
})
afterEach(() => {
  for (const c of caches) c.flush()
  rmSync(root, { recursive: true, force: true })
})

describe('validation helpers', () => {
  it.each(['ds1', 'a-b_c', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'A'.repeat(64)])('%s is a valid data source id', (id) => expect(validCacheDsId(id)).toBe(true))
  it.each(['', '../x', 'a/b', 'a\\b', 'a.b', 'a b', 'x'.repeat(65), 'a\u0000b', undefined, null, 3, {}, []])('%j is not', (id) => expect(validCacheDsId(id)).toBe(false))
  it.each(['pg:dbs', 'pg:tables:a%3Ab:public', 'x'])('%s is a valid key', (k) => expect(validCacheKey(k)).toBe(true))
  it.each(['', 'a\nb', 'a\u0000b', 'a\u007fb', 'k'.repeat(513), 5, null, undefined])('%j is not', (k) => expect(validCacheKey(k)).toBe(false))
  it('prefixes may be empty but not control characters / huge', () => {
    expect(validCachePrefix('')).toBe(true)
    expect(validCachePrefix('pg:')).toBe(true)
    expect(validCachePrefix('a\nb')).toBe(false)
    expect(validCachePrefix('x'.repeat(513))).toBe(false)
    expect(validCachePrefix(1)).toBe(false)
  })
})

describe('get / set', () => {
  it('stores a list with the time it was fetched and gives it back', () => {
    let t = 1000
    const c = mk({ now: () => t })
    expect(c.get('ds1', 'pg:dbs')).toBeUndefined()
    expect(c.set('ds1', 'pg:dbs', ['a', 'b'])).toBe(true)
    expect(c.get('ds1', 'pg:dbs')).toEqual({ at: 1000, data: ['a', 'b'] })
    t = 2000
    c.set('ds1', 'pg:dbs', ['a', 'b', 'c'])
    expect(c.get('ds1', 'pg:dbs')).toEqual({ at: 2000, data: ['a', 'b', 'c'] })
  })

  it('stores a copy: later changes to the caller\'s object do not leak in', () => {
    const c = mk()
    const data = { public: ['t1'] }
    c.set('ds1', 'k', data)
    data.public.push('t2')
    expect(c.get('ds1', 'k')!.data).toEqual({ public: ['t1'] })
  })

  it('sources are isolated from each other', () => {
    const c = mk()
    c.set('a', 'k', 1)
    c.set('b', 'k', 2)
    expect(c.get('a', 'k')!.data).toBe(1)
    expect(c.get('b', 'k')!.data).toBe(2)
    c.delete('a')
    expect(c.get('a', 'k')).toBeUndefined()
    expect(c.get('b', 'k')!.data).toBe(2)
  })

  it.each([null, 0, '', false, [], {}])('a falsy-looking value (%j) is a real entry', (v) => {
    const c = mk()
    expect(c.set('d', 'k', v)).toBe(true)
    expect(c.get('d', 'k')!.data).toEqual(v)
  })

  it('refuses undefined, circular and BigInt data', () => {
    const c = mk()
    const circ: Record<string, unknown> = {}
    circ.self = circ
    expect(c.set('d', 'k', undefined)).toBe(false)
    expect(c.set('d', 'k', circ)).toBe(false)
    expect(c.set('d', 'k', { n: BigInt(1) })).toBe(false)
    expect(c.get('d', 'k')).toBeUndefined()
  })

  it('invalid ids and keys never reach the disk (no path traversal)', () => {
    const c = mk()
    for (const id of ['../evil', 'a/b', '', 'x'.repeat(80)]) expect(c.set(id, 'k', 1)).toBe(false)
    for (const key of ['', 'a\nb', 'k'.repeat(600)]) expect(c.set('ok', key, 1)).toBe(false)
    c.flush()
    expect(existsSync(join(root, 'evil.json'))).toBe(false)
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
    expect(c.get('../evil', 'k')).toBeUndefined()
    expect(c.delete('../evil')).toBe(0)
    expect(c.all(['../evil', 'a/b'])).toEqual({})
  })
})

describe('persistence', () => {
  it('flush() writes synchronously; a new instance reads it back', () => {
    const c = mk()
    c.set('ds1', 'pg:dbs', ['x'])
    c.set('ds1', 'ddb:tables', ['t'])
    expect(c.pending()).toBe(1)
    c.flush()
    expect(c.pending()).toBe(0)
    expect(read('ds1').v).toBe(CACHE_VERSION)
    const d = mk()
    expect(d.get('ds1', 'pg:dbs')!.data).toEqual(['x'])
    expect(d.get('ds1', 'ddb:tables')!.data).toEqual(['t'])
  })

  it('writes by itself after the debounce, atomically (no temp files left)', async () => {
    const c = mk({ debounceMs: 20 })
    c.set('ds1', 'k', [1])
    expect(existsSync(file('ds1'))).toBe(false) // not yet
    await sleep(120)
    expect(existsSync(file('ds1'))).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(c.pending()).toBe(0)
  })

  it('a burst of changes is written once, with the last state', async () => {
    const c = mk({ debounceMs: 30 })
    for (let i = 0; i < 50; i++) c.set('ds1', 'k', [i])
    c.set('ds1', 'other', 'x')
    await sleep(150)
    const j = read('ds1')
    expect(j.entries.k.data).toEqual([49])
    expect(j.entries.other.data).toBe('x')
  })

  it('a steady stream of changes still reaches the disk (max wait)', async () => {
    const c = mk({ debounceMs: 20 })
    const t0 = Date.now()
    let seen = false
    for (let i = 0; i < 40 && !seen; i++) {
      c.set('ds1', 'k', [i])
      await sleep(8) // always under the debounce: a plain trailing debounce would never fire
      seen = existsSync(file('ds1'))
    }
    expect(seen).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('a flush right after the async write started wins: the older temp file never replaces the newer file', async () => {
    const c = mk({ debounceMs: 5 })
    c.set('ds1', 'k', ['old'])
    await sleep(5) // the timer fires and the async write starts
    c.set('ds1', 'k', ['new'])
    c.flush()
    await sleep(120)
    expect(read('ds1').entries.k.data).toEqual(['new'])
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('deleting everything removes the file', () => {
    const c = mk()
    c.set('ds1', 'k', 1)
    c.flush()
    expect(existsSync(file('ds1'))).toBe(true)
    c.delete('ds1')
    c.flush()
    expect(existsSync(file('ds1'))).toBe(false)
  })

  it('creates the cache directory on demand', () => {
    expect(existsSync(dir)).toBe(false)
    const c = mk()
    c.set('ds1', 'k', 1)
    c.flush()
    expect(existsSync(dir)).toBe(true)
  })

  it('the directory can be a function (resolved lazily)', () => {
    let calls = 0
    const c = createObjectCache({ dir: () => (calls++, dir), debounceMs: 10 })
    expect(calls).toBe(0)
    c.set('ds1', 'k', 1)
    c.flush()
    expect(calls).toBeGreaterThan(0)
    expect(existsSync(file('ds1'))).toBe(true)
  })

  it('a write error is reported, not thrown', () => {
    writeFileSync(root + '/blocker', 'x')
    const errors: string[] = []
    const c = createObjectCache({ dir: join(root, 'blocker', 'sub'), debounceMs: 10, onError: (m) => errors.push(m) })
    c.set('ds1', 'k', 1)
    expect(() => c.flush()).not.toThrow()
    expect(errors[0]).toMatch(/cache write failed/)
  })
})

describe('bad files are ignored and deleted', () => {
  const put = (id: string, text: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file(id), text)
  }
  it('corrupt JSON', () => {
    put('ds1', '{not json')
    const c = mk()
    expect(c.get('ds1', 'k')).toBeUndefined()
    expect(existsSync(file('ds1'))).toBe(false)
    expect(c.set('ds1', 'k', 1)).toBe(true) // and it works afterwards
  })
  it('an unknown version', () => {
    put('ds1', JSON.stringify({ v: 99, entries: { k: { at: 1, data: 1 } } }))
    const c = mk()
    expect(c.get('ds1', 'k')).toBeUndefined()
    expect(existsSync(file('ds1'))).toBe(false)
  })
  it.each([['no entries', { v: CACHE_VERSION }], ['entries is an array', { v: CACHE_VERSION, entries: [] }], ['not an object', 5], ['null', null]])(
    'wrong shape: %s',
    (_n, body) => {
      put('ds1', JSON.stringify(body))
      const c = mk()
      expect(c.get('ds1', 'k')).toBeUndefined()
      expect(existsSync(file('ds1'))).toBe(false)
    }
  )
  it('keeps the good entries of a file and drops the malformed ones', () => {
    put(
      'ds1',
      JSON.stringify({
        v: CACHE_VERSION,
        entries: { good: { at: 5, data: [1] }, noAt: { data: 1 }, badAt: { at: 'x', data: 1 }, noData: { at: 1 }, nul: null, 'bad\nkey': { at: 1, data: 1 } }
      })
    )
    const c = mk()
    expect(c.get('ds1', 'good')).toEqual({ at: 5, data: [1] })
    for (const k of ['noAt', 'badAt', 'noData', 'nul']) expect(c.get('ds1', k)).toBeUndefined()
    expect(Object.keys(c.all(['ds1'])['ds1'])).toEqual(['good'])
  })
})

describe('size cap', () => {
  it('an entry that would exceed the cap is not cached', () => {
    const c = mk({ maxBytes: 400 })
    expect(c.set('d', 'small', 'x')).toBe(true)
    expect(c.set('d', 'big', 'y'.repeat(1000))).toBe(false)
    expect(c.get('d', 'big')).toBeUndefined()
    expect(c.get('d', 'small')).toBeTruthy()
  })
  it('the cap is per source', () => {
    const c = mk({ maxBytes: 300 })
    const blob = 'z'.repeat(150)
    expect(c.set('a', 'k1', blob)).toBe(true)
    expect(c.set('a', 'k2', blob)).toBe(false) // a is full
    expect(c.set('b', 'k1', blob)).toBe(true) // b has its own budget
  })
  it('replacing an entry frees its old size', () => {
    const c = mk({ maxBytes: 400 })
    expect(c.set('d', 'k', 'a'.repeat(250))).toBe(true)
    expect(c.set('d', 'k', 'b'.repeat(260))).toBe(true) // would not fit next to the old copy
    expect(c.get('d', 'k')!.data).toBe('b'.repeat(260))
  })
  it('a failed replacement drops the outdated entry (no entry beats a stale one)', () => {
    const c = mk({ maxBytes: 400 })
    c.set('d', 'k', 'old')
    expect(c.set('d', 'k', 'n'.repeat(900))).toBe(false)
    expect(c.get('d', 'k')).toBeUndefined()
  })
  it('deleting entries frees budget', () => {
    const c = mk({ maxBytes: 300 })
    const blob = 'q'.repeat(150)
    c.set('d', 'a', blob)
    expect(c.set('d', 'b', blob)).toBe(false)
    c.delete('d', 'a')
    expect(c.set('d', 'b', blob)).toBe(true)
  })
  it('the real default is 40 MB: a few MB of keys fit', () => {
    const c = mk()
    const keys = Array.from({ length: 100_000 }, (_, i) => `session:${i}:some:longer:key:name`)
    expect(c.set('d', cacheKeys.redisTree(0), { complete: true, dbsize: keys.length, types: { string: keys } })).toBe(true)
  })
  it('a file bigger than the cap is not loaded beyond it', () => {
    const big = mk({ maxBytes: 10_000_000 })
    for (let i = 0; i < 20; i++) big.set('d', 'k' + i, 'x'.repeat(2000))
    big.flush()
    const small = mk({ maxBytes: 12_000 })
    const got = Object.keys(small.all(['d'])['d'] ?? {})
    expect(got.length).toBeGreaterThan(0)
    expect(got.length).toBeLessThan(20)
  })
})

describe('delete / clear / all / size', () => {
  it('delete(prefix) removes matching keys only and counts them', () => {
    const c = mk()
    c.set('d', 'pg:dbs', 1)
    c.set('d', 'pg:schemas:a', 2)
    c.set('d', 'pg:schemas:b', 3)
    c.set('d', 'ddb:tables', 4)
    expect(c.delete('d', 'pg:schemas:')).toBe(2)
    expect(c.get('d', 'pg:dbs')).toBeTruthy()
    expect(c.get('d', 'pg:schemas:a')).toBeUndefined()
    expect(c.get('d', 'ddb:tables')).toBeTruthy()
    expect(c.delete('d', 'nope')).toBe(0)
    expect(c.delete('d')).toBe(2)
  })
  it('an empty prefix means everything', () => {
    const c = mk()
    c.set('d', 'a', 1)
    c.set('d', 'b', 2)
    expect(c.delete('d', '')).toBe(2)
  })
  it('an invalid prefix deletes nothing', () => {
    const c = mk()
    c.set('d', 'a', 1)
    expect(c.delete('d', 'a\nb')).toBe(0)
    expect(c.get('d', 'a')).toBeTruthy()
  })
  it('clear(id) removes one source and its file', () => {
    const c = mk()
    c.set('a', 'k', 1)
    c.set('b', 'k', 1)
    c.flush()
    c.clear('a')
    expect(existsSync(file('a'))).toBe(false)
    expect(existsSync(file('b'))).toBe(true)
    expect(c.get('a', 'k')).toBeUndefined()
    expect(c.get('b', 'k')).toBeTruthy()
    c.flush()
    expect(existsSync(file('a'))).toBe(false) // a pending write of the removed source does not resurrect it
  })
  it('clear() removes every file and temp file, including sources this process never loaded', () => {
    const c = mk()
    c.set('a', 'k', 1)
    c.flush()
    writeFileSync(file('never-loaded'), JSON.stringify({ v: CACHE_VERSION, entries: {} }))
    writeFileSync(join(dir, 'x.json.1.tmp'), 'junk')
    writeFileSync(join(dir, 'keep.txt'), 'not ours')
    c.clear()
    expect(readdirSync(dir)).toEqual(['keep.txt'])
    expect(c.get('a', 'k')).toBeUndefined()
  })
  it('clear(id) of a removed source with an invalid id is ignored', () => {
    const c = mk()
    expect(() => c.clear('../x')).not.toThrow()
  })
  it('all() returns the entries of the given sources, optionally only some key prefixes', () => {
    const c = mk()
    c.set('a', 'pg:dbs', ['x'])
    c.set('a', 'redis:tree:0', { big: true })
    c.set('b', 'ddb:tables', ['t'])
    c.set('c', 'redis:tree:1', {})
    expect(Object.keys(c.all(['a', 'b'])).sort()).toEqual(['a', 'b'])
    const idx = c.all(['a', 'b', 'c'], ['pg:dbs', 'ddb:tables'])
    expect(Object.keys(idx).sort()).toEqual(['a', 'b']) // c has nothing under those prefixes
    expect(Object.keys(idx.a)).toEqual(['pg:dbs'])
    expect(idx.a['pg:dbs'].data).toEqual(['x'])
  })
  it('size() is the bytes on disk (pending changes are flushed first)', () => {
    const c = mk()
    expect(c.size()).toBe(0)
    c.set('a', 'k', 'x'.repeat(100))
    const n = c.size()
    expect(n).toBeGreaterThan(100)
    expect(n).toBe(readFileSync(file('a')).length)
  })
})

describe('cacheIdentity: what a data source connects to', () => {
  const pg = (o: Partial<DataSource> = {}): DataSource => ({ id: 'a', name: 'A', host: 'h', port: 5432, user: 'u', password: 'p', database: 'postgres', ssl: false, ...o })
  const ddb = (o: Partial<NonNullable<DataSource['dynamo']>> = {}): DataSource => ({
    ...pg({ kind: 'dynamodb', host: '', port: 0, user: '', database: '' }),
    dynamo: { region: 'us-east-1', authMode: 'default', ...o }
  })
  const rd = (o: Partial<NonNullable<DataSource['redis']>> = {}): DataSource => ({
    ...pg({ kind: 'redis', host: '', port: 0, user: '', database: '' }),
    redis: { host: 'localhost', port: 6379, db: 0, tls: false, ...o }
  })
  it('things that do not change what is behind the connection keep the identity', () => {
    const base = cacheIdentity(pg())
    for (const o of [{ name: 'Renamed' }, { password: 'other' }, { ssl: true }, { folderId: 'f' }, { dbSort: 'size-desc' as const }, { visibleDbs: ['x'] }, { tableFilter: {} }, { schemaFilter: {} }])
      expect(cacheIdentity(pg(o)), JSON.stringify(o)).toBe(base)
  })
  it.each([{ host: 'h2' }, { port: 5433 }, { user: 'v' }, { database: 'other' }])('PostgreSQL: %j changes it', (o) => expect(cacheIdentity(pg(o))).not.toBe(cacheIdentity(pg())))
  it('a source without kind is PostgreSQL', () => expect(cacheIdentity(pg({ kind: undefined }))).toBe(cacheIdentity(pg({ kind: 'postgres' }))))
  it.each([{ region: 'eu-west-1' }, { endpoint: 'http://localhost:8000' }, { profile: 'dev' }, { authMode: 'keys' as const }, { accessKeyId: 'AKIA1' }])(
    'DynamoDB: %j changes it',
    (o) => expect(cacheIdentity(ddb(o))).not.toBe(cacheIdentity(ddb()))
  )
  it('DynamoDB: secrets and filters do not', () => {
    expect(cacheIdentity(ddb({ secretAccessKey: 'x', sessionToken: 'y' }))).toBe(cacheIdentity(ddb()))
    expect(cacheIdentity({ ...ddb(), tableFilter: { dynamodb: { list: ['a'] } } })).toBe(cacheIdentity(ddb()))
  })
  it.each([{ host: 'redis.example' }, { port: 6380 }, { username: 'app' }, { db: 3 }, { tls: true }])('Redis: %j changes it', (o) => expect(cacheIdentity(rd(o))).not.toBe(cacheIdentity(rd())))
  it('Redis: password and key delimiter do not', () => {
    expect(cacheIdentity(rd({ password: 'x', keyDelimiter: ':' }))).toBe(cacheIdentity(rd()))
  })
  it('different kinds never share an identity', () => {
    expect(new Set([cacheIdentity(pg()), cacheIdentity(ddb()), cacheIdentity(rd())]).size).toBe(3)
  })
  it('missing sources have an empty identity', () => {
    expect(cacheIdentity(undefined)).toBe('')
    expect(cacheIdentity(null)).toBe('')
  })
})

describe('isDdl / redisCommandWrites', () => {
  it.each([
    'create table t (id int)', 'DROP TABLE t', '  alter table t add column x int', 'select 1; drop table t', '-- hi\ncreate schema s',
    '/* c */ create database d', 'insert into t values (1);\nCREATE INDEX i on t(x)'
  ])('DDL: %s', (sql) => expect(isDdl(sql)).toBe(true))
  it.each(['select 1', "select 'create table x'", '-- create table x\nselect 1', '/* drop table t */ select 2', 'insert into t values (1)', 'update t set a = 1', 'delete from t', 'select * from created', '', undefined, 5])(
    'not DDL: %j',
    (sql) => expect(isDdl(sql)).toBe(false)
  )
  it.each(['SET a 1', 'del a', 'RENAME a b', 'HSET h f v', 'FLUSHDB', 'get a\nset b 2', 'EXPIRE a 10', 'LPUSH l x'])('Redis write: %s', (t) => expect(redisCommandWrites(t)).toBe(true))
  it.each(['GET a', 'scan 0', 'INFO', 'ping', 'hgetall h', 'TTL a', 'GET a\nTYPE b', '', '  ', '# comment', 'select 3', undefined])('Redis read-only: %j', (t) => expect(redisCommandWrites(t)).toBe(false))
})

describe('invalidationsFor: which cached lists a structure change drops', () => {
  it('create database -> the database list', () => expect(invalidationsFor('db:createDatabase', ['new'])).toEqual([cacheKeys.pgDbs]))
  it('drop database -> the list and everything below it', () => {
    expect(invalidationsFor('db:dropDatabase', ['app'])).toEqual([cacheKeys.pgDbs, cacheKeys.pgSchemas('app'), cacheKeys.pgTableNames('app'), cacheKeys.pgTablesOf('app')])
  })
  it('create schema -> that database\'s schema list and counts', () => {
    expect(invalidationsFor('db:createSchema', ['app', 's'])).toEqual([cacheKeys.pgSchemas('app'), cacheKeys.pgTableNames('app')])
  })
  it.each(['db:createTable', 'db:renameTable', 'db:dropTable'])('%s -> that schema\'s table list and the counts', (ch) => {
    expect(invalidationsFor(ch, ['app', 'public', 't'])).toEqual([cacheKeys.pgTables('app', 'public'), cacheKeys.pgTableNames('app')])
  })
  it('adding a column changes no list', () => expect(invalidationsFor('db:addColumn', ['app', 'public', 't'])).toEqual([]))
  it('a console script drops lists only when it is DDL', () => {
    expect(invalidationsFor('db:query', ['app', 'public', 'select 1'])).toEqual([])
    expect(invalidationsFor('db:query', ['app', 'public', 'create table x(i int)'])).toEqual([cacheKeys.pgDbs, cacheKeys.pgSchemas('app'), cacheKeys.pgTableNames('app'), cacheKeys.pgTablesOf('app')])
  })
  it.each(['redis:delete', 'redis:rename', 'redis:create', 'redis:setString'])('%s -> that database\'s key tree and the database list', (ch) => {
    expect(invalidationsFor(ch, [3, 'k'])).toEqual([cacheKeys.redisTree(3), cacheKeys.redisDbs])
  })
  it('a Redis console command drops them only when it writes', () => {
    expect(invalidationsFor('redis:command', [2, 'GET a'])).toEqual([])
    expect(invalidationsFor('redis:command', [2, 'SET a 1'])).toEqual([cacheKeys.redisTree(2), cacheKeys.redisDbs])
  })
  it('junk arguments drop nothing', () => {
    expect(invalidationsFor('redis:delete', ['x'])).toEqual([])
    expect(invalidationsFor('redis:delete', [-1])).toEqual([])
    expect(invalidationsFor('redis:delete', [1.5])).toEqual([])
    expect(invalidationsFor('db:query', [])).toEqual([])
  })
  it('unknown channels drop nothing', () => {
    expect(invalidationsFor('db:rows', ['a'])).toEqual([])
    expect(invalidationsFor('whatever', [])).toEqual([])
  })
  it('database names with a colon cannot be confused with other keys', () => {
    expect(cacheKeys.pgTables('a:b', 'c')).not.toBe(cacheKeys.pgTables('a', 'b:c'))
    expect(cacheKeys.pgTablesOf('a:b').startsWith('pg:tables:a%3Ab:')).toBe(true)
  })
  it('the prefixes drop exactly the entries they describe', () => {
    const c = mk()
    c.set('d', cacheKeys.pgDbs, ['app'])
    c.set('d', cacheKeys.pgSchemas('app'), ['public'])
    c.set('d', cacheKeys.pgTables('app', 'public'), [{ name: 't', kind: 'table' }])
    c.set('d', cacheKeys.pgTables('other', 'public'), [{ name: 'u', kind: 'table' }])
    for (const p of invalidationsFor('db:dropDatabase', ['app'])) c.delete('d', p)
    expect(c.get('d', cacheKeys.pgDbs)).toBeUndefined()
    expect(c.get('d', cacheKeys.pgSchemas('app'))).toBeUndefined()
    expect(c.get('d', cacheKeys.pgTables('app', 'public'))).toBeUndefined()
    expect(c.get('d', cacheKeys.pgTables('other', 'public'))).toBeTruthy()
  })
})
