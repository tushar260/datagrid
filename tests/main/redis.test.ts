import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource } from '../../src/shared'
import { REDIS_BIN_PREFIX } from '../../src/shared'

/**
 * Unit tests of src/main/redis.ts against a fake ioredis (no sockets, never a real server): they pin down which commands
 * are sent (SCAN never KEYS, pipelines, NX / KEEPTTL / RENAMENX ...), input validation / clamping, pooling and error text.
 * The same module is exercised against a real throwaway redis-server by redis.int.test.ts (RUN_REDIS_TESTS=1).
 */

interface FakeRedis {
  opts: Record<string, unknown>
  status: string
  calls: [string, unknown[]][]
  disconnected: number
  listeners: Record<string, (e: Error) => void>
}

const h = vi.hoisted(() => ({
  clients: [] as unknown[],
  handler: (() => null) as (cmd: string, args: unknown[], client: unknown) => unknown,
  connectError: null as Error | null
}))

vi.mock('ioredis', () => {
  class Redis {
    status = 'wait'
    calls: [string, unknown[]][] = []
    disconnected = 0
    listeners: Record<string, (e: Error) => void> = {}
    constructor(public opts: Record<string, unknown>) {
      h.clients.push(this)
    }
    on(ev: string, fn: (e: Error) => void): this {
      this.listeners[ev] = fn
      return this
    }
    async connect(): Promise<void> {
      if (h.connectError) {
        this.status = 'end'
        this.listeners.error?.(h.connectError)
        throw new Error('Connection is closed.')
      }
      this.status = 'ready'
    }
    disconnect(): void {
      this.status = 'end'
      this.disconnected++
    }
    async callBuffer(cmd: string, ...args: unknown[]): Promise<unknown> {
      this.calls.push([cmd.toUpperCase(), args])
      return h.handler(cmd.toUpperCase(), args, this)
    }
    pipeline(): unknown {
      const q: [string, unknown[]][] = []
      const p = {
        callBuffer: (cmd: string, ...args: unknown[]) => (q.push([cmd.toUpperCase(), args]), p),
        exec: async () =>
          Promise.all(
            q.map(async ([c, a]) => {
              this.calls.push([c, a])
              try {
                return [null, await h.handler(c, a, this)]
              } catch (e) {
                return [e, null]
              }
            })
          )
      }
      return p
    }
  }
  return { Redis }
})

import * as redis from '../../src/main/redis'

const ds = (over: Partial<NonNullable<DataSource['redis']>> = {}, id = 'r1'): DataSource => ({
  id, name: 'R', kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  redis: { host: 'localhost', port: 6379, db: 0, tls: false, ...over }
})
const B = (s: string): Buffer => Buffer.from(s)
const replyErr = (m: string): Error => Object.assign(new Error(m), { name: 'ReplyError' })
const fakes = (): FakeRedis[] => h.clients as FakeRedis[]
const allCalls = (): string[] => fakes().flatMap((c) => c.calls.map(([n]) => n))

