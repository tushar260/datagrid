import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Column, DynamoPage, DynamoTableInfo } from '../../shared'
import type { TableRef } from './Explorer'
import { getTableView, setTableView } from './session'
import { tableKey } from './lib/refs'
import SuggestInput from './SuggestInput'
import { useLinger } from './useLinger'
import { useSettings } from './lib/settings'
import { effectiveSelection, NO_ROWS, rangeSet, toggleLin } from './lib/rowSelection'
import { explorerOwnsRefresh } from './lib/focusZone'
import { PARTIQL_WHERE_KEYWORDS } from './lib/suggest'
import { quotePartiqlName } from './lib/partiqlCandidates'
import { suggestPartiqlFix } from './lib/partiqlFix'
import IndexPicker from './IndexPicker'

/**
 * Table view of a DynamoDB table: a read-only grid fed by Scan (cursor paging with a stack of start keys, because DynamoDB
 * cannot jump to a page) or - with a WHERE condition - by PartiQL; plus a Structure tab (keys, attributes, indexes, table
 * info). It reuses the TableView chrome (toolbar, filter bar, grid, row selection, loading overlay) through the shared CSS.
 */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD_HINT = IS_MAC ? '⌘' : 'Ctrl'
const PAGE_SIZES = [25, 50, 100, 500, 1000]
const NO_EDIT = 'Editing items is not supported yet'
const NO_SORT = 'Sorting is not supported by DynamoDB scans'

const clean = (e: unknown): string =>
  String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Cur { i: number; c: number }

