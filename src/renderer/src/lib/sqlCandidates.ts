import type { Column } from '../../../shared'
import { quoteName } from './suggest'
import { resolveQualifier, type KnownNames, type SqlCtx, type TableRef } from './sqlContext'

/** Candidate generation + ranking for the query-console autocomplete (pure; metadata is passed in). */

export type SqlKind = 'kw' | 'fn' | 'table' | 'view' | 'col' | 'schema'

export interface SqlItem {
  kind: SqlKind
  label: string // shown text
  insert: string // replaces the word at the caret
  detail: string // right-hand hint: column type, `table` / `view`, `keyword` ...
  col?: Column
  src?: string // owning alias / table when several tables are in scope
  caretBack?: number // caret offset from the end of the inserted text (`count(|)`)
}

export interface TableEntry {
  name: string
  kind: string // 'table' | 'view' | 'matview' | 'foreign'
}

export interface SqlMeta extends KnownNames {
  tables: Record<string, TableEntry[]>
  columns: (schema: string, table: string) => Column[] | undefined
}

export const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema'])
const MAX_ITEMS = 300

export const SQL_KEYWORDS = [
  'select', 'from', 'where', 'join', 'left join', 'inner join', 'right join', 'full join', 'cross join', 'left outer join',
  'on', 'group by', 'order by', 'having', 'limit', 'offset', 'insert into', 'values', 'update', 'set', 'delete from',
  'returning', 'as', 'distinct', 'union', 'union all', 'intersect', 'except', 'with', 'case', 'when', 'then', 'else', 'end',
  'and', 'or', 'not', 'in', 'exists', 'between', 'like', 'ilike', 'is null', 'is not null', 'asc', 'desc', 'nulls first',
  'nulls last', 'true', 'false', 'null', 'using', 'on conflict', 'do nothing', 'do update set', 'create table',
  'create index', 'create unique index', 'create view', 'alter table', 'drop table', 'drop index', 'drop view', 'truncate',
  'add column', 'drop column', 'primary key', 'references', 'default', 'partition by', 'over', 'filter', 'lateral', 'fetch',
  'explain', 'explain analyze', 'begin', 'commit', 'rollback', 'analyze', 'vacuum'
]

// [name, takes arguments]
export const SQL_FUNCTIONS: [string, boolean][] = [
  ['count', true], ['sum', true], ['avg', true], ['min', true], ['max', true], ['coalesce', true], ['nullif', true],
  ['now', false], ['current_date', false], ['current_timestamp', false], ['lower', true], ['upper', true], ['length', true],
  ['substring', true], ['cast', true], ['to_char', true], ['to_date', true], ['to_timestamp', true], ['date_trunc', true],
  ['extract', true], ['age', true], ['array_agg', true], ['string_agg', true], ['json_agg', true], ['jsonb_agg', true],
  ['json_build_object', true], ['jsonb_build_object', true], ['concat', true], ['concat_ws', true], ['trim', true],
  ['replace', true], ['split_part', true], ['regexp_replace', true], ['round', true], ['ceil', true], ['floor', true],
  ['abs', true], ['greatest', true], ['least', true], ['row_number', false], ['rank', false], ['dense_rank', false],
  ['generate_series', true], ['unnest', true], ['random', false], ['gen_random_uuid', false], ['md5', true],
  ['to_json', true], ['to_jsonb', true], ['jsonb_array_elements', true], ['bool_and', true], ['bool_or', true]
]

// what can follow a table reference (Ctrl+Space still offers everything)
const FOLLOW_KEYWORDS = new Set([
  'where', 'join', 'left join', 'right join', 'inner join', 'full join', 'cross join', 'left outer join', 'on', 'using',
  'group by', 'order by', 'having', 'limit', 'offset', 'union', 'union all', 'intersect', 'except', 'set', 'values',
  'select', 'returning', 'on conflict', 'as', 'fetch'
])

const applyCase = (s: string, upper: boolean): string => (upper ? s.toUpperCase() : s)

/** 0 = prefix match, 1 = contains, -1 = no match. */
export function matchRank(label: string, word: string): number {
  if (!word) return 0
  const l = label.toLowerCase()
  const w = word.toLowerCase()
  if (l.startsWith(w)) return 0
  return l.includes(w) ? 1 : -1
}

const kindOf = (e: TableEntry): SqlKind => (e.kind === 'view' || e.kind === 'matview' ? 'view' : 'table')

/** Distinct, known tables of the statement (alias → which table's columns to offer). */
export function resolveRefs(refs: TableRef[], meta: SqlMeta): { schema: string; table: string; name: string }[] {
  const out: { schema: string; table: string; name: string }[] = []
  for (const r of refs) {
    const schema = r.schema ?? meta.defaultSchema
    if (!meta.tables[schema]?.some((t) => t.name === r.table)) continue // unknown / still typing / listing not loaded
    const name = r.alias ?? r.table
    if (!out.some((o) => o.schema === schema && o.table === r.table && o.name === name)) out.push({ schema, table: r.table, name })
  }
  return out
}

