import type { RedisReply } from '../shared'

/**
 * Console support for Redis: splitting a command line into arguments with redis-cli's quoting rules, refusing the commands
 * that cannot work on a pooled connection, and turning raw replies into the plain `RedisReply` the renderer draws.
 * Pure (no sockets), so it is unit tested directly.
 */

const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\0' || c === '\f' || c === '\v'
const isHex = (c: string | undefined): boolean => !!c && /^[0-9a-fA-F]$/.test(c)

/**
 * Splits one command line like redis-cli (sdssplitargs): whitespace separates arguments; "double quotes" understand
 * \n \r \t \b \a \xHH \" \\ (any other \c is c); 'single quotes' only understand \'. A closing quote must be followed by
 * whitespace. Arguments are Buffers because \xHH can produce arbitrary bytes. Throws on unbalanced quotes.
 */
export function splitArgs(line: string): Buffer[] {
  const out: Buffer[] = []
  let i = 0
  const n = line.length
  for (;;) {
    while (i < n && isSpace(line[i])) i++
    if (i >= n) return out
    const parts: Buffer[] = []
    let text = ''
    const flush = (): void => {
      if (text) parts.push(Buffer.from(text, 'utf8'))
      text = ''
    }
    let inDq = false
    let inSq = false
    let done = false
    while (!done) {
      const c = line[i]
      if (inDq) {
        if (i >= n) throw new Error('Unbalanced quotes in the command')
        if (c === '\\' && line[i + 1] === 'x' && isHex(line[i + 2]) && isHex(line[i + 3])) {
          flush()
          parts.push(Buffer.from([parseInt(line.slice(i + 2, i + 4), 16)]))
          i += 3
        } else if (c === '\\' && i + 1 < n) {
          i++
          const e = line[i]
          text += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'b' ? '\b' : e === 'a' ? '\x07' : e
        } else if (c === '"') {
          if (i + 1 < n && !isSpace(line[i + 1])) throw new Error('Unbalanced quotes in the command (a closing quote must be followed by a space)')
          done = true
        } else text += c
      } else if (inSq) {
        if (i >= n) throw new Error('Unbalanced quotes in the command')
        if (c === '\\' && line[i + 1] === "'") {
          i++
          text += "'"
        } else if (c === "'") {
          if (i + 1 < n && !isSpace(line[i + 1])) throw new Error('Unbalanced quotes in the command (a closing quote must be followed by a space)')
          done = true
        } else text += c
      } else {
        if (i >= n || isSpace(c)) done = true
        else if (c === '"') inDq = true
        else if (c === "'") inSq = true
        else text += c
      }
      if (i < n) i++
    }
    flush()
    out.push(parts.length === 1 ? parts[0] : Buffer.concat(parts))
  }
}

/** The command lines of a console text: one per non-empty line, `#` comment lines dropped. */
export function commandLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

const NO_BLOCK = 'cannot run in this console because it uses one shared connection per database'

/** Commands that would break the app's connection model (blocking, push-style or connection-state changing). */
const BLOCKED: Record<string, string> = {
  SUBSCRIBE: 'push-style (pub/sub)',
  PSUBSCRIBE: 'push-style (pub/sub)',
  SSUBSCRIBE: 'push-style (pub/sub)',
  UNSUBSCRIBE: 'push-style (pub/sub)',
  PUNSUBSCRIBE: 'push-style (pub/sub)',
  SUNSUBSCRIBE: 'push-style (pub/sub)',
  MONITOR: 'a never-ending stream',
  SYNC: 'a replication stream',
  PSYNC: 'a replication stream',
  BLPOP: 'blocking',
  BRPOP: 'blocking',
  BRPOPLPUSH: 'blocking',
  BLMOVE: 'blocking',
  BLMPOP: 'blocking',
  BZPOPMIN: 'blocking',
  BZPOPMAX: 'blocking',
  BZMPOP: 'blocking',
  WAIT: 'blocking',
  WAITAOF: 'blocking',
  MULTI: 'transactional (it changes the state of the connection); use EVAL or run the commands one by one',
  EXEC: 'transactional (it changes the state of the connection)',
  DISCARD: 'transactional (it changes the state of the connection)',
  WATCH: 'transactional (it changes the state of the connection)',
  UNWATCH: 'transactional (it changes the state of the connection)',
  HELLO: 'a protocol switch',
  RESET: 'a connection reset'
}

