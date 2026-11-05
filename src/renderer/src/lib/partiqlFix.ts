import { tokenize, type Hint } from './whereFix'

/** Friendly messages + one-click fixes for the DynamoDB (PartiQL) WHERE box. */

/** PartiQL condition functions whose first argument is the attribute: `begins_with(sk, 'x')`, `contains(tags, 'y')`, ... */
const ATTR_FUNCTIONS = ['begins_with', 'contains', 'attribute_type']
/** words that can sit before a function call without being an attribute (`a = 1 and begins_with(...)`) */
const KEYWORDS = new Set(['and', 'or', 'not', 'where', 'in', 'between', 'is', 'null', 'missing', 'true', 'false', 'like', 'select', 'from'])

/**
 * `SK begins_with('x')` (the function written like an operator) is not PartiQL: the attribute is the function's first
 * argument. Rewrites every such occurrence to `begins_with(SK, 'x')`. Returns null when there is nothing to fix.
 */
export function suggestPartiqlFix(where: string): Hint | null {
  const toks = tokenize(where)
  const edits: { s: number; e: number; text: string; shown: string; before: string }[] = []
  for (let i = 0; i + 2 < toks.length; i++) {
    const attr = toks[i]
    const fn = toks[i + 1]
    const open = toks[i + 2]
    if (!(attr.t === 'word' || attr.t === 'qid')) continue
    if (attr.t === 'word' && KEYWORDS.has(attr.v.toLowerCase())) continue
    if (fn.t !== 'word' || !ATTR_FUNCTIONS.includes(fn.v.toLowerCase())) continue
    if (open.t !== 'sym' || open.v !== '(') continue
    // `begins_with` itself as the "attribute" of an earlier call, e.g. `contains(begins_with(...` is not this mistake
    const prev = toks[i - 1]
    if (prev && prev.t === 'sym' && prev.v === '(' && toks[i - 2]?.t === 'word' && ATTR_FUNCTIONS.includes(toks[i - 2].v.toLowerCase())) continue
    // matching ')'
    let depth = 0
    let close = -1
    for (let j = i + 2; j < toks.length; j++) {
      const t = toks[j]
      if (t.t !== 'sym') continue
      if (t.v === '(') depth++
      else if (t.v === ')' && --depth === 0) { close = j; break }
    }
    if (close < 0) continue
    const args = where.slice(open.e, toks[close].s).trim()
    const attrText = where.slice(attr.s, attr.e)
    const fixed = `${fn.v}(${attrText}${args ? ', ' + args : ''})`
    edits.push({ s: attr.s, e: toks[close].e, text: fixed, shown: fixed, before: where.slice(attr.s, toks[close].e) })
    i = close
  }
  if (!edits.length) return null
  let out = ''
  let pos = 0
  for (const e of edits) {
    out += where.slice(pos, e.s) + e.text
    pos = e.e
  }
  out += where.slice(pos)
  const first = edits[0]
  return {
    message: `\`${first.before}\` is not valid PartiQL: the attribute goes inside the function. Use \`${first.shown}\``,
    fixedWhere: out
  }
}
