/**
 * Pure SQL context analysis for the query-console autocomplete: a lightweight lexer (strings, quoted identifiers,
 * comments, dollar quotes), the statement under the caret, the clause the caret is in, the tables referenced by the
 * statement (`from schema.table [as] alias`, `join ...`, `update ...`, `insert into ...`) and qualifier resolution.
 * No DOM / React here so it can be unit-tested directly.
 */

export type TokType = 'word' | 'qid' | 'str' | 'num' | 'comment' | 'p'
export interface Tok {
  t: TokType
  text: string // raw source text
  value: string // words: lower-cased; quoted identifiers: unquoted; punctuation: the char
  start: number
  end: number
  closed: boolean // false for an unterminated string / quoted identifier / block comment
}

const isWordStart = (c: string): boolean => /[\p{L}_]/u.test(c)
const isWordChar = (c: string): boolean => /[\p{L}\p{N}_$]/u.test(c)
/** Characters that make up the identifier being typed (no `$`: `$1` is a parameter). */
const isIdentChar = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c)

export function lex(sql: string): Tok[] {
  const out: Tok[] = []
  const n = sql.length
  let i = 0
  const push = (t: TokType, start: number, end: number, value: string, closed = true): void => {
    out.push({ t, text: sql.slice(start, end), value, start, end, closed })
  }
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && sql[i + 1] === '-') {
      let j = i + 2
      while (j < n && sql[j] !== '\n') j++
      push('comment', i, j, '', true)
      i = j
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') (depth++, (j += 2))
        else if (sql[j] === '*' && sql[j + 1] === '/') (depth--, (j += 2))
        else j++
      }
      push('comment', i, j, '', depth === 0)
      i = j
    } else if (c === "'") {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else {
            j++
            closed = true
            break
          }
        } else j++
      }
      push('str', i, j, '', closed)
      i = j
    } else if (c === '"') {
      let j = i + 1
      let closed = false
      let v = ''
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            v += '"'
            j += 2
          } else {
            j++
            closed = true
            break
          }
        } else v += sql[j++]
      }
      push('qid', i, j, v, closed)
      i = j
    } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))![0]
      const k = sql.indexOf(tag, i + tag.length)
      const j = k < 0 ? n : k + tag.length
      push('str', i, j, '', k >= 0)
      i = j
    } else if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9_.eE]/.test(sql[j]) && !(sql[j] === '.' && !/[0-9]/.test(sql[j + 1] ?? ''))) j++
      push('num', i, j, sql.slice(i, j))
      i = j
    } else if (isWordStart(c)) {
      let j = i + 1
      while (j < n && isWordChar(sql[j])) j++
      push('word', i, j, sql.slice(i, j).toLowerCase())
      i = j
    } else {
      push('p', i, i + 1, c)
      i++
    }
  }
  return out
}

/** Is the caret inside a string literal, quoted identifier or comment? */
export function inLiteral(toks: Tok[], caret: number): boolean {
  for (const k of toks) {
    if (k.start >= caret) break
    if (k.t === 'str' || k.t === 'qid') {
      if (caret < k.end || (caret === k.end && !k.closed)) return true
    } else if (k.t === 'comment') {
      const lineComment = k.text.startsWith('--')
      if (caret < k.end || (caret === k.end && (lineComment || !k.closed))) return true
    }
  }
  return false
}

/** [start, end) of the `;`-separated statement containing the caret. */
export function statementRange(toks: Tok[], caret: number, length: number): [number, number] {
  let s = 0
  let e = length
  for (const k of toks) {
    if (k.t === 'p' && k.value === ';') {
      if (k.end <= caret) s = k.end
      else if (k.start >= caret) {
        e = k.start
        break
      }
    }
  }
  return [s, e]
}

export interface TableRef {
  schema?: string // normalized (unquoted → lower-case, quoted → exact)
  table: string
  alias?: string
}

// words that can follow a table reference and therefore are never its alias
const ALIAS_STOP = new Set(
  ('where on using join inner left right full cross natural outer group order having limit offset union intersect except ' +
    'returning set values select from window for lateral fetch with and or not as when then else end case ' +
    'tablesample into default do conflict partition over filter within').split(' ')
)
const FROM_FUNCS = new Set(['extract', 'substring', 'trim', 'overlay', 'position'])

const isName = (k: Tok | undefined): k is Tok => !!k && (k.t === 'word' || k.t === 'qid')

