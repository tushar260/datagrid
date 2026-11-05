import { describe, expect, it } from 'vitest'
import { blockedReason, commandLines, errorReply, escapeBytes, isReplyError, isUtf8, normalizeReply, splitArgs } from '../../src/main/redisCommand'

const args = (line: string): string[] => splitArgs(line).map((b) => b.toString('utf8'))
const B = (...n: number[]): Buffer => Buffer.from(n)

describe('splitArgs (redis-cli quoting)', () => {
  it('splits on whitespace', () => {
    expect(args('SET a b')).toEqual(['SET', 'a', 'b'])
    expect(args('  GET\t k  ')).toEqual(['GET', 'k'])
    expect(args('')).toEqual([])
    expect(args('   ')).toEqual([])
  })
  it('double quotes keep spaces and understand escapes', () => {
    expect(args('SET k "hello world"')).toEqual(['SET', 'k', 'hello world'])
    expect(args('SET k "a\\nb\\tc\\"d\\\\e"')).toEqual(['SET', 'k', 'a\nb\tc"d\\e'])
    expect(args('SET k ""')).toEqual(['SET', 'k', ''])
    expect(args('ECHO "\\q"')).toEqual(['ECHO', 'q']) // unknown escape: the character itself
  })
  it('\\xHH produces raw bytes', () => {
    expect(splitArgs('SET k "\\xff\\x00a"')[2]).toEqual(Buffer.concat([B(0xff, 0), Buffer.from('a')]))
    expect(splitArgs('SET k "x\\xe2\\x82\\xacy"')[2].toString('utf8')).toBe('x€y')
    expect(args('ECHO "\\xZZ"')).toEqual(['ECHO', 'xZZ']) // not hex: plain escape
  })
  it("single quotes are literal except \\'", () => {
    expect(args("SET k 'a \\n b'")).toEqual(['SET', 'k', 'a \\n b'])
    expect(args("SET k 'it\\'s'")).toEqual(['SET', 'k', "it's"])
  })
  it('unbalanced quotes and a closing quote glued to text are errors', () => {
    expect(() => splitArgs('SET k "abc')).toThrow(/Unbalanced quotes/)
    expect(() => splitArgs("SET k 'abc")).toThrow(/Unbalanced quotes/)
    expect(() => splitArgs('SET k "abc"def')).toThrow(/Unbalanced quotes/)
    expect(() => splitArgs("SET k 'abc'def")).toThrow(/Unbalanced quotes/)
  })
  it('a quoted argument followed by another works', () => {
    expect(args('HSET h "a b" \'c d\' e')).toEqual(['HSET', 'h', 'a b', 'c d', 'e'])
  })
})

describe('commandLines', () => {
  it('one command per non-empty line; # comments and CRLF handled', () => {
    expect(commandLines('SET a 1\r\n\n  # note\nGET a  \n')).toEqual(['SET a 1', 'GET a'])
    expect(commandLines('')).toEqual([])
    expect(commandLines('# only a comment')).toEqual([])
  })
})

describe('blockedReason', () => {
  const r = (line: string): string | null => blockedReason(splitArgs(line))
  it('allows ordinary commands', () => {
    for (const l of ['GET a', 'set a 1', 'SCAN 0 MATCH x*', 'XREAD COUNT 1 STREAMS s 0', 'CLIENT LIST', 'INFO', '']) expect(r(l)).toBeNull()
  })
  it('refuses push, blocking and connection-state commands (any case)', () => {
    for (const l of ['SUBSCRIBE c', 'psubscribe c*', 'MONITOR', 'SYNC', 'BLPOP l 0', 'brpop l 1', 'BZPOPMIN z 0', 'WAIT 1 0', 'MULTI', 'exec', 'WATCH k', 'HELLO 3', 'RESET']) {
      expect(r(l), l).toMatch(/not supported in this console/)
    }
  })
  it('SELECT points to the database selector', () => {
    expect(r('SELECT 3')).toMatch(/SELECT is not available.*Database Explorer/)
    expect(r('select 0')).toMatch(/SELECT is not available/)
  })
  it('XREAD / XREADGROUP only with BLOCK; some CLIENT subcommands', () => {
    expect(r('XREAD BLOCK 0 STREAMS s $')).toMatch(/BLOCK/)
    expect(r('xreadgroup GROUP g c block 5 STREAMS s >')).toMatch(/BLOCK/)
    expect(r('CLIENT REPLY OFF')).toMatch(/CLIENT REPLY/)
    expect(r('client tracking on')).toMatch(/CLIENT TRACKING/)
    expect(r('CLIENT SETNAME x')).toBeNull()
  })
})

