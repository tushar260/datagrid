import { describe, expect, it } from 'vitest'
import { CACHE_INDEX_PREFIXES, CACHE_MAX_BYTES, cacheKeys, compactKeyTree, expandKeyTree, type RedisKeyTree } from '../src/shared'

describe('cacheKeys', () => {
  it('are short, plain and distinct per level', () => {
    const keys = [
      cacheKeys.pgDbs, cacheKeys.pgRoles, cacheKeys.pgTablespaces, cacheKeys.pgSchemas('app'), cacheKeys.pgTableNames('app'),
      cacheKeys.pgTables('app', 'public'), cacheKeys.ddbTables, cacheKeys.redisDbs, cacheKeys.redisTree(0)
    ]
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[\x20-\x7e]{1,200}$/)
  })
  it('names are URI-encoded (a colon, slash or unicode in a name cannot blur two keys)', () => {
    expect(cacheKeys.pgSchemas('a:b')).toBe('pg:schemas:a%3Ab')
    expect(cacheKeys.pgTables('d/b', 'ünï')).toBe('pg:tables:d%2Fb:%C3%BCn%C3%AF')
    expect(cacheKeys.pgTables('a:b', 'c')).not.toBe(cacheKeys.pgTables('a', 'b:c'))
  })
  it('pgTablesOf is the prefix of every table list of that database only', () => {
    expect(cacheKeys.pgTables('app', 'x').startsWith(cacheKeys.pgTablesOf('app'))).toBe(true)
    expect(cacheKeys.pgTables('apple', 'x').startsWith(cacheKeys.pgTablesOf('app'))).toBe(false)
  })
  it('the ⌘O index prefixes cover the name lists and never the (big) key trees', () => {
    const covered = (k: string): boolean => CACHE_INDEX_PREFIXES.some((p) => k.startsWith(p))
    for (const k of [cacheKeys.pgDbs, cacheKeys.pgSchemas('a'), cacheKeys.pgTables('a', 'b'), cacheKeys.ddbTables, cacheKeys.redisDbs]) expect(covered(k), k).toBe(true)
    for (const k of [cacheKeys.redisTree(0), cacheKeys.pgRoles, cacheKeys.pgTablespaces, cacheKeys.pgTableNames('a')]) expect(covered(k), k).toBe(false)
  })
  it('the size cap is 40 MB', () => expect(CACHE_MAX_BYTES).toBe(40 * 1024 * 1024))
})

describe('compact key trees', () => {
  const tree: RedisKeyTree = {
    complete: true,
    dbsize: 5,
    keys: [
      { key: 'a:1', type: 'string' }, { key: 'a:2', type: 'string' }, { key: 'l', type: 'list' }, { key: '\u0000b64:/w==', type: 'hash' }, { key: 'z', type: 'zset' }
    ]
  }
  it('groups the key names by type (no repeated objects)', () => {
    const c = compactKeyTree(tree)
    expect(c).toEqual({ complete: true, dbsize: 5, types: { string: ['a:1', 'a:2'], list: ['l'], hash: ['\u0000b64:/w=='], zset: ['z'] } })
  })
  it('round-trips every key with its type (order within a type kept)', () => {
    const back = expandKeyTree(JSON.parse(JSON.stringify(compactKeyTree(tree))))!
    const norm = (k: RedisKeyTree['keys']): string[] => k.map((x) => x.type + '|' + x.key).sort()
    expect(norm(back.keys)).toEqual(norm(tree.keys))
    expect(back.complete).toBe(true)
    expect(back.dbsize).toBe(5)
    expect(back.keys.filter((k) => k.type === 'string').map((k) => k.key)).toEqual(['a:1', 'a:2'])
  })
  it('an incomplete / empty tree round-trips', () => {
    expect(expandKeyTree(compactKeyTree({ keys: [], complete: false, dbsize: 9 }))).toEqual({ keys: [], complete: false, dbsize: 9 })
  })
  it('is much smaller than the plain form', () => {
    const big: RedisKeyTree = { complete: true, dbsize: 1000, keys: Array.from({ length: 1000 }, (_, i) => ({ key: 'k' + i, type: 'string' as const })) }
    expect(JSON.stringify(compactKeyTree(big)).length).toBeLessThan(JSON.stringify(big).length * 0.6)
  })
  it.each([null, undefined, 5, 'x', [], {}, { complete: 'yes', dbsize: 1, types: {} }, { complete: true, dbsize: '1', types: {} }, { complete: true, dbsize: 1 },
    { complete: true, dbsize: 1, types: { string: 'abc' } }, { complete: true, dbsize: 1, types: { string: [1] } }])('malformed %j -> null (a cache miss)', (v) => {
    expect(expandKeyTree(v)).toBeNull()
  })
})
