import { REDIS_BIN_PREFIX, isRedisBinaryName, redisDisplayName, type RedisTreeType } from '../../../shared'
import { escapeGlob } from './redis'

/**
 * The explorer's view of a Redis database: keys grouped by type (strings, lists, ...), then into nested folders by a key
 * delimiter (`user:42:profile` -> user / 42 / profile). Pure and fast: one pass builds a trie (O(total key length)),
 * then every folder's children are sorted once (folders first, natural case-insensitive order, then keys).
 *
 * Every key appears exactly once. Empty segments (`a::b`, `:a`, `a:`) become folders / leaves labelled "(empty)" so
 * nothing is lost, and a key that is also the prefix of others (`a` and `a:b`) is a leaf next to the folder `a`.
 */

export const EMPTY_LABEL = '(empty)'

export interface TypeMeta {
  type: RedisTreeType
  /** node id segment */
  id: string
  /** folder label */
  label: string
  /** the TYPE name SCAN ... TYPE understands (null: no filter possible for "other") */
  scanType: string | null
}

/** Display order of the type folders. */
export const TYPE_GROUPS: TypeMeta[] = [
  { type: 'string', id: 'strings', label: 'strings', scanType: 'string' },
  { type: 'list', id: 'lists', label: 'lists', scanType: 'list' },
  { type: 'set', id: 'sets', label: 'sets', scanType: 'set' },
  { type: 'zset', id: 'zsets', label: 'sorted sets', scanType: 'zset' },
  { type: 'hash', id: 'hashes', label: 'hash tables', scanType: 'hash' },
  { type: 'stream', id: 'streams', label: 'streams', scanType: 'stream' },
  { type: 'other', id: 'other', label: 'other', scanType: null }
]

export interface KeyLeaf {
  kind: 'key'
  /** label: the last segment */
  name: string
  /** the full key (as sent over IPC: binary names stay encoded) */
  key: string
  type: RedisTreeType
}

export interface KeyFolder {
  kind: 'folder'
  name: string
  /** the full display name of everything above and including this folder, with the trailing delimiter: `user:42:` */
  prefix: string
  /** number of keys beneath */
  count: number
  /** true when a binary-named key is beneath: `prefix` is then an escaped display name (see `prefixPattern`) */
  binary?: boolean
  /** sorted: folders first, then keys */
  children: KeyEntry[]
}

export type KeyEntry = KeyFolder | KeyLeaf

export interface TypeGroup extends TypeMeta {
  count: number
  children: KeyEntry[]
}

interface Building {
  name: string
  prefix: string
  count: number
  binary: boolean
  folders: Map<string, Building>
  leaves: KeyLeaf[]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
/** natural, case-insensitive; ties fall back to code units so the order is deterministic */
const cmp = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)

const newNode = (name: string, prefix: string): Building => ({ name, prefix, count: 0, binary: false, folders: new Map(), leaves: [] })

function finish(b: Building): KeyFolder {
  const folders: KeyFolder[] = []
  for (const f of b.folders.values()) folders.push(finish(f))
  folders.sort((x, y) => cmp(x.name, y.name))
  const leaves = b.leaves.sort((x, y) => cmp(x.name, y.name) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  return { kind: 'folder', name: b.name, prefix: b.prefix, count: b.count, ...(b.binary ? { binary: true } : {}), children: [...folders, ...leaves] }
}

/**
 * Groups `keys` by type and delimiter. A blank delimiter lists the keys flat under their type. Only types with keys are
 * returned, in TYPE_GROUPS order.
 */
export function buildKeyTree(keys: { key: string; type: RedisTreeType }[], delimiter: string): TypeGroup[] {
  const roots = new Map<RedisTreeType, Building>()
  for (const { key, type } of keys) {
    let root = roots.get(type)
    if (!root) roots.set(type, (root = newNode('', '')))
    root.count++
    const shown = redisDisplayName(key)
    const bin = isRedisBinaryName(key)
    let node = root
    let from = 0
    if (delimiter) {
      for (;;) {
        const at = shown.indexOf(delimiter, from)
        if (at < 0) break
        const seg = shown.slice(from, at)
        let next = node.folders.get(seg)
        if (!next) node.folders.set(seg, (next = newNode(seg || EMPTY_LABEL, shown.slice(0, at + delimiter.length))))
        next.count++
        if (bin) next.binary = true
        node = next
        from = at + delimiter.length
      }
    }
    const last = shown.slice(from)
    node.leaves.push({ kind: 'key', name: last || EMPTY_LABEL, key, type })
  }
  const out: TypeGroup[] = []
  for (const meta of TYPE_GROUPS) {
    const root = roots.get(meta.type)
    if (!root) continue
    out.push({ ...meta, count: root.count, children: finish(root).children })
  }
  return out
}

/** The bytes a `redisDisplayName` text stands for: its backslash escapes (xNN, backslash, quote, n, r, t) undone, the rest as UTF-8. */
function displayBytes(shown: string): number[] {
  const out: number[] = []
  const enc = new TextEncoder()
  for (let i = 0; i < shown.length; ) {
    if (shown[i] === '\\') {
      const n = shown[i + 1]
      const hex = n === 'x' ? shown.slice(i + 2, i + 4) : ''
      if (/^[0-9a-f]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 4; continue }
      const simple: Record<string, number> = { '\\': 92, '"': 34, n: 10, r: 13, t: 9 }
      if (n !== undefined && n in simple) { out.push(simple[n]); i += 2; continue }
    }
    const cp = shown.codePointAt(i)!
    out.push(...enc.encode(String.fromCodePoint(cp)))
    i += cp > 0xffff ? 2 : 1
  }
  return out
}

/**
 * A SCAN pattern matching the keys beneath a folder (`user:42:` -> `user:42:*`; special characters are escaped). A folder
 * with binary-named keys has an escaped display name as prefix; its pattern is sent like a binary name
 * (REDIS_BIN_PREFIX + base64 of the glob's bytes) so the server matches the real bytes.
 */
export const prefixPattern = (prefix: string, binary = false): string => {
  if (!binary) return escapeGlob(prefix) + '*'
  let s = ''
  for (const b of displayBytes(prefix)) s += (b === 42 || b === 63 || b === 91 || b === 93 || b === 92 ? '\\' : '') + String.fromCharCode(b)
  return REDIS_BIN_PREFIX + btoa(s + '*')
}

/** Every key beneath a folder / group (depth-first), e.g. for tests and "copy". */
export function keysUnder(entries: KeyEntry[]): string[] {
  const out: string[] = []
  const walk = (list: KeyEntry[]): void => {
    for (const e of list) e.kind === 'key' ? out.push(e.key) : walk(e.children)
  }
  walk(entries)
  return out
}
