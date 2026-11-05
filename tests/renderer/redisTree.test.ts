import { describe, expect, it } from 'vitest'
import { REDIS_BIN_PREFIX, type RedisTreeType } from '../../src/shared'
import { buildKeyTree, EMPTY_LABEL, keysUnder, prefixPattern, TYPE_GROUPS, type KeyEntry, type KeyFolder } from '../../src/renderer/src/lib/redisTree'

const ks = (names: string[], type: RedisTreeType = 'string'): { key: string; type: RedisTreeType }[] => names.map((key) => ({ key, type }))
const names = (l: KeyEntry[]): string[] => l.map((e) => (e.kind === 'folder' ? e.name + '/' : e.name))
const folder = (l: KeyEntry[], name: string): KeyFolder => {
  const f = l.find((e): e is KeyFolder => e.kind === 'folder' && e.name === name)
  if (!f) throw new Error(`no folder ${name} in ${names(l).join(',')}`)
  return f
}
const all = (groups: ReturnType<typeof buildKeyTree>): string[] => groups.flatMap((g) => keysUnder(g.children)).sort()

describe('type groups', () => {
  it('only types that have keys, in DataGrip order, with their counts', () => {
    const g = buildKeyTree(
      [
        ...ks(['h1', 'h2'], 'hash'), ...ks(['s1', 's2', 's3']), ...ks(['z'], 'zset'), ...ks(['l'], 'list'),
        ...ks(['x'], 'stream'), ...ks(['m'], 'other'), ...ks(['t'], 'set')
      ],
      ':'
    )
    expect(g.map((x) => x.label)).toEqual(['strings', 'lists', 'sets', 'sorted sets', 'hash tables', 'streams', 'other'])
    expect(g.map((x) => x.count)).toEqual([3, 1, 1, 1, 2, 1, 1])
    expect(g.map((x) => x.id)).toEqual(['strings', 'lists', 'sets', 'zsets', 'hashes', 'streams', 'other'])
  })

  it('no keys -> no groups', () => {
    expect(buildKeyTree([], ':')).toEqual([])
  })

  it('a single type shows just that folder', () => {
    expect(buildKeyTree(ks(['a'], 'list'), ':').map((x) => x.label)).toEqual(['lists'])
  })

  it('scan types: everything but "other" can be filtered by SCAN ... TYPE', () => {
    expect(TYPE_GROUPS.filter((x) => x.scanType === null).map((x) => x.type)).toEqual(['other'])
    expect(TYPE_GROUPS.map((x) => x.scanType).filter(Boolean)).toEqual(['string', 'list', 'set', 'zset', 'hash', 'stream'])
  })
})