/** Installs a handler from a table of command -> reply (or function). Unknown commands reply null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Table = Record<string, ((args: any[]) => unknown) | object | string | number | null>
function serve(table: Table): void {
  h.handler = (cmd, args) => {
    const v = table[cmd]
    if (typeof v === 'function') return (v as (a: unknown[]) => unknown)(args)
    return v === undefined ? null : v
  }
}

beforeEach(() => {
  h.clients.length = 0
  h.connectError = null
  serve({})
})
afterEach(async () => {
  await redis.closeAll()
})

describe('names', () => {
  it('text round-trips as is', () => {
    expect(redis.encodeName(B('user:1 é'))).toBe('user:1 é')
    expect(redis.decodeName('user:1 é')).toEqual(B('user:1 é'))
  })
  it('bytes that are not UTF-8 use the base64 sentinel and round-trip', () => {
    const bytes = Buffer.from([0x61, 0xff, 0x00])
    const s = redis.encodeName(bytes)
    expect(s).toBe(REDIS_BIN_PREFIX + bytes.toString('base64'))
    expect(redis.decodeName(s)).toEqual(bytes)
  })
  it('a text key that starts like the sentinel is encoded too (so it cannot be mistaken for one)', () => {
    const odd = B(REDIS_BIN_PREFIX + 'xyz')
    const s = redis.encodeName(odd)
    expect(s).toBe(REDIS_BIN_PREFIX + odd.toString('base64'))
    expect(redis.decodeName(s)).toEqual(odd)
  })
  it('checkDb accepts 0..255 only', () => {
    expect(redis.checkDb(0)).toBe(0)
    expect(redis.checkDb(255)).toBe(255)
    for (const bad of [-1, 256, 1.5, NaN, '1', null, undefined]) expect(() => redis.checkDb(bad), String(bad)).toThrow(/Database must be/)
  })
})

describe('clientOptions', () => {
  const o = (cfg: Partial<NonNullable<DataSource['redis']>>): Record<string, unknown> =>
    redis.clientOptions({ host: 'h', port: 1, db: 0, tls: false, ...cfg })
  it('fails fast and avoids surprises', () => {
    const x = o({})
    expect(x).toMatchObject({ host: 'h', port: 1, protocol: 2, lazyConnect: true, maxRetriesPerRequest: 1, autoResendUnfulfilledCommands: false })
    expect(x.connectTimeout as number).toBeLessThanOrEqual(5000)
    expect(x).not.toHaveProperty('db') // SELECT is done explicitly: ioredis would swallow a failed one
    const retry = x.retryStrategy as (n: number) => number | null
    expect(retry(1)).toBeGreaterThan(0)
    expect(retry(2)).toBeNull()
  })
  it('username / password only when set; host is trimmed', () => {
    expect(o({ host: ' h ' })).toMatchObject({ host: 'h' })
    expect(o({})).not.toHaveProperty('password')
    expect(o({})).not.toHaveProperty('username')
    expect(o({ username: ' app ', password: 'pw' })).toMatchObject({ username: 'app', password: 'pw' })
    expect(o({ username: '  ' })).not.toHaveProperty('username')
  })
  it('TLS: SNI for host names, none for IP addresses', () => {
    expect(o({ tls: true, host: 'redis.example.com' }).tls).toEqual({ servername: 'redis.example.com' })
    expect(o({ tls: true, host: '10.0.0.5' }).tls).toEqual({})
    expect(o({})).not.toHaveProperty('tls')
  })
})

describe('cleanRedisError', () => {
  const c = (e: unknown, ctx = { host: 'h', port: 6379 }): string => redis.cleanRedisError(e, ctx)
  it.each([
    ['WRONGPASS invalid username-password pair or user is disabled.', /Authentication failed/],
    ['NOAUTH Authentication required.', /Authentication required/],
    ['ERR AUTH <password> called without any password configured for the default user', /no password set/],
    ["NOPERM this user has no permissions to run the 'config' command", /Permission denied/],
    ['WRONGTYPE Operation against a key holding the wrong kind of value', /Wrong type/],
    ['ERR DB index is out of range', /Database index out of range/],
    ['ERR SELECT is not allowed in cluster mode', /cluster mode/],
    ['LOADING Redis is loading the dataset in memory', /still loading/],
    ['Command timed out', /command timed out/i],
    ['Connection is closed.', /connection to h:6379 was closed/],
    ['Connection timeout', /Timed out connecting to h:6379/]
  ])('%s', (msg, re) => {
    expect(c(new Error(msg))).toMatch(re)
  })
  it('network codes, also nested in a cause', () => {
    expect(c(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' }))).toMatch(/connection refused/)
    expect(c(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), { host: 'nope', port: 1 })).toMatch(/Could not resolve host "nope"/)
    expect(c(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toMatch(/Timed out/)
    expect(c(new Error('wrapper', { cause: Object.assign(new Error('inner'), { code: 'ECONNREFUSED' }) }))).toMatch(/connection refused/)
  })
  it('TLS problems say so', () => {
    expect(c(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toMatch(/TLS error talking to h:6379/)
    expect(c(new Error('wrong version number'))).toMatch(/untick "Use TLS"/)
  })
  it('other errors: the server message without the ERR prefix; never an empty string', () => {
    expect(c(new Error('ERR unknown command `foo`'))).toBe('unknown command `foo`')
    expect(c(undefined)).toBeTruthy()
    expect(c({})).toBeTruthy()
  })
})

describe('parseKeyspace', () => {
  it('reads db lines, ignores the rest, sorts', () => {
    expect(redis.parseKeyspace('# Keyspace\r\ndb3:keys=10,expires=2,avg_ttl=0\r\ndb0:keys=1,expires=0,avg_ttl=0\r\n')).toEqual([
      { db: 0, keys: 1, expires: 0 }, { db: 3, keys: 10, expires: 2 }
    ])
    expect(redis.parseKeyspace('# Keyspace\r\n')).toEqual([])
    expect(redis.parseKeyspace('db1:keys=oops')).toEqual([{ db: 1, keys: 0, expires: 0 }])
  })
})

describe('testConnection', () => {
  it('validates before opening anything', async () => {
    await expect(redis.testConnection(ds({ host: '' }))).rejects.toThrow(/Host is required/)
    await expect(redis.testConnection(ds({ port: 0 }))).rejects.toThrow(/Port/)
    expect(fakes()).toHaveLength(0)
  })
  it('reports product, version, mode, db and latency over a throwaway connection', async () => {
    serve({ PING: B('PONG'), INFO: B('# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n') })
    const msg = await redis.testConnection(ds())
    expect(msg).toMatch(/^Redis 7\.2\.4 \(standalone\), db0, PONG in \d+ ms$/)
    expect(fakes()).toHaveLength(1)
    expect(fakes()[0].disconnected).toBe(1)
    expect(redis.poolSize()).toBe(0) // not pooled
  })
  it('names the product when the server says (Valkey ...) and SELECTs a non-zero db', async () => {
    serve({ PING: B('PONG'), INFO: B('redis_version:8.0.0\r\nserver_name:valkey\r\nredis_mode:cluster\r\n') })
    expect(await redis.testConnection(ds({ db: 4 }))).toMatch(/^Valkey 8\.0\.0 \(cluster\), db4/)
    expect(fakes()[0].calls[0]).toEqual(['SELECT', [4]])
  })
  it('INFO being denied is not a failure', async () => {
    serve({ PING: B('PONG'), INFO: () => { throw replyErr('NOPERM no permissions to run the info command') } })
    expect(await redis.testConnection(ds())).toMatch(/^Redis \(standalone\), db0, PONG/)
  })
  it('a connection error is turned into a clean message and the client is closed; the password never shows', async () => {
    h.connectError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' })
    const err = await redis.testConnection(ds({ password: 'sup3rs3cret' })).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/Could not connect to localhost:6379 \(connection refused\)/)
    expect((err as Error).message).not.toContain('sup3rs3cret')
    expect(fakes()[0].disconnected).toBeGreaterThan(0)
  })
  it('a server error from PING (bad password) is clean', async () => {
    serve({ PING: () => { throw replyErr('WRONGPASS invalid username-password pair') } })
    await expect(redis.testConnection(ds())).rejects.toThrow(/Authentication failed/)
  })
  it('a source that is not Redis is refused', async () => {
    await expect(redis.testConnection({ ...ds(), redis: undefined })).rejects.toThrow(/Not a Redis data source/)
  })
})

describe('connection pool', () => {
  it('one lazily opened client per data source and database; the same one is reused', async () => {
    const a = await redis.connection(ds(), 0)
    expect(fakes()).toHaveLength(1)
    expect(await redis.connection(ds(), 0)).toBe(a)
    expect(fakes()).toHaveLength(1)
    const b = await redis.connection(ds(), 2)
    expect(b).not.toBe(a)
    expect(fakes()[1].calls[0]).toEqual(['SELECT', [2]]) // explicit SELECT after connecting
    expect(fakes()[0].calls).toHaveLength(0) // db 0: nothing to select
    expect(redis.poolSize()).toBe(2)
  })
  it('the console has its own connection per database', async () => {
    const main = await redis.connection(ds(), 1)
    const con = await redis.connection(ds(), 1, 'console')
    expect(con).not.toBe(main)
    expect((con as unknown as FakeRedis).opts.commandTimeout).toBeGreaterThan((main as unknown as FakeRedis).opts.commandTimeout as number)
  })
  it('different data sources never share a client', async () => {
    const a = await redis.connection(ds({}, 'a'), 0)
    const b = await redis.connection(ds({}, 'b'), 0)
    expect(a).not.toBe(b)
  })
  it('an edited data source (host / password / tls ...) gets a fresh client and the old one is closed', async () => {
    const a = await redis.connection(ds(), 0)
    const b = await redis.connection(ds({ password: 'new' }), 0)
    expect(b).not.toBe(a)
    expect((a as unknown as FakeRedis).disconnected).toBe(1)
  })
  it('an ended client is replaced on the next use', async () => {
    const a = (await redis.connection(ds(), 0)) as unknown as FakeRedis
    a.status = 'end'
    const b = await redis.connection(ds(), 0)
    expect(b).not.toBe(a)
  })
  it('a failed connect is not pooled and reports the real reason (not "Connection is closed")', async () => {
    h.connectError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    await expect(redis.connection(ds(), 0)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(redis.poolSize()).toBe(0)
    h.connectError = null
    await expect(redis.connection(ds(), 0)).resolves.toBeTruthy() // the next call tries again
  })
  it('a failing SELECT (db out of range) fails the connection call', async () => {
    serve({ SELECT: () => { throw replyErr('ERR DB index is out of range') } })
    await expect(redis.dbSize(ds(), 99)).rejects.toThrow(/Database index out of range/)
  })
  it('closeAll(dsId) closes only that data source', async () => {
    const a = (await redis.connection(ds({}, 'a'), 0)) as unknown as FakeRedis
    const a2 = (await redis.connection(ds({}, 'a'), 3)) as unknown as FakeRedis
    const b = (await redis.connection(ds({}, 'ab'), 0)) as unknown as FakeRedis // id prefix of another id must not match
    await redis.closeAll('a')
    expect([a.disconnected, a2.disconnected, b.disconnected]).toEqual([1, 1, 0])
    expect(redis.poolSize()).toBe(1)
    await redis.closeAll()
    expect(b.disconnected).toBe(1)
    expect(redis.poolSize()).toBe(0)
  })
  it('attaches an error listener (ioredis would print every connection error otherwise)', async () => {
    const a = (await redis.connection(ds(), 0)) as unknown as FakeRedis
    expect(typeof a.listeners.error).toBe('function')
  })
})

describe('listDatabases', () => {
  it('databases with keys, the configured one always included, the server count', async () => {
    serve({
      INFO: (a) => (String(a[0]) === 'keyspace' ? B('# Keyspace\r\ndb2:keys=5,expires=1,avg_ttl=9\r\n') : B('cluster_enabled:0\r\n')),
      CONFIG: [B('databases'), B('16')]
    })
    expect(await redis.listDatabases(ds({ db: 0 }))).toEqual({
      databases: [{ db: 0, keys: 0, expires: 0 }, { db: 2, keys: 5, expires: 1 }], count: 16, cluster: false
    })
  })
  it('cluster mode: one database; CONFIG denied: count null', async () => {
    serve({ INFO: (a) => (String(a[0]) === 'keyspace' ? B('db0:keys=3,expires=0\r\n') : B('cluster_enabled:1\r\n')) })
    expect(await redis.listDatabases(ds())).toMatchObject({ cluster: true, count: 1, databases: [{ db: 0, keys: 3 }] })
    serve({
      INFO: (a) => (String(a[0]) === 'keyspace' ? B('') : B('cluster_enabled:0\r\n')),
      CONFIG: () => { throw replyErr('NOPERM config') }
    })
    expect(await redis.listDatabases(ds())).toMatchObject({ cluster: false, count: null })
  })
  it('a failing INFO keyspace is an error', async () => {
    serve({ INFO: () => { throw replyErr('NOAUTH Authentication required.') } })
    await expect(redis.listDatabases(ds())).rejects.toThrow(/Authentication required/)
  })
})

describe('scanKeys', () => {
  /** SCAN pages: each call returns the next page; the types / ttls come from the pipeline. */
  function pages(...p: string[][]): void {
    let i = 0
    serve({
      SCAN: () => {
        const batch = p[i++] ?? []
        return [B(i >= p.length ? '0' : String(i)), batch.map(B)]
      },
      TYPE: (a) => (String(a[0]).startsWith('gone') ? B('none') : B(String(a[0]).startsWith('h:') ? 'hash' : 'string')),
      PTTL: (a) => (String(a[0]).endsWith('!') ? 4500 : -1)
    })
  }
  const scanCalls = (): unknown[][] => fakes().flatMap((c) => c.calls.filter(([n]) => n === 'SCAN').map(([, a]) => a))

  it('uses SCAN (never KEYS) with MATCH / COUNT and reports type + TTL', async () => {
    pages(['a', 'h:b', 'c!'])
    const r = await redis.scanKeys(ds(), 0, { pattern: 'user:*', count: 100 })
    expect(r).toEqual({
      keys: [{ key: 'a', type: 'string', ttl: -1 }, { key: 'h:b', type: 'hash', ttl: -1 }, { key: 'c!', type: 'string', ttl: 4500 }],
      cursor: null
    })
    expect(scanCalls()[0]).toEqual(['0', 'MATCH', 'user:*', 'COUNT', 100])
    expect(allCalls()).not.toContain('KEYS')
    expect(allCalls()).not.toContain('FLUSHDB')
  })
  it('a binary pattern (REDIS_BIN_PREFIX + base64) is decoded to the raw bytes for MATCH', async () => {
    pages(['a'])
    const raw = Buffer.from([0xff, 0xfe, 0x3a, 0x2a])
    await redis.scanKeys(ds(), 0, { pattern: '\u0000b64:' + raw.toString('base64') })
    const m = scanCalls()[0]
    expect(m.slice(0, 2)).toEqual(['0', 'MATCH'])
    expect(Buffer.isBuffer(m[2])).toBe(true)
    expect([...(m[2] as Buffer)]).toEqual([...raw])
  })
  it('no MATCH for * / empty; default and clamped COUNT', async () => {
    pages(['a'])
    await redis.scanKeys(ds(), 0)
    expect(scanCalls()[0]).toEqual(['0', 'COUNT', 500])
    pages(['a'])
    await redis.scanKeys(ds(), 0, { pattern: '*', count: 5_000_000 })
    expect(scanCalls()[1]).toEqual(['0', 'COUNT', 10_000])
    pages(['a'])
    await redis.scanKeys(ds(), 0, { pattern: '', count: 1 })
    expect(scanCalls()[2]).toEqual(['0', 'COUNT', 10])
  })
  it('keeps scanning until the limit is reached (soft cap) and returns the continuation cursor', async () => {
    pages(['a', 'b'], ['c', 'd'], ['e'])
    const r = await redis.scanKeys(ds(), 0, { limit: 3 })
    expect(r.keys.map((k) => k.key)).toEqual(['a', 'b', 'c', 'd']) // a reply is never split
    expect(r.cursor).toBe('2')
    pages(['x'], ['y'])
    expect((await redis.scanKeys(ds(), 0, { cursor: '2', limit: 1 })).cursor).toBe('1')
    expect(scanCalls().at(-1)![0]).toBe('2')
  })
  it('limit is clamped (1..5000)', async () => {
    pages(['a'], ['b'])
    expect((await redis.scanKeys(ds(), 0, { limit: -5 })).keys).toHaveLength(1)
    expect((await redis.scanKeys(ds(), 0, { limit: Number.NaN })).cursor).toBeNull()
  })
  it('keys that vanished between SCAN and TYPE are dropped; SCAN duplicates collapse', async () => {
    pages(['a', 'gone1', 'a'])
    expect((await redis.scanKeys(ds(), 0)).keys.map((k) => k.key)).toEqual(['a'])
  })
  it('type filter goes to SCAN TYPE; a server without it (Redis < 6) is filtered client-side', async () => {
    pages(['a', 'h:b'])
    await redis.scanKeys(ds(), 0, { type: 'Hash' })
    expect(scanCalls()[0]).toEqual(['0', 'COUNT', 500, 'TYPE', 'hash'])
    let first = true
    serve({
      SCAN: (a) => {
        if (first && (a as unknown[]).includes('TYPE')) { first = false; throw replyErr('ERR syntax error') }
        return [B('0'), [B('a'), B('h:b')]]
      },
      TYPE: (a) => B(String(a[0]).startsWith('h:') ? 'hash' : 'string'),
      PTTL: -1
    })
    const r = await redis.scanKeys(ds(), 0, { type: 'hash' })
    expect(r.keys.map((k) => k.key)).toEqual(['h:b'])
  })
  it('binary key names use the sentinel', async () => {
    serve({ SCAN: [B('0'), [Buffer.from([0xff, 0x01])]], TYPE: B('string'), PTTL: -1 })
    const r = await redis.scanKeys(ds(), 0)
    expect(r.keys[0].key).toBe(REDIS_BIN_PREFIX + Buffer.from([0xff, 0x01]).toString('base64'))
  })
  it('rejects bad input before touching the server', async () => {
    await expect(redis.scanKeys(ds(), 300)).rejects.toThrow(/Database must be/)
    await expect(redis.scanKeys(ds(), 0, { cursor: 'abc' })).rejects.toThrow(/Invalid cursor/)
    await expect(redis.scanKeys(ds(), 0, { cursor: '1; FLUSHALL' })).rejects.toThrow(/Invalid cursor/)
    await expect(redis.scanKeys(ds(), 0, { type: 'hash COUNT 5' })).rejects.toThrow(/Invalid key type/)
    await expect(redis.scanKeys(ds(), 0, { pattern: 'x'.repeat(redis.MAX_PATTERN_CHARS + 1) })).rejects.toThrow(/Pattern is too long/)
    expect(fakes()).toHaveLength(0)
  })
  it('server errors come back clean', async () => {
    serve({ SCAN: () => { throw replyErr('NOAUTH Authentication required.') } })
    await expect(redis.scanKeys(ds(), 0)).rejects.toThrow(/Authentication required/)
  })
})

