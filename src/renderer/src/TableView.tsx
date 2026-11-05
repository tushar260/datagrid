import type React from "react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Column, RowsResult } from '../../shared'
import type { TableRef } from './Explorer'
import { getTableView, setTableView, tableKey } from './session'
import SuggestInput from './SuggestInput'
import { useRatioSplit } from './Resizable'
import { MAX_LIMIT, parseRange } from './lib/range'
import { useLinger } from './useLinger'
import { computeDelete, effectiveSelection, linOf, NO_ROWS, rangeSet, toggleLin } from './lib/rowSelection'
import { cleanDbError, suggestHint } from './lib/whereFix'
import { explorerOwnsRefresh } from './lib/focusZone'
import { getSettings, useSettings } from './lib/settings'

type Row = Record<string, unknown>
interface Pending {
  edits: Map<number, Row>
  deleted: Set<number>
  inserted: Row[]
}
type Kind = 'row' | 'new'
interface Cur { kind: Kind; i: number; c: number }
const emptyPending = (): Pending => ({ edits: new Map(), deleted: new Set(), inserted: [] })
const isDirty = (p: Pending): boolean => p.edits.size + p.deleted.size + p.inserted.length > 0
const NULL_TOKEN = '<null>'
const clean = (e: unknown): string => cleanDbError(e)
/** Render `backticked` parts of a hint message as <code>. */
const hintParts = (msg: string): React.ReactNode[] =>
  msg.split('`').map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD_HINT = IS_MAC ? '⌘' : 'Ctrl'