describe('grouping by delimiter', () => {
  it('user:42:profile becomes user / 42 / profile with counts on the folders', () => {
    const [g] = buildKeyTree(ks(['user:42:profile', 'user:42:name', 'user:7:profile', 'plain']), ':')
    expect(names(g.children)).toEqual(['user/', 'plain'])
    const user = folder(g.children, 'user')
    expect(user.count).toBe(3)
    expect(user.prefix).toBe('user:')
    expect(names(user.children)).toEqual(['7/', '42/'])
    const f42 = folder(user.children, '42')
    expect(f42.count).toBe(2)
    expect(f42.prefix).toBe('user:42:')
    expect(f42.children).toEqual([
      { kind: 'key', name: 'name', key: 'user:42:name', type: 'string' },
      { kind: 'key', name: 'profile', key: 'user:42:profile', type: 'string' }
    ])
  })

  it('folders first (natural, case-insensitive order), then keys', () => {
    const [g] = buildKeyTree(ks(['c:1', 'a:1', 'a10:1', 'a2:1', 'zeta', 'Alpha', 'beta', 'B:1']), ':')
    expect(names(g.children)).toEqual(['a/', 'a2/', 'a10/', 'B/', 'c/', 'Alpha', 'beta', 'zeta'])
  })

  it('names differing only by case are both kept (deterministic order)', () => {
    const [g] = buildKeyTree(ks(['B:1', 'b:2']), ':')
    expect(g.children).toHaveLength(2)
    expect(g.children.map((e) => (e as KeyFolder).count)).toEqual([1, 1])
  })

  it('a key that is also a prefix is a leaf next to the folder of the same name', () => {
    const [g] = buildKeyTree(ks(['a', 'a:b', 'a:b:c']), ':')
    expect(names(g.children)).toEqual(['a/', 'a'])
    const a = folder(g.children, 'a')
    // "a:b" is a key and a prefix: leaf `b` beside folder `b`
    expect(names(a.children)).toEqual(['b/', 'b'])
    expect(keysUnder(g.children).sort()).toEqual(['a', 'a:b', 'a:b:c'])
    const b = folder(a.children, 'b')
    expect(b.children).toEqual([{ kind: 'key', name: 'c', key: 'a:b:c', type: 'string' }])
  })

  it('a key that is a prefix: both the leaf and the folder exist', () => {
    const [g] = buildKeyTree(ks(['x:y', 'x:y:z']), ':')
    const x = folder(g.children, 'x')
    expect(names(x.children)).toEqual(['y/', 'y'])
  })

  it('multi-character delimiters', () => {
    const [g] = buildKeyTree(ks(['a::b::c', 'a::d', 'a:e', 'a:::f']), '::')
    expect(names(g.children)).toEqual(['a/', 'a:e'])
    const a = folder(g.children, 'a')
    expect(a.prefix).toBe('a::')
    // the delimiter is matched left to right: a:::f is `a::` + `:f`, a leaf named ":f" under a
    expect(a.children.map((e) => e.name)).toEqual(['b', ':f', 'd'])
    expect(keysUnder(g.children).sort()).toEqual(['a:::f', 'a::b::c', 'a::d', 'a:e'])
  })

  it.each([['/'], ['.'], ['|'], ['->'], ['::'], [' '], ['é']])('delimiter %j groups and loses nothing', (d) => {
    const keys = [`a${d}b${d}c`, `a${d}b`, `a${d}d`, 'plain', `z${d}`, `${d}lead`]
    const g = buildKeyTree(ks(keys), d)
    expect(all(g)).toEqual([...keys].sort())
    const a = folder(g[0].children, 'a')
    expect(a.prefix).toBe(`a${d}`)
    expect(a.count).toBe(3)
  })

  it('a blank delimiter lists the keys flat under their type', () => {
    const [g] = buildKeyTree(ks(['a:b', 'c', 'a:b:c']), '')
    expect(g.children.every((e) => e.kind === 'key')).toBe(true)
    expect(names(g.children)).toEqual(['a:b', 'a:b:c', 'c'])
  })

  it('a delimiter that never occurs is the same as flat', () => {
    const [g] = buildKeyTree(ks(['a:b', 'c']), '|')
    expect(names(g.children)).toEqual(['a:b', 'c'])
  })

  it('types group separately: the same prefix exists in each type with its own count', () => {
    const g = buildKeyTree([...ks(['u:1', 'u:2']), ...ks(['u:3'], 'hash')], ':')
    expect(folder(g[0].children, 'u').count).toBe(2)
    expect(folder(g[1].children, 'u').count).toBe(1)
  })
})

describe('empty segments', () => {
  it.each([
    [['a::b'], 'a'],
    [[':a'], ''],
    [['a:'], 'a'],
    [['::'], ''],
    [[':'], ''],
    [['a:::b'], 'a']
  ])('%j appears exactly once and does not crash', (keys) => {
    const g = buildKeyTree(ks(keys), ':')
    expect(all(g)).toEqual([...keys].sort())
  })

  it('a::b is a / (empty) / b', () => {
    const [g] = buildKeyTree(ks(['a::b']), ':')
    const a = folder(g.children, 'a')
    const e = folder(a.children, EMPTY_LABEL)
    expect(e.prefix).toBe('a::')
    expect(e.children).toEqual([{ kind: 'key', name: 'b', key: 'a::b', type: 'string' }])
  })

  it('a trailing delimiter gives a leaf named (empty); a leading one a folder named (empty)', () => {
    const [g] = buildKeyTree(ks(['a:', ':b']), ':')
    const a = folder(g.children, 'a')
    expect(a.children).toEqual([{ kind: 'key', name: EMPTY_LABEL, key: 'a:', type: 'string' }])
    const lead = folder(g.children, EMPTY_LABEL)
    expect(lead.prefix).toBe(':')
    expect(lead.children).toEqual([{ kind: 'key', name: 'b', key: ':b', type: 'string' }])
  })

  it('an empty key name is a single leaf', () => {
    const [g] = buildKeyTree(ks(['']), ':')
    expect(g.children).toEqual([{ kind: 'key', name: EMPTY_LABEL, key: '', type: 'string' }])
  })

  it('a literal "(empty)" segment does not merge with a real empty one', () => {
    const [g] = buildKeyTree(ks(['a::x', 'a:(empty):y']), ':')
    const a = folder(g.children, 'a')
    expect(a.children).toHaveLength(2)
    expect(new Set(a.children.map((c) => (c as KeyFolder).prefix)).size).toBe(2)
  })
})

describe('unicode and binary names', () => {
  it('unicode keys group and sort', () => {
    const keys = ['用户:1:名', '用户:2:名', 'émoji:😀:x', 'ünï:a']
    const g = buildKeyTree(ks(keys), ':')
    expect(all(g)).toEqual([...keys].sort())
    expect(folder(g[0].children, '用户').count).toBe(2)
  })

  it('binary names group by their escaped display name but keep the encoded key', () => {
    const key = REDIS_BIN_PREFIX + Buffer.from([0xff, 0x3a, 0x01]).toString('base64')
    const [g] = buildKeyTree(ks([key, 'a:b']), ':')
    expect(keysUnder(g.children).sort()).toEqual([key, 'a:b'].sort())
  })
})

