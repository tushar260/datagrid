import type { Column } from '../../../shared'
import { quoteIdent } from '../../../shared'
import type { SqlItem } from './sqlCandidates'

/**
 * Completion logic for the DynamoDB PartiQL console: keywords, functions, table names (always inserted double-quoted)
 * and the attribute names of the tables the current statement references. Pure, so it is unit tested directly.
 */

export const PARTIQL_KEYWORDS = [
  'select', 'from', 'where', 'insert into', 'value', 'update', 'set', 'remove', 'delete from', 'and', 'or', 'not', 'in',
  'between', 'is null', 'is not null', 'is missing', 'is not missing', 'order by', 'asc', 'desc',
  'returning all old *', 'returning all new *', 'returning modified old *', 'returning modified new *', 'true', 'false', 'null'
]
export const PARTIQL_FUNCTIONS = ['begins_with', 'contains', 'attribute_type', 'size', 'exists', 'missing']
/** number of arguments of each function (default 1) */
const FUNCTION_ARITY: Record<string, number> = { begins_with: 2, contains: 2, attribute_type: 2 }

/**
 * A function call to insert: the right number of empty argument slots, with the caret placed in the first one
 * (`begins_with(|, )`). `caretBack` is the caret offset from the end of `insert`.
 */
export function functionSnippet(name: string): { insert: string; caretBack: number } {
  const n = FUNCTION_ARITY[name.toLowerCase()] ?? 1
  const tail = ', '.repeat(n - 1) + ')'
  return { insert: `${name}(${tail}`, caretBack: tail.length }
}

/** A conservative subset of the DynamoDB reserved words: attributes with these names are inserted double-quoted. */
const RESERVED = new Set(
  ('abort absolute action add after all allocate alter analyze and any are array as asc assert at attribute authorization ' +
    'before begin between bigint binary bit blob boolean both by call cascade case cast char character check class close ' +
    'cluster collate column commit connect connection constraint contains continue count create cross current cursor ' +
    'data database date day decimal declare default delete desc describe distinct do domain double drop each else end ' +
    'escape except exception exec exists explain false fetch file float for foreign from full function get global grant ' +
    'group having hour identity if immediate in index inner insert int integer intersect interval into is item join key ' +
    'keys language last left level like limit list local map match max min minute missing modify month name national ' +
    'natural no not null number numeric object of offset on only open option or order outer output partition path plan ' +
    'position primary public range read real reference references remove replace restrict return returns revoke right ' +
    'role rollback row rows schema scope second select session set size smallint some space sql start state status ' +
    'string table temporary then time timestamp to token transaction trigger true type union unique update user using ' +
    'value values varchar view when where while with work write year zone').split(' ')
)

/** An attribute name as it must be written in a PartiQL expression (quoted when it is not a plain safe identifier). */
export const quotePartiqlName = (name: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quoteIdent(name)

export interface PartiqlCtx {
  /** replace range [start, end) */
  start: number
  end: number
  /** what was typed (without the opening quote of a quoted name) */
  word: string
  /** 'table' after FROM / INTO / UPDATE, otherwise 'expr' */
  clause: 'table' | 'expr'
  /** tables referenced by the current statement (unquoted names) */
  tables: string[]
  kwCase: 'upper' | 'lower'
  forced: boolean
  /** the word is inside a double-quoted name */
  quoted: boolean
  /** right after `fn(`: a function's first argument (attributes are suggested even with nothing typed) */
  fnArg?: boolean
}

export interface PartiqlMeta {
  tables: string[]
  columns: (table: string) => Column[] | undefined
}

const isIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c)

/**
 * Context for completion at `caret`, or null when nothing should pop up: inside a string or comment, or - unless forced -
 * with nothing typed (a table position pops up even when empty).
 */
