import type { Column } from '../../../shared'
import { functionSnippet } from './partiqlCandidates'

/** Pure completion logic behind SuggestInput (WHERE / ORDER BY boxes). */

export const WHERE_KEYWORDS = ['and', 'or', 'not', 'like', 'ilike', 'in', 'is null', 'is not null', 'between', 'true', 'false']
export const ORDER_KEYWORDS = ['asc', 'desc', 'nulls first', 'nulls last']
/** DynamoDB PartiQL WHERE: keywords and the condition functions (a trailing `(` is inserted without a space) */
export const PARTIQL_WHERE_KEYWORDS = [
  'and', 'or', 'not', 'in', 'between', 'is null', 'is not null', 'is missing', 'is not missing', 'true', 'false',
  'begins_with(', 'contains(', 'attribute_type(', 'size(', 'exists('
]
const kwItem = (k: string): Item => {
  // `begins_with(` -> `begins_with(, )` with the caret in the first argument; plain keywords get a trailing space
  if (!k.endsWith('(')) return { kind: 'kw', label: k, insert: k + ' ' }
  return { kind: 'kw', label: k, ...functionSnippet(k.slice(0, -1)) }
}

// Postgres reserved words: a column with one of these names must be double-quoted when inserted.
export const RESERVED = new Set(
  ('all analyse analyze and any array as asc asymmetric authorization between binary both case cast check collate ' +
    'collation column concurrently constraint create cross current_catalog current_date current_role current_schema ' +
    'current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for ' +
    'foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral ' +
    'leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps ' +
    'placing primary references returning right select session_user similar some symmetric table tablesample then to ' +
    'trailing true union unique user using variadic verbose when where window with').split(' ')
)
export const needsQuote = (name: string): boolean => !/^[a-z_][a-z0-9_]*$/.test(name) || RESERVED.has(name)
export const quoteName = (name: string): string => (needsQuote(name) ? '"' + name.replace(/"/g, '""') + '"' : name)

export interface Ctx {
  start: number // replace range [start, end) in the input value
  end: number
  word: string
  alias: boolean // `t.` / `alias.` prefix present: columns only
  forced: boolean // opened with Ctrl+Space
  fnArg?: boolean // right after `fn(`: a function's first argument (attribute names are suggested even with nothing typed)
}
export interface Item {
  kind: 'col' | 'kw'
  label: string // shown text
  insert: string // text inserted in place of the current word
  col?: Column
  caretBack?: number // caret offset from the end of the inserted text (`begins_with(|, )`)
}

const FN_OPEN = /[A-Za-z_][A-Za-z0-9_]*\(\s*$/
/** words that can precede `(` without being a function call */
const NOT_FUNCTIONS = new Set(['in', 'and', 'or', 'not', 'between', 'values', 'any', 'all', 'some', 'select', 'where', 'from', 'on', 'using', 'as', 'like', 'ilike', 'is', 'then', 'else', 'when', 'case'])

/** The word under the caret, or null when the caret is inside a '...' string literal (or on a number). */
export function wordAt(value: string, caret: number): Omit<Ctx, 'forced'> | null {
  const before = value.slice(0, caret)
  if ((before.match(/'/g)?.length ?? 0) % 2 === 1) return null // inside an unterminated string literal
  const m = /(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z0-9_]*)$/.exec(before)
  if (!m) return null
  const word = m[2]
  if (/^[0-9]/.test(word)) return null
  const start = caret - word.length
  let end = caret
  while (end < value.length && /[A-Za-z0-9_]/.test(value[end])) end++ // swallow the rest of the identifier
  const alias = m[1] !== undefined
  const fnArg = !alias && !word && FN_OPEN.test(value.slice(0, start)) && !NOT_FUNCTIONS.has(/([A-Za-z_][A-Za-z0-9_]*)\(\s*$/.exec(value.slice(0, start))![1].toLowerCase())
  return { start, end, word, alias, ...(fnArg ? { fnArg } : {}) }
}

export function candidates(ctx: Ctx, columns: Column[], keywords: string[], quote: (name: string) => string = quoteName): Item[] {
  const w = ctx.word.toLowerCase()
  const cols = columns.map((c): Item => ({ kind: 'col', label: c.name, insert: quote(c.name), col: c }))
  const lc = (i: Item): string => i.label.toLowerCase()
  let out: Item[]
  if (!w) out = ctx.forced || ctx.alias || ctx.fnArg ? cols : []
  else {
    out = [...cols.filter((i) => lc(i).startsWith(w)), ...cols.filter((i) => !lc(i).startsWith(w) && lc(i).includes(w))]
    if (!out.length && ctx.forced) out = cols
  }
  if (!ctx.alias) {
    if (!w && ctx.forced && !ctx.fnArg) out = [...out, ...keywords.map(kwItem)]
    else if (w) out = [...out, ...keywords.filter((k) => k.startsWith(w)).map(kwItem)]
  }
  // nothing left to complete: the only candidate is exactly what was typed
  if (w && out.every((i) => i.label.toLowerCase() === w)) return []
  return out
}