/** Tables referenced by `from` / `join` / `update` / `insert into` / `delete ... using` in the given statement tokens. */
export function parseTableRefs(sig: Tok[]): TableRef[] {
  const refs: TableRef[] = []
  const owners: string[] = [] // function name (or '') of each open paren
  const parseOne = (i: number, fn: boolean): { ref: TableRef | null; next: number } => {
    let j = i
    if (sig[j]?.t === 'word' && (sig[j].value === 'only' || sig[j].value === 'lateral')) j++
    if (!isName(sig[j])) return { ref: null, next: j }
    const parts = [sig[j].value]
    j++
    while (sig[j]?.t === 'p' && sig[j].value === '.' && isName(sig[j + 1])) {
      parts.push(sig[j + 1].value)
      j += 2
    }
    if (fn && sig[j]?.t === 'p' && sig[j].value === '(') return { ref: null, next: j } // function call: generate_series(...)
    const ref: TableRef = { table: parts[parts.length - 1] }
    if (parts.length > 1) ref.schema = parts[parts.length - 2]
    if (sig[j]?.t === 'word' && sig[j].value === 'as' && isName(sig[j + 1])) {
      ref.alias = sig[j + 1].value
      j += 2
    } else if (isName(sig[j]) && !(sig[j].t === 'word' && ALIAS_STOP.has(sig[j].value))) {
      ref.alias = sig[j].value
      j++
    }
    return { ref, next: j }
  }
  for (let i = 0; i < sig.length; i++) {
    const k = sig[i]
    if (k.t === 'p') {
      if (k.value === '(') owners.push(sig[i - 1]?.t === 'word' ? sig[i - 1].value : '')
      else if (k.value === ')') owners.pop()
      continue
    }
    if (k.t !== 'word') continue
    const v = k.value
    if (v === 'from') {
      if (sig[i - 1]?.t === 'word' && sig[i - 1].value === 'distinct') continue
      if (FROM_FUNCS.has(owners[owners.length - 1] ?? '')) continue
    } else if (v !== 'join' && v !== 'update' && v !== 'into' && v !== 'using') continue
    let at = i + 1
    for (;;) {
      const { ref, next } = parseOne(at, v === 'from' || v === 'join' || v === 'using')
      if (ref) refs.push(ref)
      // `from a x, b y`: comma-separated list
      if (ref && v === 'from' && sig[next]?.t === 'p' && sig[next].value === ',') {
        at = next + 1
        continue
      }
      break
    }
  }
  return refs
}

export type Clause =
  | 'table' // expecting a table name (after FROM / JOIN / INTO / UPDATE / TABLE ...)
  | 'afterTable' // in the FROM clause but after a table reference (keywords expected)
  | 'column' // select list / where / on / group by / order by / having / set / returning / insert column list
  | 'start' // nothing recognisable yet (statement start, subquery start, DDL ...)

const TABLE_KW = new Set(['from', 'join', 'into', 'update', 'table', 'truncate', 'only', 'using'])
const COLUMN_KW = new Set(['select', 'where', 'on', 'group', 'order', 'having', 'set', 'returning', 'distinct'])

interface Level {
  clause: string | null
  owner: string
}

/** Clause at the end of `before` (significant tokens of the statement up to the word being typed). */
export function clauseAt(before: Tok[]): Clause {
  const stack: Level[] = [{ clause: null, owner: '' }]
  for (let i = 0; i < before.length; i++) {
    const k = before[i]
    const top = stack[stack.length - 1]
    if (k.t === 'p') {
      if (k.value === '(') stack.push({ clause: null, owner: before[i - 1]?.t === 'word' ? before[i - 1].value : '' })
      else if (k.value === ')' && stack.length > 1) stack.pop()
      continue
    }
    if (k.t !== 'word') continue
    const v = k.value
    if (v === 'from' && FROM_FUNCS.has(top.owner)) continue // extract(year from x)
    if (v === 'on' && before.slice(0, i).some((x) => x.t === 'word' && (x.value === 'index' || x.value === 'trigger' || x.value === 'comment'))) {
      top.clause = 'table' // create index i on <table>
    } else if (TABLE_KW.has(v)) top.clause = 'table'
    else if (COLUMN_KW.has(v)) top.clause = 'column'
    else if (v === 'values' || v === 'limit' || v === 'offset' || v === 'union' || v === 'with' || v === 'create' || v === 'alter' || v === 'drop') top.clause = null
  }
  const lvl = stack[stack.length - 1]
  let clause = lvl.clause
  if (clause === null && stack.length > 1) {
    // fresh paren: inherit the enclosing clause (count(| , on (| ...), except `insert into t (|` and subqueries
    const parent = stack[stack.length - 2]
    const intoCols = parent.clause === 'table' && lastKeyword(before) === 'into'
    if (intoCols) return 'column'
    clause = parent.clause === 'table' ? null : parent.clause
  }
  if (clause === 'column') return 'column'
  if (clause === 'table') {
    const prev = before[before.length - 1]
    if (prev && ((prev.t === 'word' && (TABLE_KW.has(prev.value) || prev.value === 'on')) || (prev.t === 'p' && prev.value === ','))) return 'table'
    return 'afterTable'
  }
  return 'start'
}

