import type { Column } from '../../../shared'

/** Pure helpers that turn raw Postgres errors from the WHERE / ORDER BY boxes into friendly messages and one-click fixes. */

export interface Hint {
  /** Plain text; `backticked` parts are meant to be rendered as code. */
  message: string
  /** When set, replacement text for the box the error came from (apply it and re-run). */
  fixedWhere?: string
}

/** Strip the Electron IPC wrapper and the `error:` prefix of a pg error, capitalise the first letter. */
export function cleanDbError(raw: unknown): string {
  const m = raw instanceof Error ? raw.message : raw
  let s = String(m ?? '')
  s = s.replace(/^\s*Error invoking remote method '[^']*':\s*/i, '')
  s = s.replace(/^(?:\s*error:\s*)+/i, '').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

// ---- tiny SQL tokenizer (just enough to skip string literals / quoted identifiers) -----------------

export interface Tok {
  t: 'str' | 'qid' | 'word' | 'num' | 'sym'
  s: number
  e: number
  /** word: as typed; qid: unescaped content; others: raw text */
  v: string
}

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    if (/\s/.test(ch)) { i++; continue }
    const s = i
    if (ch === "'" || ch === '"') {
      i++
      let v = ''
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) { v += ch; i += 2; continue }
          break
        }
        v += sql[i++]
      }
      i = Math.min(n, i + 1) // closing quote (an unterminated literal runs to the end)
      out.push({ t: ch === "'" ? 'str' : 'qid', s, e: i, v })
    } else if (/[A-Za-z_]/.test(ch)) {
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++
      out.push({ t: 'word', s, e: i, v: sql.slice(s, i) })
    } else if (/[0-9]/.test(ch)) {
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i])) i++
      out.push({ t: 'num', s, e: i, v: sql.slice(s, i) })
    } else if (ch === ':' && sql[i + 1] === ':') {
      i += 2
      out.push({ t: 'sym', s, e: i, v: '::' })
    } else {
      i++
      out.push({ t: 'sym', s, e: i, v: ch })
    }
  }
  return out
}

const isIdent = (t: Tok | undefined): t is Tok => !!t && (t.t === 'word' || t.t === 'qid')
const isSym = (t: Tok | undefined, v: string): boolean => !!t && t.t === 'sym' && t.v === v
const isKw = (t: Tok | undefined, v: string): boolean => !!t && t.t === 'word' && t.v.toLowerCase() === v
const TEXTUAL = /^(text|varchar|character varying|character|char|bpchar|name|citext)\b/i

function findColumn(columns: readonly Column[], t: Tok): Column | undefined {
  const key = t.t === 'word' ? t.v.toLowerCase() : t.v // pg folds bare identifiers to lower case
  return columns.find((c) => c.name === key)
}

const sameType = (a: string, b: string): boolean => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x === y || x.startsWith(y + '(') || y.startsWith(x + '(')
}

// ---- LIKE on a non-text column -> cast to text ------------------------------------------------------

const OPS: Record<string, { word: string; neg: boolean; ilike: boolean }> = {
  '~~': { word: 'LIKE', neg: false, ilike: false },
  '~~*': { word: 'ILIKE', neg: false, ilike: true },
  '!~~': { word: 'NOT LIKE', neg: true, ilike: false },
  '!~~*': { word: 'NOT ILIKE', neg: true, ilike: true }
}

/**
 * `operator does not exist: <type> ~~ unknown` (LIKE / ILIKE / NOT LIKE / NOT ILIKE on a non-text column):
 * find the offending column reference in `where` and insert `::text` after it.
 */
