import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Column } from '../../shared'
import { Icon } from './icons'
import { analyze, type SqlCtx } from './lib/sqlContext'
import { buildItems, neededLookups, type SqlItem, type SqlMeta, type TableEntry } from './lib/sqlCandidates'
import { analyzeRedis, buildRedisItems, type RedisCtx } from './lib/redisCommands'
import { analyzePartiql, buildPartiqlItems, type PartiqlCtx, type PartiqlMeta } from './lib/partiqlCandidates'

/**
 * DataGrip-like completion for the query console's <textarea>: schema metadata (loaded lazily, cached per console)
 * plus a popup anchored at the caret. The textarea stays the editor, so selection / run-selection keep working.
 */

const MAX_VISIBLE = 10
const ROW_H = 24
const POP_W = 460

const colKey = (schema: string, table: string): string => schema + '\u0000' + table

/** Lazy metadata cache for one console: table list on mount, columns of a table the first time it is referenced. */
function useSqlMeta(dsId: string, database: string, schema: string | undefined, enabled: boolean) {
  const defaultSchema = schema || 'public'
  const store = useRef({
    schemas: [] as string[],
    tables: {} as Record<string, TableEntry[]>,
    kinded: new Set<string>(), // schemas whose listing came from db:tables (has view/table kinds)
    cols: new Map<string, Column[]>(),
    pending: new Set<string>()
  })
  const gen = useRef(0) // invalidates in-flight loads after refresh / unmount
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(false)
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  const load = useCallback(() => {
    if (!enabled) return
    const g = ++gen.current
    const s = store.current
    s.cols.clear()
    s.pending.clear()
    s.kinded.clear()
    setLoading(true)
    const live = (): boolean => g === gen.current
    const all = window.api.tableNames(dsId, database).then((m: Record<string, string[]>) => {
      if (!live()) return
      const next: Record<string, TableEntry[]> = {}
      for (const [sch, names] of Object.entries(m)) next[sch] = names.map((name) => ({ name, kind: 'table' }))
      const own = s.tables[defaultSchema]
      if (own && s.kinded.has(defaultSchema)) next[defaultSchema] = own
      s.tables = next
      bump()
    })
    const own = window.api.tables(dsId, database, defaultSchema).then((l: TableEntry[]) => {
      if (!live()) return
      s.tables = { ...s.tables, [defaultSchema]: l }
      s.kinded.add(defaultSchema)
      bump()
    })
    const schemas = window.api.schemasAll(dsId, database).then((l: string[]) => {
      if (!live()) return
      s.schemas = l
      bump()
    })
    void Promise.allSettled([all, own, schemas]).then(() => {
      if (live()) setLoading(false)
    })
  }, [dsId, database, defaultSchema, bump, enabled])

  useEffect(() => {
    load()
    return () => {
      gen.current++
    }
  }, [load])

  const ensureColumns = useCallback(
    (sch: string, table: string) => {
      const s = store.current
      const k = colKey(sch, table)
      if (s.cols.has(k) || s.pending.has(k)) return
      s.pending.add(k)
      const g = gen.current
      window.api.columns(dsId, database, sch, table).then(
        (c: Column[]) => {
          if (g !== gen.current) return
          s.cols.set(k, c)
          s.pending.delete(k)
          bump()
        },
        () => {
          if (g !== gen.current) return
          s.cols.set(k, []) // don't retry on every keystroke; refresh clears it
          s.pending.delete(k)
        }
      )
    },
    [dsId, database, bump]
  )

  const ensureSchemaTables = useCallback(
    (sch: string) => {
      const s = store.current
      const k = '\u0001' + sch
      if (s.kinded.has(sch) || s.pending.has(k)) return
      s.pending.add(k)
      const g = gen.current
      window.api.tables(dsId, database, sch).then(
        (l: TableEntry[]) => {
          if (g !== gen.current) return
          s.tables = { ...s.tables, [sch]: l }
          s.kinded.add(sch)
          s.pending.delete(k)
          bump()
        },
        () => s.pending.delete(k)
      )
    },
    [dsId, database, bump]
  )

  const meta = useMemo<SqlMeta>(() => {
    const s = store.current
    return {
      defaultSchema,
      schemas: s.schemas,
      tables: s.tables,
      tablesOf: (sch) => s.tables[sch]?.map((t) => t.name),
      columns: (sch, table) => s.cols.get(colKey(sch, table))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, defaultSchema])

  return { meta, loading, refresh: load, ensureColumns, ensureSchemaTables }
}

/** Lazy metadata cache of a DynamoDB console: table names on mount; attributes of a table the first time it is referenced. */
function useDynamoMeta(dsId: string, enabled: boolean) {
  const store = useRef({ tables: [] as string[], cols: new Map<string, Column[]>(), pending: new Set<string>() })
  const gen = useRef(0)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(false)
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  const load = useCallback(() => {
    if (!enabled) return
    const g = ++gen.current
    const s = store.current
    s.cols.clear()
    s.pending.clear()
    setLoading(true)
    window.api.dynamo.tables(dsId).then(
      (l) => {
        if (g !== gen.current) return
        s.tables = l
        bump()
        setLoading(false)
      },
      () => {
        if (g === gen.current) setLoading(false)
      }
    )
  }, [dsId, enabled, bump])
  useEffect(() => {
    load()
    return () => {
      gen.current++
    }
  }, [load])

  /** key attributes (from DescribeTable) first, then every other attribute seen in a small sample of items */
  const ensureColumns = useCallback(
    (table: string) => {
      const s = store.current
      if (s.cols.has(table) || s.pending.has(table)) return
      s.pending.add(table)
      const g = gen.current
      Promise.allSettled([
        window.api.dynamo.describe(dsId, table),
        window.api.dynamo.items(dsId, table, { limit: 25 })
      ]).then(([d, it]) => {
        if (g !== gen.current) return
        const cols = new Map<string, Column>()
        if (d.status === 'fulfilled') {
          for (const k of d.value.keySchema) cols.set(k.name, { name: k.name, type: k.attrType, nullable: false, isPk: k.keyType === 'HASH' })
          for (const x of d.value.indexes) {
            for (const k of x.keys) if (!cols.has(k.name)) cols.set(k.name, { name: k.name, type: k.attrType, nullable: true, isPk: false })
          }
        }
        if (it.status === 'fulfilled') {
          for (const c of it.value.columns) if (!cols.has(c.name)) cols.set(c.name, { name: c.name, type: c.types.join('|'), nullable: true, isPk: false })
        }
        s.cols.set(table, [...cols.values()])
        s.pending.delete(table)
        bump()
      })
    },
    [dsId, bump]
  )

  const meta = useMemo<PartiqlMeta>(() => {
    const s = store.current
    return { tables: s.tables, columns: (t) => s.cols.get(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  return { meta, loading, refresh: load, ensureColumns }
}

interface Pos {
  x: number
  y: number // top of the caret's line
  lh: number
}

const MIRROR_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing',
  'textIndent', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
] as const

/** Viewport coordinates of text offset `at` in a textarea, measured with a hidden mirror element. */
export function caretCoords(el: HTMLTextAreaElement, at: number): Pos {
  const cs = getComputedStyle(el)
  const m = document.createElement('div')
  const st = m.style
  st.position = 'fixed'
  st.visibility = 'hidden'
  st.top = '0'
  st.left = '-9999px'
  st.whiteSpace = 'pre-wrap'
  st.overflowWrap = 'break-word'
  st.boxSizing = 'border-box'
  st.border = '0'
  st.overflow = 'hidden'
  st.width = el.clientWidth + 'px'
  for (const p of MIRROR_PROPS) st[p as 'fontFamily'] = cs[p as 'fontFamily']
  m.textContent = el.value.slice(0, at)
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  m.appendChild(marker)
  document.body.appendChild(m)
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4
  const r = el.getBoundingClientRect()
  const pos = {
    x: r.left + el.clientLeft + marker.offsetLeft - el.scrollLeft,
    y: r.top + el.clientTop + marker.offsetTop - el.scrollTop,
    lh
  }
  m.remove()
  return pos
}

/** Insert text over [start, end) keeping the native undo stack when possible. */
function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string): void {
  el.focus()
  el.setSelectionRange(start, end)
  let ok = false
  try {
    ok = document.execCommand('insertText', false, text)
  } catch {
    ok = false
  }
  if (!ok) {
    el.setRangeText(text, start, end, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true })) // let React's onChange see it
  }
}

const KIND_MARK: Record<string, string> = { kw: 'K', fn: 'ƒ', col: 'c' }

function KindIcon({ kind }: { kind: SqlItem['kind'] }): React.JSX.Element {
  if (kind === 'table' || kind === 'view' || kind === 'schema') return <Icon name={kind} size={14} />
  return <span className={'cs-k cs-k-' + kind}>{KIND_MARK[kind]}</span>
}

const noop = (): void => {}

export function useConsoleSuggest(
  ta: React.RefObject<HTMLTextAreaElement | null>, dsId: string, database: string, schema?: string, engine?: 'dynamodb' | 'redis'
) {
  const dynamo = engine === 'dynamodb'
  const redis = engine === 'redis'
  const pg = useSqlMeta(dsId, database, schema, !dynamo && !redis)
  const dm = useDynamoMeta(dsId, dynamo)
  const { meta, ensureColumns, ensureSchemaTables } = pg
  // Redis has nothing to look up: command names are built in
  const loading = redis ? false : dynamo ? dm.loading : pg.loading
  const refresh = redis ? noop : dynamo ? dm.refresh : pg.refresh
  const [sqlCtx, setCtx] = useState<SqlCtx | null>(null)
  const [pctx, setPctx] = useState<PartiqlCtx | null>(null)
  const [rctx, setRctx] = useState<RedisCtx | null>(null)
  const ctx: { start: number; end: number } | null = redis ? rctx : dynamo ? pctx : sqlCtx
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<Pos | null>(null)
  const suppress = useRef(false) // set while we insert a suggestion ourselves
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(
    () => (redis ? (rctx ? buildRedisItems(rctx) : []) : dynamo ? (pctx ? buildPartiqlItems(pctx, dm.meta) : []) : sqlCtx ? buildItems(sqlCtx, meta) : []),
    [redis, rctx, dynamo, pctx, sqlCtx, dm.meta, meta]
  )
  const open = items.length > 0
  const sel = Math.min(active, Math.max(0, items.length - 1))

  // fetch only what the current context references (columns of the statement's tables, one schema's tables)
  useEffect(() => {
    if (redis) return
    if (dynamo) {
      if (pctx?.clause === 'expr') for (const t of pctx.tables) dm.ensureColumns(t)
      return
    }
    if (!sqlCtx) return
    const need = neededLookups(sqlCtx, meta)
    for (const c of need.columns) ensureColumns(c.schema, c.table)
    for (const s of need.schemaTables) ensureSchemaTables(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redis, dynamo, pctx, sqlCtx, meta, ensureColumns, ensureSchemaTables, dm.ensureColumns])

  useLayoutEffect(() => {
    const el = ta.current
    if (!ctx || !el) return setPos(null)
    setPos(caretCoords(el, ctx.start))
  }, [ctx, ta])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel, open])

  const refreshCtx = useCallback(
    (el: HTMLTextAreaElement, forced = false): void => {
      if (el.selectionStart !== el.selectionEnd) {
        setCtx(null)
        setPctx(null)
        setRctx(null)
        return
      }
      if (redis) setRctx(analyzeRedis(el.value, el.selectionStart, forced))
      else if (dynamo) setPctx(analyzePartiql(el.value, el.selectionStart, forced))
      else setCtx(analyze(el.value, el.selectionStart, forced))
      setActive(0)
    },
    [dynamo, redis]
  )
  const close = useCallback((): void => {
    setCtx(null)
    setPctx(null)
    setRctx(null)
  }, [])

  const accept = (item: SqlItem): void => {
    const el = ta.current
    if (!el || !ctx) return
    suppress.current = true
    try {
      replaceRange(el, ctx.start, ctx.end, item.insert)
    } finally {
      suppress.current = false
    }
    const caret = ctx.start + item.insert.length - (item.caretBack ?? 0)
    el.setSelectionRange(caret, caret)
    close()
    // `schema.` → straight on to that schema's tables
    if (item.insert.endsWith('.') || (dynamo && item.kind === 'fn')) refreshCtx(el) // PartiQL function: attributes for its first argument
  }

  /** Call from the textarea's onChange (after the value was applied). */
  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    if (suppress.current) return
    const type = (e.nativeEvent as InputEvent).inputType ?? ''
    if (type.startsWith('delete') && !open) return // backspacing alone doesn't pop the list up
    refreshCtx(e.target)
  }

  /** Call first from the textarea's onKeyDown; returns true when the key was consumed. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing) return false
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === ' ') {
      e.preventDefault()
      refreshCtx(e.currentTarget, true)
      return true
    }
    if (!open) return false
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === 'Enter') close() // Cmd/Ctrl+Enter runs the query: bypass the popup
      return false
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((sel + 1) % items.length)
        return true
      case 'ArrowUp':
        e.preventDefault()
        setActive((sel - 1 + items.length) % items.length)
        return true
      case 'Enter':
      case 'Tab':
        if (e.shiftKey && e.key === 'Tab') return false
        e.preventDefault() // accept; never a newline / run
        accept(items[sel])
        return true
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        return true
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
        close()
        return false
    }
    return false
  }

  const popup =
    open && pos
      ? createPortal(
          <div
            ref={listRef}
            className="cs-pop"
            role="listbox"
            style={{
              left: Math.max(4, Math.min(pos.x, window.innerWidth - POP_W - 8)),
              ...(pos.y + pos.lh + MAX_VISIBLE * ROW_H + 16 > window.innerHeight && pos.y > MAX_VISIBLE * ROW_H
                ? { bottom: window.innerHeight - pos.y + 2 }
                : { top: pos.y + pos.lh + 2 }),
              maxHeight: MAX_VISIBLE * ROW_H + 8
            }}
            onMouseDown={(e) => e.preventDefault()} // keep the editor focused
          >
            {items.map((it, i) => (
              <div
                key={i}
                role="option"
                aria-selected={i === sel}
                className={'cs-item cs-' + it.kind + (i === sel ? ' on' : '')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(it)
                }}
              >
                <span className="cs-ico">
                  <KindIcon kind={it.kind} />
                </span>
                <span className="cs-name">{it.label}</span>
                {it.col?.isPk && (
                  <span className="cs-pk" title="Primary key">
                    PK
                  </span>
                )}
                {it.src && <span className="cs-src">{it.src}</span>}
                <span className="cs-type">{it.detail}</span>
              </div>
            ))}
          </div>,
          document.body
        )
      : null

  return { popup, onInput, onKeyDown, close, refresh, loading }
}