function lastKeyword(before: Tok[]): string {
  // the table keyword in front of the innermost unmatched '(' (`insert into t (` → 'into')
  let depth = 0
  for (let i = before.length - 1; i >= 0; i--) {
    const k = before[i]
    if (k.t === 'p' && k.value === ')') depth++
    else if (k.t === 'p' && k.value === '(') {
      if (depth === 0) {
        // keywords before this paren at the parent level
        for (let j = i - 1; j >= 0; j--) {
          if (before[j].t === 'word' && TABLE_KW.has(before[j].value)) return before[j].value
          if (before[j].t === 'p' && before[j].value === ')') break
        }
        return ''
      }
      depth--
    }
  }
  return ''
}

/** Words that make a typed keyword's case worth copying. */
const CASE_WORDS = new Set('select from where join on group order by having limit insert into values update set delete and or not as left inner'.split(' '))

export interface SqlCtx {
  start: number // replace range [start, end) (the word at the caret, after the dot for `alias.` contexts)
  end: number
  word: string
  qualifier: string[] | null // `a.` → ['a']; `s.t.` → ['s','t'] (normalized names)
  clause: Clause
  refs: TableRef[] // tables referenced by the current statement
  kwCase: 'upper' | 'lower' | null // case of the keywords used so far
  forced: boolean // opened with Ctrl+Space
}

/**
 * Context for completion at `caret`, or null when nothing should pop up: inside a string / quoted identifier /
 * comment, right after a number, after a `$` parameter, or (unless forced) with nothing typed.
 */
export function analyze(sql: string, caret: number, forced = false): SqlCtx | null {
  const toks = lex(sql)
  if (inLiteral(toks, caret)) return null
  let start = caret
  while (start > 0 && isIdentChar(sql[start - 1])) start--
  const word = sql.slice(start, caret)
  if (/^[0-9]/.test(word)) return null
  if (sql[start - 1] === '$') return null
  let end = caret
  while (end < sql.length && isIdentChar(sql[end])) end++

  const [ss, se] = statementRange(toks, caret, sql.length)
  const sig = toks.filter((k) => k.t !== 'comment' && k.start >= ss && k.end <= se)
  const before = sig.filter((k) => k.end <= start)

  // `a.` / `s.t.` qualifier directly before the word
  let qualifier: string[] | null = null
  const dot = before[before.length - 1]
  if (dot && dot.t === 'p' && dot.value === '.' && dot.end === start) {
    const parts: string[] = []
    let i = before.length - 2
    let edge = dot.start
    while (i >= 0 && parts.length < 2) {
      const k = before[i]
      if (!isName(k) || k.end !== edge) break
      parts.unshift(k.value)
      const d = before[i - 1]
      if (d && d.t === 'p' && d.value === '.' && d.end === k.start) {
        edge = d.start
        i -= 2
      } else break
    }
    if (!parts.length) return null // `1.` / `).` : nothing sensible to complete
    qualifier = parts
  }
  if (!word && !qualifier && !forced) return null

  let kwCase: SqlCtx['kwCase'] = null
  for (let i = toks.length - 1; i >= 0; i--) {
    const k = toks[i]
    if (k.end > start || k.t !== 'word' || !CASE_WORDS.has(k.value)) continue
    kwCase = k.text === k.text.toUpperCase() ? 'upper' : 'lower'
    break
  }

  return {
    start,
    end,
    word,
    qualifier,
    clause: qualifier ? 'column' : clauseAt(before),
    refs: parseTableRefs(sig),
    kwCase,
    forced
  }
}

export interface KnownNames {
  defaultSchema: string
  schemas: string[]
  /** table names of a schema, or undefined when that schema's listing isn't loaded */
  tablesOf: (schema: string) => string[] | undefined
}

export type Resolved = { kind: 'table'; schema: string; table: string } | { kind: 'schema'; schema: string } | null

/** What does `qualifier.` refer to: an alias / table of the statement, a schema, or a table of the default schema? */
export function resolveQualifier(parts: string[], refs: TableRef[], known: KnownNames): Resolved {
  const sch = (r: TableRef): string => r.schema ?? known.defaultSchema
  if (parts.length === 1) {
    const q = parts[0]
    const byAlias = refs.find((r) => r.alias === q)
    if (byAlias) return { kind: 'table', schema: sch(byAlias), table: byAlias.table }
    const byName = refs.find((r) => !r.alias && r.table === q && known.tablesOf(sch(r))?.includes(q))
    if (byName) return { kind: 'table', schema: sch(byName), table: byName.table }
    if (known.schemas.includes(q)) return { kind: 'schema', schema: q }
    if (known.tablesOf(known.defaultSchema)?.includes(q)) return { kind: 'table', schema: known.defaultSchema, table: q }
    return null
  }
  if (parts.length === 2) return { kind: 'table', schema: parts[0], table: parts[1] }
  return null
}