/** An error message when the command must not run in the console, else null. `args[0]` is the command name. */
export function blockedReason(args: Buffer[]): string | null {
  if (!args.length) return null
  const name = args[0].toString('utf8').toUpperCase()
  const rest = args.slice(1).map((a) => a.toString('utf8').toUpperCase())
  if (name === 'SELECT') {
    return 'SELECT is not available in the console: it would change the database of the shared connection. Use the database selector: open a console from the database you want in the Database Explorer.'
  }
  if (BLOCKED[name]) return `${name} is not supported in this console: it is ${BLOCKED[name]} and ${NO_BLOCK}.`
  if ((name === 'XREAD' || name === 'XREADGROUP') && rest.includes('BLOCK')) {
    return `${name} with BLOCK is not supported in this console: it is blocking and ${NO_BLOCK}.`
  }
  if (name === 'CLIENT' && ['REPLY', 'TRACKING', 'CACHING', 'NO-TOUCH'].includes(rest[0] ?? '')) {
    return `CLIENT ${rest[0]} is not supported in this console: it changes how the shared connection works.`
  }
  return null
}

/** Whether `text` (bytes) is valid UTF-8 that survives a decode / encode round trip. */
export const isUtf8 = (b: Buffer): boolean => Buffer.from(b.toString('utf8'), 'utf8').equals(b)

/** redis-cli style rendering of bytes that are not valid UTF-8: printable ASCII as is, the rest as \xNN. */
export function escapeBytes(b: Buffer): string {
  let out = ''
  for (const c of b) {
    out += c >= 32 && c < 127 && c !== 92 && c !== 34 ? String.fromCharCode(c) : c === 92 ? '\\\\' : c === 34 ? '\\"' : c === 10 ? '\\n' : c === 13 ? '\\r' : c === 9 ? '\\t' : '\\x' + c.toString(16).padStart(2, '0')
  }
  return out
}

const text = (b: Buffer): string => (isUtf8(b) ? b.toString('utf8') : escapeBytes(b))

/** Replies that a command sends as a status line (`+OK`); with raw buffers they look like bulk strings. */
const STATUS_WORDS = new Set(['OK', 'PONG', 'QUEUED'])

/** Errors the server reports as replies (not connection problems). */
export const isReplyError = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { name?: string }).name === 'ReplyError'

const cleanReplyMessage = (m: string): string => m.replace(/^ERR /, '')

/** The most reply nodes a console result keeps (a huge reply is cut with a note instead of freezing the UI). */
export const MAX_REPLY_NODES = 20_000

function walk(raw: unknown, command: string, top: boolean, budget: { n: number }): RedisReply {
  if (raw === null || raw === undefined) return { kind: 'nil' }
  if (typeof raw === 'number') return { kind: 'integer', value: raw }
  if (typeof raw === 'bigint') return { kind: 'integer', value: Number(raw) }
  if (typeof raw === 'boolean') return { kind: 'integer', value: raw ? 1 : 0 }
  if (Buffer.isBuffer(raw) || typeof raw === 'string') {
    const s = typeof raw === 'string' ? raw : text(raw)
    if (top && (STATUS_WORDS.has(s) || command.toUpperCase() === 'TYPE')) return { kind: 'status', value: s }
    return { kind: 'bulk', value: s }
  }
  if (Array.isArray(raw)) {
    const items: RedisReply[] = []
    for (let i = 0; i < raw.length; i++) {
      if (budget.n <= 0) {
        items.push({ kind: 'bulk', value: `… ${raw.length - i} more items not shown` })
        break
      }
      budget.n--
      items.push(walk(raw[i], command, false, budget))
    }
    return { kind: 'array', items }
  }
  if (raw instanceof Error) return { kind: 'error', message: cleanReplyMessage(raw.message) }
  return { kind: 'bulk', value: String(raw) }
}

/**
 * Raw `callBuffer` reply -> RedisReply. Status and bulk strings both arrive as Buffers, so a status is recognised by its
 * well-known word (OK / PONG / QUEUED) or by the command (TYPE answers with a status). Buffers that are not UTF-8 are
 * shown as `\xNN` escapes. Error replies nested in arrays stay in place. Replies beyond `maxNodes` items are cut.
 */
export const normalizeReply = (raw: unknown, command = '', maxNodes = MAX_REPLY_NODES): RedisReply =>
  walk(raw, command, true, { n: maxNodes })

/** A server error as an error reply. */
export const errorReply = (e: Error): RedisReply => ({ kind: 'error', message: cleanReplyMessage(e.message) })
