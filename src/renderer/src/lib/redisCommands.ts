import type { SqlItem } from './sqlCandidates'

/**
 * Completion logic for the Redis console: command names (first word of a line) with a short signature as the hint.
 * Pure, so it is unit tested directly. Only a built-in list: there is nothing to look up on the server.
 */

/** [name, signature] of the common commands (arguments in redis.io notation, `[...]` optional). */
const LIST: [string, string][] = [
  ['APPEND', 'key value'], ['AUTH', '[username] password'], ['BGSAVE', ''], ['BITCOUNT', 'key [start end]'], ['BITFIELD', 'key subcommand...'],
  ['BITOP', 'AND|OR|XOR|NOT destkey key...'], ['BITPOS', 'key bit [start [end]]'], ['CLIENT ID', ''], ['CLIENT INFO', ''], ['CLIENT LIST', ''],
  ['CLIENT SETNAME', 'name'], ['CLUSTER INFO', ''], ['COMMAND COUNT', ''], ['CONFIG GET', 'parameter'], ['COPY', 'source destination [DB db] [REPLACE]'],
  ['DBSIZE', ''], ['DECR', 'key'], ['DECRBY', 'key decrement'], ['DEL', 'key [key ...]'], ['DUMP', 'key'], ['ECHO', 'message'],
  ['EVAL', 'script numkeys [key ...] [arg ...]'], ['EVALSHA', 'sha1 numkeys [key ...] [arg ...]'], ['EXISTS', 'key [key ...]'],
  ['EXPIRE', 'key seconds [NX|XX|GT|LT]'], ['EXPIREAT', 'key unix-time-seconds'], ['EXPIRETIME', 'key'], ['FUNCTION LIST', ''],
  ['GEOADD', 'key longitude latitude member [...]'], ['GEODIST', 'key member1 member2 [unit]'], ['GEOPOS', 'key member [member ...]'],
  ['GEOSEARCH', 'key FROMMEMBER member|FROMLONLAT lon lat BYRADIUS r unit|BYBOX w h unit'], ['GET', 'key'], ['GETBIT', 'key offset'],
  ['GETDEL', 'key'], ['GETEX', 'key [EX seconds|PX ms|PERSIST]'], ['GETRANGE', 'key start end'], ['GETSET', 'key value'],
  ['HDEL', 'key field [field ...]'], ['HEXISTS', 'key field'], ['HGET', 'key field'], ['HGETALL', 'key'], ['HINCRBY', 'key field increment'],
  ['HINCRBYFLOAT', 'key field increment'], ['HKEYS', 'key'], ['HLEN', 'key'], ['HMGET', 'key field [field ...]'], ['HMSET', 'key field value [field value ...]'],
  ['HRANDFIELD', 'key [count [WITHVALUES]]'], ['HSCAN', 'key cursor [MATCH pattern] [COUNT count]'], ['HSET', 'key field value [field value ...]'],
  ['HSETNX', 'key field value'], ['HSTRLEN', 'key field'], ['HVALS', 'key'], ['INCR', 'key'], ['INCRBY', 'key increment'],
  ['INCRBYFLOAT', 'key increment'], ['INFO', '[section]'], ['KEYS', 'pattern (blocks the server on big databases; prefer SCAN)'],
  ['LASTSAVE', ''], ['LINDEX', 'key index'], ['LINSERT', 'key BEFORE|AFTER pivot element'], ['LLEN', 'key'], ['LMOVE', 'source destination LEFT|RIGHT LEFT|RIGHT'],
  ['LMPOP', 'numkeys key [key ...] LEFT|RIGHT [COUNT count]'], ['LPOP', 'key [count]'], ['LPOS', 'key element [RANK rank] [COUNT n] [MAXLEN len]'],
  ['LPUSH', 'key element [element ...]'], ['LPUSHX', 'key element [element ...]'], ['LRANGE', 'key start stop'], ['LREM', 'key count element'],
  ['LSET', 'key index element'], ['LTRIM', 'key start stop'], ['MEMORY USAGE', 'key [SAMPLES count]'], ['MGET', 'key [key ...]'],
  ['MSET', 'key value [key value ...]'], ['MSETNX', 'key value [key value ...]'], ['OBJECT ENCODING', 'key'], ['OBJECT FREQ', 'key'],
  ['OBJECT IDLETIME', 'key'], ['PERSIST', 'key'], ['PEXPIRE', 'key milliseconds'], ['PEXPIREAT', 'key unix-time-milliseconds'], ['PFADD', 'key element [element ...]'],
  ['PFCOUNT', 'key [key ...]'], ['PFMERGE', 'destkey sourcekey [sourcekey ...]'], ['PING', '[message]'], ['PSETEX', 'key milliseconds value'],
  ['PTTL', 'key'], ['PUBLISH', 'channel message'], ['PUBSUB CHANNELS', '[pattern]'], ['RANDOMKEY', ''], ['RENAME', 'key newkey'],
  ['RENAMENX', 'key newkey'], ['RESTORE', 'key ttl serialized-value [REPLACE]'], ['RPOP', 'key [count]'], ['RPOPLPUSH', 'source destination'],
  ['RPUSH', 'key element [element ...]'], ['RPUSHX', 'key element [element ...]'], ['SADD', 'key member [member ...]'], ['SAVE', ''],
  ['SCAN', 'cursor [MATCH pattern] [COUNT count] [TYPE type]'], ['SCARD', 'key'], ['SCRIPT EXISTS', 'sha1 [sha1 ...]'], ['SDIFF', 'key [key ...]'],
  ['SDIFFSTORE', 'destination key [key ...]'], ['SET', 'key value [NX|XX] [GET] [EX s|PX ms|EXAT t|PXAT t|KEEPTTL]'], ['SETBIT', 'key offset value'],
  ['SETEX', 'key seconds value'], ['SETNX', 'key value'], ['SETRANGE', 'key offset value'], ['SINTER', 'key [key ...]'],
  ['SINTERCARD', 'numkeys key [key ...] [LIMIT limit]'], ['SINTERSTORE', 'destination key [key ...]'], ['SISMEMBER', 'key member'],
  ['SLOWLOG GET', '[count]'], ['SMEMBERS', 'key'], ['SMISMEMBER', 'key member [member ...]'], ['SMOVE', 'source destination member'],
  ['SORT', 'key [BY pattern] [LIMIT offset count] [GET pattern] [ASC|DESC] [ALPHA] [STORE dest]'], ['SPOP', 'key [count]'],
  ['SRANDMEMBER', 'key [count]'], ['SREM', 'key member [member ...]'], ['SSCAN', 'key cursor [MATCH pattern] [COUNT count]'], ['STRLEN', 'key'],
  ['SUNION', 'key [key ...]'], ['SUNIONSTORE', 'destination key [key ...]'], ['TIME', ''], ['TOUCH', 'key [key ...]'], ['TTL', 'key'], ['TYPE', 'key'],
  ['UNLINK', 'key [key ...]'], ['XACK', 'key group id [id ...]'], ['XADD', 'key [NOMKSTREAM] [MAXLEN [~] n] *|id field value [field value ...]'],
  ['XAUTOCLAIM', 'key group consumer min-idle-time start [COUNT count]'], ['XDEL', 'key id [id ...]'], ['XGROUP CREATE', 'key group id|$ [MKSTREAM]'],
  ['XINFO STREAM', 'key [FULL]'], ['XLEN', 'key'], ['XPENDING', 'key group [start end count [consumer]]'], ['XRANGE', 'key start end [COUNT count]'],
  ['XREAD', '[COUNT count] STREAMS key [key ...] id [id ...]'], ['XREADGROUP', 'GROUP group consumer [COUNT count] STREAMS key id'],
  ['XREVRANGE', 'key end start [COUNT count]'], ['XTRIM', 'key MAXLEN|MINID [~] threshold'], ['ZADD', 'key [NX|XX] [GT|LT] [CH] score member [score member ...]'],
  ['ZCARD', 'key'], ['ZCOUNT', 'key min max'], ['ZDIFF', 'numkeys key [key ...] [WITHSCORES]'], ['ZINCRBY', 'key increment member'],
  ['ZINTERSTORE', 'destination numkeys key [key ...]'], ['ZLEXCOUNT', 'key min max'], ['ZMSCORE', 'key member [member ...]'], ['ZPOPMAX', 'key [count]'],
  ['ZPOPMIN', 'key [count]'], ['ZRANDMEMBER', 'key [count [WITHSCORES]]'], ['ZRANGE', 'key start stop [BYSCORE|BYLEX] [REV] [LIMIT offset count] [WITHSCORES]'],
  ['ZRANGEBYSCORE', 'key min max [WITHSCORES] [LIMIT offset count]'], ['ZRANK', 'key member'], ['ZREM', 'key member [member ...]'],
  ['ZREMRANGEBYRANK', 'key start stop'], ['ZREMRANGEBYSCORE', 'key min max'], ['ZREVRANGE', 'key start stop [WITHSCORES]'], ['ZREVRANK', 'key member'],
  ['ZSCAN', 'key cursor [MATCH pattern] [COUNT count]'], ['ZSCORE', 'key member'], ['ZUNIONSTORE', 'destination numkeys key [key ...]']
]

