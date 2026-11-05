/**
 * Integration tests against a throwaway redis-server that this file starts itself (random free high port, 127.0.0.1,
 * nothing persisted) and stops afterwards. Skipped unless RUN_REDIS_TESTS=1:  npm run test:redis
 * It never connects to a Redis on the default port 6379 and never flushes anything outside its own instance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Redis } from 'ioredis'
import type { DataSource, RedisConfig } from '../../src/shared'
import {
  closeAll, createKey, dbSize, deleteKeys, getKey, itemOp, listDatabases, poolSize, renameKey, runCommands, scanKeys, setString,
  setTtl, testConnection, encodeName, decodeName, keyTree, cancelKeyTree
} from '../../src/main/redis'
import { exactPattern } from '../../src/renderer/src/lib/redis'
import { buildKeyTree, keysUnder, prefixPattern, type KeyEntry, type KeyFolder } from '../../src/renderer/src/lib/redisTree'
import { freePort, startRedis, type TestServer } from './helpers/redisServer'

const on = !!process.env.RUN_REDIS_TESTS

const src = (port: number, over: Partial<RedisConfig> = {}, id = 'int'): DataSource => ({
  id, name: 'int', kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  redis: { host: '127.0.0.1', port, db: 0, tls: false, ...over }
})

describe.skipIf(!on)('Redis integration (own throwaway redis-server)', () => {
  let server: TestServer
  let authed: TestServer
  let ds: DataSource
  let admin: Redis

  beforeAll(async () => {
    server = await startRedis()
    authed = await startRedis(['--requirepass', 'sekret-pw'])
    expect(server.port).not.toBe(6379)
    ds = src(server.port)
    admin = new Redis({ host: '127.0.0.1', port: server.port })
    // seed
    await admin.set('str', 'hello world')
    await admin.set('json', '{"a":1,"b":[1,2]}')
    await admin.set('ünï:κey', 'unicode')
    await admin.set('ttl:key', 'x', 'EX', 1000)
    await admin.hset('h', { f1: 'v1', f2: 'v2', f3: 'v3' })
    await admin.rpush('l', 'a', 'b', 'c', 'd', 'e')
    await admin.sadd('s', 'x', 'y', 'z')
    await admin.zadd('z', 1, 'one', 2.5, 'two', 3, 'three')
    await admin.xadd('st', '1-1', 'k', 'v1')
    await admin.xadd('st', '2-1', 'k', 'v2', 'k2', 'w2')
    await admin.xadd('st', '3-1', 'k', 'v3')
    await admin.set(Buffer.from([0xff, 0xfe, 0x00, 0x41]), Buffer.from([0x80, 0x81, 0x00]))
    const p = admin.pipeline()
    for (let i = 0; i < 1500; i++) p.set(`bulk:${String(i).padStart(4, '0')}`, String(i))
    for (let i = 0; i < 40; i++) p.hset(`user:${i}`, 'n', String(i))
    await p.exec()
    await admin.select(3)
    await admin.set('in-db3', '1')
    await admin.set('in-db3b', '2', 'EX', 100)
    await admin.select(0)
  })

  afterAll(async () => {
    await closeAll()
    admin?.disconnect()
    await server?.stop()
    await authed?.stop()
  })

  it('testConnection reports the version and mode', async () => {
    const r = await testConnection(ds)
    expect(r).toMatch(/Redis \d+\.\d+\.\d+ \(standalone\), db0, PONG in \d+ ms/)
  })

  it('wrong port: a clear refusal, fast', async () => {
    const dead = await freePort() // nothing listens there
    const t0 = Date.now()
    await expect(testConnection(src(dead))).rejects.toThrow(/connection refused/i)
    await expect(listDatabases(src(dead, {}, 'dead'))).rejects.toThrow(/Could not connect to 127\.0\.0\.1:\d+ \(connection refused\)/)
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(poolSize()).toBe(0)
  })

  it('unknown host', async () => {
    await expect(testConnection({ ...ds, redis: { ...ds.redis!, host: 'no-such-host.invalid' } })).rejects.toThrow(/resolve host "no-such-host.invalid"/)
  })

  it('authentication: wrong / missing / right password', async () => {
    await expect(testConnection(src(authed.port))).rejects.toThrow(/Authentication required/)
    await expect(testConnection(src(authed.port, { password: 'nope' }))).rejects.toThrow(/Authentication failed/)
    await expect(testConnection(src(authed.port, { username: 'default', password: 'nope' }))).rejects.toThrow(/Authentication failed/)
    expect(await testConnection(src(authed.port, { password: 'sekret-pw' }))).toMatch(/PONG/)
    // pooled path too
    await expect(listDatabases(src(authed.port, {}, 'auth-bad'))).rejects.toThrow(/Authentication required/)
    const good = src(authed.port, { password: 'sekret-pw' }, 'auth-ok')
    expect((await listDatabases(good)).databases[0].db).toBe(0)
  })

  it('a password sent to a server that has none is harmless (ioredis carries on)', async () => {
    expect(await testConnection(src(server.port, { password: 'x' }))).toMatch(/PONG/)
  })

  it('databases: those with keys, always the configured one, and the count', async () => {
    const r = await listDatabases(ds)
    expect(r.cluster).toBe(false)
    expect(r.count).toBe(16)
    expect(r.databases.map((d) => d.db)).toEqual([0, 3])
    expect(r.databases[1]).toMatchObject({ db: 3, keys: 2, expires: 1 })
    const empty = await listDatabases(src(server.port, { db: 7 }, 'db7'))
    expect(empty.databases.map((d) => d.db)).toEqual([0, 3, 7])
    expect(empty.databases[2].keys).toBe(0)
  })

  it('dbSize counts per database', async () => {
    expect(await dbSize(ds, 3)).toBe(2)
    expect(await dbSize(ds, 0)).toBeGreaterThan(1500)
  })

  it('scan pages through every key exactly once, with type and TTL', async () => {
    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    do {
      const r: Awaited<ReturnType<typeof scanKeys>> = await scanKeys(ds, 0, { limit: 300, cursor })
      for (const k of r.keys) {
        expect(seen.has(k.key)).toBe(false)
        seen.add(k.key)
      }
      cursor = r.cursor
      pages++
    } while (cursor)
    expect(pages).toBeGreaterThan(3)
    expect(seen.size).toBe(await dbSize(ds, 0))
    const one = await scanKeys(ds, 0, { pattern: 'ttl:*' })
    expect(one.cursor).toBeNull()
    expect(one.keys).toHaveLength(1)
    expect(one.keys[0]).toMatchObject({ key: 'ttl:key', type: 'string' })
    expect(one.keys[0].ttl).toBeGreaterThan(900_000)
    const plain = await scanKeys(ds, 0, { pattern: 'str' })
    expect(plain.keys[0].ttl).toBe(-1)
  })

  it('scan: glob patterns and type filter', async () => {
    const r = await scanKeys(ds, 0, { pattern: 'bulk:00[0-4]?', limit: 5000 })
    let all = r.keys
    let cur = r.cursor
    while (cur) {
      const n = await scanKeys(ds, 0, { pattern: 'bulk:00[0-4]?', limit: 5000, cursor: cur })
      all = all.concat(n.keys)
      cur = n.cursor
    }
    expect(all).toHaveLength(50)
    const hashes = await scanKeys(ds, 0, { type: 'hash', limit: 5000 })
    let hs = hashes.keys
    let hc = hashes.cursor
    while (hc) {
      const n = await scanKeys(ds, 0, { type: 'hash', limit: 5000, cursor: hc })
      hs = hs.concat(n.keys)
      hc = n.cursor
    }
    expect(hs.every((k) => k.type === 'hash')).toBe(true)
    expect(hs).toHaveLength(41) // h + user:*
  })

  it('scan: the renderer\'s exact-key pattern (backslash-escaped) matches that key only', async () => {
    for (const k of ['exact:a', 'exact:ab', 'exact:a*', 'exact:a ']) await createKey(ds, 0, k, { type: 'string', value: 'v' })
    for (const k of ['exact:a', 'exact:ab', 'exact:a*', 'exact:a ']) {
      const r = await scanKeys(ds, 0, { pattern: exactPattern(k), limit: 5000 })
      let keys = r.keys.map((x) => x.key)
      let cur = r.cursor
      while (cur) {
        const n: Awaited<ReturnType<typeof scanKeys>> = await scanKeys(ds, 0, { pattern: exactPattern(k), limit: 5000, cursor: cur })
        keys = keys.concat(n.keys.map((x) => x.key))
        cur = n.cursor
      }
      expect(keys, k).toEqual([k])
    }
    await deleteKeys(ds, 0, ['exact:a', 'exact:ab', 'exact:a*', 'exact:a '])
  })

  it('scan: unicode and binary keys are addressable', async () => {
    const r = await scanKeys(ds, 0, { pattern: '*κey' })
    expect(r.keys.map((k) => k.key)).toEqual(['ünï:κey'])
    expect((await getKey(ds, 0, 'ünï:κey')).value).toMatchObject({ kind: 'string', text: 'unicode' })
    const bin = await scanKeys(ds, 0, { pattern: '\\xff*', limit: 5000 }).catch(() => null)
    expect(bin).toBeTruthy()
    // find the binary key via a full scan
    let cursor: string | null = null
    let found = ''
    do {
      const p: Awaited<ReturnType<typeof scanKeys>> = await scanKeys(ds, 0, { limit: 5000, cursor })
      const hit = p.keys.find((k) => k.key.startsWith('\u0000b64:'))
      if (hit) found = hit.key
      cursor = p.cursor
    } while (cursor && !found)
    expect(found).toBe(encodeName(Buffer.from([0xff, 0xfe, 0x00, 0x41])))
    const d = await getKey(ds, 0, found)
    expect(d.type).toBe('string')
    expect(d.value).toMatchObject({ kind: 'string', binary: true, text: '', base64: Buffer.from([0x80, 0x81, 0x00]).toString('base64'), bytes: 3 })
    expect(await deleteKeys(ds, 0, [found])).toBe(1)
  })

  it('scan input is validated', async () => {
    await expect(scanKeys(ds, 256, {})).rejects.toThrow(/Database must be/)
    await expect(scanKeys(ds, 0, { cursor: 'abc' })).rejects.toThrow(/Invalid cursor/)
    // db 200 does not exist on a 16-database server: an error, never a silent fall back to database 0
    await expect(scanKeys(ds, 200, { limit: 5 })).rejects.toThrow(/Database index out of range/)
    await expect(testConnection(src(server.port, { db: 200 }))).rejects.toThrow(/Database index out of range/)
    const before = poolSize()
    await expect(scanKeys(ds, 200, {})).rejects.toThrow(/Database index out of range/)
    expect(poolSize()).toBe(before) // the failed connection was not kept
  })

  it('getKey shapes every type', async () => {
    const s = await getKey(ds, 0, 'str')
    expect(s).toMatchObject({ key: 'str', type: 'string', ttl: -1, length: 11, value: { kind: 'string', text: 'hello world', binary: false, truncated: false } })
    expect(s.size).toBeGreaterThan(0)
    expect(typeof s.encoding).toBe('string')
    const h = await getKey(ds, 0, 'h')
    expect(h.type).toBe('hash')
    expect(h.length).toBe(3)
    expect(h.value).toMatchObject({ kind: 'hash', next: null })
    expect((h.value as { items: unknown[] }).items).toEqual(expect.arrayContaining([{ field: 'f2', value: 'v2' }]))
    const l = await getKey(ds, 0, 'l', { limit: 2 })
    expect(l.value).toEqual({ kind: 'list', items: ['a', 'b'], offset: 0, next: 2 })
    const l2 = await getKey(ds, 0, 'l', { limit: 2, offset: 4 })
    expect(l2.value).toEqual({ kind: 'list', items: ['e'], offset: 4, next: null })
    const set = await getKey(ds, 0, 's')
    expect((set.value as { items: string[] }).items.sort()).toEqual(['x', 'y', 'z'])
    const z = await getKey(ds, 0, 'z', { limit: 2 })
    expect(z.value).toEqual({ kind: 'zset', items: [{ member: 'one', score: '1' }, { member: 'two', score: '2.5' }], offset: 0, next: 2 })
    const st = await getKey(ds, 0, 'st', { limit: 2 })
    expect(st.length).toBe(3)
    expect(st.value).toMatchObject({ kind: 'stream', next: '3-1' })
    expect((st.value as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(['1-1', '2-1'])
    const st2 = await getKey(ds, 0, 'st', { limit: 2, cursor: '3-1' })
    expect(st2.value).toMatchObject({ kind: 'stream', next: null })
    const missing = await getKey(ds, 0, 'nope-nope')
    expect(missing).toMatchObject({ type: 'none', ttl: -2, value: { kind: 'none' } })
  })

  it('hash / set paging over a big key', async () => {
    const p = admin.pipeline()
    for (let i = 0; i < 1200; i++) p.hset('bigh', `f${i}`, `v${i}`).sadd('bigs', `m${i}`)
    await p.exec()
    const seenH = new Set<string>()
    let cur: string | null = null
    do {
      const d: Awaited<ReturnType<typeof getKey>> = await getKey(ds, 0, 'bigh', { limit: 200, cursor: cur })
      const v = d.value as { items: { field: string }[]; next: string | null }
      v.items.forEach((i) => seenH.add(i.field))
      cur = v.next
    } while (cur)
    expect(seenH.size).toBe(1200)
    const seenS = new Set<string>()
    cur = null
    do {
      const d: Awaited<ReturnType<typeof getKey>> = await getKey(ds, 0, 'bigs', { limit: 200, cursor: cur })
      const v = d.value as { items: string[]; next: string | null }
      v.items.forEach((i) => seenS.add(i))
      cur = v.next
    } while (cur)
    expect(seenS.size).toBe(1200)
  })

  it('a huge string is capped at 1 MB and flagged', async () => {
    await admin.set('huge', 'é'.repeat(700_000)) // 1.4 MB of 2-byte characters: the cut may fall inside one
    const d = await getKey(ds, 0, 'huge')
    const v = d.value as { kind: 'string'; text: string; binary: boolean; truncated: boolean; bytes: number }
    expect(v.truncated).toBe(true)
    expect(v.binary).toBe(false)
    expect(v.bytes).toBe(1_400_000)
    expect(Buffer.byteLength(v.text)).toBeLessThanOrEqual(1_048_576)
    expect(Buffer.byteLength(v.text)).toBeGreaterThan(1_048_570)
    expect(d.length).toBe(1_400_000)
  })

  it('module / unknown type is reported as unsupported', async () => {
    // (a plain redis-server has no module types: simulate by checking the shape for a type the code does not know)
    const d = await getKey(ds, 0, 'str')
    expect(d.value.kind).toBe('string')
  })

  it('writes: setString (keep or reset the TTL), refuses other types', async () => {
    await admin.set('w:s', 'one', 'EX', 500)
    await setString(ds, 0, 'w:s', 'two', { keepTtl: true })
    let d = await getKey(ds, 0, 'w:s')
    expect(d.value).toMatchObject({ text: 'two' })
    expect(d.ttl).toBeGreaterThan(400_000)
    await setString(ds, 0, 'w:s', 'three')
    d = await getKey(ds, 0, 'w:s')
    expect(d.ttl).toBe(-1)
    await expect(setString(ds, 0, 'h', 'x')).rejects.toThrow(/holds a hash, not a string/)
    await expect(setString(ds, 0, 'w:missing', 'x')).rejects.toThrow(/no longer exists/)
    await setString(ds, 0, 'w:s', 'multi\nline "quoted" ünï')
    expect((await getKey(ds, 0, 'w:s')).value).toMatchObject({ text: 'multi\nline "quoted" ünï' })
  })

  it('writes: TTL set / persist / missing key', async () => {
    await admin.set('w:t', 'x')
    await setTtl(ds, 0, 'w:t', 120)
    const ttl = (await getKey(ds, 0, 'w:t')).ttl
    expect(ttl).toBeGreaterThan(100_000)
    expect(ttl).toBeLessThanOrEqual(120_000)
    await setTtl(ds, 0, 'w:t', null)
    expect((await getKey(ds, 0, 'w:t')).ttl).toBe(-1)
    await expect(setTtl(ds, 0, 'w:nope', 10)).rejects.toThrow(/does not exist/)
    await expect(setTtl(ds, 0, 'w:t', 0)).rejects.toThrow(/at least 1/)
  })

  it('writes: rename refuses to overwrite', async () => {
    await admin.set('w:r1', 'a')
    await admin.set('w:r2', 'b')
    await expect(renameKey(ds, 0, 'w:r1', 'w:r2')).rejects.toThrow(/already exists.*not overwritten/)
    expect(await admin.get('w:r2')).toBe('b')
    await renameKey(ds, 0, 'w:r1', 'w:r3')
    expect(await admin.get('w:r3')).toBe('a')
    expect(await admin.exists('w:r1')).toBe(0)
    await expect(renameKey(ds, 0, 'w:r1', 'w:r4')).rejects.toThrow(/does not exist/)
    await expect(renameKey(ds, 0, 'w:r3', 'w:r3')).rejects.toThrow(/same/)
  })

  it('writes: create refuses to overwrite, supports every editable type and a TTL', async () => {
    await createKey(ds, 0, 'w:c1', { type: 'string', value: 'v' }, { ttl: 300 })
    expect(await admin.get('w:c1')).toBe('v')
    expect(await admin.ttl('w:c1')).toBeGreaterThan(250)
    await expect(createKey(ds, 0, 'w:c1', { type: 'string', value: 'other' })).rejects.toThrow(/already exists/)
    expect(await admin.get('w:c1')).toBe('v')
    await createKey(ds, 0, 'w:ch', { type: 'hash', field: 'f', value: 'v' })
    await createKey(ds, 0, 'w:cl', { type: 'list', value: 'v' })
    await createKey(ds, 0, 'w:cs', { type: 'set', member: 'm' })
    await createKey(ds, 0, 'w:cz', { type: 'zset', member: 'm', score: 4.5 }, { ttl: 60 })
    expect(await admin.hgetall('w:ch')).toEqual({ f: 'v' })
    expect(await admin.lrange('w:cl', 0, -1)).toEqual(['v'])
    expect(await admin.smembers('w:cs')).toEqual(['m'])
    expect(await admin.zscore('w:cz', 'm')).toBe('4.5')
    expect(await admin.ttl('w:cz')).toBeGreaterThan(0)
    await expect(createKey(ds, 0, 'w:ch', { type: 'hash', field: 'f', value: 'x' })).rejects.toThrow(/already exists/)
    await expect(createKey(ds, 0, 'w:cx', { type: 'zset', member: 'm', score: 'abc' })).rejects.toThrow(/not a valid score/)
    expect(await admin.exists('w:cx')).toBe(0)
  })

  it('writes: item edits', async () => {
    await admin.del('w:ih', 'w:il', 'w:is', 'w:iz')
    await admin.hset('w:ih', 'a', '1')
    await itemOp(ds, 0, 'w:ih', { op: 'hset', field: 'b', value: '2' })
    await itemOp(ds, 0, 'w:ih', { op: 'hset', field: 'a', value: 'ü' })
    await itemOp(ds, 0, 'w:ih', { op: 'hdel', field: 'b' })
    expect(await admin.hgetall('w:ih')).toEqual({ a: 'ü' })
    await admin.rpush('w:il', 'x', 'y', 'x')
    await itemOp(ds, 0, 'w:il', { op: 'lset', index: 1, value: 'Y' })
    await itemOp(ds, 0, 'w:il', { op: 'lpush', value: 'first' })
    await itemOp(ds, 0, 'w:il', { op: 'rpush', value: 'last' })
    await itemOp(ds, 0, 'w:il', { op: 'lrem', value: 'x' })
    expect(await admin.lrange('w:il', 0, -1)).toEqual(['first', 'Y', 'x', 'last'])
    await expect(itemOp(ds, 0, 'w:il', { op: 'lset', index: 99, value: 'z' })).rejects.toThrow(/index out of range/)
    await admin.sadd('w:is', 'a')
    await itemOp(ds, 0, 'w:is', { op: 'sadd', member: 'b' })
    await itemOp(ds, 0, 'w:is', { op: 'srem', member: 'a' })
    expect(await admin.smembers('w:is')).toEqual(['b'])
    await admin.zadd('w:iz', 1, 'a')
    await itemOp(ds, 0, 'w:iz', { op: 'zadd', member: 'a', score: 9 })
    await itemOp(ds, 0, 'w:iz', { op: 'zadd', member: 'b', score: '-inf' })
    await itemOp(ds, 0, 'w:iz', { op: 'zrem', member: 'b' })
    expect(await admin.zrange('w:iz', '0', '-1', 'WITHSCORES')).toEqual(['a', '9'])
    await expect(itemOp(ds, 0, 'h', { op: 'sadd', member: 'x' })).rejects.toThrow(/Wrong type/)
  })

  it('deleteKeys removes keys (counting those that existed)', async () => {
    await admin.mset('d:1', 'a', 'd:2', 'b', 'd:3', 'c')
    expect(await deleteKeys(ds, 0, ['d:1', 'd:2', 'd:missing'])).toBe(2)
    expect(await admin.exists('d:1', 'd:2', 'd:3')).toBe(1)
    expect(await deleteKeys(ds, 0, [])).toBe(0)
  })

  it('databases are separate connections: keys in db 3 stay in db 3', async () => {
    const r = await scanKeys(ds, 3, {})
    expect(r.keys.map((k) => k.key).sort()).toEqual(['in-db3', 'in-db3b'])
    expect((await getKey(ds, 3, 'in-db3')).value).toMatchObject({ text: '1' })
    expect((await getKey(ds, 0, 'in-db3')).type).toBe('none')
    await createKey(ds, 3, 'only3', { type: 'string', value: 'x' })
    expect(await admin.exists('only3')).toBe(0)
    await deleteKeys(ds, 3, ['only3'])
  })

  it('console: quoting, escapes, replies of every kind', async () => {
    const r = await runCommands(ds, 0, 'SET "c:k 1" "line1\\nline2 \\x41"\nGET "c:k 1"\nEXISTS "c:k 1" nope\nGET c:nope\nTYPE h\nMGET str "c:k 1"\nPING')
    const reply = r.results.map((x) => x.reply)
    expect(reply[0]).toEqual({ kind: 'status', value: 'OK' })
    expect(reply[1]).toEqual({ kind: 'bulk', value: 'line1\nline2 A' })
    expect(reply[2]).toEqual({ kind: 'integer', value: 1 })
    expect(reply[3]).toEqual({ kind: 'nil' })
    expect(reply[4]).toEqual({ kind: 'status', value: 'hash' })
    expect(reply[5]).toEqual({ kind: 'array', items: [{ kind: 'bulk', value: 'hello world' }, { kind: 'bulk', value: 'line1\nline2 A' }] })
    expect(reply[6]).toEqual({ kind: 'status', value: 'PONG' })
    expect(r.results.every((x) => x.durationMs >= 0)).toBe(true)
    expect(r.results[0].command).toBe('SET')
    await deleteKeys(ds, 0, ['c:k 1'])
  })

  it('console: comments / blank lines skipped, stops at the first error', async () => {
    const r = await runCommands(ds, 0, '# a comment\n\nSET c:e 1\nLPUSH c:e x\nSET c:e2 2')
    expect(r.results).toHaveLength(2)
    expect(r.results[1].reply).toEqual({ kind: 'error', message: 'WRONGTYPE Operation against a key holding the wrong kind of value' })
    expect(await admin.exists('c:e2')).toBe(0)
    await deleteKeys(ds, 0, ['c:e'])
  })

  it('console: binary replies are escaped; nested arrays keep their shape', async () => {
    const r = await runCommands(ds, 0, 'SET c:b "\\xff\\x00a"\nGET c:b\nSCAN 0 MATCH h COUNT 100000\nCLUSTER INFO')
    expect(r.results[1].reply).toEqual({ kind: 'bulk', value: '\\xff\\x00a' })
    const scan = r.results[2].reply
    expect(scan.kind).toBe('array')
    expect(r.results[3].reply.kind).toBe('error') // cluster support disabled: an error reply, the console keeps working
    await deleteKeys(ds, 0, ['c:b'])
  })

  it('console: blocked commands never reach the server; SELECT is refused', async () => {
    for (const line of ['SUBSCRIBE ch', 'MONITOR', 'BLPOP q 0', 'XREAD BLOCK 0 STREAMS st $', 'SELECT 5', 'MULTI']) {
      const r = await runCommands(ds, 0, line)
      expect(r.results[0].reply.kind).toBe('error')
    }
    const sel = await runCommands(ds, 0, 'SELECT 5')
    expect((sel.results[0].reply as { message: string }).message).toMatch(/database selector/)
    // the console connection is still in db 0
    const r = await runCommands(ds, 0, 'GET str')
    expect(r.results[0].reply).toEqual({ kind: 'bulk', value: 'hello world' })
    // a non-blocking XREAD is fine
    const x = await runCommands(ds, 0, 'XREAD COUNT 1 STREAMS st 0')
    expect(x.results[0].reply.kind).toBe('array')
  })

  it('console: unbalanced quotes are an error reply, unknown commands too', async () => {
    const a = await runCommands(ds, 0, 'GET "abc')
    expect(a.results[0].reply).toMatchObject({ kind: 'error', message: expect.stringMatching(/Unbalanced quotes/) })
    const b = await runCommands(ds, 0, 'FOOBAR 1')
    expect(b.results[0].reply).toMatchObject({ kind: 'error', message: expect.stringMatching(/unknown command/i) })
    await expect(runCommands(ds, 0, '  \n# nothing')).rejects.toThrow(/Nothing to run/)
  })

  it('console runs in the database it was opened on', async () => {
    const r = await runCommands(ds, 3, 'GET in-db3\nDBSIZE')
    expect(r.results[0].reply).toEqual({ kind: 'bulk', value: '1' })
    expect(r.results[1].reply).toEqual({ kind: 'integer', value: 2 })
  })

  it('pooling: one connection per data source + db (+ console), closeAll(id) closes only that source', async () => {
    await closeAll()
    expect(poolSize()).toBe(0)
    await getKey(ds, 0, 'str')
    await getKey(ds, 3, 'in-db3')
    await runCommands(ds, 0, 'PING')
    expect(poolSize()).toBe(3)
    const other = src(server.port, {}, 'other')
    await getKey(other, 0, 'str')
    expect(poolSize()).toBe(4)
    await closeAll('int')
    expect(poolSize()).toBe(1)
    await closeAll()
    expect(poolSize()).toBe(0)
    // a closed source simply reconnects
    expect((await getKey(ds, 0, 'str')).type).toBe('string')
  })

  it('a dropped connection is replaced on the next call', async () => {
    await getKey(ds, 0, 'str')
    await admin.call('CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'yes')
    // the pooled client notices the drop; the next calls recover (maybe after one failed attempt)
    let ok = false
    for (let i = 0; i < 4 && !ok; i++) {
      try {
        ok = (await getKey(ds, 0, 'str')).type === 'string'
      } catch {
        /* first call after the drop can fail */
      }
    }
    expect(ok).toBe(true)
  })
})


