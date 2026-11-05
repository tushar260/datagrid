import { REDIS_BIN_PREFIX, redisDisplayName } from '../../../shared'
import type { RedisKeyInfo, RedisReply, RedisValue } from '../../../shared'

/** Pure helpers of the Redis views (unit tested directly). */

export const REDIS_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const

/** Types whose items can be edited key by key in the detail pane. */
export const EDITABLE_ITEM_TYPES = ['hash', 'list', 'set', 'zset'] as const

export const dbName = (db: number): string => `db${db}`

/** CSS class of a type badge (`rt-string`, ..., `rt-other` for module types). */
export const typeClass = (type: string): string => 'rt rt-' + ((REDIS_TYPES as readonly string[]).includes(type) ? type : 'other')

/** Time to live for the grid: ∞ = no expiry, otherwise the two largest units (`2d 3h`, `5m 10s`, `850 ms`). */
export function fmtTtl(ms: number): string {
  if (ms === -1) return '∞'
  if (ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d) return h ? `${d}d ${h}h` : `${d}d`
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  if (m) return sec ? `${m}m ${sec}s` : `${m}m`
  return `${sec}s`
}

/**
 * The TTL box of the detail pane: `90`, `90s`, `5m`, `2h`, `1d`, `1d 2h 30m` -> seconds; empty / `none` / `∞` /
 * `persist` -> null (no expiry); anything else -> undefined (invalid).
 */
export function parseTtlInput(text: string): number | null | undefined {
  const t = text.trim().toLowerCase()
  if (!t || t === 'none' || t === '∞' || t === 'persist' || t === '-1') return null
  if (/^\d+$/.test(t)) return Number(t) >= 1 ? Number(t) : undefined
  const parts = t.split(/\s+/)
  let total = 0
  for (const p of parts) {
    const m = /^(\d+)([smhd])$/.exec(p)
    if (!m) return undefined
    total += Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd']
  }
  return total >= 1 && Number.isSafeInteger(total) ? total : undefined
}

/** The TTL box text for an existing TTL: whole seconds (what Redis stores them as in EXPIRE), or empty for none. */
export const ttlInputOf = (ms: number): string => (ms >= 0 ? String(Math.max(1, Math.round(ms / 1000))) : '')

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

/** Pretty-printed JSON when the text is a JSON object or array, else null. */
export function prettyJson(text: string): string | null {
  const t = text.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

/** Hex dump line text of base64 data: `de ad be ef` (first `max` bytes). */
export function base64Hex(b64: string, max = 4096): string {
  let bin = ''
  try {
    bin = atob(b64)
  } catch {
    return ''
  }
  const out: string[] = []
  for (let i = 0; i < Math.min(bin.length, max); i++) out.push(bin.charCodeAt(i).toString(16).padStart(2, '0'))
  return out.join(' ') + (bin.length > max ? ' …' : '')
}

/** The name as shown in a grid cell (binary names as `\xNN` escapes). */
export const keyLabel = redisDisplayName

/** Case-insensitive sort-stable merge of key pages: later pages append, a repeated key keeps its first position (SCAN can repeat). */
export function mergeKeys(existing: RedisKeyInfo[], more: RedisKeyInfo[]): RedisKeyInfo[] {
  const seen = new Map(existing.map((k, i) => [k.key, i]))
  const out = existing.slice()
  for (const k of more) {
    const at = seen.get(k.key)
    if (at === undefined) {
      seen.set(k.key, out.length)
      out.push(k)
    } else out[at] = k
  }
  return out
}

/** Plain text of a reply (what Copy gives): scalars as is, arrays one numbered line per item, nested ones indented. */
export function replyText(r: RedisReply, depth = 0): string {
  const pad = '   '.repeat(depth)
  switch (r.kind) {
    case 'nil':
      return '(nil)'
    case 'integer':
      return `(integer) ${r.value}`
    case 'status':
    case 'bulk':
      return r.value
    case 'error':
      return `(error) ${r.message}`
    case 'array':
      if (!r.items.length) return '(empty array)'
      return r.items.map((x, i) => `${pad}${i + 1}) ${x.kind === 'array' ? '\n' + replyText(x, depth + 1) : replyText(x, depth + 1)}`).join('\n')
  }
}

/** Redis glob special characters. */
const GLOB = /[*?[\]\\]/

/** The MATCH pattern for what was typed in the pattern box: a plain word means "contains" (`*word*`), anything with glob syntax is used as is. */
export const effectivePattern = (typed: string): string => {
  // surrounding blanks are noise, except one that was escaped on purpose (`\ `, see exactPattern)
  const t = typed.replace(/^\s+/, '').replace(/(?<!\\)\s+$/, '')
  return !t ? '' : t.startsWith(REDIS_BIN_PREFIX) || GLOB.test(t) ? t : `*${t}*`
}

/** Escapes glob syntax so the text matches itself. */
export const escapeGlob = (key: string): string => key.replace(/[*?[\]\\]/g, '\\$&')

/**
 * A pattern that matches exactly `key` (to jump to a freshly created / renamed key). It always contains a backslash:
 * a plain word would be read as "contains", and a trailing blank would be trimmed.
 */
export const exactPattern = (key: string): string => {
  const e = escapeGlob(key).replace(/\s$/, '\\$&')
  return e.startsWith('\\') ? e : '\\' + e // `\x` matches a literal x
}

/**
 * What "Copy value" puts on the clipboard: a string as is (`edited` = the editor's current text when it differs), binary as
 * base64, collections as pretty JSON (hash -> object, list / set -> array, zset -> [{member, score}], stream -> entries).
 */
export const valueCopyText = (v: RedisValue, edited?: string): string => {
  switch (v.kind) {
    case 'string':
      return v.binary ? v.base64 : edited ?? v.text
    case 'hash':
      return JSON.stringify(Object.fromEntries(v.items.map((x) => [x.field, x.value])), null, 2)
    case 'list':
    case 'set':
    case 'zset':
      return JSON.stringify(v.items, null, 2)
    case 'stream':
      return JSON.stringify(v.entries.map((e) => ({ id: e.id, fields: Object.fromEntries(e.fields.map((f) => [f.field, f.value])) })), null, 2)
    default:
      return ''
  }
}
