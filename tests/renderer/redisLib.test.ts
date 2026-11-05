import { describe, expect, it } from 'vitest'
import {
  base64Hex, dbName, effectivePattern, escapeGlob, exactPattern, fmtBytes, fmtTtl, mergeKeys, parseTtlInput, prettyJson, replyText, ttlInputOf, typeClass, valueCopyText
} from '../../src/renderer/src/lib/redis'
import { isRedisRef, isRedisKeyRef, keyTabTitle, redisKeyRef, redisRef, tableKey, tablePath, isDynamoRef } from '../../src/renderer/src/lib/refs'
import { typeLabel } from '../../src/renderer/src/lib/typeLabel'
import { REDIS_COMMANDS, analyzeRedis, buildRedisItems } from '../../src/renderer/src/lib/redisCommands'

describe('fmtTtl', () => {
  it.each([
    [-1, '∞'], [-2, '—'], [0, '0 ms'], [850, '850 ms'], [1000, '1s'], [59_000, '59s'], [60_000, '1m'], [90_000, '1m 30s'],
    [3_600_000, '1h'], [5_400_000, '1h 30m'], [86_400_000, '1d'], [93_600_000, '1d 2h'], [31_536_000_000, '365d']
  ])('%d ms -> %s', (ms, out) => expect(fmtTtl(ms)).toBe(out))
})

describe('parseTtlInput', () => {
  it('seconds, units and combinations', () => {
    expect(parseTtlInput('90')).toBe(90)
    expect(parseTtlInput(' 90s ')).toBe(90)
    expect(parseTtlInput('5m')).toBe(300)
    expect(parseTtlInput('2h')).toBe(7200)
    expect(parseTtlInput('1d')).toBe(86400)
    expect(parseTtlInput('1d 2h 30m 5s')).toBe(86400 + 7200 + 1800 + 5)
    expect(parseTtlInput('5M')).toBe(300)
  })
  it('empty / none / persist mean no expiry', () => {
    for (const t of ['', '  ', 'none', 'None', '∞', 'persist', '-1']) expect(parseTtlInput(t), t).toBeNull()
  })
  it('anything else is invalid (undefined)', () => {
    for (const t of ['0', '0s', 'abc', '5x', '1.5h', '-5', '5 m', '1d2h', '9'.repeat(30) + 's']) expect(parseTtlInput(t), t).toBeUndefined()
  })
  it('ttlInputOf round-trips whole seconds and is empty without an expiry', () => {
    expect(ttlInputOf(90_000)).toBe('90')
    expect(ttlInputOf(400)).toBe('1')
    expect(ttlInputOf(-1)).toBe('')
    expect(ttlInputOf(-2)).toBe('')
  })
})

