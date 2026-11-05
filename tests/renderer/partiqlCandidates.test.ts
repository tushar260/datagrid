import { describe, expect, it } from 'vitest'
import {
  analyzePartiql, buildPartiqlItems, functionSnippet, PARTIQL_FUNCTIONS, PARTIQL_KEYWORDS, quotePartiqlName, type PartiqlMeta
} from '../../src/renderer/src/lib/partiqlCandidates'
import { candidates, PARTIQL_WHERE_KEYWORDS, wordAt } from '../../src/renderer/src/lib/suggest'

const col = (name: string, type = 'S', isPk = false) => ({ name, type, nullable: !isPk, isPk })
const META: PartiqlMeta = {
  tables: ['Orders', 'users', 'we"ird'],
  columns: (t) =>
    t === 'Orders' ? [col('pk', 'S', true), col('sk', 'N'), col('status'), col('created At'), col('total')] : t === 'users' ? [col('id', 'S', true), col('email')] : undefined
}
/** analyse `text` with the caret at `|` (or at the end) */
const at = (text: string, forced = false) => {
  const caret = text.includes('|') ? text.indexOf('|') : text.length
  const t = text.replace('|', '')
  return { t, ctx: analyzePartiql(t, caret, forced) }
}
const labels = (text: string, forced = false): string[] => {
  const { ctx } = at(text, forced)
  return ctx ? buildPartiqlItems(ctx, META).map((i) => i.label) : []
}

describe('quotePartiqlName', () => {
  it.each([
    ['pk', 'pk'], ['userId', 'userId'], ['_x1', '_x1'],
    ['status', '"status"'], ['Name', '"Name"'], ['value', '"value"'], ['date', '"date"'], ['size', '"size"'],
    ['created At', '"created At"'], ['a-b', '"a-b"'], ['1abc', '"1abc"'], ['we"ird', '"we""ird"'], ['', '""'], ['é', '"é"']
  ])('%j -> %s', (n, q) => expect(quotePartiqlName(n)).toBe(q))
})

describe('analyzePartiql', () => {
  it('table position after FROM / INTO / UPDATE, even with nothing typed', () => {
    for (const kw of ['FROM', 'from', 'INTO', 'UPDATE']) {
      const { ctx } = at(`SELECT * ${kw} `)
      expect(ctx).toMatchObject({ clause: 'table', word: '' })
    }
  })

  it('expression position needs a typed word unless forced', () => {
    expect(at('SELECT * FROM "Orders" WHERE ').ctx).toBeNull()
    expect(at('SELECT * FROM "Orders" WHERE ', true).ctx).toMatchObject({ clause: 'expr', tables: ['Orders'] })
    expect(at('SELECT * FROM "Orders" WHERE st').ctx).toMatchObject({ clause: 'expr', word: 'st', start: 'SELECT * FROM "Orders" WHERE '.length })
  })

  it('collects the tables of the current statement only', () => {
    const { ctx } = at('SELECT * FROM users; SELECT * FROM "Orders" WHERE st|; SELECT * FROM "x"')
    expect(ctx!.tables).toEqual(['Orders'])
    expect(at('UPDATE "a""b" SET x = 1 WHERE y|').ctx!.tables).toEqual(['a"b'])
    expect(at(`INSERT INTO t VALUE {'a': 1} -- x\n`, true).ctx!.tables).toEqual(['t'])
  })

  it('nothing inside strings or comments', () => {
    expect(at(`SELECT * FROM "Orders" WHERE status = 'sh`).ctx).toBeNull()
    expect(at('SELECT 1 -- hel').ctx).toBeNull()
    expect(at('SELECT 1 /* hel').ctx).toBeNull()
    expect(at('SELECT 1 /* x */ FROM t WHERE a').ctx).not.toBeNull()
    expect(at(`SELECT 'it''s' FROM t WHERE a`).ctx).not.toBeNull()
  })

  it('a quoted name completes tables, but not attributes', () => {
    const { ctx, t } = at('SELECT * FROM "Ord|"')
    expect(ctx).toMatchObject({ clause: 'table', word: 'Ord', quoted: true })
    expect(t.slice(ctx!.start, ctx!.end)).toBe('"Ord"') // the closing quote is part of the replaced range
    expect(at('SELECT * FROM "Orders" WHERE "sta').ctx).toBeNull()
    expect(at('SELECT * FROM "Ord', false).ctx).toMatchObject({ end: 'SELECT * FROM "Ord'.length }) // no closing quote
  })

  it('numbers are not completed; the identifier after the caret is replaced too', () => {
    expect(at('SELECT * FROM t WHERE 12').ctx).toBeNull()
    const { ctx, t } = at('SELECT * FROM t WHERE st|atus = 1')
    expect(t.slice(ctx!.start, ctx!.end)).toBe('status')
  })

  it('keyword case follows what the user typed', () => {
    expect(at('select * from t where a').ctx!.kwCase).toBe('lower')
    expect(at('SELECT * FROM t WHERE a').ctx!.kwCase).toBe('upper')
    expect(at('FROM t WHERE a').ctx!.kwCase).toBe('upper')
  })

  it('a semicolon inside quotes does not end the statement', () => {
    expect(at(`SELECT * FROM "a;b" WHERE st`).ctx!.tables).toEqual(['a;b'])
  })
})