describe('getKey', () => {
  const type = (t: string, extra: Record<string, unknown> = {}): void =>
    serve({ TYPE: B(t), PTTL: 90_000, MEMORY: 128, OBJECT: B('embstr'), ...extra })

  it('none: the key does not exist', async () => {
    serve({ TYPE: B('none'), PTTL: -2 })
    expect(await redis.getKey(ds(), 0, 'k')).toEqual({ key: 'k', type: 'none', ttl: -2, size: null, length: null, value: { kind: 'none' } })
  })
  it('string with metadata', async () => {
    type('string', { STRLEN: 5, GETRANGE: B('hello') })
    expect(await redis.getKey(ds(), 0, 'k')).toEqual({
      key: 'k', type: 'string', ttl: 90_000, size: 128, length: 5, encoding: 'embstr',
      value: { kind: 'string', text: 'hello', binary: false, base64: '', bytes: 5, truncated: false }
    })
  })
  it('empty string, binary string and a cut-off long string', async () => {
    type('string', { STRLEN: 0 })
    expect((await redis.getKey(ds(), 0, 'k')).value).toMatchObject({ text: '', binary: false, bytes: 0 })
    type('string', { STRLEN: 3, GETRANGE: Buffer.from([0xff, 0x00, 0x41]) })
    expect((await redis.getKey(ds(), 0, 'k')).value).toEqual({
      kind: 'string', text: '', binary: true, base64: Buffer.from([0xff, 0, 0x41]).toString('base64'), bytes: 3, truncated: false
    })
    // a cut in the middle of "é" must not turn the text into "binary"
    const cut = Buffer.concat([Buffer.alloc(redis.MAX_STRING_BYTES - 1, 0x61), Buffer.from('é').subarray(0, 1)])
    type('string', { STRLEN: redis.MAX_STRING_BYTES + 10, GETRANGE: cut })
    const v = (await redis.getKey(ds(), 0, 'k')).value
    expect(v).toMatchObject({ binary: false, truncated: true, bytes: redis.MAX_STRING_BYTES + 10 })
    expect((v as { text: string }).text).toHaveLength(redis.MAX_STRING_BYTES - 1)
    const range = fakes()[0].calls.find(([n]) => n === 'GETRANGE')![1]
    expect(range.slice(1)).toEqual([0, redis.MAX_STRING_BYTES - 1])
  })
  it('hash: HSCAN pages, field / value pairs', async () => {
    type('hash', { HLEN: 2, HSCAN: [B('0'), [B('f1'), B('v1'), B('f2'), B('v2')]] })
    const d = await redis.getKey(ds(), 0, 'h')
    expect(d.length).toBe(2)
    expect(d.value).toEqual({ kind: 'hash', items: [{ field: 'f1', value: 'v1' }, { field: 'f2', value: 'v2' }], next: null })
    type('hash', { HLEN: 9, HSCAN: [B('17'), [B('f'), B('v')]] })
    expect((await redis.getKey(ds(), 0, 'h', { limit: 1 })).value).toMatchObject({ next: '17' })
    expect(fakes().flatMap((c) => c.calls).filter(([n]) => n === 'HSCAN').at(-1)![1].slice(1)).toEqual(['0', 'COUNT', 1])
    expect(allCalls()).not.toContain('HGETALL')
  })
  it('set: SSCAN with repeats removed', async () => {
    type('set', { SCARD: 2, SSCAN: [B('0'), [B('a'), B('b'), B('a')]] })
    expect((await redis.getKey(ds(), 0, 's')).value).toEqual({ kind: 'set', items: ['a', 'b'], next: null })
  })
  it('list: LRANGE window and the next offset', async () => {
    type('list', { LLEN: 10, LRANGE: [B('x'), B('y')] })
    expect((await redis.getKey(ds(), 0, 'l', { offset: 4, limit: 2 })).value).toEqual({ kind: 'list', items: ['x', 'y'], offset: 4, next: 6 })
    expect(fakes()[0].calls.find(([n]) => n === 'LRANGE')![1].slice(1)).toEqual([4, 5])
    type('list', { LLEN: 2, LRANGE: [B('x'), B('y')] })
    expect((await redis.getKey(ds(), 0, 'l')).value).toMatchObject({ next: null })
  })
  it('zset: members with scores', async () => {
    type('zset', { ZCARD: 3, ZRANGE: [B('a'), B('1'), B('b'), B('2.5')] })
    expect((await redis.getKey(ds(), 0, 'z', { limit: 2 })).value).toEqual({
      kind: 'zset', items: [{ member: 'a', score: '1' }, { member: 'b', score: '2.5' }], offset: 0, next: 2
    })
  })
  it('stream: entries and the id to continue from', async () => {
    type('stream', {
      XLEN: 3,
      XRANGE: [[B('1-0'), [B('f'), B('v')]], [B('2-0'), [B('g'), B('w')]], [B('3-0'), []]]
    })
    expect((await redis.getKey(ds(), 0, 'x', { limit: 2 })).value).toEqual({
      kind: 'stream',
      entries: [{ id: '1-0', fields: [{ field: 'f', value: 'v' }] }, { id: '2-0', fields: [{ field: 'g', value: 'w' }] }],
      next: '3-0'
    })
    expect(fakes()[0].calls.find(([n]) => n === 'XRANGE')![1].slice(1)).toEqual(['-', '+', 'COUNT', 3])
    await redis.getKey(ds(), 0, 'x', { cursor: '2-0', limit: 2 })
    expect(fakes()[0].calls.filter(([n]) => n === 'XRANGE').at(-1)![1][1]).toBe('2-0')
  })
  it('module types are "unsupported"; MEMORY / OBJECT being denied is fine', async () => {
    type('ReJSON-RL', { MEMORY: () => { throw replyErr('NOPERM') }, OBJECT: () => { throw replyErr('NOPERM') } })
    expect(await redis.getKey(ds(), 0, 'j')).toEqual({
      key: 'j', type: 'ReJSON-RL', ttl: 90_000, size: null, length: null, value: { kind: 'unsupported', type: 'ReJSON-RL' }
    })
  })
  it('paging inputs are clamped; empty / oversized keys and bad db are rejected', async () => {
    type('list', { LLEN: 5, LRANGE: [] })
    await redis.getKey(ds(), 0, 'l', { offset: -3, limit: 99_999 })
    expect(fakes()[0].calls.find(([n]) => n === 'LRANGE')![1].slice(1)).toEqual([0, redis.MAX_PAGE_LIMIT - 1])
    await expect(redis.getKey(ds(), 0, '')).rejects.toThrow(/Key must not be empty/)
    await expect(redis.getKey(ds(), 0, 'k'.repeat(redis.MAX_KEY_BYTES + 1))).rejects.toThrow(/too long/)
    await expect(redis.getKey(ds(), 999, 'k')).rejects.toThrow(/Database must be/)
    await expect(redis.getKey(ds(), 0, 5 as never)).rejects.toThrow(/Key must not be empty/)
  })
  it('a binary key name is sent as the exact bytes', async () => {
    serve({ TYPE: B('none'), PTTL: -2 })
    const bytes = Buffer.from([0xff, 0xfe, 0x00])
    await redis.getKey(ds(), 0, redis.encodeName(bytes))
    expect(fakes()[0].calls[0][1][0]).toEqual(bytes)
  })
})