export function suggestLikeCastFix(where: string, errorMessage: string, columns: readonly Column[] = []): Hint | null {
  const em = /operator does not exist:\s*(.+?)\s+(~~\*?|!~~\*?)\s+(unknown|text)\b/i.exec(errorMessage)
  if (!em) return null
  const errType = em[1].trim()
  if (TEXTUAL.test(errType)) return null
  const op = OPS[em[2]]
  const toks = tokenize(where)

  interface Cand { start: number; end: number; col?: Column; likeIdx: number }
  const cands: Cand[] = []
  for (let k = 0; k < toks.length; k++) {
    const lk = toks[k]
    const isLike = isKw(lk, 'like')
    const isILike = isKw(lk, 'ilike')
    if (!(isLike || isILike) || isILike !== op.ilike) continue
    let j = k - 1
    const neg = isKw(toks[j], 'not')
    if (neg) j--
    if (neg !== op.neg) continue
    if (!isIdent(toks[j])) continue // `)` / literal / expression operand: no safe rewrite
    let start = j
    while (isSym(toks[start - 1], '.') && isIdent(toks[start - 2])) start -= 2
    const before = toks[start - 1]
    if (isSym(before, '::') || isSym(before, '.')) continue // already cast (or something odd)
    cands.push({ start, end: j, col: findColumn(columns, toks[j]), likeIdx: k })
  }
  const usable = cands.filter((c) => !(c.col && TEXTUAL.test(c.col.type)))
  const typed = usable.filter((c) => c.col && sameType(c.col.type, errType))
  const pick = (typed.length ? typed : usable)[0]
  if (!pick) return null

  const pos = toks[pick.end].e
  const fixedWhere = where.slice(0, pos) + '::text' + where.slice(pos)
  const operand = where.slice(toks[pick.start].s, pos)
  // preview: operand::text <op> 'literal'
  const after = toks[pick.likeIdx + 1]
  const stop = after && after.t === 'str' ? after.e : toks[pick.likeIdx].e
  const snippet = operand + '::text' + where.slice(pos, stop)
  const type = pick.col?.type ?? errType
  return {
    message: `\`${operand}\` is of type ${type}; ${op.word} only works on text. Cast it: \`${snippet}\``,
    fixedWhere
  }
}

// ---- unknown column: wrong case -> quoted identifier --------------------------------------------------

export function suggestColumnCaseFix(text: string, errorMessage: string, columns: readonly Column[] = []): Hint | null {
  const em = /column (?:"([^"]+)"|([\w$.]+)) does not exist/i.exec(errorMessage)
  if (!em) return null
  const missing = em[1] ?? em[2].split('.').pop()!
  const generic = 'Column not found - check the name/case; quoted identifiers are case-sensitive.'
  const matches = columns.filter((c) => c.name !== missing && c.name.toLowerCase() === missing.toLowerCase())
  if (matches.length !== 1) return { message: generic }
  const real = matches[0].name
  const quoted = `"${real.replace(/"/g, '""')}"`
  const base = `Column not found - did you mean \`${quoted}\`? Quoted identifiers are case-sensitive; unquoted names fold to lower case.`

  const toks = tokenize(text)
  let out = ''
  let last = 0
  let changed = false
  toks.forEach((t, i) => {
    const hit = t.t === 'qid' ? t.v === missing : t.t === 'word' && t.v.toLowerCase() === missing && missing === missing.toLowerCase()
    if (!hit || isSym(toks[i - 1], '::') || isSym(toks[i + 1], '(')) return
    out += text.slice(last, t.s) + quoted
    last = t.e
    changed = true
  })
  if (!changed) return { message: base }
  return { message: base, fixedWhere: out + text.slice(last) }
}

// ---- invalid input syntax --------------------------------------------------------------------------

export function suggestInvalidInput(errorMessage: string): Hint | null {
  const m = /invalid input syntax for (?:type )?([^:]+?):/i.exec(errorMessage)
  if (!m) return null
  return { message: `Value doesn't match the column type (${m[1].trim()}).` }
}

/** First applicable hint for an error raised while running `text` (the WHERE or ORDER BY expression). */
export function suggestHint(text: string, errorMessage: string, columns: readonly Column[] = []): Hint | null {
  return (
    suggestLikeCastFix(text, errorMessage, columns) ??
    suggestColumnCaseFix(text, errorMessage, columns) ??
    suggestInvalidInput(errorMessage)
  )
}