describe('buildPartiqlItems', () => {
  it('suggests table names after FROM, inserted double-quoted', () => {
    const { ctx } = at('SELECT * FROM ')
    const items = buildPartiqlItems(ctx!, META)
    expect(items.map((i) => i.label)).toEqual(['Orders', 'users', 'we"ird'])
    expect(items.map((i) => i.insert)).toEqual(['"Orders"', '"users"', '"we""ird"'])
    expect(items.every((i) => i.kind === 'table')).toBe(true)
    expect(labels('SELECT * FROM us')).toEqual(['users'])
    expect(labels('SELECT * FROM rd')).toEqual(['Orders', 'we"ird']) // substring matches too
    expect(labels('UPDATE ord')).toEqual(['Orders'])
  })

  it('no suggestion when the only candidate is what was typed', () => {
    expect(labels('SELECT * FROM users')).toEqual([])
    expect(labels('SELECT * FROM "users"'.slice(0, -1))).toEqual([])
  })

  it('attributes of the referenced tables, quoted when needed, PK flagged', () => {
    const items = buildPartiqlItems(at('SELECT * FROM "Orders" WHERE s').ctx!, META)
    const status = items.find((i) => i.label === 'status')!
    expect(status).toMatchObject({ kind: 'col', insert: '"status"', detail: 'S' })
    const sk = items.find((i) => i.label === 'sk')!
    expect(sk.insert).toBe('sk')
    expect(buildPartiqlItems(at('SELECT * FROM "Orders" WHERE cr').ctx!, META).find((i) => i.label === 'created At')!.insert).toBe('"created At"')
    expect(buildPartiqlItems(at('SELECT * FROM "Orders" WHERE si').ctx!, META).find((i) => i.label === 'size')?.kind).toBe('fn')
    expect(buildPartiqlItems(at('SELECT * FROM "Orders" WHERE p').ctx!, META).find((i) => i.label === 'pk')!.col!.isPk).toBe(true)
  })

  it('attributes come first, then keywords and functions', () => {
    const kinds = buildPartiqlItems(at('SELECT * FROM "Orders" WHERE s').ctx!, META).map((i) => i.kind)
    expect(kinds.indexOf('col')).toBeLessThan(kinds.indexOf('kw'))
    expect(kinds).toContain('fn')
  })

  it('forced with nothing typed lists attributes, keywords and functions', () => {
    const l = labels('SELECT * FROM users WHERE ', true)
    expect(l).toEqual(expect.arrayContaining(['id', 'email', 'SELECT', 'begins_with']))
  })

  it('keywords follow the typed case; multi-word ones are offered', () => {
    expect(labels('select * from users where ord')).toContain('order by')
    expect(labels('SELECT * FROM users WHERE ord')).toContain('ORDER BY')
    const ins = buildPartiqlItems(at('INSERT INTO users val').ctx!, META).find((i) => i.label === 'VALUE')!
    expect(ins.insert).toBe('VALUE ')
    expect(labels('SELECT * FROM users WHERE a ret')).toEqual(expect.arrayContaining(['RETURNING ALL OLD *', 'RETURNING ALL NEW *']))
  })

  it('functions insert a call with the right number of arguments and put the caret in the first one', () => {
    const f = buildPartiqlItems(at('SELECT * FROM users WHERE begin').ctx!, META).find((i) => i.label === 'begins_with')!
    expect(f).toMatchObject({ kind: 'fn', insert: 'begins_with(, )', caretBack: 3 })
    const find = (typed: string, label: string) => buildPartiqlItems(at(`SELECT * FROM users WHERE ${typed}`).ctx!, META).find((i) => i.label === label)!
    expect(find('cont', 'contains')).toMatchObject({ insert: 'contains(, )', caretBack: 3 })
    expect(find('attribute_t', 'attribute_type')).toMatchObject({ insert: 'attribute_type(, )', caretBack: 3 })
    expect(find('siz', 'size')).toMatchObject({ insert: 'size()', caretBack: 1 })
    expect(find('exi', 'exists')).toMatchObject({ insert: 'exists()', caretBack: 1 })
  })

  it('right after `fn(` attribute names are suggested with nothing typed (no keywords / functions)', () => {
    const r = at('SELECT * FROM Orders WHERE begins_with(')
    expect(r.ctx).toMatchObject({ word: '', fnArg: true })
    const items = buildPartiqlItems(r.ctx!, META)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.kind === 'col')).toBe(true)
    expect(items.map((i) => i.label)).toEqual(['pk', 'sk', 'status', 'created At', 'total'])
    // caret between the parentheses of an inserted call
    expect(at('SELECT * FROM Orders WHERE size(|)').ctx).toMatchObject({ fnArg: true })
    expect(at('SELECT * FROM Orders WHERE begins_with(|, )').ctx).toMatchObject({ fnArg: true })
  })

  it('no popup after non-function parentheses, a second argument, or without a function name', () => {
    expect(at('SELECT * FROM Orders WHERE pk in (').ctx).toBeNull()
    expect(at('SELECT * FROM Orders WHERE a and (').ctx).toBeNull()
    expect(at('SELECT * FROM Orders WHERE begins_with(pk, ').ctx).toBeNull()
    expect(at('SELECT * FROM Orders WHERE (').ctx).toBeNull()
  })

  it('functionSnippet: caret offset always points just after the opening parenthesis', () => {
    for (const n of ['begins_with', 'contains', 'attribute_type', 'size', 'exists', 'whatever']) {
      const s = functionSnippet(n)
      expect(s.insert.length - s.caretBack).toBe(n.length + 1)
      expect(s.insert.slice(0, n.length + 1)).toBe(n + '(')
    }
  })

  it('no LIMIT keyword (PartiQL has none)', () => {
    expect(PARTIQL_KEYWORDS).not.toContain('limit')
    expect(labels('SELECT * FROM users WHERE lim')).toEqual([])
    expect(PARTIQL_FUNCTIONS).toContain('contains')
  })

  it('unknown attributes (metadata not loaded yet) still offer keywords', () => {
    expect(labels('SELECT * FROM nothing WHERE an')).toEqual(expect.arrayContaining(['AND']))
  })

  it('caps the list', () => {
    const many: PartiqlMeta = { tables: Array.from({ length: 500 }, (_, i) => 't' + i), columns: () => [] }
    expect(buildPartiqlItems(analyzePartiql('SELECT * FROM t', 15)!, many)).toHaveLength(300)
  })
})