const DELETE_HINT = IS_MAC ? '⌫' : 'Delete'
const SUBMIT_HINT = IS_MAC ? '⌘↵' : 'Ctrl+Enter'
const ADD_ROW_HINT = IS_MAC ? '⌘N' : 'Ctrl+N'
/** Cmd/Ctrl+N (no Shift/Alt): add a row, like the "+" button. */
const isAddRowKey = (e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n'

const PAGE_SIZES = [50, 100, 500, 1000]

/** Pure: apply the text typed into a cell to a pending-changes object. */
function applyEdit(pending: Pending, res: RowsResult, kind: Kind, i: number, col: string, text: string): Pending {
  const v = text === NULL_TOKEN ? null : text
  const p = { ...pending, edits: new Map(pending.edits), inserted: [...pending.inserted] }
  if (kind === 'row') {
    if (res.rows[i][col] === v) {
      const e = { ...(p.edits.get(i) ?? {}) }
      delete e[col]
      if (Object.keys(e).length) p.edits.set(i, e)
      else p.edits.delete(i)
    } else p.edits.set(i, { ...(p.edits.get(i) ?? {}), [col]: v })
  } else p.inserted[i] = { ...p.inserted[i], [col]: v }
  return p
}

function CellEditor(props: {
  initial: string
  typed: string | null
  inputRef: React.MutableRefObject<HTMLInputElement | null>
  onBlur: (text: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  const { initial, typed, inputRef } = props
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (typed !== null) el.setSelectionRange(el.value.length, el.value.length)
    else el.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <input
      ref={inputRef}
      className="cell-edit"
      placeholder={`text, or ${NULL_TOKEN}`}
      defaultValue={typed ?? initial}
      onBlur={(e) => props.onBlur(e.target.value)}
      onKeyDown={props.onKeyDown}
    />
  )
}

export default function TableView({
  t, reloadToken = 0, reloadSoft = false, active = true
}: { t: TableRef; reloadToken?: number; reloadSoft?: boolean; active?: boolean }): React.JSX.Element {
  const [tab, setTab] = useState<'data' | 'structure'>('data')
  const [res, setRes] = useState<RowsResult | null>(null)
  // view state restored from the previous session (applied filters / sort / paging only, never rows)
  const [v0] = useState(() => getTableView(tableKey(t)))
  // paging is offset-based (offset = 0-based index of the first row, pageSize = limit) so any range can be shown
  const [offset, setOffset] = useState(v0 ? v0.offset ?? v0.page * v0.pageSize : 0)
  const [pageSize, setPageSize] = useState(Math.min(MAX_LIMIT, v0?.pageSize ?? getSettings().pageSize))
  const { nullText } = useSettings()
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(v0?.sort ?? null)
  const [whereInput, setWhereInput] = useState(v0?.where ?? '')
  const [where, setWhere] = useState(v0?.where ?? '')
  // raw ORDER BY expression: typed (input) vs applied (Enter). When applied & non-empty it replaces the header sort.
  const [orderInput, setOrderInput] = useState(v0?.orderExpr ?? '')
  const [orderExpr, setOrderExpr] = useState(v0?.orderExpr ?? '')
  // draggable divider between the WHERE and ORDER BY boxes (share of WHERE, persisted; default 60/40)
  const fsplit = useRatioSplit('datagrip-lite:filter-split', 0.6)
  // restored tabs load lazily: nothing is fetched until the tab is first shown
  const [started, setStarted] = useState(active)
  useEffect(() => { if (active) setStarted(true) }, [active])
  useEffect(() => {
    // `page` is kept for compatibility with older saved sessions; `offset` is authoritative
    setTableView(tableKey(t), { page: Math.floor(offset / pageSize), pageSize, offset, sort, where, orderExpr })
  }, [t, offset, pageSize, sort, where, orderExpr])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [pending, setPending] = useState<Pending>(emptyPending())
  // the focused/selected cell (c = column index); its row is the "selected row" used by delete
  const [cur, setCur] = useState<Cur | null>(null)
  // explicit multi-row selection (linear row indexes, see linOf); empty = only the focused cell's row is selected
  const [selRows, setSelRows] = useState<ReadonlySet<number>>(NO_ROWS)
  // Escape: no row counts as selected (the cell cursor `cur` stays); reset by the next focused-cell change
  const [selCleared, setSelCleared] = useState(false)
  const anchorRef = useRef<number | null>(null) // range anchor for Shift+click / Shift+Arrow
  const keepSelRef = useRef(false) // set right before a setCur that must NOT reset the row selection
  const [editing, setEditing] = useState<{ kind: Kind; i: number; col: string } | null>(null)
  const [indexes, setIndexes] = useState<{ name: string; definition: string }[]>([])

  const gridRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const typedRef = useRef<string | null>(null) // first character typed to start an edit (replaces content)
  const doneRef = useRef(true) // true once the current edit was committed/cancelled (guards onBlur re-entry)
  const busyRef = useRef(false)
  const [flashRow, setFlashRow] = useState<number | null>(null) // index of the pending-insert row that was just added
  const [paneFade, setPaneFade] = useState(false) // true right after switching Data/Structure: the new pane fades in once

  const dirty = isDirty(pending)
  const isView = t.kind !== 'table'
  const nRowsR = res?.rows.length ?? 0
  const selSet = effectiveSelection(selRows, cur, nRowsR, selCleared)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const r = await window.api.rows({
        dsId: t.dsId, database: t.database, schema: t.schema, table: t.table,
        where, orderBy: orderExpr.trim() ? undefined : sort ?? undefined, orderExpr, limit: pageSize, offset
      })
      doneRef.current = true
      setRes(r)
      // a restored offset can be past the end if rows were deleted meanwhile: jump to the last page
      if (offset > 0 && r.rows.length === 0 && r.total > 0) setOffset(Math.max(0, r.total - pageSize))
      setPending(emptyPending())
      setCur(null)
      setSelRows(NO_ROWS)
      anchorRef.current = null
      setEditing(null)
    } catch (e) {
      setErr(clean(e))
    } finally {
      setLoading(false)
    }
  }, [t, where, sort, orderExpr, offset, pageSize])

  useEffect(() => { if (started) void load() }, [load, started])
  const firstToken = useRef(reloadToken)
  const [idxTick, setIdxTick] = useState(0) // bumped on reload so the Structure tab's indexes are re-fetched too
  useEffect(() => {
    if (!started || reloadToken === firstToken.current) return
    // "soft" reloads come from re-opening the already open tab (double-click / Enter / F4): unsaved edits are kept
    // (the tree refresh and the toolbar reload still drop them, as before)
    if (reloadSoft && dirty) return
    void load()
    setIdxTick((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])
  useEffect(() => {
    if (tab === 'structure') window.api.indexes(t.dsId, t.database, t.schema, t.table).then(setIndexes).catch(() => setIndexes([]))
  }, [tab, t, idxTick])

  const cols: Column[] = res?.columns ?? []
  const pkCols = useMemo(() => cols.filter((c) => c.isPk).map((c) => c.name), [cols])
  // friendly hint (+ optional one-click fix) for errors coming from the applied WHERE / ORDER BY expressions
  const hint = useMemo(() => {
    if (!err) return null
    const w = where.trim() ? suggestHint(where, err, cols) : null
    if (w?.fixedWhere !== undefined) return { message: w.message, target: 'where' as const, fixed: w.fixedWhere }
    const o = orderExpr.trim() ? suggestHint(orderExpr, err, cols) : null
    if (o?.fixedWhere !== undefined) return { message: o.message, target: 'order' as const, fixed: o.fixedWhere }
    const m = w ?? o ?? suggestHint('', err, cols)
    return m ? { message: m.message, target: null, fixed: undefined } : null
  }, [err, where, orderExpr, cols])
  const applyHintFix = (): void => {
    if (!hint || hint.fixed === undefined) return
    setOffset(0)
    if (hint.target === 'where') { setWhereInput(hint.fixed); setWhere(hint.fixed) }
    else if (hint.target === 'order') { setOrderInput(hint.fixed); setOrderExpr(hint.fixed) }
  }
  const total = res?.total ?? 0
  const atEnd = !res || offset + pageSize >= total
  const rangeFrom = Math.min(offset + 1, total)
  const rangeTo = Math.min(offset + pageSize, total)

  // ---- editable row range ("1-100" label) ---------------------------------------------------------
  const [rangeText, setRangeText] = useState<string | null>(null) // null = label shown, string = editor open
  const [rangeErr, setRangeErr] = useState('')
  const [shake, setShake] = useState(0)
  const rangeRef = useRef<HTMLInputElement>(null)
  const rangeDoneRef = useRef(true)
  const openRange = (): void => {
    if (!S.current.res || S.current.res.total === 0) return
    rangeDoneRef.current = false
    setRangeErr('')
    setRangeText(`${rangeFrom}-${rangeTo}`)
  }
  const closeRange = (): void => { rangeDoneRef.current = true; setRangeText(null); setRangeErr('') }
  /** Enter (strict: invalid keeps the editor open with an error) or blur (lenient: invalid/unchanged just cancels). */
  const commitRange = (strict: boolean): void => {
    if (rangeDoneRef.current || rangeText === null) return
    const r = parseRange(rangeText, pageSize, total)
    if (typeof r === 'string') {
      if (strict) { setRangeErr(r); setShake((n) => n + 1) } else closeRange()
      return
    }
    closeRange()
    if (r.offset === offset && r.limit === pageSize) return
    setOffset(r.offset)
    setPageSize(r.limit)
  }
  // any paging change made elsewhere (buttons, size select, filters) closes the editor
  useEffect(() => { rangeDoneRef.current = true; setRangeText(null); setRangeErr('') }, [offset, pageSize, where, orderExpr, sort])
  useLayoutEffect(() => {
    if (rangeText !== null && rangeRef.current && document.activeElement !== rangeRef.current) {
      rangeRef.current.focus()
      rangeRef.current.select()
    }
  }, [rangeText === null])
  // Cmd/Ctrl+G ("go to row"): focus the range editor of the active table tab
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'g') return
      if (S.current.tab !== 'data') return
      e.preventDefault()
      if (rangeRef.current) { rangeRef.current.focus(); rangeRef.current.select() } else openRange()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  // Cmd/Ctrl+N when nothing is focused (focus on <body>, e.g. after a dialog closed): the active table tab still adds a row.
  // With focus inside the view the React handler below deals with it; elsewhere (explorer, console, dialogs) it is ignored.
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent): void => {
      if (!isAddRowKey(e) || e.target !== document.body) return
      const s = S.current
      if (s.tab !== 'data' || s.isView || s.submitting || document.querySelector('.modal-bg, .cd-bg')) return
      e.preventDefault()
      addRow()
      focusGrid()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  /** The toolbar ⟳ button and Cmd/Ctrl+R: re-fetch rows + count (same offset / limit / filters / sort), drop pending edits. */
  const reload = (): void => {
    void load()
    setIdxTick((n) => n + 1) // the Structure tab's indexes are re-fetched too
  }
  // Cmd/Ctrl+R: reload the grid of the active table tab, exactly like the toolbar ⟳ button. Registered in the capture phase so it
  // wins over the Explorer's own Cmd+R (tree refresh); keystrokes that belong to the Explorer (focus inside `.explorer`, or nothing
  // focused after a click in it) and keystrokes while a dialog is open are left alone. The button is disabled while submitting; so is this.
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'r' && e.code !== 'KeyR') return
      if (document.querySelector('.modal-bg, .cd-bg')) return
      if (explorerOwnsRefresh(e.target)) return
      e.preventDefault()
      e.stopPropagation() // the Explorer's window-level handler must not also refresh the tree
      if (e.repeat || S.current.submitting) return
      reload()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  })

  // latest state for the keyboard handlers
  const S = useRef({ pending, editing, res, cur, selRows, selCleared, cols, isView, tab, active, pkCols, loading, submitting })
  S.current = { pending, editing, res, cur, selRows, selCleared, cols, isView, tab, active, pkCols, loading, submitting }

  // any focused-cell change resets the row selection to that cell's row, unless the change came from row-selection code
  useEffect(() => {
    setSelCleared(false) // a click / arrow key / add / select-all re-establishes a selection after Escape
    if (keepSelRef.current) { keepSelRef.current = false; return }
    setSelRows((p) => (p.size ? NO_ROWS : p))
    anchorRef.current = cur ? linOf(cur, S.current.res?.rows.length ?? 0) : null
  }, [cur])

  // keep the focused cell visible (sticky header / row-number column are covered via scroll-padding in CSS)
  useEffect(() => {
    if (cur && !editing) gridRef.current?.querySelector('td.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [cur, editing])

  // after "add row": scroll the newly appended row into view (the editor focuses itself with preventScroll)
  const revealNewRef = useRef(false)
  useLayoutEffect(() => {
    if (!revealNewRef.current) return
    revealNewRef.current = false
    const rows = gridRef.current?.querySelectorAll('tr.new')
    rows?.[rows.length - 1]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pending.inserted.length])

  const cellVal = (i: number, c: string): unknown =>
    pending.edits.get(i)?.[c] !== undefined || (pending.edits.get(i) && c in pending.edits.get(i)!)
      ? pending.edits.get(i)![c]
      : res!.rows[i][c]

  const focusGrid = (): void => gridRef.current?.focus({ preventScroll: true })

  // ---- cell navigation -------------------------------------------------------------------------
  const moveBy = (dr: number, dc: number, abs?: { r?: number; c?: number }): void => {
    const { res: rs, cur: cu, cols: cs, pending: pd } = S.current
    if (!rs || !cs.length) return
    const nRows = rs.rows.length
    const total = nRows + pd.inserted.length
    if (!total) return
    const lin = cu ? (cu.kind === 'row' ? cu.i : nRows + cu.i) : 0
    const c0 = cu ? cu.c : 0
    const r = Math.max(0, Math.min(total - 1, abs?.r ?? lin + dr))
    const c = Math.max(0, Math.min(cs.length - 1, abs?.c ?? c0 + dc))
    setCur(r < nRows ? { kind: 'row', i: r, c } : { kind: 'new', i: r - nRows, c })
  }

  const startEdit = (kind: Kind, i: number, col: string, typed: string | null): void => {
    if (S.current.isView) return
    doneRef.current = false
    typedRef.current = typed
    setEditing({ kind, i, col })
  }

  /** Commit (text !== null) or cancel (null) the open editor, optionally moving the focused cell afterwards. */
  const finishEdit = (text: string | null, move?: [number, number]): void => {
    const ed = S.current.editing
    if (!ed || doneRef.current) return
    doneRef.current = true
    if (text !== null && S.current.res) setPending(applyEdit(S.current.pending, S.current.res, ed.kind, ed.i, ed.col, text))
    setEditing(null)
    focusGrid()
    if (move) moveBy(move[0], move[1])
  }

  /** Commit whatever is typed in an open editor and return the resulting pending changes (for submit/add/etc). */
  const flushEdit = (): Pending => {
    const ed = S.current.editing
    const inp = inputRef.current
    if (!ed || !inp || doneRef.current || !S.current.res) return S.current.pending
    doneRef.current = true
    const p = applyEdit(S.current.pending, S.current.res, ed.kind, ed.i, ed.col, inp.value)
    setPending(p)
    setEditing(null)
    S.current = { ...S.current, pending: p, editing: null }
    return p
  }

  const addRow = (): void => {
    const p = flushEdit()
    setPending({ ...p, inserted: [...p.inserted, {}] })
    const flash = p.inserted.length // one-shot highlight (CSS `row-flash`) for the freshly inserted row only
    setFlashRow(flash)
    setTimeout(() => setFlashRow((f) => (f === flash ? null : f)), 700)
    // DataGrip behaviour: focus the new row's first cell and open it for editing (Tab then moves on)
    const first = S.current.cols[0]
    setCur({ kind: 'new', i: p.inserted.length, c: 0 })
    revealNewRef.current = true
    if (first) startEdit('new', p.inserted.length, first.name, null)
    else focusGrid()
  }
  /** Delete ALL selected rows: loaded rows are marked pending-delete (toggled off if all already are), new rows are dropped. */
  /** Returns the resulting pending changes, or null when nothing was deleted (no selection / no primary key). */
  const deleteRow = (force = false): Pending | null => {
    const p = flushEdit()
    const rs = S.current.res
    if (!rs) return null
    const nRows = rs.rows.length
    const lins = [...effectiveSelection(S.current.selRows, S.current.cur, nRows, S.current.selCleared)]
    if (!lins.length) return null
    const r = computeDelete(lins, nRows, p.deleted, S.current.pkCols.length > 0, force)
    if (r.noPk) setErr('Table has no primary key; cannot edit/delete rows') // same wording the server gives on submit
    const next: Pending = {
      ...p, deleted: r.deleted, inserted: r.dropNew.size ? p.inserted.filter((_, k) => !r.dropNew.has(k)) : p.inserted
    }
    setPending(next)
    setCur(null)
    setSelRows(NO_ROWS)
    anchorRef.current = null
    S.current = { ...S.current, pending: next }
    return r.noPk ? null : next
  }
  /** ⌘/Ctrl+click on "-": mark the selected rows deleted and submit right away (pending state stays if it fails). */
  const deleteAndSubmit = (): void => {
    const p = deleteRow(true)
    if (p) void submit(p)
  }

  // ---- row selection ---------------------------------------------------------------------------
  const curAt = (lin: number, c: number): Cur => {
    const nRows = S.current.res?.rows.length ?? 0
    return lin < nRows ? { kind: 'row', i: lin, c } : { kind: 'new', i: lin - nRows, c }
  }

  /** Mouse selection on a row-number gutter cell or a data cell: plain = select row, Shift = range, Cmd/Ctrl = toggle. */
  const pickRow = (kind: Kind, i: number, c: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void => {
    const rs = S.current.res
    if (!rs) return
    const nRows = rs.rows.length
    const lin = linOf({ kind, i }, nRows)
    const cur0 = S.current.cur
    if (e.shiftKey) {
      const anchor = anchorRef.current ?? (cur0 ? linOf(cur0, nRows) : lin)
      anchorRef.current = anchor
      keepSelRef.current = true
      setSelRows(rangeSet(anchor, lin))
      setCur({ kind, i, c })
    } else if (e.metaKey || e.ctrlKey) {
      const next = toggleLin(effectiveSelection(S.current.selRows, cur0, nRows, S.current.selCleared), lin)
      if (!next.has(lin)) {
        if (!next.size) { setCur(null); return } // nothing selected any more (effect resets the rest)
        const rest = [...next].pop()!
        anchorRef.current = rest
        keepSelRef.current = true
        setSelRows(next)
        setCur(curAt(rest, c))
      } else {
        next.add(lin)
        anchorRef.current = lin
        keepSelRef.current = true
        setSelRows(next)
        setCur({ kind, i, c })
      }
    } else {
      setCur({ kind, i, c })
    }
  }

  /** Shift+ArrowUp/Down: extend the selected range from the anchor; the focused cell follows the moving end. */
  const extendBy = (dr: number): void => {
    const { res: rs, cur: cu, cols: cs, pending: pd } = S.current
    if (!rs || !cs.length) return
    const nRows = rs.rows.length
    const total = nRows + pd.inserted.length
    if (!total) return
    const lin0 = cu ? linOf(cu, nRows) : 0
    const lin = Math.max(0, Math.min(total - 1, lin0 + dr))
    const anchor = anchorRef.current ?? lin0
    anchorRef.current = anchor
    keepSelRef.current = true
    setSelRows(rangeSet(anchor, lin))
    setCur(curAt(lin, cu?.c ?? 0))
  }

  const selectAllRows = (): void => {
    const { res: rs, cur: cu, pending: pd } = S.current
    if (!rs) return
    const total = rs.rows.length + pd.inserted.length
    if (!total) return
    anchorRef.current = 0
    keepSelRef.current = true
    setSelRows(rangeSet(0, total - 1))
    setCur(cu ? { ...cu } : curAt(0, 0)) // always a new object so the cur-effect consumes keepSelRef
  }

  const submit = async (p: Pending = S.current.pending): Promise<void> => {
    const rs = S.current.res
    if (busyRef.current || !rs || !isDirty(p)) return
    busyRef.current = true
    setSubmitting(true) // immediate feedback, before any round trip
    setErr('')
    const t0 = performance.now()
    try {
      const pkOf = (i: number): Row => Object.fromEntries(S.current.pkCols.map((c) => [c, rs.rows[i][c]]))
      await window.api.apply(t.dsId, t.database, t.schema, t.table, {
        updates: [...p.edits].map(([i, set]) => ({ pk: pkOf(i), set })),
        inserts: p.inserted,
        deletes: [...p.deleted].map(pkOf)
      })
      const t1 = performance.now()
      await load()
      console.debug(`[submit] apply ${Math.round(t1 - t0)}ms, reload ${Math.round(performance.now() - t1)}ms`)
    } catch (e) {
      setErr(clean(e))
    } finally {
      busyRef.current = false
      setSubmitting(false)
    }
  }

  const revert = (): void => {
    flushEdit()
    setPending(emptyPending())
    setCur(null)
    setSelRows(NO_ROWS)
    anchorRef.current = null
    setEditing(null)
  }

  const sortBy = (c: string): void => {
    setOffset(0)
    // header sort wins over the ORDER BY box: clicking a header clears it
    setOrderInput('')
    setOrderExpr('')
    setSort((s) => (!s || s.column !== c ? { column: c, desc: false } : s.desc ? null : { column: c, desc: true }))
  }

  /** Enter in the WHERE or ORDER BY box applies both (back to page 0). A non-empty ORDER BY replaces the header sort. */
  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey) return
    setOffset(0)
    setWhere(whereInput)
    setOrderExpr(orderInput)
    if (orderInput.trim()) setSort(null)
  }

  const copy = (txt: string): void => void navigator.clipboard.writeText(txt)

  const valueAt = (cu: Cur): unknown => {
    const rs = S.current.res
    const cs = S.current.cols
    if (!rs || !cs[cu.c]) return undefined
    const name = cs[cu.c].name
    if (cu.kind === 'new') return S.current.pending.inserted[cu.i]?.[name]
    const e = S.current.pending.edits.get(cu.i)
    return e && name in e ? e[name] : rs.rows[cu.i]?.[name]
  }

  // ---- keyboard --------------------------------------------------------------------------------
  const onViewKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const s = S.current
    if (!s.active || s.tab !== 'data') return
    const mod = e.metaKey || e.ctrlKey

    // Cmd/Ctrl+Enter anywhere in this table view: commit an open edit, then submit
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (!s.isView) void submit(flushEdit())
      return
    }
    // Cmd/Ctrl+N anywhere in this table view (grid, cell editor, WHERE / ORDER BY): same as the "+" button
    if (isAddRowKey(e)) {
      if (s.isView || s.submitting || document.querySelector('.modal-bg, .cd-bg')) return
      e.preventDefault()
      e.stopPropagation()
      addRow()
      focusGrid()
      return
    }
    // below: grid navigation. Keys meant for inputs/buttons are ignored (the cell editor has its own handler)
    if ((e.target as HTMLElement).closest('input, select, textarea, button')) return
    if (s.loading || s.submitting || !s.res) return
    const handled = (): void => { e.preventDefault(); e.stopPropagation() }
    const page = Math.max(1, Math.floor((gridRef.current?.clientHeight ?? 400) / 22) - 1)

    if (mod && !e.altKey) {
      if (e.key.toLowerCase() === 'c' && s.cur && !window.getSelection()?.toString()) {
        const v = valueAt(s.cur)
        copy(v == null ? '' : String(v))
        handled()
      } else if (e.key.toLowerCase() === 'a' && !e.shiftKey) { handled(); selectAllRows() }
      else if (e.key === 'Backspace' && !s.isView) { handled(); deleteRow() }
      else if (e.key === 'ArrowUp') { handled(); moveBy(0, 0, { r: 0 }) }
      else if (e.key === 'ArrowDown') { handled(); moveBy(0, 0, { r: Infinity }) }
      else if (e.key === 'Home') { handled(); moveBy(0, 0, { r: 0, c: 0 }) }
      else if (e.key === 'End') { handled(); moveBy(0, 0, { r: Infinity, c: Infinity }) }
      return
    }
    if (e.altKey) return

    switch (e.key) {
      case 'ArrowUp': handled(); if (e.shiftKey) extendBy(-1); else moveBy(-1, 0); return
      case 'ArrowDown': handled(); if (e.shiftKey) extendBy(1); else moveBy(1, 0); return
      case 'Delete':
      case 'Backspace':
        if (!s.isView) { handled(); deleteRow() }
        return
      case 'Escape': // "remove selection": no row stays highlighted, the cell cursor stays so arrows keep working
        // (Shift+Esc is the sidebar toggle; popups / editors stop Escape before it gets here)
        if (e.shiftKey) return
        if (effectiveSelection(s.selRows, s.cur, s.res.rows.length, s.selCleared).size === 0) return
        handled()
        setSelRows(NO_ROWS)
        setSelCleared(true)
        return
      case 'ArrowLeft': handled(); moveBy(0, -1); return
      case 'ArrowRight': handled(); moveBy(0, 1); return
      case 'Home': handled(); moveBy(0, 0, { c: 0 }); return
      case 'End': handled(); moveBy(0, 0, { c: Infinity }); return
      case 'PageUp': handled(); moveBy(-page, 0); return
      case 'PageDown': handled(); moveBy(page, 0); return
      case 'Tab': {
        const cu = s.cur
        const total = s.res.rows.length + s.pending.inserted.length
        const lin = cu ? (cu.kind === 'row' ? cu.i : s.res.rows.length + cu.i) : 0
        const c = cu?.c ?? 0
        const atEnd = e.shiftKey ? lin === 0 && c === 0 : lin === total - 1 && c === s.cols.length - 1
        if (!total || atEnd) return // let focus leave the grid
        handled()
        if (e.shiftKey) { if (c === 0) moveBy(-1, 0, { c: Infinity }); else moveBy(0, -1) }
        else if (c === s.cols.length - 1) moveBy(1, 0, { c: 0 })
        else moveBy(0, 1)
        return
      }
      case 'Enter':
      case 'F2':
        if (s.cur && s.cols[s.cur.c] && !s.isView) { handled(); startEdit(s.cur.kind, s.cur.i, s.cols[s.cur.c].name, null) }
        return
      default:
        if (e.key.length === 1 && !mod && s.cur && s.cols[s.cur.c] && !s.isView) {
          handled()
          startEdit(s.cur.kind, s.cur.i, s.cols[s.cur.c].name, e.key)
        }
    }
  }

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return // bubbles to the view handler: commit + submit
    if (isAddRowKey(e)) return // bubbles to the view handler: commit this edit, then add a row
    const text = (e.target as HTMLInputElement).value
    const done = (txt: string | null, move?: [number, number]): void => {
      e.preventDefault()
      e.stopPropagation()
      finishEdit(txt, move)
    }
    switch (e.key) {
      case 'Enter': done(text, [e.shiftKey ? -1 : 1, 0]); break
      case 'Escape': done(null); break
      case 'Tab': done(text, [0, e.shiftKey ? -1 : 1]); break
      case 'ArrowDown': done(text, [1, 0]); break
      case 'ArrowUp': done(text, [-1, 0]); break
      default: e.stopPropagation() // Left/Right/Home/End/typing stay inside the input
    }
  }

  const renderCell = (kind: Kind, i: number, c: Column, ci: number, v: unknown): React.JSX.Element => {
    const isEd = editing && editing.kind === kind && editing.i === i && editing.col === c.name
    const changed = kind === 'row' && pending.edits.get(i) && c.name in pending.edits.get(i)!
    const isCur = !!cur && cur.kind === kind && cur.i === i && cur.c === ci
    return (
      <td
        key={c.name}
        className={(changed ? 'changed ' : '') + (v === null || v === undefined ? 'null ' : '') + (isCur ? 'cur' : '')}
        onMouseDown={(e) => { if (!isEd && e.button === 0) pickRow(kind, i, ci, e) }}
        onDoubleClick={() => startEdit(kind, i, c.name, null)}
        onContextMenu={(e) => { e.preventDefault(); copy(v == null ? '' : String(v)) }}
        title={v == null ? 'NULL' : String(v)}
      >
        {isEd ? (
          <CellEditor
            initial={v == null ? '' : String(v)}
            typed={typedRef.current}
            inputRef={inputRef}
            onBlur={(text) => finishEdit(text)}
            onKeyDown={onEditorKeyDown}
          />
        ) : v == null ? nullText : String(v)}
      </td>
    )
  }

  const busy = loading || submitting
  const showOverlay = useLinger(busy, 160) // stays mounted while it fades out
  const pickTab = (k: 'data' | 'structure'): void => {
    if (k === tab) return
    setPaneFade(true)
    setTab(k)
  }

  return (
    <div
      className={'tableview' + (paneFade ? ' pane-fade' : '')}
      tabIndex={-1}
      onKeyDown={onViewKeyDown}
      onAnimationEnd={(e) => { if (e.animationName === 'pane-in') setPaneFade(false) }}
    >
      <div className="subtabs">
        <button className={tab === 'data' ? 'on' : ''} onClick={() => pickTab('data')}>Data</button>
        <button className={tab === 'structure' ? 'on' : ''} onClick={() => pickTab('structure')}>Structure</button>
      </div>

      {tab === 'data' && (
        <>
          <div
            className="toolbar"
            // keep an open cell editor focused while clicking buttons so the first click always registers
            onMouseDown={(e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault() }}
          >
            <div className="tb-group">
            <button disabled={offset === 0} onClick={() => setOffset(0)}>⏮</button>
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>◀</button>
            <span className="pageinfo">
              {!res ? '…' : (
                <>
                  {rangeText === null ? (
                    <span
                      className={'range-label' + (total === 0 ? ' off' : '')}
                      role="button"
                      tabIndex={total === 0 ? -1 : 0}
                      title={total === 0 ? undefined : `Click to edit range (${IS_MAC ? '⌘G' : 'Ctrl+G'})`}
                      onClick={openRange}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRange() } }}
                    >{rangeFrom}-{rangeTo}</span>
                  ) : (
                    <span className="range-edit">
                      <input
                        key={shake}
                        ref={rangeRef}
                        className={'range-input' + (rangeErr ? ' bad' : '')}
                        value={rangeText}
                        spellCheck={false}
                        title="from-to (e.g. 1-100), or a start row (500 / 500-) to keep the page size"
                        onChange={(e) => { setRangeText(e.target.value); setRangeErr('') }}
                        onBlur={() => commitRange(false)}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); commitRange(true) }
                          else if (e.key === 'Escape') { e.preventDefault(); closeRange(); focusGrid() }
                        }}
                      />
                      {rangeErr && <span className="range-err">{rangeErr}</span>}
                    </span>
                  )}
                  <span className="range-total">&nbsp;of {total}</span>
                </>
              )}
            </span>
            <button disabled={atEnd} onClick={() => setOffset(offset + pageSize)}>▶</button>
            <button disabled={atEnd} onClick={() => setOffset(Math.max(0, total - pageSize))}>⏭</button>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {(PAGE_SIZES.includes(pageSize) ? PAGE_SIZES : [...PAGE_SIZES, pageSize].sort((a, b) => a - b)).map((n) => (
                <option key={n} value={n}>{PAGE_SIZES.includes(n) ? n : `custom (${n})`}</option>
              ))}
            </select>
            </div>
            <span className="sep" />
            <div className="tb-group">
            <button title={`Reload (${IS_MAC ? '⌘R' : 'Ctrl+R'})`} disabled={submitting} onClick={reload}>⟳</button>
            {!isView && (
              <>
                <button title={`Add row (${ADD_ROW_HINT})`} disabled={submitting} onClick={() => { addRow(); focusGrid() }}>＋</button>
                <button
                  title={(selSet.size > 1 ? `Delete ${selSet.size} rows (${DELETE_HINT})` : `Delete selected rows (${DELETE_HINT})`) +
                    ` — ${MOD_HINT}-click to delete and submit`}
                  disabled={selSet.size === 0 || submitting}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) deleteAndSubmit()
                    else deleteRow()
                    focusGrid()
                  }}
                >－</button>
              </>
            )}
            </div>
            {!isView && (
              <>
                <span className="sep" />
                <div className="tb-group">
                <button
                  title={`Submit (${SUBMIT_HINT})`}
                  className="primary"
                  disabled={(!dirty && !editing) || submitting}
                  onClick={() => void submit(flushEdit())}
                >
                  {submitting ? <><span className="loader" /> Submitting…</> : 'Submit'}
                </button>
                <button title="Revert" disabled={(!dirty && !editing) || submitting} onClick={() => { revert(); focusGrid() }}>Revert</button>
                </div>
              </>
            )}
            {loading && !submitting && <span className="loader" title="Loading…" />}
          </div>
          <div className="filterbar">
            <div className="fb-field where" ref={fsplit.aRef} style={{ flex: `${fsplit.ratio} 1 0` }}>
              <span className="fb-label">WHERE</span>
              <SuggestInput
                mode="where"
                columns={cols}
                placeholder="e.g. id > 10 and name like 'a%'"
                value={whereInput}
                onChange={setWhereInput}
                onKeyDown={onFilterKeyDown}
              />
            </div>
            {fsplit.divider}
            <div className="fb-field order" ref={fsplit.bRef} style={{ flex: `${1 - fsplit.ratio} 1 0` }}>
              <span className="fb-label">ORDER BY</span>
              <SuggestInput
                mode="order"
                columns={cols}
                placeholder="e.g. name desc, id"
                value={orderInput}
                onChange={setOrderInput}
                onKeyDown={onFilterKeyDown}
              />
            </div>
          </div>
          {err && <div className="msg bad">{err}</div>}
          {err && hint && (
            <div className="msg hint-bar">
              <span className="hint-text">{hintParts(hint.message)}</span>
              {hint.fixed !== undefined && (
                <button className="hint-fix" onClick={applyHintFix}>Apply fix</button>
              )}
            </div>
          )}
          {!isView && res && pkCols.length === 0 && <div className="msg warn">No primary key: editing existing rows is disabled.</div>}
          <div className={'gridbox' + (busy ? ' busy' : '')}>
          {showOverlay && (
            <div className={'loading-overlay' + (busy ? '' : ' leaving')}>
              <span className="loader big" />
              <span>{submitting ? 'Submitting changes…' : 'Loading rows…'}</span>
            </div>
          )}
          <div className="gridwrap" tabIndex={0} ref={gridRef}>
            <table className="grid">
              <thead>
                <tr>
                  <th className="rn">#</th>
                  {cols.map((c) => (
                    <th key={c.name} onClick={() => sortBy(c.name)}>
                      <span className="cname">{c.isPk ? '🔑 ' : ''}{c.name}</span>
                      <span className="ctype">{c.type}</span>
                      {!orderExpr.trim() && sort?.column === c.name && <span className="sortmark">{sort.desc ? ' ▼' : ' ▲'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {res?.rows.map((r, i) => (
                  <tr
                    key={i}
                    className={(selSet.has(i) ? 'sel ' : '') + (pending.deleted.has(i) ? 'del' : '')}
                  >
                    <td className="rn" onMouseDown={(e) => { if (e.button === 0) pickRow('row', i, cur?.c ?? 0, e) }}>{offset + i + 1}</td>
                    {cols.map((c, ci) =>
                      renderCell('row', i, c, ci, pkCols.length === 0 && pending.edits.has(i) ? r[c.name] : cellVal(i, c.name))
                    )}
                  </tr>
                ))}
                {pending.inserted.map((r, i) => (
                  <tr key={'n' + i} className={'new ' + (selSet.has(nRowsR + i) ? 'sel ' : '') + (flashRow === i ? 'flash' : '')}>
                    <td className="rn" onMouseDown={(e) => { if (e.button === 0) pickRow('new', i, cur?.c ?? 0, e) }}>＋</td>
                    {cols.map((c, ci) => renderCell('new', i, c, ci, r[c.name]))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        </>
      )}

      {tab === 'structure' && (
        <div className="gridwrap structure">
          <h4>Columns</h4>
          <table className="grid">
            <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>PK</th></tr></thead>
            <tbody>
              {cols.map((c) => (
                <tr key={c.name}><td>{c.name}</td><td>{c.type}</td><td>{c.nullable ? 'yes' : 'no'}</td><td>{c.isPk ? '🔑' : ''}</td></tr>
              ))}
            </tbody>
          </table>
          <h4>Indexes</h4>
          <table className="grid">
            <thead><tr><th>Name</th><th>Definition</th></tr></thead>
            <tbody>{indexes.map((x) => <tr key={x.name}><td>{x.name}</td><td>{x.definition}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