/** Which lookups would improve the candidates for this context? The UI fetches them lazily and re-renders. */
export function neededLookups(ctx: SqlCtx, meta: SqlMeta): { columns: { schema: string; table: string }[]; schemaTables: string[] } {
  const need = { columns: [] as { schema: string; table: string }[], schemaTables: [] as string[] }
  if (ctx.qualifier) {
    const r = resolveQualifier(ctx.qualifier, ctx.refs, meta)
    if (r?.kind === 'table') {
      if (meta.tables[r.schema]?.some((t) => t.name === r.table)) need.columns.push({ schema: r.schema, table: r.table })
    } else if (r?.kind === 'schema') need.schemaTables.push(r.schema)
  } else if (ctx.clause === 'column' || ctx.clause === 'afterTable' || ctx.clause === 'start') {
    for (const r of resolveRefs(ctx.refs, meta)) need.columns.push({ schema: r.schema, table: r.table })
  }
  return need
}

interface Cand {
  item: SqlItem
  group: number
}

export function buildItems(ctx: SqlCtx, meta: SqlMeta): SqlItem[] {
  const w = ctx.word
  const afterTable = ctx.clause === 'afterTable' && !ctx.forced
  // keyword case follows what is being typed; with nothing typed, the keywords used so far (lower-case by default)
  const upper = !w
    ? ctx.kwCase === 'upper'
    : w === w.toUpperCase() && /[A-Z]/.test(w) && (w.length >= 2 || ctx.kwCase !== 'lower')
  const colItem = (c: Column, src?: string): SqlItem => ({
    kind: 'col', label: c.name, insert: quoteName(c.name), detail: c.type, col: c, src
  })

  const rank = (cands: Cand[], all: boolean): SqlItem[] => {
    const scored = cands
      .map((c, order) => ({ c, order, q: all ? 0 : matchRank(c.item.label, w) }))
      .filter((x) => x.q >= 0 && !(afterTable && x.q > 0)) // after a table: prefix matches only
      .sort((a, b) => a.c.group - b.c.group || a.q - b.q || a.order - b.order)
    return scored.slice(0, MAX_ITEMS).map((x) => x.c.item)
  }
  const finish = (cands: Cand[]): SqlItem[] => {
    let out = rank(cands, false)
    if (!out.length && w && ctx.forced) out = rank(cands, true)
    // nothing left to complete: the only candidates are exactly what was typed
    if (w && out.every((i) => i.label.toLowerCase() === w.toLowerCase())) return []
    return out
  }

  // `alias.` / `table.` / `schema.table.` / `schema.`
  if (ctx.qualifier) {
    const r = resolveQualifier(ctx.qualifier, ctx.refs, meta)
    if (!r) return []
    if (r.kind === 'table') {
      const cols = meta.columns(r.schema, r.table) ?? []
      return finish(cols.map((c) => ({ item: colItem(c), group: 0 })))
    }
    const list = meta.tables[r.schema] ?? []
    return finish(
      list.map((t) => ({ item: { kind: kindOf(t), label: t.name, insert: quoteName(t.name), detail: t.kind === 'matview' ? 'matview' : kindOf(t) }, group: 0 }))
    )
  }

  const cols: Cand[] = []
  const refs = resolveRefs(ctx.refs, meta)
  const multi = refs.length > 1
  for (const r of refs) for (const c of meta.columns(r.schema, r.table) ?? []) cols.push({ item: colItem(c, multi ? r.name : undefined), group: 0 })

  const kws: Cand[] = SQL_KEYWORDS.filter((k) => !afterTable || FOLLOW_KEYWORDS.has(k)).map((k) => ({
    item: { kind: 'kw', label: applyCase(k, upper), insert: applyCase(k, upper) + ' ', detail: 'keyword' },
    group: 0
  }))
  const fns: Cand[] = SQL_FUNCTIONS.map(([f, args]) => {
    const name = applyCase(f, upper)
    const bare = f.startsWith('current_') // current_date / current_timestamp take no parentheses
    return {
      item: { kind: 'fn', label: name, insert: bare ? name : name + '()', detail: 'function', caretBack: args ? 1 : 0 },
      group: 0
    }
  })
  const local: Cand[] = (meta.tables[meta.defaultSchema] ?? []).map((t) => ({
    item: { kind: kindOf(t), label: t.name, insert: quoteName(t.name), detail: kindOf(t) }, group: 0
  }))
  const schemas: Cand[] = meta.schemas.map((s) => ({
    item: { kind: 'schema', label: s, insert: quoteName(s) + '.', detail: 'schema' }, group: 0
  }))
  const other: Cand[] = []
  for (const [s, list] of Object.entries(meta.tables)) {
    if (s === meta.defaultSchema || SYSTEM_SCHEMAS.has(s)) continue
    for (const t of list) {
      other.push({ item: { kind: kindOf(t), label: `${s}.${t.name}`, insert: `${quoteName(s)}.${quoteName(t.name)}`, detail: kindOf(t) }, group: 0 })
    }
  }

  const g = (cs: Cand[], group: number): Cand[] => cs.map((c) => ({ ...c, group }))
  let all: Cand[]
  if (ctx.clause === 'table') {
    all = [...g(local, 0), ...g(schemas, 1), ...g(other, 2), ...g(kws, 3), ...g(fns, 4)]
  } else if (ctx.clause === 'column') {
    all = [...g(cols, 0), ...g(kws, 1), ...g(fns, 1), ...g(local, 2), ...g(schemas, 3), ...g(other, 4)]
  } else if (afterTable) {
    all = g(kws, 0) // `from users u |` → where / join / group by ...
  } else {
    // statement start: keywords are what comes next
    all = [...g(kws, 0), ...g(fns, 1), ...g(cols, 2), ...g(local, 3), ...g(schemas, 4), ...g(other, 5)]
  }
  return finish(all)
}