describe('setString', () => {
  it('replaces a string; KEEPTTL keeps the expiry', async () => {
    serve({ TYPE: B('string'), SET: B('OK') })
    await redis.setString(ds(), 0, 'k', 'v', { keepTtl: true })
    expect(fakes()[0].calls.at(-1)).toEqual(['SET', [B('k'), B('v'), 'KEEPTTL']])
    await redis.setString(ds(), 0, 'k', 'w')
    expect(fakes()[0].calls.at(-1)).toEqual(['SET', [B('k'), B('w')]])
  })
  it('servers without KEEPTTL: PTTL + SET + PEXPIRE', async () => {
    serve({
      TYPE: B('string'),
      PTTL: 5000,
      SET: (a) => { if ((a as unknown[]).includes('KEEPTTL')) throw replyErr('ERR syntax error'); return B('OK') }
    })
    await redis.setString(ds(), 0, 'k', 'v', { keepTtl: true })
    expect(allCalls().slice(-3)).toEqual(['PTTL', 'SET', 'PEXPIRE'])
    expect(fakes()[0].calls.at(-1)![1]).toEqual([B('k'), 5000])
  })
  it('refuses a missing key or another type (it would silently replace a hash)', async () => {
    serve({ TYPE: B('none') })
    await expect(redis.setString(ds(), 0, 'k', 'v')).rejects.toThrow(/no longer exists/)
    serve({ TYPE: B('hash') })
    await expect(redis.setString(ds(), 0, 'k', 'v')).rejects.toThrow(/holds a hash, not a string/)
    expect(allCalls()).not.toContain('SET')
  })
  it('validates the value', async () => {
    await expect(redis.setString(ds(), 0, 'k', 5 as never)).rejects.toThrow(/Value must be text/)
    await expect(redis.setString(ds(), 0, 'k', 'x'.repeat(redis.MAX_VALUE_BYTES + 1))).rejects.toThrow(/too large/)
  })
})