describe('normalizeReply', () => {
  it('scalars', () => {
    expect(normalizeReply(null)).toEqual({ kind: 'nil' })
    expect(normalizeReply(undefined)).toEqual({ kind: 'nil' })
    expect(normalizeReply(5)).toEqual({ kind: 'integer', value: 5 })
    expect(normalizeReply(BigInt(7))).toEqual({ kind: 'integer', value: 7 })
    expect(normalizeReply(true)).toEqual({ kind: 'integer', value: 1 })
    expect(normalizeReply(Buffer.from('hi'), 'GET')).toEqual({ kind: 'bulk', value: 'hi' })
  })
  it('status words at the top level, and TYPE answers', () => {
    expect(normalizeReply(Buffer.from('OK'), 'SET')).toEqual({ kind: 'status', value: 'OK' })
    expect(normalizeReply(Buffer.from('PONG'), 'PING')).toEqual({ kind: 'status', value: 'PONG' })
    expect(normalizeReply(Buffer.from('hash'), 'type')).toEqual({ kind: 'status', value: 'hash' })
    // a stored value that happens to be "OK" is still a status here: documented heuristic, only at the top level
    expect(normalizeReply([Buffer.from('OK')], 'LRANGE')).toEqual({ kind: 'array', items: [{ kind: 'bulk', value: 'OK' }] })
  })
  it('nested arrays, nils and in-place errors', () => {
    const err = Object.assign(new Error('ERR boom'), { name: 'ReplyError' })
    expect(normalizeReply([Buffer.from('a'), null, [1, Buffer.from('b')], err], 'X')).toEqual({
      kind: 'array',
      items: [
        { kind: 'bulk', value: 'a' }, { kind: 'nil' },
        { kind: 'array', items: [{ kind: 'integer', value: 1 }, { kind: 'bulk', value: 'b' }] },
        { kind: 'error', message: 'boom' }
      ]
    })
    expect(normalizeReply([])).toEqual({ kind: 'array', items: [] })
  })
  it('bytes that are not UTF-8 are shown escaped', () => {
    expect(normalizeReply(B(0x61, 0xff, 0x00), 'GET')).toEqual({ kind: 'bulk', value: 'a\\xff\\x00' })
    expect(isUtf8(Buffer.from('é'))).toBe(true)
    expect(isUtf8(B(0xc3))).toBe(false)
    expect(escapeBytes(B(0x22, 0x5c, 0x0a, 0x7f))).toBe('\\"\\\\\\n\\x7f')
  })
  it('a huge reply is cut with a note', () => {
    const r = normalizeReply(Array.from({ length: 50 }, (_, i) => i), 'X', 10)
    expect(r.kind).toBe('array')
    if (r.kind !== 'array') return
    expect(r.items).toHaveLength(11)
    expect(r.items[10]).toEqual({ kind: 'bulk', value: '… 40 more items not shown' })
  })
  it('unknown objects are stringified rather than thrown on', () => {
    expect(normalizeReply({ a: 1 })).toEqual({ kind: 'bulk', value: '[object Object]' })
  })
})

describe('errors', () => {
  it('errorReply strips the ERR prefix; isReplyError tells server replies from connection errors', () => {
    expect(errorReply(new Error('ERR unknown command'))).toEqual({ kind: 'error', message: 'unknown command' })
    expect(errorReply(new Error('WRONGTYPE Operation against a key'))).toEqual({ kind: 'error', message: 'WRONGTYPE Operation against a key' })
    expect(isReplyError(Object.assign(new Error('x'), { name: 'ReplyError' }))).toBe(true)
    expect(isReplyError(new Error('x'))).toBe(false)
    expect(isReplyError(null)).toBe(false)
  })
})