describe('prefixPattern / keysUnder', () => {
  it.each([
    ['user:42:', 'user:42:*'],
    ['a*b:', 'a\\*b:*'],
    ['x[1]:', 'x\\[1\\]:*'],
    ['q?:', 'q\\?:*'],
    ['back\\slash:', 'back\\\\slash:*']
  ])('%j -> %j', (prefix, pat) => expect(prefixPattern(prefix)).toBe(pat))

  it('binary folders get a binary pattern: REDIS_BIN_PREFIX + base64 of the real glob bytes', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x3a, 0x3a, 0x00, 0x41])
    const key = REDIS_BIN_PREFIX + bytes.toString('base64')
    const [g] = buildKeyTree(ks([key, 'text:x']), ':')
    const f = folder(g.children, '\\xff\\xfe')
    expect(f.binary).toBe(true)
    expect(folder(g.children, 'text').binary).toBeUndefined()
    const pat = prefixPattern(f.prefix, f.binary)
    expect(pat.startsWith(REDIS_BIN_PREFIX)).toBe(true)
    expect([...Buffer.from(pat.slice(REDIS_BIN_PREFIX.length), 'base64')]).toEqual([0xff, 0xfe, 0x3a, 0x2a])
    // deeper folders of the same key are flagged too
    expect(folder(f.children, EMPTY_LABEL).binary).toBe(true)
    // glob characters and backslashes in the bytes are escaped; escapes of the display name are undone
    const odd = Buffer.from(prefixPattern('\\x01*\\\\a\\"\\n:', true).slice(REDIS_BIN_PREFIX.length), 'base64')
    expect([...odd]).toEqual([1, 0x5c, 0x2a, 0x5c, 0x5c, 0x61, 0x22, 0x0a, 0x3a, 0x2a])
    expect(prefixPattern('é:', true).slice(REDIS_BIN_PREFIX.length)).toBe(Buffer.from('\u00c3\u00a9:*', 'latin1').toString('base64'))
    expect(prefixPattern('user:')).toBe('user:*') // text folders are unchanged
  })

  it('keysUnder lists everything beneath a folder', () => {
    const [g] = buildKeyTree(ks(['a:1', 'a:b:2', 'a:b:3', 'c']), ':')
    expect(keysUnder(folder(g.children, 'a').children).sort()).toEqual(['a:1', 'a:b:2', 'a:b:3'])
  })
})

describe('invariants on random data', () => {
  const rnd = (seed: number): (() => number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  it('every key exactly once, folder counts add up, prefixes end with the delimiter', () => {
    const r = rnd(7)
    const segs = ['a', 'b', '', 'C', '10', '2', '(empty)', 'ü']
    const types: RedisTreeType[] = ['string', 'list', 'set', 'zset', 'hash', 'stream', 'other']
    const keys = new Set<string>()
    while (keys.size < 3000) {
      const n = 1 + Math.floor(r() * 5)
      keys.add(Array.from({ length: n }, () => segs[Math.floor(r() * segs.length)]).join(r() < 0.1 ? '::' : ':'))
    }
    const list = [...keys].map((key) => ({ key, type: types[Math.floor(r() * types.length)] }))
    for (const d of [':', '::', '', ':a']) {
      const g = buildKeyTree(list, d)
      expect(all(g)).toEqual([...keys].sort())
      expect(g.reduce((n, x) => n + x.count, 0)).toBe(list.length)
      const check = (l: KeyEntry[]): number =>
        l.reduce((n, e) => {
          if (e.kind === 'key') return n + 1
          expect(e.prefix.endsWith(d)).toBe(true)
          const inside = check(e.children)
          expect(inside).toBe(e.count)
          return n + inside
        }, 0)
      for (const x of g) expect(check(x.children)).toBe(x.count)
    }
  })
})

describe('performance', () => {
  it('100,000 keys build in well under a second', () => {
    const keys: { key: string; type: RedisTreeType }[] = []
    for (let i = 0; i < 100_000; i++) keys.push({ key: `app:${i % 50}:item:${i % 997}:${i}`, type: i % 3 ? 'string' : 'hash' })
    const t0 = performance.now()
    const g = buildKeyTree(keys, ':')
    const ms = performance.now() - t0
    expect(g.reduce((n, x) => n + x.count, 0)).toBe(100_000)
    expect(ms).toBeLessThan(1500)
  })

  it('100,000 keys in ONE folder (flat) also sort fast', () => {
    const keys = Array.from({ length: 100_000 }, (_, i) => ({ key: `k${i}`, type: 'string' as const }))
    const t0 = performance.now()
    const [g] = buildKeyTree(keys, ':')
    expect(g.children).toHaveLength(100_000)
    expect(performance.now() - t0).toBeLessThan(2500)
  })
})