describe('setTtl', () => {
  it('EXPIRE with whole seconds; PERSIST with null', async () => {
    serve({ EXPIRE: 1, PERSIST: 1 })
    await redis.setTtl(ds(), 0, 'k', 90)
    expect(fakes()[0].calls.at(-1)).toEqual(['EXPIRE', [B('k'), 90]])
    await redis.setTtl(ds(), 0, 'k', null)
    expect(fakes()[0].calls.at(-1)).toEqual(['PERSIST', [B('k')]])
  })
  it('a missing key is an error; bad seconds are rejected', async () => {
    serve({ EXPIRE: 0 })
    await expect(redis.setTtl(ds(), 0, 'k', 5)).rejects.toThrow(/does not exist/)
    for (const s of [0, -1, 1.5, NaN, 4e9, '5' as never]) await expect(redis.setTtl(ds(), 0, 'k', s), String(s)).rejects.toThrow(/TTL must be/)
  })
})

describe('deleteKeys', () => {
  it('UNLINK in chunks; resolves with the number removed', async () => {
    serve({ UNLINK: (a) => (a as unknown[]).length })
    const keys = Array.from({ length: 1200 }, (_, i) => `k${i}`)
    expect(await redis.deleteKeys(ds(), 0, keys)).toBe(1200)
    expect(fakes()[0].calls.filter(([n]) => n === 'UNLINK').map(([, a]) => a.length)).toEqual([500, 500, 200])
  })
  it('falls back to DEL on servers without UNLINK', async () => {
    serve({ UNLINK: () => { throw replyErr("ERR unknown command 'UNLINK'") }, DEL: 2 })
    expect(await redis.deleteKeys(ds(), 0, ['a', 'b'])).toBe(2)
  })
  it('nothing to delete = 0 and no connection; too many keys are refused', async () => {
    expect(await redis.deleteKeys(ds(), 0, [])).toBe(0)
    expect(fakes()).toHaveLength(0)
    await expect(redis.deleteKeys(ds(), 0, Array(redis.MAX_DELETE_KEYS + 1).fill('k'))).rejects.toThrow(/Too many keys/)
    await expect(redis.deleteKeys(ds(), 0, ['ok', ''])).rejects.toThrow(/Key must not be empty/)
  })
  it('there is no flush anywhere in the module surface', () => {
    expect(Object.keys(redis).filter((k) => /flush/i.test(k))).toEqual([])
  })
})

describe('renameKey', () => {
  it('RENAMENX; a taken name is reported and nothing is overwritten', async () => {
    serve({ RENAMENX: 1 })
    await redis.renameKey(ds(), 0, 'a', 'b')
    expect(fakes()[0].calls.at(-1)).toEqual(['RENAMENX', [B('a'), B('b')]])
    serve({ RENAMENX: 0 })
    await expect(redis.renameKey(ds(), 0, 'a', 'b')).rejects.toThrow(/already exists.*not overwritten/)
    expect(allCalls()).not.toContain('RENAME')
  })
  it('missing source, same name, empty name', async () => {
    serve({ RENAMENX: () => { throw replyErr('ERR no such key') } })
    await expect(redis.renameKey(ds(), 0, 'a', 'b')).rejects.toThrow(/does not exist/)
    await expect(redis.renameKey(ds(), 0, 'a', 'a')).rejects.toThrow(/same as the current/)
    await expect(redis.renameKey(ds(), 0, 'a', '')).rejects.toThrow(/New key must not be empty/)
  })
})

describe('createKey', () => {
  it('string: SET NX (+ EX); an existing key is a clear error', async () => {
    serve({ SET: B('OK') })
    await redis.createKey(ds(), 0, 'k', { type: 'string', value: 'v' }, { ttl: 60 })
    expect(fakes()[0].calls.at(-1)).toEqual(['SET', [B('k'), B('v'), 'NX', 'EX', 60]])
    await redis.createKey(ds(), 0, 'k', { type: 'string', value: 'v' })
    expect(fakes()[0].calls.at(-1)![1]).toEqual([B('k'), B('v'), 'NX'])
    serve({ SET: null })
    await expect(redis.createKey(ds(), 0, 'k', { type: 'string', value: 'v' })).rejects.toThrow(/already exists/)
  })
  it.each([
    [{ type: 'hash', field: 'f', value: 'v' }, 'HSET', [B('k'), B('f'), B('v')]],
    [{ type: 'list', value: 'v' }, 'RPUSH', [B('k'), B('v')]],
    [{ type: 'set', member: 'm' }, 'SADD', [B('k'), B('m')]],
    [{ type: 'zset', member: 'm', score: '1.5' }, 'ZADD', [B('k'), '1.5', B('m')]]
  ] as const)('%j: check-then-write with %s, then EXPIRE', async (spec, cmd, args) => {
    serve({ EXISTS: 0, [cmd]: 1, EXPIRE: 1 })
    await redis.createKey(ds(), 0, 'k', spec as never, { ttl: 30 })
    const calls = fakes()[0].calls.map(([n]) => n)
    expect(calls).toEqual(['EXISTS', cmd, 'EXPIRE'])
    expect(fakes()[0].calls[1][1]).toEqual(args)
  })
  it('an existing non-string key is refused before writing', async () => {
    serve({ EXISTS: 1 })
    await expect(redis.createKey(ds(), 0, 'k', { type: 'set', member: 'm' })).rejects.toThrow(/already exists/)
    expect(allCalls()).not.toContain('SADD')
  })
  it('validation: ttl, score, type, empty names', async () => {
    await expect(redis.createKey(ds(), 0, 'k', { type: 'string', value: 'v' }, { ttl: 0 })).rejects.toThrow(/TTL must be/)
    serve({ EXISTS: 0 })
    await expect(redis.createKey(ds(), 0, 'k', { type: 'zset', member: 'm', score: 'abc' })).rejects.toThrow(/not a valid score/)
    await expect(redis.createKey(ds(), 0, 'k', { type: 'zset', member: 'm', score: '' })).rejects.toThrow(/not a valid score/)
    await expect(redis.createKey(ds(), 0, 'k', { type: 'hash', field: '', value: 'v' })).rejects.toThrow(/Field must not be empty/)
    await expect(redis.createKey(ds(), 0, 'k', { type: 'stream' } as never)).rejects.toThrow(/Only string, hash, list, set and zset/)
    await expect(redis.createKey(ds(), 0, '', { type: 'string', value: 'v' })).rejects.toThrow(/Key must not be empty/)
  })
  it('zset accepts inf scores', async () => {
    serve({ EXISTS: 0, ZADD: 1 })
    await redis.createKey(ds(), 0, 'k', { type: 'zset', member: 'm', score: '+inf' })
    expect(fakes()[0].calls[1][1][1]).toBe('inf')
  })
})