describe('small helpers', () => {
  it('fmtBytes', () => {
    expect([fmtBytes(5), fmtBytes(2048), fmtBytes(3 * 1048576), fmtBytes(2.5 * 1073741824)]).toEqual(['5 B', '2.0 KB', '3.0 MB', '2.50 GB'])
  })
  it('prettyJson only for objects / arrays', () => {
    expect(prettyJson('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
    expect(prettyJson(' [1] ')).toBe('[\n  1\n]')
    for (const t of ['', '5', '"x"', 'null', '{bad', 'hello', '[1,']) expect(prettyJson(t), t).toBeNull()
  })
  it('base64Hex', () => {
    expect(base64Hex(btoa('\u00de\u00ad\u00be\u00ef'))).toBe('de ad be ef')
    expect(base64Hex(btoa('abcd'), 2)).toBe('61 62 …')
    expect(base64Hex('***')).toBe('')
  })
  it('typeClass / dbName', () => {
    expect(typeClass('hash')).toBe('rt rt-hash')
    expect(typeClass('ReJSON-RL')).toBe('rt rt-other')
    expect(dbName(3)).toBe('db3')
  })
  it('effectivePattern: a plain word is "contains"; glob syntax is used as is', () => {
    expect(effectivePattern('')).toBe('')
    expect(effectivePattern('  ')).toBe('')
    expect(effectivePattern('user')).toBe('*user*')
    for (const p of ['user:*', 'a?c', 'h[ae]llo', 'a\\*b']) expect(effectivePattern(p)).toBe(p)
  })
  it('effectivePattern leaves a binary pattern alone (no "contains" wrapping)', () => {
    const p = '\u0000b64:/+8qKg=='
    expect(effectivePattern(p)).toBe(p)
  })
  it('escapeGlob makes an exact-match pattern', () => {
    expect(escapeGlob('a*b?c[d]e\\f')).toBe('a\\*b\\?c\\[d\\]e\\\\f')
    expect(escapeGlob('plain')).toBe('plain')
  })
  it('exactPattern always carries a backslash so it is never read as "contains" and survives trimming', () => {
    expect(exactPattern('user:1')).toBe('\\user:1')
    expect(exactPattern('a*b')).toBe('\\a\\*b')
    expect(exactPattern('*x')).toBe('\\*x')
    expect(exactPattern('tail ')).toBe('\\tail\\ ')
    for (const k of ['user:1', 'a*b', 'tail ', ' lead', 'x\\y', 'a b']) {
      const p = effectivePattern(exactPattern(k))
      expect(p, k).toBe(exactPattern(k)) // not wrapped, not trimmed
      // and the pattern really matches only that key (Redis glob semantics: backslash escapes the next char)
      const re = new RegExp('^' + p.replace(/\\(.)/g, (_m, c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) + '$')
      expect(re.test(k), k).toBe(true)
      expect(re.test(k + 'x'), k).toBe(false)
    }
  })
  it('effectivePattern keeps a deliberately escaped trailing blank', () => {
    expect(effectivePattern('a\\ ')).toBe('a\\ ')
    expect(effectivePattern('  a  ')).toBe('*a*')
  })
  it('mergeKeys appends, keeps first positions and refreshes repeats', () => {
    const k = (key: string, ttl = -1) => ({ key, type: 'string', ttl })
    expect(mergeKeys([k('a'), k('b')], [k('c'), k('a', 5)])).toEqual([k('a', 5), k('b'), k('c')])
    expect(mergeKeys([], [k('x')])).toEqual([k('x')])
  })
  it('replyText formats like redis-cli', () => {
    expect(replyText({ kind: 'nil' })).toBe('(nil)')
    expect(replyText({ kind: 'integer', value: 4 })).toBe('(integer) 4')
    expect(replyText({ kind: 'status', value: 'OK' })).toBe('OK')
    expect(replyText({ kind: 'bulk', value: 'x' })).toBe('x')
    expect(replyText({ kind: 'error', message: 'boom' })).toBe('(error) boom')
    expect(replyText({ kind: 'array', items: [] })).toBe('(empty array)')
    expect(replyText({ kind: 'array', items: [{ kind: 'bulk', value: 'a' }, { kind: 'array', items: [{ kind: 'integer', value: 1 }] }, { kind: 'nil' }] })).toBe(
      '1) a\n2) \n   1) (integer) 1\n3) (nil)'
    )
  })
})

describe('Redis refs', () => {
  const r = redisRef('d1', 'My Redis', 3)
  it('identity: key and tree path by db index; cannot collide with other kinds', () => {
    expect(r).toMatchObject({ dsId: 'd1', dsName: 'My Redis', kind: 'redis', engine: 'redis', db: 3, table: 'db3' })
    expect(isRedisRef(r)).toBe(true)
    expect(isDynamoRef(r)).toBe(false)
    expect(isRedisRef({ engine: 'dynamodb' })).toBe(false)
    expect(tableKey(r)).toBe('t|redis|d1|3')
    expect(tablePath(r)).toBe('d1/db3')
    expect(tableKey(redisRef('d1', 'x', 4))).not.toBe(tableKey(r))
    expect(tableKey({ ...r, db: undefined })).toBe('t|redis|d1|0')
  })
  it('typeLabel', () => {
    expect(typeLabel('redis')).toBe('Redis')
    expect(typeLabel('redisdb')).toBe('Redis Database')
  })
})

describe('Redis console completion', () => {
  const ctx = (text: string, forced = false, caret = text.length) => analyzeRedis(text, caret, forced)
  it('completes the first word of a line', () => {
    const c = ctx('ge')!
    expect(c).toMatchObject({ start: 0, end: 2, word: 'ge', lower: true })
    const names = buildRedisItems(c).map((i) => i.label)
    expect(names).toEqual(expect.arrayContaining(['get', 'getrange', 'geoadd']))
    const firstOther = names.findIndex((n) => !n.startsWith('ge'))
    expect(names.slice(0, firstOther < 0 ? names.length : firstOther).every((n) => n.startsWith('ge'))).toBe(true)
    expect(names.slice(firstOther).some((n) => n.startsWith('ge'))).toBe(false) // prefix matches first, then names that merely contain it
    expect(names.every((n) => n === n.toLowerCase())).toBe(true)
  })
  it('keeps the case style of what was typed (upper by default)', () => {
    const get = buildRedisItems(ctx('GE')!).find((i) => i.label === 'GET')
    expect(get).toMatchObject({ label: 'GET', insert: 'GET ', kind: 'fn', detail: 'key' })
    // an exact match is listed first
    expect(buildRedisItems(ctx('GET')!)[0].label).toBe('GET')
  })
  it('later lines, indentation and the replace range', () => {
    const t = 'SET a 1\n  hg'
    const c = ctx(t)!
    expect(c).toMatchObject({ start: 10, end: 12, word: 'hg' })
    expect(buildRedisItems(c).map((i) => i.label)).toEqual(expect.arrayContaining(['hget', 'hgetall']))
  })
  it('the word right of the caret is replaced too', () => {
    const c = analyzeRedis('GETRANGE k 0 1', 3)!
    expect(c).toMatchObject({ start: 0, end: 8, word: 'GET' })
  })
  it('nothing for arguments, comments, quotes, empty words (unless forced)', () => {
    expect(ctx('GET k')).toBeNull()
    expect(ctx('SET k "va')).toBeNull()
    expect(ctx('# get')).toBeNull()
    expect(ctx('')).toBeNull()
    expect(ctx('GET ')).toBeNull()
    const f = ctx('', true)!
    expect(buildRedisItems(f).length).toBeGreaterThan(20)
  })
  it('two-word commands complete as a whole after the first word', () => {
    const c = ctx('client ')!
    expect(c.word).toBe('client ')
    const items = buildRedisItems(c).map((i) => i.label)
    expect(items).toEqual(expect.arrayContaining(['client list', 'client id']))
    expect(items.every((i) => i.startsWith('client '))).toBe(true)
    expect(ctx('CLIENT LI')).toMatchObject({ word: 'CLIENT LI' })
    expect(ctx('CLIENT LIST extra')).toBeNull()
  })
  it('an exact single match offers nothing; the list is bounded; the catalogue is sane', () => {
    expect(buildRedisItems(ctx('PING')!)).toEqual([])
    expect(buildRedisItems(ctx('TTL')!).map((i) => i.label)).toEqual(['TTL', 'PTTL']) // exact first, then names that contain it
    expect(buildRedisItems({ start: 0, end: 4, word: 'PING', forced: false, lower: false })).toEqual([])
    expect(buildRedisItems({ start: 0, end: 0, word: '', forced: true, lower: false }).length).toBeLessThanOrEqual(60)
    const names = REDIS_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
    for (const must of ['GET', 'SET', 'DEL', 'SCAN', 'HGETALL', 'LRANGE', 'ZADD', 'XADD', 'EXPIRE', 'TTL', 'INFO', 'PING', 'TYPE']) expect(names).toContain(must)
    // dangerous commands are not even suggested
    for (const never of ['FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'DEBUG', 'KEYS *']) expect(names).not.toContain(never)
  })
})

describe('valueCopyText (Copy value)', () => {
  it('a string is copied as is; edits in the editor win; binary values as base64', () => {
    const v = { kind: 'string' as const, text: 'hello', binary: false, base64: 'aGVsbG8=', bytes: 5, truncated: false }
    expect(valueCopyText(v)).toBe('hello')
    expect(valueCopyText(v, 'hello!')).toBe('hello!')
    expect(valueCopyText(v, '')).toBe('')
    expect(valueCopyText({ ...v, binary: true }, 'ignored')).toBe('aGVsbG8=')
  })
  it('a hash becomes a JSON object, list / set a JSON array, zset a list of members with scores', () => {
    expect(JSON.parse(valueCopyText({ kind: 'hash', items: [{ field: 'a', value: '1' }, { field: 'b', value: '' }], next: null }))).toEqual({ a: '1', b: '' })
    expect(JSON.parse(valueCopyText({ kind: 'list', items: ['x', 'y'], offset: 0, next: null }))).toEqual(['x', 'y'])
    expect(JSON.parse(valueCopyText({ kind: 'set', items: ['m'], next: null }))).toEqual(['m'])
    expect(JSON.parse(valueCopyText({ kind: 'zset', items: [{ member: 'a', score: '1.5' }], offset: 0, next: null }))).toEqual([{ member: 'a', score: '1.5' }])
  })
  it('a stream keeps entry ids and their fields apart (a field called "id" cannot clash)', () => {
    const out = JSON.parse(valueCopyText({ kind: 'stream', entries: [{ id: '1-0', fields: [{ field: 'id', value: 'x' }, { field: 't', value: '2' }] }], next: null }))
    expect(out).toEqual([{ id: '1-0', fields: { id: 'x', t: '2' } }])
  })
  it('nothing to copy for missing / module values', () => {
    expect(valueCopyText({ kind: 'none' })).toBe('')
    expect(valueCopyText({ kind: 'unsupported', type: 'ReJSON-RL' })).toBe('')
  })
  it('unicode survives', () => {
    expect(JSON.parse(valueCopyText({ kind: 'hash', items: [{ field: '名', value: '😀' }], next: null }))).toEqual({ 名: '😀' })
  })
})

describe('key tab identity (refs)', () => {
  const key = redisKeyRef('d1', 'Cache', 3, 'user:42:name')
  it('a key ref is a redis ref carrying its key, db and database label', () => {
    expect(key).toEqual({
      dsId: 'd1', dsName: 'Cache', database: 'db3', schema: '', table: 'user:42:name', kind: 'redis', engine: 'redis', db: 3, redisKey: 'user:42:name'
    })
    expect(isRedisRef(key)).toBe(true)
    expect(isRedisKeyRef(key)).toBe(true)
    expect(isRedisKeyRef(redisRef('d1', 'C', 3))).toBe(false)
    expect(isRedisKeyRef({ engine: 'dynamodb', redisKey: 'x' })).toBe(false)
    expect(isRedisKeyRef({})).toBe(false)
  })
  it('key tabs are identified by data source + database + key, distinct from the key browser', () => {
    expect(tableKey(key)).toBe('t|rkey|d1|3|user:42:name')
    expect(tableKey(redisRef('d1', 'Cache', 3))).toBe('t|redis|d1|3')
    expect(tableKey(redisKeyRef('d1', 'Cache', 4, 'user:42:name'))).not.toBe(tableKey(key))
    expect(tableKey(redisKeyRef('d2', 'Cache', 3, 'user:42:name'))).not.toBe(tableKey(key))
    expect(tableKey(redisKeyRef('d1', 'Cache', 3, 'user:42:other'))).not.toBe(tableKey(key))
    // a key containing the separator cannot collide with another key (the key is the last component)
    expect(tableKey(redisKeyRef('d1', 'C', 3, 'a|b'))).toBe('t|rkey|d1|3|a|b')
  })
  it('the same key looked up twice gives the same identity (open = focus, not a second tab)', () => {
    expect(tableKey(redisKeyRef('d1', 'Cache (renamed source)', 3, 'k'))).toBe(tableKey(redisKeyRef('d1', 'Cache', 3, 'k')))
  })
  it('tree path of a key tab lives under its database (refreshing the database reloads it)', () => {
    expect(tablePath(key)).toBe('d1/db3/k:user:42:name')
    expect(tablePath(key).startsWith(tablePath(redisRef('d1', 'C', 3)) + '/')).toBe(true)
  })
  it('keyTabTitle: short names whole, long ones keep their tail, binary ones are escaped', () => {
    expect(keyTabTitle('counter')).toBe('counter')
    expect(keyTabTitle('a'.repeat(28))).toBe('a'.repeat(28))
    const long = 'tenant:1234567890:session:abcdefghijklmnop'
    expect(keyTabTitle(long)).toBe('…' + long.slice(-27))
    expect(keyTabTitle(long)).toHaveLength(28)
    expect(keyTabTitle('\u0000b64:' + 'x')).toBeTruthy()
  })
  it('type labels for the tree', () => {
    expect(typeLabel('rtype')).toBeTruthy()
    expect(typeLabel('rfolder')).toBe('Key folder')
    for (const t of ['string', 'hash', 'list', 'set', 'zset', 'stream', 'other']) expect(typeLabel('key-' + t)).toBeTruthy()
  })
})