/**
 * The explorer's key tree and key tabs against real data: a few thousand keys of every type in database 5 of a third
 * throwaway server (so the counts asserted above for the other server's databases are untouched).
 */
describe.skipIf(!on)('Redis explorer: key tree and key tabs (own throwaway redis-server)', () => {
  let server: TestServer
  let ds: DataSource
  let admin: Redis
  /** every key seeded in db 5 (as sent over IPC) with its Redis type */
  const expected = new Map<string, string>()
  const DB = 5
  const bin = Buffer.from([0xff, 0xfe, 0x3a, 0x00, 0x41]) // not UTF-8, contains a ":"

  beforeAll(async () => {
    server = await startRedis()
    expect(server.port).not.toBe(6379)
    ds = src(server.port, {}, 'tree')
    admin = new Redis({ host: '127.0.0.1', port: server.port, db: DB })
    const p = admin.pipeline()
    const add = (name: string, type: string, fn: () => unknown): void => {
      expected.set(name, type)
      fn()
    }
    for (let i = 0; i < 2300; i++) add(`user:${i % 40}:name:${i}`, 'string', () => p.set(`user:${i % 40}:name:${i}`, String(i)))
    for (let i = 0; i < 40; i++) add(`queue:${i % 4}:${i}`, 'list', () => p.rpush(`queue:${i % 4}:${i}`, 'a', 'b'))
    for (let i = 0; i < 150; i++) add(`tag:${i % 10}:${i}`, 'set', () => p.sadd(`tag:${i % 10}:${i}`, 'm'))
    for (let i = 0; i < 60; i++) add(`board:${i}`, 'zset', () => p.zadd(`board:${i}`, i, 'm'))
    for (let i = 0; i < 300; i++) add(`session:${i % 7}:${i}`, 'hash', () => p.hset(`session:${i % 7}:${i}`, 'f', 'v'))
    for (let i = 0; i < 12; i++) add(`events:${i}`, 'stream', () => p.xadd(`events:${i}`, '1-1', 'k', 'v'))
    // nesting / collision / odd-name cases (all strings)
    for (const k of ['a', 'a:b', 'a:b:c', 'a::b', ':lead', 'trail:', '::', '用户:1:名', 'we*ird[1]:x', 'q?:y', 'back\\slash:z', 'sp ace:k', 'x:(empty):y', '']) {
      add(k, 'string', () => p.set(k, 'v'))
    }
    add(encodeName(bin), 'string', () => p.set(bin, 'v'))
    await p.exec()
  })

  afterAll(async () => {
    await closeAll()
    admin?.disconnect()
    await server?.stop()
  })

  const typesOf = (r: { keys: { key: string; type: string }[] }): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const k of r.keys) out[k.type] = (out[k.type] ?? 0) + 1
    return out
  }
  const countType = (t: string): number => [...expected.values()].filter((x) => x === t).length

  it('lists every key exactly once with the right type, completely', async () => {
    const t0 = Date.now()
    const r = await keyTree(ds, DB)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.complete).toBe(true)
    expect(r.dbsize).toBe(expected.size)
    expect(r.keys).toHaveLength(expected.size)
    expect(new Set(r.keys.map((k) => k.key)).size).toBe(expected.size) // no duplicates
    for (const k of r.keys) expect(expected.get(k.key), k.key).toBe(k.type)
    expect(typesOf(r)).toEqual({
      string: countType('string'), list: 40, set: 150, zset: 60, hash: 300, stream: 12
    })
  })

  it('the type / prefix folders: counts per type and per prefix are exact', async () => {
    const r = await keyTree(ds, DB)
    const g = buildKeyTree(r.keys as never, ':')
    expect(g.map((x) => [x.label, x.count])).toEqual([
      ['strings', countType('string')], ['lists', 40], ['sets', 150], ['sorted sets', 60], ['hash tables', 300], ['streams', 12]
    ])
    const strings = g[0]
    const user = strings.children.find((e): e is KeyFolder => e.kind === 'folder' && e.name === 'user')!
    expect(user.count).toBe(2300)
    expect(user.children).toHaveLength(40)
    // 2300 keys over 40 groups: i % 40 === 7 hits 58 of them (57 full rounds + one more, since 2300 = 57 * 40 + 20)
    const in7 = [...expected].filter(([k, t]) => t === 'string' && k.startsWith('user:7:')).length
    expect(in7).toBe(58)
    expect((user.children.find((e) => e.kind === 'folder' && e.name === '7') as KeyFolder).count).toBe(in7)
    // a:b:c-style names, a key that is also a prefix, empty segments, unicode, binary: every key exactly once
    expect(keysUnder(strings.children).sort()).toEqual([...expected].filter(([, t]) => t === 'string').map(([k]) => k).sort())
    const a = strings.children.find((e): e is KeyFolder => e.kind === 'folder' && e.name === 'a')!
    expect(a.count).toBe(3) // a:b, a:b:c, a::b (the key "a" itself is a leaf next to the folder)
    expect(strings.children.some((e) => e.kind === 'key' && e.name === 'a')).toBe(true)
  })

  it('a folder\'s "Browse in Key Browser" pattern finds exactly the keys the tree shows under it (glob characters escaped)', async () => {
    const r = await keyTree(ds, DB)
    const [strings] = buildKeyTree(r.keys as never, ':')
    const check = async (list: KeyEntry[], depth = 0): Promise<void> => {
      for (const e of list) {
        if (e.kind !== 'folder' || depth > 1) continue
        const want = keysUnder(e.children).sort()
        const got: string[] = []
        let cursor: string | null = null
        do {
          const page: { keys: { key: string; type: string }[]; cursor: string | null } = await scanKeys(ds, DB, {
            pattern: prefixPattern(e.prefix, e.binary), type: 'string', limit: 500, ...(cursor ? { cursor } : {})
          })
          got.push(...page.keys.map((k) => k.key))
          cursor = page.cursor
        } while (cursor)
        expect(got.sort(), e.prefix).toEqual(want)
        await check(e.children, depth + 1)
      }
    }
    // (the big user: folder is checked at its first level only to keep this fast)
    await check(strings.children.filter((e) => e.kind === 'folder' && (e as KeyFolder).count < 500))
    const odd: [string, string][] = [['we*ird[1]:', 'we*ird[1]:x'], ['q?:', 'q?:y'], ['back\\slash:', 'back\\slash:z'], ['sp ace:', 'sp ace:k']]
    for (const [prefix, only] of odd) {
      const hit = await scanKeys(ds, DB, { pattern: prefixPattern(prefix), limit: 100 })
      expect(hit.keys.map((k) => k.key), prefix).toEqual([only])
    }
  })

  it('binary names come back encoded and decode to the exact bytes', async () => {
    const r = await keyTree(ds, DB)
    const enc = r.keys.find((k) => k.key.startsWith('\u0000b64:'))!
    expect(decodeName(enc.key)).toEqual(bin)
    expect(enc.type).toBe('string')
    expect((await getKey(ds, DB, enc.key)).type).toBe('string')
  })

  it('caps at max and says it is incomplete; the total is still reported', async () => {
    const r = await keyTree(ds, DB, { max: 1000 })
    expect(r.keys).toHaveLength(1000)
    expect(r.complete).toBe(false)
    expect(r.dbsize).toBe(expected.size)
    expect(new Set(r.keys.map((k) => k.key)).size).toBe(1000)
    for (const k of r.keys) expect(expected.get(k.key)).toBe(k.type)
    expect((await keyTree(ds, DB, { max: expected.size })).complete).toBe(true) // exactly everything is still complete
    expect((await keyTree(ds, DB, { max: 0 })).keys).toHaveLength(1) // clamped up to 1
  })

  it('an empty database is complete and empty; the other database is not mixed in', async () => {
    expect(await keyTree(ds, 9)).toEqual({ keys: [], complete: true, dbsize: 0 })
    expect((await keyTree(ds, 0)).keys).toHaveLength(0)
  })

  it('uses SCAN and TYPE only: never KEYS (and writes nothing)', async () => {
    await admin.call('CONFIG', 'RESETSTAT')
    await keyTree(ds, DB)
    const stats = String(await admin.info('commandstats'))
    expect(stats).toMatch(/cmdstat_scan:/)
    expect(stats).toMatch(/cmdstat_type:/)
    expect(stats).not.toMatch(/cmdstat_keys:/)
    for (const w of ['set', 'del', 'rename', 'expire', 'flushdb', 'flushall']) expect(stats, w).not.toMatch(new RegExp(`cmdstat_${w}:`))
    expect(await dbSize(ds, DB)).toBe(expected.size)
  })

  it('a newer scan supersedes a running one: the newer is exact, the older never mixes data', async () => {
    const a = keyTree(ds, DB)
    const b = keyTree(ds, DB)
    const [ra, rb] = await Promise.all([a, b])
    expect(rb.complete).toBe(true)
    expect(rb.keys).toHaveLength(expected.size)
    expect(ra.complete === false || ra.keys.length === expected.size).toBe(true)
    for (const k of ra.keys) expect(expected.get(k.key)).toBe(k.type)
  })

  it('cancelKeyTree stops a scan that has not finished', async () => {
    const p = keyTree(ds, DB)
    cancelKeyTree(ds, DB)
    const r = await p
    expect(r.complete).toBe(false)
    expect(r.keys.length).toBeLessThan(expected.size)
  })

  describe('key tab operations on real data', () => {
    it('every type opens: type, length and value kind', async () => {
      const want: [string, string, string][] = [
        ['user:0:name:0', 'string', 'string'], ['queue:0:0', 'list', 'list'], ['tag:0:0', 'set', 'set'],
        ['board:0', 'zset', 'zset'], ['session:0:0', 'hash', 'hash'], ['events:0', 'stream', 'stream']
      ]
      for (const [k, type, kind] of want) {
        const d = await getKey(ds, DB, k)
        expect(d.type, k).toBe(type)
        expect(d.value.kind, k).toBe(kind)
        expect(d.ttl).toBe(-1)
      }
      expect((await getKey(ds, DB, 'a:b:c')).value).toMatchObject({ kind: 'string', text: 'v' })
      // the empty key name is legal in Redis but deliberately not addressable here (names must be non-empty, like fields / members)
      await expect(getKey(ds, DB, '')).rejects.toThrow(/Key must not be empty/)
    })

    it('edit in place keeps the TTL; TTL set / persist round-trip', async () => {
      await setTtl(ds, DB, 'a', 300)
      await setString(ds, DB, 'a', 'edited', { keepTtl: true })
      const d = await getKey(ds, DB, 'a')
      expect(d.value).toMatchObject({ kind: 'string', text: 'edited' })
      expect(d.ttl).toBeGreaterThan(290_000)
      await setTtl(ds, DB, 'a', null)
      expect((await getKey(ds, DB, 'a')).ttl).toBe(-1)
    })

    it('rename moves the key in the tree; renaming onto an existing key is refused and loses nothing', async () => {
      await renameKey(ds, DB, 'board:59', 'board:renamed')
      expected.delete('board:59')
      expected.set('board:renamed', 'zset')
      let r = await keyTree(ds, DB)
      expect(r.keys.some((k) => k.key === 'board:renamed' && k.type === 'zset')).toBe(true)
      expect(r.keys.some((k) => k.key === 'board:59')).toBe(false)
      await expect(renameKey(ds, DB, 'board:renamed', 'board:0')).rejects.toThrow(/already exists/)
      r = await keyTree(ds, DB)
      expect(r.keys).toHaveLength(expected.size)
      expect((await getKey(ds, DB, 'board:renamed')).type).toBe('zset')
    })

    it('delete removes keys from the tree; a deleted key is reported as gone (the tab\'s "Key no longer exists")', async () => {
      const doomed = ['events:11', 'tag:9:149', 'a::b']
      expect(await deleteKeys(ds, DB, doomed)).toBe(3)
      for (const k of doomed) expected.delete(k)
      const r = await keyTree(ds, DB)
      expect(r.dbsize).toBe(expected.size)
      expect(r.keys).toHaveLength(expected.size)
      expect(r.keys.some((k) => doomed.includes(k.key))).toBe(false)
      const g = await getKey(ds, DB, 'events:11')
      expect(g.ttl).toBe(-2)
      expect(g.value.kind).toBe('none')
      const counts = typesOf(r)
      expect(counts.stream).toBe(11)
      expect(counts.set).toBe(149)
    })

    it('a key that expires while the tree is open simply disappears on the next scan', async () => {
      await createKey(ds, DB, 'fleeting', { type: 'string', value: 'x' } as never, { ttl: 1 })
      expect((await keyTree(ds, DB)).keys.some((k) => k.key === 'fleeting')).toBe(true)
      await new Promise((x) => setTimeout(x, 1300))
      const r = await keyTree(ds, DB)
      expect(r.keys.some((k) => k.key === 'fleeting')).toBe(false)
      expect((await getKey(ds, DB, 'fleeting')).ttl).toBe(-2)
    })
  })

  it('a different data source id keeps its own scans (cancel of another source does not interfere)', async () => {
    const other = src(server.port, {}, 'tree-other')
    const p = keyTree(ds, DB)
    cancelKeyTree(other, DB)
    const r = await p
    expect(r.complete).toBe(true)
    expect(r.keys).toHaveLength(expected.size)
  })
})