describe('itemOp', () => {
  const run = async (op: Parameters<typeof redis.itemOp>[3], reply: number | object | string = 1): Promise<[string, unknown[]]> => {
    serve({ [{ hset: 'HSET', hdel: 'HDEL', lset: 'LSET', lpush: 'LPUSH', rpush: 'RPUSH', lrem: 'LREM', sadd: 'SADD', srem: 'SREM', zadd: 'ZADD', zrem: 'ZREM' }[op.op]]: reply })
    await redis.itemOp(ds(), 0, 'k', op)
    return fakes().at(-1)!.calls.at(-1)!
  }
  it('sends the matching command with exact bytes', async () => {
    expect(await run({ op: 'hset', field: 'f', value: 'v' })).toEqual(['HSET', [B('k'), B('f'), B('v')]])
    expect(await run({ op: 'hdel', field: 'f' })).toEqual(['HDEL', [B('k'), B('f')]])
    expect(await run({ op: 'lset', index: 2, value: 'v' }, B('OK'))).toEqual(['LSET', [B('k'), 2, B('v')]])
    expect(await run({ op: 'lpush', value: 'v' })).toEqual(['LPUSH', [B('k'), B('v')]])
    expect(await run({ op: 'rpush', value: 'v' })).toEqual(['RPUSH', [B('k'), B('v')]])
    expect(await run({ op: 'lrem', value: 'v' })).toEqual(['LREM', [B('k'), 1, B('v')]])
    expect(await run({ op: 'lrem', value: 'v', count: 0 })).toEqual(['LREM', [B('k'), 0, B('v')]])
    expect(await run({ op: 'sadd', member: 'm' })).toEqual(['SADD', [B('k'), B('m')]])
    expect(await run({ op: 'srem', member: 'm' })).toEqual(['SREM', [B('k'), B('m')]])
    expect(await run({ op: 'zadd', member: 'm', score: ' 2.5 ' })).toEqual(['ZADD', [B('k'), '2.5', B('m')]])
    expect(await run({ op: 'zrem', member: 'm' })).toEqual(['ZREM', [B('k'), B('m')]])
  })
  it('binary values pass through as the exact bytes; empty values are allowed, empty fields / members are not for fields', async () => {
    const bytes = Buffer.from([0xff, 0x00])
    expect(await run({ op: 'hset', field: 'f', value: redis.encodeName(bytes) })).toEqual(['HSET', [B('k'), B('f'), bytes]])
    expect(await run({ op: 'rpush', value: '' })).toEqual(['RPUSH', [B('k'), Buffer.alloc(0)]])
    await expect(redis.itemOp(ds(), 0, 'k', { op: 'hset', field: '', value: 'v' })).rejects.toThrow(/Field must not be empty/)
  })
  it('resolves with the number the server reports', async () => {
    serve({ HDEL: 3 })
    expect(await redis.itemOp(ds(), 0, 'k', { op: 'hdel', field: 'f' })).toBe(3)
  })
  it('rejects malformed operations', async () => {
    await expect(redis.itemOp(ds(), 0, 'k', { op: 'lset', index: -1, value: 'v' })).rejects.toThrow(/Invalid list index/)
    await expect(redis.itemOp(ds(), 0, 'k', { op: 'lset', index: 1.5, value: 'v' })).rejects.toThrow(/Invalid list index/)
    await expect(redis.itemOp(ds(), 0, 'k', { op: 'lrem', value: 'v', count: 1.5 })).rejects.toThrow(/Invalid count/)
    await expect(redis.itemOp(ds(), 0, 'k', { op: 'zadd', member: 'm', score: 'nan' })).rejects.toThrow(/not a valid score/)
    await expect(redis.itemOp(ds(), 0, 'k', { op: 'flushall' } as never)).rejects.toThrow(/Unknown operation/)
    await expect(redis.itemOp(ds(), 0, 'k', null as never)).rejects.toThrow(/Invalid operation/)
    expect(allCalls()).not.toContain('FLUSHALL')
  })
  it('a WRONGTYPE from the server is explained', async () => {
    serve({ HSET: () => { throw replyErr('WRONGTYPE Operation against a key holding the wrong kind of value') } })
    await expect(redis.itemOp(ds(), 0, 'k', { op: 'hset', field: 'f', value: 'v' })).rejects.toThrow(/Wrong type/)
  })
})