export function analyzePartiql(text: string, caret: number, forced = false): PartiqlCtx | null {
  // scan up to the caret: statement start, string / quoted-name / comment state
  let stmtStart = 0
  let state: 'none' | 'sq' | 'dq' | 'lc' | 'bc' = 'none'
  let quoteAt = -1
  for (let i = 0; i < caret; i++) {
    const c = text[i]
    if (state === 'sq') { if (c === "'") { if (text[i + 1] === "'" && i + 1 < caret) i++; else state = 'none' } }
    else if (state === 'dq') { if (c === '"') { if (text[i + 1] === '"' && i + 1 < caret) i++; else state = 'none' } }
    else if (state === 'lc') { if (c === '\n') state = 'none' }
    else if (state === 'bc') { if (c === '*' && text[i + 1] === '/') { i++; state = 'none' } }
    else if (c === "'") state = 'sq'
    else if (c === '"') { state = 'dq'; quoteAt = i }
    else if (c === '-' && text[i + 1] === '-') state = 'lc'
    else if (c === '/' && text[i + 1] === '*') state = 'bc'
    else if (c === ';') stmtStart = i + 1
  }
  if (state === 'sq' || state === 'lc' || state === 'bc') return null

  // end of the statement: the next `;` outside quotes
  let stmtEnd = text.length
  {
    let q: string | null = null
    for (let i = caret; i < text.length; i++) {
      const c = text[i]
      if (q) { if (c === q) q = null }
      else if (c === "'" || c === '"') q = c
      else if (c === ';') { stmtEnd = i; break }
    }
  }
  const stmt = text.slice(stmtStart, stmtEnd)

  let start = caret
  let end = caret
  let word: string
  const quoted = state === 'dq'
  if (quoted) {
    start = quoteAt
    word = text.slice(quoteAt + 1, caret)
    const nl = text.indexOf('\n', caret)
    const close = text.indexOf('"', caret)
    end = close >= 0 && (nl < 0 || close < nl) ? close + 1 : caret
  } else {
    while (start > 0 && isIdent(text[start - 1])) start--
    word = text.slice(start, caret)
    if (/^[0-9]/.test(word)) return null
    while (end < text.length && isIdent(text[end])) end++
  }

  const before = text.slice(stmtStart, start).replace(/--[^\n]*$/gm, '')
  const clause: 'table' | 'expr' = /\b(from|into|update)\s*$/i.test(before) ? 'table' : 'expr'
  if (quoted && clause !== 'table') return null // a quoted attribute name is not completed
  const call = !quoted && !word ? /([A-Za-z_][A-Za-z0-9_]*)\(\s*$/.exec(before) : null
  const fnArg = !!call && !['in', 'and', 'or', 'not', 'between', 'values', 'value', 'where', 'select', 'from', 'set'].includes(call[1].toLowerCase())
  if (!word && !forced && clause !== 'table' && !fnArg) return null

  const tables: string[] = []
  const re = /\b(?:from|into|update)\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)/gi
  for (let m = re.exec(stmt); m; m = re.exec(stmt)) {
    const n = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]
    if (!tables.includes(n)) tables.push(n)
  }
  const first = /\b(select|insert|update|delete)\b/i.exec(stmt)
  const kwCase = first && first[1] === first[1].toLowerCase() ? 'lower' : 'upper'
  return { start, end, word, clause, tables, kwCase, forced, quoted, ...(fnArg ? { fnArg } : {}) }
}

const MAX_ITEMS = 300

export function buildPartiqlItems(ctx: PartiqlCtx, meta: PartiqlMeta): SqlItem[] {
  const w = ctx.word.toLowerCase()
  const rank = <T,>(list: T[], name: (t: T) => string): T[] => [
    ...list.filter((t) => name(t).toLowerCase().startsWith(w)),
    ...(w ? list.filter((t) => !name(t).toLowerCase().startsWith(w) && name(t).toLowerCase().includes(w)) : [])
  ]
  const out: SqlItem[] = []
  if (ctx.clause === 'table') {
    for (const name of rank(meta.tables, (n) => n)) out.push({ kind: 'table', label: name, insert: quoteIdent(name), detail: 'table' })
  } else {
    for (const table of ctx.tables) {
      for (const col of rank(meta.columns(table) ?? [], (c) => c.name)) {
        out.push({ kind: 'col', label: col.name, insert: quotePartiqlName(col.name), detail: col.type, col })
      }
    }
    if ((w || ctx.forced) && !(ctx.fnArg && !w)) {
      const cased = (k: string): string => (ctx.kwCase === 'upper' ? k.toUpperCase() : k)
      for (const k of PARTIQL_KEYWORDS.filter((x) => x.startsWith(w))) out.push({ kind: 'kw', label: cased(k), insert: cased(k) + ' ', detail: 'keyword' })
      for (const f of PARTIQL_FUNCTIONS.filter((x) => x.startsWith(w))) out.push({ kind: 'fn', label: f, ...functionSnippet(f), detail: 'function' })
    }
  }
  // nothing left to complete: the only candidate is exactly what was typed
  if (w && out.every((i) => i.label.toLowerCase() === w)) return []
  return out.slice(0, MAX_ITEMS)
}