const TYPE_NAMES: Record<string, string> = { S: 'String (S)', N: 'Number (N)', B: 'Binary (B)' }
const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`)

export default function DynamoTableView({
  t, reloadToken = 0, active = true
}: { t: TableRef; reloadToken?: number; active?: boolean }): React.JSX.Element {
  const { nullText, pageSize: defaultSize } = useSettings()
  const [tab, setTab] = useState<'data' | 'structure'>('data')
  const [v0] = useState(() => getTableView(tableKey(t)))
  const [pageSize, setPageSize] = useState(v0?.pageSize ?? defaultSize)
  const [whereInput, setWhereInput] = useState(v0?.where ?? '')
  const [where, setWhere] = useState(v0?.where ?? '')
  const [index, setIndex] = useState<string>(v0?.index ?? '') // '' = the table itself, otherwise a GSI / LSI name
  // paging: cursors[i] = start cursor of page i (null = first page); offsets[i] = number of items before page i
  const [idx, setIdx] = useState(0)
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const [offsets, setOffsets] = useState<number[]>([0])
  const [page, setPage] = useState<DynamoPage | null>(null)
  const [info, setInfo] = useState<DynamoTableInfo | null>(null)
  const [infoErr, setInfoErr] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [started, setStarted] = useState(active) // restored tabs load lazily: nothing is fetched until first shown
  useEffect(() => { if (active) setStarted(true) }, [active])
  const [paneFade, setPaneFade] = useState(false)

  const [cur, setCur] = useState<Cur | null>(null)
  const [selRows, setSelRows] = useState<ReadonlySet<number>>(NO_ROWS)
  const [selCleared, setSelCleared] = useState(false)
  const anchorRef = useRef<number | null>(null)
  const keepSelRef = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTableView(tableKey(t), { page: 0, pageSize, offset: 0, sort: null, where, orderExpr: '', ...(index ? { index } : {}) })
  }, [t, pageSize, where, index])

  const cursor = cursors[idx] ?? null
  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const r = await window.api.dynamo.items(t.dsId, t.table, { limit: pageSize, cursor, where, ...(index ? { index } : {}) })
      setPage(r)
      setOffsets((o) => {
        const n = o.slice(0, idx + 1)
        n[idx] = o[idx] ?? 0
        n[idx + 1] = n[idx] + r.rows.length
        return n
      })
      setCur(null)
      setSelRows(NO_ROWS)
      anchorRef.current = null
    } catch (e) {
      setErr(clean(e))
    } finally {
      setLoading(false)
    }
  }, [t.dsId, t.table, pageSize, cursor, where, idx, index])
  const loadInfo = useCallback(() => {
    window.api.dynamo.describe(t.dsId, t.table).then((d) => { setInfo(d); setInfoErr('') }, (e) => setInfoErr(clean(e)))
  }, [t.dsId, t.table])

  useEffect(() => { if (started) void load() }, [load, started])
  useEffect(() => { if (started) loadInfo() }, [loadInfo, started])
  const firstToken = useRef(reloadToken)
  useEffect(() => {
    if (!started || reloadToken === firstToken.current) return
    void load()
    loadInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  /** The toolbar button and Cmd/Ctrl+R: re-scan from the start key of the current page. */
  const reload = (): void => { void load(); loadInfo() }
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'r' && e.code !== 'KeyR') return
      if (document.querySelector('.modal-bg, .cd-bg')) return
      if (explorerOwnsRefresh(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      reload()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  })

  const resetPaging = (): void => { setIdx(0); setCursors([null]); setOffsets([0]) }
  const applyWhere = (w: string): void => { resetPaging(); setWhere(w) }
  /** Table <-> index: starts again from the first page; the condition is kept (it usually names the index's keys, so clear it yourself) */
  const pickIndex = (name: string): void => { if (name === index) return; resetPaging(); setIndex(name) }
  // friendly hint (+ one-click fix) when the applied WHERE has a known mistake, e.g. `SK begins_with('x')`
  const hint = useMemo(() => (err && where.trim() ? suggestPartiqlFix(where) : null), [err, where])
  const applyHintFix = (): void => {
    if (!hint?.fixedWhere) return
    setWhereInput(hint.fixedWhere)
    applyWhere(hint.fixedWhere)
  }
  const changeSize = (n: number): void => { resetPaging(); setPageSize(n) }
  const goNext = (): void => {
    if (!page?.next) return
    setCursors((c) => [...c.slice(0, idx + 1), page.next])
    setIdx(idx + 1)
  }
  const goPrev = (): void => { if (idx > 0) setIdx(idx - 1) }

  const cols = page?.columns ?? []
  const rows = page?.rows ?? []
  const nRows = rows.length
  const offset = offsets[idx] ?? 0
  const selSet = effectiveSelection(selRows, cur ? { kind: 'row', i: cur.i } : null, nRows, selCleared)
  const atEnd = !page || !page.next
  const exactTotal = page && !page.next ? offset + nRows : null
  const approx = info && !where.trim() ? info.itemCount : null

  // attribute names for the WHERE completion: key schema + every attribute seen so far
  const suggestCols = useMemo<Column[]>(() => {
    const seen = new Map<string, Column>()
    // reading through an index: its key attributes first (those are what a fast Query condition uses)
    for (const k of info?.indexes.find((x) => x.name === index)?.keys ?? []) seen.set(k.name, { name: k.name, type: k.attrType || k.keyType, nullable: false, isPk: k.keyType === 'HASH' })
    for (const k of info?.keySchema ?? []) if (!seen.has(k.name)) seen.set(k.name, { name: k.name, type: k.attrType || k.keyType, nullable: false, isPk: k.keyType === 'HASH' })
    for (const c of cols) if (!seen.has(c.name)) seen.set(c.name, { name: c.name, type: c.types.join('|') || 'S', nullable: true, isPk: c.key === 'HASH' })
    return [...seen.values()]
  }, [info, cols, index])

  // latest state for the keyboard handlers
  const S = useRef({ page, cur, selRows, selCleared, tab, active, loading, nRows })
  S.current = { page, cur, selRows, selCleared, tab, active, loading, nRows }

  useEffect(() => {
    setSelCleared(false)
    if (keepSelRef.current) { keepSelRef.current = false; return }
    setSelRows((p) => (p.size ? NO_ROWS : p))
    anchorRef.current = cur ? cur.i : null
  }, [cur])
  useEffect(() => {
    if (cur) gridRef.current?.querySelector('td.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [cur])

  const copy = (txt: string): void => void navigator.clipboard.writeText(txt)
  /** the full value of a cell: text as is, nested values / sets as JSON */
  const fullCell = (i: number, c: number): string => {
    const v = page?.items[i]?.[cols[c]?.name ?? '']
    return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, typeof v === 'object' ? 2 : 0)
  }
  /** the selected items as JSON: one object for one row, an array otherwise */
  const selectedJson = (): string => {
    const picked = [...selSet].sort((a, b) => a - b).map((i) => page?.items[i]).filter(Boolean)
    return JSON.stringify(picked.length === 1 ? picked[0] : picked, null, 2)
  }

  const moveBy = (dr: number, dc: number, abs?: { r?: number; c?: number }): void => {
    const { cur: cu } = S.current
    const n = S.current.nRows
    if (!n || !cols.length) return
    const r = Math.max(0, Math.min(n - 1, abs?.r ?? (cu?.i ?? 0) + dr))
    const c = Math.max(0, Math.min(cols.length - 1, abs?.c ?? (cu?.c ?? 0) + dc))
    setCur({ i: r, c })
  }
  const extendBy = (dr: number): void => {
    const n = S.current.nRows
    if (!n) return
    const cu = S.current.cur
    const lin0 = cu?.i ?? 0
    const lin = Math.max(0, Math.min(n - 1, lin0 + dr))
    const anchor = anchorRef.current ?? lin0
    anchorRef.current = anchor
    keepSelRef.current = true
    setSelRows(rangeSet(anchor, lin))
    setCur({ i: lin, c: cu?.c ?? 0 })
  }
  const selectAllRows = (): void => {
    const n = S.current.nRows
    if (!n) return
    anchorRef.current = 0
    keepSelRef.current = true
    setSelRows(rangeSet(0, n - 1))
    setCur(S.current.cur ? { ...S.current.cur } : { i: 0, c: 0 })
  }
  const pickRow = (i: number, c: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void => {
    gridRef.current?.focus({ preventScroll: true }) // keyboard navigation / copy work right after a click
    const cu = S.current.cur
    if (e.shiftKey) {
      const anchor = anchorRef.current ?? cu?.i ?? i
      anchorRef.current = anchor
      keepSelRef.current = true
      setSelRows(rangeSet(anchor, i))
      setCur({ i, c })
    } else if (e.metaKey || e.ctrlKey) {
      const next = toggleLin(effectiveSelection(S.current.selRows, cu ? { kind: 'row', i: cu.i } : null, S.current.nRows, S.current.selCleared), i)
      if (!next.has(i)) {
        if (!next.size) { setCur(null); return }
        const rest = [...next].pop()!
        anchorRef.current = rest
        keepSelRef.current = true
        setSelRows(next)
        setCur({ i: rest, c })
      } else {
        anchorRef.current = i
        keepSelRef.current = true
        setSelRows(next)
        setCur({ i, c })
      }
    } else setCur({ i, c })
  }

  const onViewKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const s = S.current
    if (!s.active || s.tab !== 'data') return
    if ((e.target as HTMLElement).closest('input, select, textarea, button')) return
    if (s.loading || !s.page) return
    const mod = e.metaKey || e.ctrlKey
    const handled = (): void => { e.preventDefault(); e.stopPropagation() }
    const pageRows = Math.max(1, Math.floor((gridRef.current?.clientHeight ?? 400) / 22) - 1)
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase()
      // like PostgreSQL grids: Cmd/Ctrl+C copies the focused cell's value; with several rows selected it copies those items as JSON
      if (k === 'c' && !window.getSelection()?.toString() && (selSet.size > 1 || s.cur)) {
        handled()
        if (selSet.size > 1 || !s.cur) copy(selectedJson())
        else copy(fullCell(s.cur.i, s.cur.c))
      }
      else if (k === 'a' && !e.shiftKey) { handled(); selectAllRows() }
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
      case 'ArrowLeft': handled(); moveBy(0, -1); return
      case 'ArrowRight': handled(); moveBy(0, 1); return
      case 'Home': handled(); moveBy(0, 0, { c: 0 }); return
      case 'End': handled(); moveBy(0, 0, { c: Infinity }); return
      case 'PageUp': handled(); moveBy(-pageRows, 0); return
      case 'PageDown': handled(); moveBy(pageRows, 0); return
      case 'Escape':
        if (e.shiftKey || effectiveSelection(s.selRows, s.cur ? { kind: 'row', i: s.cur.i } : null, s.nRows, s.selCleared).size === 0) return
        handled()
        setSelRows(NO_ROWS)
        setSelCleared(true)
        return
      case 'Tab': {
        const cu = s.cur
        const lin = cu?.i ?? 0
        const c = cu?.c ?? 0
        const end = e.shiftKey ? lin === 0 && c === 0 : lin === s.nRows - 1 && c === cols.length - 1
        if (!s.nRows || end) return
        handled()
        if (e.shiftKey) { if (c === 0) moveBy(-1, 0, { c: Infinity }); else moveBy(0, -1) }
        else if (c === cols.length - 1) moveBy(1, 0, { c: 0 })
        else moveBy(0, 1)
        return
      }
    }
  }

  const busy = loading
  const showOverlay = useLinger(busy, 160)
  const pickTab = (k: 'data' | 'structure'): void => {
    if (k === tab) return
    setPaneFade(true)
    setTab(k)
  }
  const rangeFrom = nRows ? offset + 1 : 0
  const rangeTo = offset + nRows

  return (
    <div
      className={'tableview dynamo' + (paneFade ? ' pane-fade' : '')}
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
          <div className="toolbar" onMouseDown={(e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault() }}>
            <div className="tb-group">
              <button title="First page" disabled={idx === 0 || loading} onClick={() => setIdx(0)}>⏮</button>
              <button title="Previous page" disabled={idx === 0 || loading} onClick={goPrev}>◀</button>
              <span className="pageinfo">
                {!page ? '…' : (
                  <>
                    <span className={'range-label off'}>{rangeFrom}-{rangeTo}</span>
                    {exactTotal !== null ? (
                      <span className="range-total">&nbsp;of {exactTotal}</span>
                    ) : approx !== null ? (
                      <span className="range-total" title="Approximate item count from DescribeTable (DynamoDB refreshes it about every 6 hours)">&nbsp;of ~{approx}</span>
                    ) : null}
                  </>
                )}
              </span>
              <button title="Next page" disabled={atEnd || loading} onClick={goNext}>▶</button>
              <button title="DynamoDB cannot jump to the last page" disabled>⏭</button>
              <select value={pageSize} onChange={(e) => changeSize(Number(e.target.value))}>
                {(PAGE_SIZES.includes(pageSize) ? PAGE_SIZES : [...PAGE_SIZES, pageSize].sort((a, b) => a - b)).map((n) => (
                  <option key={n} value={n}>{PAGE_SIZES.includes(n) ? n : `custom (${n})`}</option>
                ))}
              </select>
            </div>
            <span className="sep" />
            <div className="tb-group">
              <button title={`Reload (${MOD_HINT}${IS_MAC ? '' : '+'}R)`} onClick={reload}>⟳</button>
              <button title={NO_EDIT} disabled>＋</button>
              <button title={NO_EDIT} disabled>－</button>
              <button
                title={`Copy the selected item${selSet.size > 1 ? 's' : ''} as JSON`}
                disabled={selSet.size === 0}
                onClick={() => { copy(selectedJson()); gridRef.current?.focus({ preventScroll: true }) }}
              >Copy JSON</button>
            </div>
            <span className="sep" />
            <div className="tb-group">
              <button title={NO_EDIT} className="primary" disabled>Submit</button>
              <button title={NO_EDIT} disabled>Revert</button>
            </div>
            {loading && <span className="loader" title="Loading…" />}
          </div>
          <div className="filterbar">
            {(index || (info?.indexes.length ?? 0) > 0) && (
              <div className="fb-field source">
                <IndexPicker
                  table={t.table}
                  tableKeys={info?.keySchema}
                  indexes={info?.indexes ?? []}
                  value={index}
                  onChange={pickIndex}
                />
              </div>
            )}
            <div className="fb-field where" style={{ flex: '1 1 0' }}>
              <span className="fb-label">WHERE</span>
              <SuggestInput
                mode="where"
                columns={suggestCols}
                keywords={PARTIQL_WHERE_KEYWORDS}
                quote={quotePartiqlName}
                placeholder="e.g. pk = 'a' and begins_with(sk, 'x')"
                value={whereInput}
                onChange={setWhereInput}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) applyWhere(whereInput) }}
              />
            </div>
            <span className="fb-hint" title="PartiQL: SELECT * FROM table WHERE condition">
              PartiQL condition. A condition without the {index ? "index" : "partition"} key scans the whole {index ? "index" : "table"}.
            </span>
          </div>
          {err && <div className="msg bad">{err}</div>}
          {err && hint && (
            <div className="msg hint-bar">
              <span className="hint-text">{hint.message.split('`').map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</span>
              {hint.fixedWhere !== undefined && <button className="hint-fix" onClick={applyHintFix}>Apply fix</button>}
            </div>
          )}
          {page?.columnsCapped && <div className="msg warn">More than 200 attributes: only the first 200 columns are shown (copy the item for the rest).</div>}
          <div className={'gridbox' + (busy ? ' busy' : '')}>
            {showOverlay && (
              <div className={'loading-overlay' + (busy ? '' : ' leaving')}>
                <span className="loader big" />
                <span>Loading items…</span>
              </div>
            )}
            <div className="gridwrap" tabIndex={0} ref={gridRef}>
              <table className="grid">
                <thead>
                  <tr>
                    <th className="rn">#</th>
                    {cols.map((c) => (
                      <th key={c.name} title={NO_SORT} style={{ cursor: 'default' }}>
                        {c.key && <span className="keybadge" title={c.key === 'HASH' ? 'Partition key' : 'Sort key'}>{c.key === 'HASH' ? 'PK' : 'SK'}</span>}
                        <span className="cname">{c.name}</span>
                        <span className="ctype">{c.types.join('|')}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={selSet.has(i) ? 'sel' : ''}>
                      <td className="rn" onMouseDown={(e) => { if (e.button === 0) pickRow(i, cur?.c ?? 0, e) }}>{offset + i + 1}</td>
                      {r.map((v, ci) => (
                        <td
                          key={ci}
                          className={(v === null ? 'null ' : '') + (cur && cur.i === i && cur.c === ci ? 'cur' : '')}
                          onMouseDown={(e) => { if (e.button === 0) pickRow(i, ci, e) }}
                          onContextMenu={(e) => { e.preventDefault(); copy(fullCell(i, ci)) }}
                          title={v === null ? 'NULL' : v}
                        >
                          {v === null ? nullText : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {page && nRows === 0 && !err && (
                <div className="tree-empty" style={{ padding: 12 }}>
                  {where.trim() ? 'No items match this condition' : 'This table has no items'}
                  {page.next ? ' on this page (more pages follow: use Next)' : ''}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {tab === 'structure' && (
        <div className="gridwrap structure">
          {infoErr && <div className="msg bad">{infoErr}</div>}
          {!info && !infoErr && <div className="tree-empty">Loading…</div>}
          {info && (
            <>
              <h4>Key schema</h4>
              <table className="grid" data-section="keys">
                <thead><tr><th>Name</th><th>Type</th><th>Key</th></tr></thead>
                <tbody>
                  {info.keySchema.map((k) => (
                    <tr key={k.name}><td>{k.name}</td><td>{TYPE_NAMES[k.attrType] ?? k.attrType}</td><td>{k.keyType}</td></tr>
                  ))}
                </tbody>
              </table>
              <h4>Attributes</h4>
              <table className="grid" data-section="attributes">
                <thead><tr><th>Name</th><th>Type</th></tr></thead>
                <tbody>
                  {info.attributes.map((a) => <tr key={a.name}><td>{a.name}</td><td>{TYPE_NAMES[a.type] ?? a.type}</td></tr>)}
                </tbody>
              </table>
              <h4>Indexes</h4>
              <table className="grid" data-section="indexes">
                <thead><tr><th>Name</th><th>Kind</th><th>Keys</th><th>Projection</th><th>Status</th></tr></thead>
                <tbody>
                  {info.indexes.map((x) => (
                    <tr key={x.kind + x.name}>
                      <td>{x.name}</td>
                      <td>{x.kind}</td>
                      <td>{x.keys.map((k) => `${k.name} (${k.keyType})`).join(', ')}</td>
                      <td>{x.projection}{x.nonKeyAttributes.length ? `: ${x.nonKeyAttributes.join(', ')}` : ''}</td>
                      <td>{x.status ?? ''}</td>
                    </tr>
                  ))}
                  {info.indexes.length === 0 && <tr><td colSpan={5} className="null">No secondary indexes</td></tr>}
                </tbody>
              </table>
              <h4>Table info</h4>
              <table className="grid" data-section="info">
                <tbody>
                  <tr><td>Status</td><td>{info.status}</td></tr>
                  <tr><td>Billing mode</td><td>{info.billingMode}</td></tr>
                  {info.billingMode === 'PROVISIONED' && <tr><td>Capacity (RCU / WCU)</td><td>{info.rcu ?? '-'} / {info.wcu ?? '-'}</td></tr>}
                  <tr><td>Item count</td><td>{info.itemCount.toLocaleString('en-US')}</td></tr>
                  <tr><td>Size</td><td>{fmtBytes(info.sizeBytes)}</td></tr>
                  <tr><td>Created</td><td>{info.createdAt ?? '-'}</td></tr>
                  <tr><td>ARN</td><td>{info.arn}</td></tr>
                  <tr><td>TTL</td><td>{info.ttl ? (info.ttl.attribute ? `${info.ttl.status} (${info.ttl.attribute})` : info.ttl.status) : 'unknown'}</td></tr>
                  <tr><td>Streams</td><td>{info.stream.enabled ? `enabled${info.stream.viewType ? ` (${info.stream.viewType})` : ''}` : 'disabled'}</td></tr>
                  {info.tableClass && <tr><td>Table class</td><td>{info.tableClass}</td></tr>}
                  {info.deletionProtection !== undefined && <tr><td>Deletion protection</td><td>{info.deletionProtection ? 'enabled' : 'disabled'}</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  )
}