describe('runCommands (console)', () => {
  it('runs one command per line on the console connection, with redis-cli quoting and normalised replies', async () => {
    serve({ SET: B('OK'), GET: B('hello world'), LRANGE: [B('a'), null, 3] })
    const r = await redis.runCommands(ds(), 2, 'SET k "hello world"\n\n# a comment\nget k\nlrange l 0 -1')
    expect(r.results.map((e) => [e.line, e.command, e.reply])).toEqual([
      ['SET k "hello world"', 'SET', { kind: 'status', value: 'OK' }],
      ['get k', 'GET', { kind: 'bulk', value: 'hello world' }],
      ['lrange l 0 -1', 'LRANGE', { kind: 'array', items: [{ kind: 'bulk', value: 'a' }, { kind: 'nil' }, { kind: 'integer', value: 3 }] }]
    ])
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    const c = fakes().find((x) => x.calls.some(([n]) => n === 'SET'))!
    expect(c.calls.filter(([n]) => n !== 'SELECT')[0]).toEqual(['SET', [B('k'), B('hello world')]])
    expect(c.calls[0]).toEqual(['SELECT', [2]]) // the console's own connection is on the right db
    expect(fakes()).toHaveLength(1)
  })
  it('stops at the first error; a server error is a reply, not an exception', async () => {
    serve({ GET: () => { throw replyErr('WRONGTYPE Operation against a key holding the wrong kind of value') }, PING: B('PONG') })
    const r = await redis.runCommands(ds(), 0, 'GET k\nPING')
    expect(r.results).toHaveLength(1)
    expect(r.results[0].reply).toEqual({ kind: 'error', message: 'WRONGTYPE Operation against a key holding the wrong kind of value' })
  })
  it('blocking / push / SELECT / MULTI commands are refused without being sent', async () => {
    for (const line of ['BLPOP l 0', 'SUBSCRIBE c', 'SELECT 1', 'MULTI', 'MONITOR']) {
      const r = await redis.runCommands(ds(), 0, 'PING\n' + line)
      expect(r.results[1].reply.kind).toBe('error')
      expect(fakes().flatMap((c) => c.calls.map(([n]) => n))).not.toContain(line.split(' ')[0])
      await redis.closeAll()
      h.clients.length = 0
    }
  })
  it('unbalanced quotes are an error reply on that line', async () => {
    serve({ PING: B('PONG') })
    const r = await redis.runCommands(ds(), 0, 'PING\nSET k "oops')
    expect(r.results).toHaveLength(2)
    expect(r.results[1].reply).toMatchObject({ kind: 'error', message: expect.stringMatching(/Unbalanced quotes/) })
  })
  it('a connection failure is a clean error reply', async () => {
    h.connectError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const r = await redis.runCommands(ds(), 0, 'PING')
    expect(r.results[0].reply).toMatchObject({ kind: 'error', message: expect.stringMatching(/connection refused/) })
  })
  it('input limits', async () => {
    await expect(redis.runCommands(ds(), 0, '   \n# nothing')).rejects.toThrow(/Nothing to run/)
    await expect(redis.runCommands(ds(), 0, 'PING\n'.repeat(1001))).rejects.toThrow(/Too many commands/)
    await expect(redis.runCommands(ds(), 0, 'x'.repeat(1_048_577))).rejects.toThrow(/too large/)
    await expect(redis.runCommands(ds(), 300, 'PING')).rejects.toThrow(/Database must be/)
    await expect(redis.runCommands(ds(), 0, 5 as never)).rejects.toThrow(/too large|Nothing to run/)
  })
})

