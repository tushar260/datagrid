import { describe, expect, it } from 'vitest'
import {
  dsKind, isRedisBinaryName, redisDelimiter, redisDisplayName, REDIS_BIN_PREFIX, REDIS_DEFAULT_DELIMITER, REDIS_DEFAULT_PORT, REDIS_KEYTREE_MAX,
  REDIS_MAX_DB, REDIS_MAX_DELIMITER, validateRedisConfig
} from '../src/shared'

describe('dsKind', () => {
  it('knows redis; unknown or missing kinds are still postgres', () => {
    expect(dsKind({ kind: 'redis' })).toBe('redis')
    expect(dsKind({ kind: 'postgres' })).toBe('postgres')
    expect(dsKind({})).toBe('postgres')
    expect(dsKind(null)).toBe('postgres')
    expect(dsKind({ kind: 'mongo' as never })).toBe('postgres')
  })
})

describe('validateRedisConfig', () => {
  const ok = { host: 'localhost', port: 6379, db: 0 }
  it('accepts sensible settings', () => {
    expect(validateRedisConfig(ok)).toBeNull()
    expect(validateRedisConfig({ ...ok, host: ' redis.example.com ', port: 65535, db: REDIS_MAX_DB })).toBeNull()
    expect(REDIS_DEFAULT_PORT).toBe(6379)
  })
  it.each([
    [{ host: '' }, /Host is required/],
    [{ host: '   ' }, /Host is required/],
    [{ host: 'a b' }, /spaces/],
    [{ port: 0 }, /Port/],
    [{ port: 65536 }, /Port/],
    [{ port: 6379.5 }, /Port/],
    [{ port: NaN }, /Port/],
    [{ db: -1 }, /Database/],
    [{ db: 256 }, /Database/],
    [{ db: 1.2 }, /Database/],
    [{ db: NaN }, /Database/]
  ])('rejects %j', (patch, re) => {
    expect(validateRedisConfig({ ...ok, ...patch })).toMatch(re)
  })
  it('a missing host is "required", not a crash', () => {
    expect(validateRedisConfig({ port: 1, db: 0 } as never)).toMatch(/Host is required/)
  })
})

describe('binary names', () => {
  const bin = (bytes: number[]): string => REDIS_BIN_PREFIX + btoa(String.fromCharCode(...bytes))
  it('recognises the prefix', () => {
    expect(isRedisBinaryName(bin([1, 2]))).toBe(true)
    expect(isRedisBinaryName('user:1')).toBe(false)
    expect(isRedisBinaryName('')).toBe(false)
  })
  it('text is shown as is', () => {
    expect(redisDisplayName('user:1 é')).toBe('user:1 é')
  })
  it('binary names are shown as \\xNN escapes with printable ASCII kept', () => {
    expect(redisDisplayName(bin([0x61, 0xff, 0x00, 0x62]))).toBe('a\\xff\\x00b')
    expect(redisDisplayName(bin([0x22, 0x5c, 0x0a, 0x0d, 0x09, 0x80]))).toBe('\\"\\\\\\n\\r\\t\\x80')
  })
  it('a corrupt payload falls back to the raw text instead of throwing', () => {
    expect(redisDisplayName(REDIS_BIN_PREFIX + '***not base64***')).toBe(REDIS_BIN_PREFIX + '***not base64***')
  })
})

describe('key delimiter', () => {
  const ok = { host: 'localhost', port: 6379, db: 0 }
  it('defaults to none (a flat key list) when absent; a typed separator is used as is', () => {
    expect(REDIS_DEFAULT_DELIMITER).toBe('')
    expect(redisDelimiter({})).toBe('')
    expect(redisDelimiter(undefined)).toBe('')
    expect(redisDelimiter(null)).toBe('')
    expect(redisDelimiter({ keyDelimiter: ':' })).toBe(':')
    expect(redisDelimiter({ keyDelimiter: '' })).toBe('')
    expect(redisDelimiter({ keyDelimiter: '/' })).toBe('/')
    expect(redisDelimiter({ keyDelimiter: '::' })).toBe('::')
  })
  it('the tree is capped at 100,000 keys', () => expect(REDIS_KEYTREE_MAX).toBe(100_000))
  it.each([[undefined], [''], [':'], ['/'], ['::'], ['->'], [' '], ['12345678'], ['é'], ['\\']])('%j is valid', (d) => {
    expect(validateRedisConfig({ ...ok, keyDelimiter: d })).toBeNull()
  })
  it('longer than the maximum, non-text and line breaks are rejected', () => {
    expect(REDIS_MAX_DELIMITER).toBe(8)
    expect(validateRedisConfig({ ...ok, keyDelimiter: '123456789' })).toMatch(/at most 8/)
    expect(validateRedisConfig({ ...ok, keyDelimiter: 5 as never })).toMatch(/must be text/)
    expect(validateRedisConfig({ ...ok, keyDelimiter: null as never })).toMatch(/must be text/)
    expect(validateRedisConfig({ ...ok, keyDelimiter: 'a\nb' })).toMatch(/line breaks/)
    expect(validateRedisConfig({ ...ok, keyDelimiter: '\r' })).toMatch(/line breaks/)
    expect(validateRedisConfig({ ...ok, keyDelimiter: '\u0000' })).toMatch(/line breaks/)
  })
})