export const REDIS_COMMANDS: { name: string; sig: string }[] = LIST.map(([name, sig]) => ({ name, sig })).sort((a, b) => a.name.localeCompare(b.name))

export interface RedisCtx {
  /** replace range [start, end) */
  start: number
  end: number
  /** what was typed of the command name (first word of the line) */
  word: string
  forced: boolean
  /** the line is already written in lower case: complete in lower case too */
  lower: boolean
}

/**
 * Context for completion at `caret`, or null when nothing should pop up: not in the first word of a line, on a `#`
 * comment line, or (unless forced) with nothing typed. Multi-word commands (`CLIENT LIST`) are completed as a whole.
 */
export function analyzeRedis(text: string, caret: number, forced = false): RedisCtx | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const before = text.slice(lineStart, caret)
  if (before.trimStart().startsWith('#')) return null
  const lead = before.length - before.trimStart().length
  const typed = before.slice(lead)
  // only the command position: a second word is a plain argument, except the sub-command of a two-word command
  if (/["']/.test(typed)) return null
  const words = typed.split(/\s+/)
  if (words.length > 2) return null
  if (words.length === 2 && !LIST.some(([n]) => n.toLowerCase().startsWith(words[0].toLowerCase() + ' '))) return null
  const word = words.length === 2 ? `${words[0]} ${words[1]}` : words[0]
  if (!word && !forced) return null
  let end = caret
  const lineEnd = text.indexOf('\n', caret)
  const rest = text.slice(caret, lineEnd < 0 ? text.length : lineEnd)
  const m = /^[A-Za-z0-9_-]*/.exec(rest)
  end += m ? m[0].length : 0
  return { start: lineStart + lead, end, word, forced, lower: word !== '' && word === word.toLowerCase() && /[a-z]/.test(word) }
}

const MAX_ITEMS = 60

/** Candidates for the context: commands whose name starts with the typed word (then those that contain it). */
export function buildRedisItems(ctx: RedisCtx): SqlItem[] {
  const w = ctx.word.toLowerCase()
  // an exact match comes first, then the rest in alphabetical order
  const starts = REDIS_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(w)).sort((a, b) => Number(b.name.toLowerCase() === w) - Number(a.name.toLowerCase() === w))
  const has = w.length > 1 ? REDIS_COMMANDS.filter((c) => !c.name.toLowerCase().startsWith(w) && c.name.toLowerCase().includes(w)) : []
  const items = [...starts, ...has].map((c): SqlItem => {
    const label = ctx.lower ? c.name.toLowerCase() : c.name
    return { kind: 'fn', label, insert: label + ' ', detail: c.sig || 'no arguments' }
  })
  // nothing left to complete: the only candidate is exactly what was typed
  if (w && items.length === 1 && items[0].label.toLowerCase() === w) return []
  return items.slice(0, MAX_ITEMS)
}