describe('keyTree (explorer)', () => {
  /** A keyspace of `names` served in SCAN pages of `per` keys; TYPE comes from `typeOf` (default: by prefix). */
  function keyspace(names: string[], per = 1000, typeOf: (k: string) => string = (k) => (k.startsWith('h:') ? 'hash' : k.startsWith('l:') ? 'list' : 'string')): void {
    serve({
      DBSIZE: () => names.length,
      SCAN: (a) => {
        const at = Number(String(a[0]))
        const next = at + per
        return [B(next >= names.length ? '0' : String(next)), names.slice(at, next).map(B)]
      },
      TYPE: (a) => (String(a[0]).startsWith('gone') ? B('none') : B(typeOf(String(a[0]))))
    })
  }
  const calls = (name: string): unknown[][] => fakes().flatMap((c) => c.calls.filter(([n]) => n === name).map(([, a]) => a))

  it('reads every key with its type using SCAN (never KEYS) and reports dbsize', async () => {
    keyspace(['a', 'h:b', 'l:c', 'd'])
    const r = await redis.keyTree(ds(), 0)
    expect(r).toEqual({
      keys: [{ key: 'a', type: 'string' }, { key: 'h:b', type: 'hash' }, { key: 'l:c', type: 'list' }, { key: 'd', type: 'string' }],
      complete: true,
      dbsize: 4
    })
    expect(allCalls()).not.toContain('KEYS')
    expect(allCalls().filter((c) => !['SELECT', 'DBSIZE', 'SCAN', 'TYPE'].includes(c))).toEqual([])
  })

  it('SCAN COUNT 1000 with no MATCH, following the cursor to its end', async () => {
    keyspace(Array.from({ length: 2500 }, (_, i) => 'k' + i))
    const r = await redis.keyTree(ds(), 0)
    expect(r.keys).toHaveLength(2500)
    expect(r.complete).toBe(true)
    expect(calls('SCAN')).toEqual([['0', 'COUNT', 1000], ['1000', 'COUNT', 1000], ['2000', 'COUNT', 1000]])
  })

  it('pipelines the TYPE lookups: one batch per SCAN page, not a round trip per key', async () => {
    keyspace(Array.from({ length: 2500 }, (_, i) => 'k' + i))
    const spy: number[] = []
    const real = h.handler
    let inBatch = 0
    h.handler = (cmd, args, client) => {
      if (cmd === 'TYPE') inBatch++
      else if (inBatch) { spy.push(inBatch); inBatch = 0 }
      return real(cmd, args, client)
    }
    await redis.keyTree(ds(), 0)
    spy.push(inBatch)
    expect(spy).toEqual([1000, 1000, 500])
    // TYPE was sent through pipelines (exec), never through callBuffer one by one
    expect(fakes()[0].calls.filter(([n]) => n === 'TYPE')).toHaveLength(2500)
  })

  it('SELECTs the requested database', async () => {
    keyspace(['a'])
    await redis.keyTree(ds(), 5)
    expect(calls('SELECT')).toEqual([[5]])
  })

  it('caps the result at max and says it is incomplete (the cap lands mid-page)', async () => {
    keyspace(Array.from({ length: 2500 }, (_, i) => 'k' + i))
    const r = await redis.keyTree(ds(), 0, { max: 1500 })
    expect(r.keys).toHaveLength(1500)
    expect(r.keys[1499].key).toBe('k1499')
    expect(r.complete).toBe(false)
    expect(r.dbsize).toBe(2500)
    expect(calls('SCAN')).toHaveLength(2) // stopped as soon as the cap was hit
  })

  it('exactly max keys and nothing more is still complete', async () => {
    keyspace(['a', 'b', 'c'])
    const r = await redis.keyTree(ds(), 0, { max: 3 })
    expect(r).toMatchObject({ complete: true })
    expect(r.keys).toHaveLength(3)
  })

  it('the cap falls on a page boundary with more keys left: incomplete', async () => {
    keyspace(Array.from({ length: 2000 }, (_, i) => 'k' + i))
    const r = await redis.keyTree(ds(), 0, { max: 1000 })
    expect(r.keys).toHaveLength(1000)
    expect(r.complete).toBe(false)
  })

  it.each([
    [undefined, 100_000],
    [0, 1],
    [-5, 1],
    [NaN, 100_000],
    [1e9, 100_000],
    ['7', 100_000], // not a number: the default
    [2.9, 2]
  ])('max %j is clamped to 1..100000 (here %j)', async (max, expected) => {
    keyspace(Array.from({ length: 150_000 }, (_, i) => 'k' + i), 10_000)
    const r = await redis.keyTree(ds(), 0, { max: max as number })
    expect(r.keys.length).toBe(Math.min(expected, 150_000))
    expect(r.complete).toBe(false)
  })

  it('never returns more than 100,000 keys, whatever is asked', async () => {
    keyspace(Array.from({ length: 120_000 }, (_, i) => 'k' + i), 10_000)
    const r = await redis.keyTree(ds(), 0, { max: Number.MAX_SAFE_INTEGER })
    expect(r.keys).toHaveLength(100_000)
    expect(r.complete).toBe(false)
    expect(r.dbsize).toBe(120_000)
  })

  it('maps types: unknown / module types become "other", every core type is kept', async () => {
    keyspace(['s', 'l', 'e', 'z', 'h', 'x', 'm'], 1000, (k) => ({ s: 'string', l: 'list', e: 'set', z: 'zset', h: 'hash', x: 'stream', m: 'ReJSON-RL' })[k]!)
    const r = await redis.keyTree(ds(), 0)
    expect(r.keys.map((k) => k.type)).toEqual(['string', 'list', 'set', 'zset', 'hash', 'stream', 'other'])
  })

  it('treeType: case-insensitive, none / empty are gone', () => {
    expect(redis.treeType('STRING')).toBe('string')
    expect(redis.treeType('none')).toBeNull()
    expect(redis.treeType('')).toBeNull()
    expect(redis.treeType('weird')).toBe('other')
  })

  it('a key that vanished between SCAN and TYPE is dropped', async () => {
    keyspace(['a', 'gone1', 'b'])
    const r = await redis.keyTree(ds(), 0)
    expect(r.keys.map((k) => k.key)).toEqual(['a', 'b'])
    expect(r.complete).toBe(true)
  })

  it('a failing TYPE for one key does not fail the tree (that key is skipped)', async () => {
    serve({
      DBSIZE: 3,
      SCAN: () => [B('0'), [B('a'), B('bad'), B('c')]],
      TYPE: (a) => {
        if (String(a[0]) === 'bad') throw replyErr('WRONGTYPE nope')
        return B('string')
      }
    })
    const r = await redis.keyTree(ds(), 0)
    expect(r.keys.map((k) => k.key)).toEqual(['a', 'c'])
  })

  it('SCAN may repeat a key: it is listed once', async () => {
    let i = 0
    serve({
      DBSIZE: 2,
      SCAN: () => [B(++i < 3 ? String(i) : '0'), [B('a'), B('b')].slice(0, i === 2 ? 2 : 1)],
      TYPE: B('string')
    })
    const r = await redis.keyTree(ds(), 0)
    expect(r.keys.map((k) => k.key)).toEqual(['a', 'b'])
    expect(calls('TYPE')).toHaveLength(2) // the repeats were not even asked about
  })

  it('binary key names stay encoded; text that looks like the sentinel too', async () => {
    const bin = Buffer.from([0xff, 0x00, 0x41])
    serve({ DBSIZE: 2, SCAN: () => [B('0'), [bin, B('plain')]], TYPE: B('string') })
    const r = await redis.keyTree(ds(), 0)
    expect(r.keys[0].key).toBe(REDIS_BIN_PREFIX + bin.toString('base64'))
    expect(r.keys[1].key).toBe('plain')
    // TYPE was asked about the raw bytes
    expect(calls('TYPE')[0][0]).toEqual(bin)
  })

  it('an empty database is complete with no keys', async () => {
    keyspace([])
    expect(await redis.keyTree(ds(), 0)).toEqual({ keys: [], complete: true, dbsize: 0 })
  })

  it('a newer scan of the same database supersedes the older one (which ends early, incomplete)', async () => {
    const names = Array.from({ length: 5000 }, (_, i) => 'k' + i)
    keyspace(names)
    const real = h.handler
    let first = true
    let second: Promise<unknown> | null = null
    h.handler = (cmd, args, client) => {
      // while the first scan is on its first SCAN, start a second one
      if (cmd === 'SCAN' && first) {
        first = false
        second = redis.keyTree(ds(), 0)
      }
      return real(cmd, args, client)
    }
    const a = await redis.keyTree(ds(), 0)
    const b = (await second) as unknown as Awaited<ReturnType<typeof redis.keyTree>>
    expect(a.complete).toBe(false)
    expect(a.keys.length).toBeLessThan(5000)
    expect(b.complete).toBe(true)
    expect(b.keys).toHaveLength(5000)
  })

  it('cancelKeyTree stops a running scan', async () => {
    keyspace(Array.from({ length: 5000 }, (_, i) => 'k' + i))
    const real = h.handler
    let n = 0
    h.handler = (cmd, args, client) => {
      if (cmd === 'SCAN' && ++n === 2) redis.cancelKeyTree(ds(), 0)
      return real(cmd, args, client)
    }
    const r = await redis.keyTree(ds(), 0)
    expect(r.complete).toBe(false)
    expect(calls('SCAN').length).toBeLessThan(5)
  })

  it('cancelling database 1 does not stop a scan of database 0, nor another data source', async () => {
    keyspace(Array.from({ length: 3000 }, (_, i) => 'k' + i))
    const real = h.handler
    h.handler = (cmd, args, client) => {
      if (cmd === 'SCAN') {
        redis.cancelKeyTree(ds(), 1)
        redis.cancelKeyTree(ds({}, 'other'), 0)
      }
      return real(cmd, args, client)
    }
    const r = await redis.keyTree(ds(), 0)
    expect(r.complete).toBe(true)
    expect(r.keys).toHaveLength(3000)
  })

  it('validates the database index', async () => {
    await expect(redis.keyTree(ds(), 256)).rejects.toThrow(/Database must be/)
    await expect(redis.keyTree(ds(), -1)).rejects.toThrow(/Database must be/)
    expect(() => redis.cancelKeyTree(ds(), 999)).toThrow(/Database must be/)
  })

  it('a connection failure is a clean error', async () => {
    h.connectError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    await expect(redis.keyTree(ds(), 0)).rejects.toThrow(/connection refused/)
  })

  it('a SCAN error is a clean error (no password in it)', async () => {
    serve({ DBSIZE: 1, SCAN: () => { throw replyErr('NOAUTH Authentication required.') } })
    await expect(redis.keyTree(ds({ password: 'sup3rs3cret' }), 0)).rejects.toThrow(/Authentication required/)
    await redis.keyTree(ds({ password: 'sup3rs3cret' }), 0).catch((e: Error) => expect(e.message).not.toContain('sup3rs3cret'))
  })

  it('closeAll cancels a scan in flight', async () => {
    keyspace(Array.from({ length: 5000 }, (_, i) => 'k' + i))
    const real = h.handler
    let n = 0
    h.handler = (cmd, args, client) => {
      if (cmd === 'SCAN' && ++n === 2) void redis.closeAll()
      return real(cmd, args, client)
    }
    const r = await redis.keyTree(ds(), 0).catch(() => ({ complete: false }))
    expect(r.complete).toBe(false)
  })

  it('never writes: only SELECT / DBSIZE / SCAN / TYPE are ever sent', async () => {
    keyspace(Array.from({ length: 2500 }, (_, i) => 'k' + i))
    await redis.keyTree(ds(), 3, { max: 2000 })
    expect(new Set(allCalls())).toEqual(new Set(['SELECT', 'DBSIZE', 'SCAN', 'TYPE']))
  })
})

describe('secrets', () => {
  it('the password is only ever handed to the client options, never in an error message or result', async () => {
    h.connectError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const d = ds({ password: 'sup3rs3cret' })
    const msgs: string[] = []
    for (const fn of [() => redis.testConnection(d), () => redis.listDatabases(d), () => redis.scanKeys(d, 0), () => redis.getKey(d, 0, 'k')]) {
      msgs.push(await fn().then(() => '', (e: Error) => e.message))
    }
    const r = await redis.runCommands(d, 0, 'PING')
    msgs.push(JSON.stringify(r))
    expect(msgs.every((m) => m && !m.includes('sup3rs3cret'))).toBe(true)
  })
})