describe('WHERE box (SuggestInput) with PartiQL keywords', () => {
  const cols = [col('pk', 'S', true), col('status')]
  const run = (v: string, quote = quotePartiqlName) => candidates({ ...wordAt(v, v.length)!, forced: false }, cols, PARTIQL_WHERE_KEYWORDS, quote)

  it('functions are inserted as a call with empty argument slots (caret in the first), plain keywords with a trailing space', () => {
    expect(run('beg').find((i) => i.label === 'begins_with(')).toMatchObject({ insert: 'begins_with(, )', caretBack: 3 })
    expect(run('con').find((i) => i.label === 'contains(')).toMatchObject({ insert: 'contains(, )', caretBack: 3 })
    expect(run('siz').find((i) => i.label === 'size(')).toMatchObject({ insert: 'size()', caretBack: 1 })
    expect(run('an').find((i) => i.label === 'and')!.insert).toBe('and ')
    expect(run('is').map((i) => i.label)).toEqual(['is null', 'is not null', 'is missing', 'is not missing'])
  })

  it('attribute names use PartiQL quoting (reserved words get quoted)', () => {
    expect(run('sta').find((i) => i.label === 'status')!.insert).toBe('"status"')
    expect(run('p').find((i) => i.label === 'pk')!.insert).toBe('pk')
  })

  it('the default (Postgres) behaviour is unchanged', () => {
    const items = candidates({ ...wordAt('sta', 3)!, forced: false }, cols, ['and'])
    expect(items.find((i) => i.label === 'status')!.insert).toBe('status')
  })
})
