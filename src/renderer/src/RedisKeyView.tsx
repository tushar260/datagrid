import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { redisDisplayName, type RedisKeyDetail as Detail, type RedisKeyInfo } from '../../shared'
import type { TableRef } from './Explorer'
import RedisKeyDetail from './RedisKeyDetail'
import RedisNewKeyDialog from './RedisNewKeyDialog'
import { getTableView, setTableView } from './session'
import { tableKey } from './lib/refs'
import { useLinger } from './useLinger'
import { useRatioSplit } from './Resizable'
import { effectiveSelection, NO_ROWS, rangeSet, toggleLin } from './lib/rowSelection'
import { explorerOwnsRefresh } from './lib/focusZone'
import { REDIS_TYPES, effectivePattern, exactPattern, fmtTtl, mergeKeys, typeClass } from './lib/redis'

/**
 * Key browser of one Redis logical database: a SCAN-driven grid (never KEYS) with a pattern box, a type filter and
 * "Load more", multi-select delete / copy, and a resizable detail pane (RedisKeyDetail) for the focused key.
 * It reuses the TableView chrome (toolbar, filter bar, grid, loading overlay) through the shared CSS.
 */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD_HINT = IS_MAC ? '⌘' : 'Ctrl'
const PAGE_SIZES = [100, 200, 500, 1000, 5000]
const DEFAULT_PAGE = 200
const SPLIT_KEY = 'datagrip-lite:redis-split'
const SPLIT_DEFAULT = 0.55 // share of the width taken by the key list

const clean = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function RedisKeyView({
  t, reloadToken = 0, active = true
}: { t: TableRef; reloadToken?: number; active?: boolean }): React.JSX.Element {
  const db = t.db ?? 0
  const [v0] = useState(() => getTableView(tableKey(t)))
  const [pageSize, setPageSize] = useState(v0?.pageSize && PAGE_SIZES.includes(v0.pageSize) ? v0.pageSize : DEFAULT_PAGE)
  // the saved view state reuses TableViewState: `where` = pattern box, `orderExpr` = type filter
  // opened from a tree folder ("Browse in Key Browser"): its pattern / type win over the saved view
  const [f0] = useState(() => t.redisFilter)
  const [patternInput, setPatternInput] = useState(f0 ? f0.pattern : v0?.where ?? '')
  const [pattern, setPattern] = useState(f0 ? f0.pattern : v0?.where ?? '')
  const [type, setType] = useState(f0 ? f0.type : v0?.orderExpr ?? '')
  // the same tab asked again from another folder
  const appliedFilter = useRef(f0?.n)
  useEffect(() => {
    const f = t.redisFilter
    if (!f || f.n === appliedFilter.current) return
    appliedFilter.current = f.n
    setPatternInput(f.pattern)
    setPattern(f.pattern)
    setType(f.type)
  }, [t.redisFilter])
  const [keys, setKeys] = useState<RedisKeyInfo[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false) // a scan finished at least once with the current filters
  const [total, setTotal] = useState<number | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [started, setStarted] = useState(active) // restored tabs load lazily: nothing is fetched until first shown
  useEffect(() => { if (active) setStarted(true) }, [active])

  const [cur, setCur] = useState<number | null>(null)
  const [selRows, setSelRows] = useState<ReadonlySet<number>>(NO_ROWS)
  const [selCleared, setSelCleared] = useState(false)
  const [creating, setCreating] = useState(false)
  const [detailToken, setDetailToken] = useState(0)
  const anchorRef = useRef<number | null>(null)
  const keepSelRef = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const gen = useRef(0) // drops answers of a scan that was superseded by a newer one
  const split = useRatioSplit(SPLIT_KEY, SPLIT_DEFAULT)

  useEffect(() => {
    setTableView(tableKey(t), { page: 0, pageSize, offset: 0, sort: null, where: pattern, orderExpr: type })
  }, [t, pageSize, pattern, type])

  const curKeyRef = useRef<string | null>(null)
  const pickAfter = useRef<string | null>(null) // a key to select once the next scan returns (created / renamed)

  /** Scans from the start (`more` false) or continues from the saved cursor (`more` true, "Load more"). */
  const scan = useCallback(async (more: boolean, from: string | null): Promise<void> => {
    const g = ++gen.current
    setLoading(true)
    setErr('')
    try {
      const r = await window.api.redis.scan(t.dsId, db, {
        pattern: effectivePattern(pattern), type: type || undefined, limit: pageSize, ...(more && from ? { cursor: from } : {})
      })
      if (g !== gen.current) return
      setKeys((prev) => (more ? mergeKeys(prev, r.keys) : r.keys))
      setCursor(r.cursor)
      setLoaded(true)
      if (!more) {
        // keep the focused key across a reload when it is still there (or select the one that was just created / renamed)
        const want = pickAfter.current ?? curKeyRef.current
        pickAfter.current = null
        const i = want ? r.keys.findIndex((k) => k.key === want) : -1
        setSelRows(NO_ROWS)
        anchorRef.current = i >= 0 ? i : null
        setCur(i >= 0 ? i : null)
      }
    } catch (e) {
      if (g !== gen.current) return
      setErr(clean(e))
      if (!more) setKeys([])
    } finally {
      if (g === gen.current) setLoading(false)
    }
    window.api.redis.dbsize(t.dsId, db).then((n) => { if (g === gen.current) setTotal(n) }, () => undefined)
  }, [t.dsId, db, pattern, type, pageSize])

  curKeyRef.current = cur !== null ? keys[cur]?.key ?? null : null
  const reload = (): void => { setDetailToken((n) => n + 1); void scan(false, null) }

  useEffect(() => { if (started) void scan(false, null) }, [scan, started])
  const firstToken = useRef(reloadToken)
  useEffect(() => {
    if (!started || reloadToken === firstToken.current) return
    setDetailToken((n) => n + 1)
    void scan(false, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])
  useEffect(() => () => { gen.current++ }, [])

  // toolbar ⟳ and Cmd/Ctrl+R (not while the explorer owns the shortcut)
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

  const nRows = keys.length
  const selSet = effectiveSelection(selRows, cur !== null ? { kind: 'row', i: cur } : null, nRows, selCleared)
  const selKeys = (): string[] => [...selSet].sort((a, b) => a - b).map((i) => keys[i]?.key).filter((k): k is string => k !== undefined)
  // the detail pane follows the one focused key (several selected rows: nothing to show)
  const focusKey = selSet.size === 1 ? keys[[...selSet][0]]?.key ?? null : null

  const S = useRef({ cur, selRows, selCleared, nRows, active, loading })
  S.current = { cur, selRows, selCleared, nRows, active, loading }

  useEffect(() => {
    setSelCleared(false)
    if (keepSelRef.current) { keepSelRef.current = false; return }
    setSelRows((p) => (p.size ? NO_ROWS : p))
    anchorRef.current = cur
  }, [cur])
  useEffect(() => {
    if (cur !== null) gridRef.current?.querySelector('tr.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [cur])

  const copy = (txt: string): void => void navigator.clipboard.writeText(txt)
  const copyKeys = (): void => copy(selKeys().map(redisDisplayName).join('\n'))

  const deleteSelected = async (): Promise<void> => {
    const ks = selKeys()
    if (!ks.length) return
    const what = ks.length === 1 ? `key "${redisDisplayName(ks[0])}"` : `${ks.length} keys`
    if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return
    setErr('')
    try {
      await window.api.redis.delete(t.dsId, db, ks)
      const gone = new Set(ks)
      setKeys((l) => l.filter((k) => !gone.has(k.key)))
      setSelRows(NO_ROWS)
      setCur(null)
      setTotal((n) => (n === null ? n : Math.max(0, n - ks.length)))
    } catch (e) {
      // some keys may have been deleted before the failure: re-scan, then show the error (a scan clears it)
      const msg = clean(e)
      void scan(false, null).then(() => setErr(msg))
    }
  }

  /** The detail pane loaded a key: keep the grid row's type / TTL in step (a key that expired shows as gone there too). */
  const onDetail = useCallback((d: Detail): void => {
    setKeys((l) => {
      const i = l.findIndex((k) => k.key === d.key)
      if (i < 0 || (l[i].type === d.type && l[i].ttl === d.ttl)) return l
      if (d.ttl === -2) return l
      const next = l.slice()
      next[i] = { ...l[i], type: d.type, ttl: d.ttl }
      return next
    })
  }, [])

  const moveBy = (dr: number, abs?: number): void => {
    const n = S.current.nRows
    if (!n) return
    setCur(Math.max(0, Math.min(n - 1, abs ?? (S.current.cur ?? 0) + dr)))
  }
  const extendBy = (dr: number): void => {
    const n = S.current.nRows
    if (!n) return
    const lin0 = S.current.cur ?? 0
    const lin = Math.max(0, Math.min(n - 1, lin0 + dr))
    const anchor = anchorRef.current ?? lin0
    anchorRef.current = anchor
    keepSelRef.current = true
    setSelRows(rangeSet(anchor, lin))
    setCur(lin)
  }
  const selectAllRows = (): void => {
    const n = S.current.nRows
    if (!n) return
    anchorRef.current = 0
    keepSelRef.current = true
    setSelRows(rangeSet(0, n - 1))
    setCur(S.current.cur ?? 0)
  }
  const pickRow = (i: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void => {
    gridRef.current?.focus({ preventScroll: true })
    const cu = S.current.cur
    if (e.shiftKey) {
      const anchor = anchorRef.current ?? cu ?? i
      anchorRef.current = anchor
      keepSelRef.current = true
      setSelRows(rangeSet(anchor, i))
      setCur(i)
    } else if (e.metaKey || e.ctrlKey) {
      const next = toggleLin(effectiveSelection(S.current.selRows, cu !== null ? { kind: 'row', i: cu } : null, S.current.nRows, S.current.selCleared), i)
      if (!next.has(i)) {
        if (!next.size) { setCur(null); return }
        const rest = [...next].pop()!
        anchorRef.current = rest
        keepSelRef.current = true
        setSelRows(next)
        setCur(rest)
      } else {
        anchorRef.current = i
        keepSelRef.current = true
        setSelRows(next)
        setCur(i)
      }
    } else setCur(i)
  }

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const s = S.current
    if (!s.active) return
    if ((e.target as HTMLElement).closest('input, select, textarea, button')) return
    const mod = e.metaKey || e.ctrlKey
    const handled = (): void => { e.preventDefault(); e.stopPropagation() }
    const pageRows = Math.max(1, Math.floor((gridRef.current?.clientHeight ?? 400) / 22) - 1)
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'c' && !window.getSelection()?.toString() && selSet.size > 0) { handled(); copyKeys() }
      else if (k === 'a' && !e.shiftKey) { handled(); selectAllRows() }
      else if (e.key === 'ArrowUp') { handled(); moveBy(0, 0) }
      else if (e.key === 'ArrowDown') { handled(); moveBy(0, Infinity) }
      else if (e.key === 'Backspace' || e.key === 'Delete') { handled(); void deleteSelected() }
      return
    }
    if (e.altKey) return
    switch (e.key) {
      case 'ArrowUp': handled(); if (e.shiftKey) extendBy(-1); else moveBy(-1); return
      case 'ArrowDown': handled(); if (e.shiftKey) extendBy(1); else moveBy(1); return
      case 'Home': handled(); moveBy(0, 0); return
      case 'End': handled(); moveBy(0, Infinity); return
      case 'PageUp': handled(); moveBy(-pageRows); return
      case 'PageDown': handled(); moveBy(pageRows); return
      case 'Delete': handled(); void deleteSelected(); return
      case 'Escape':
        if (e.shiftKey || selSet.size === 0) return
        handled()
        setSelRows(NO_ROWS)
        setSelCleared(true)
        return
    }
  }

  /** Shows exactly one key (a pattern that matches only it) and selects it: after create / rename. */
  const jumpTo = (key: string): void => {
    pickAfter.current = key
    const p = exactPattern(key)
    setPatternInput(p)
    setType('')
    if (p === pattern && !type) reload()
    else setPattern(p)
  }

  const applyFilters = (p: string): void => {
    if (p === pattern) reload() // same pattern: Enter re-scans
    else setPattern(p)
  }

  const busy = loading
  const showOverlay = useLinger(busy && nRows === 0, 160)
  const eff = effectivePattern(pattern)
  const status = useMemo(() => {
    if (!loaded) return ''
    const n = keys.length.toLocaleString()
    const of = total !== null ? ` of ${total.toLocaleString()} in db${db}` : ''
    return `${n} key${keys.length === 1 ? '' : 's'} loaded${of}${cursor !== null ? ' · more to scan' : ''}`
  }, [loaded, keys.length, total, cursor, db])

  return (
    <div className="tableview redis" tabIndex={-1} onKeyDown={onGridKeyDown}>
      <div className="toolbar" onMouseDown={(e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault() }}>
        <div className="tb-group">
          <button title={`Reload (${MOD_HINT}${IS_MAC ? '' : '+'}R)`} onClick={reload}>⟳</button>
          <button title="New key" onClick={() => setCreating(true)}>＋</button>
          <button title={`Delete the selected key${selSet.size > 1 ? 's' : ''} (Delete)`} disabled={selSet.size === 0} onClick={() => void deleteSelected()}>－</button>
          <button
            title={`Copy the selected key name${selSet.size > 1 ? 's' : ''}`}
            disabled={selSet.size === 0}
            onClick={() => { copyKeys(); gridRef.current?.focus({ preventScroll: true }) }}
          >Copy</button>
          <select
            title="Keys per scan step"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <span className="rk-status" data-testid="redis-status">{status}</span>
        {loading && <span className="loader" title="Scanning…" />}
      </div>
      <div className="filterbar">
        <div className="fb-field where" style={{ flex: '1 1 0' }}>
          <span className="fb-label">PATTERN</span>
          <input
            spellCheck={false}
            placeholder="e.g. user:*  (a plain word matches keys containing it)"
            value={patternInput}
            onChange={(e) => setPatternInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) applyFilters(patternInput) }}
          />
        </div>
        <div className="fb-field">
          <span className="fb-label">TYPE</span>
          <select value={type} onChange={(e) => setType(e.target.value)} title="Only keys of this type (SCAN … TYPE)">
            <option value="">all types</option>
            {REDIS_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <span className="fb-hint" title="Redis glob: * any text, ? one character, [a-c] a range, \ escapes. Keys are read with SCAN, never KEYS.">
          {eff ? <>MATCH <code>{eff}</code></> : 'all keys'}
        </span>
      </div>
      {err && <div className="msg bad pre">{err}</div>}
      <div className="rk-body">
        <div className="rk-list" ref={split.aRef} style={{ flex: `${split.ratio} 1 0` }}>
          <div className={'gridbox' + (busy ? ' busy' : '')}>
            {showOverlay && (
              <div className={'loading-overlay' + (busy ? '' : ' leaving')}>
                <span className="loader big" />
                <span>Scanning keys…</span>
              </div>
            )}
            <div className="gridwrap" tabIndex={0} ref={gridRef}>
              <table className="grid">
                <thead>
                  <tr>
                    <th className="rn">#</th>
                    <th style={{ cursor: 'default' }}>Key</th>
                    <th style={{ cursor: 'default' }}>Type</th>
                    <th style={{ cursor: 'default' }} title="Time to live">TTL</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k, i) => (
                    <tr key={k.key} className={(selSet.has(i) ? 'sel ' : '') + (cur === i ? 'cur' : '')}>
                      <td className="rn" onMouseDown={(e) => { if (e.button === 0) pickRow(i, e) }}>{i + 1}</td>
                      <td
                        className="rk-key"
                        title={redisDisplayName(k.key)}
                        onMouseDown={(e) => { if (e.button === 0) pickRow(i, e) }}
                        onContextMenu={(e) => { e.preventDefault(); copy(redisDisplayName(k.key)) }}
                      >{redisDisplayName(k.key)}</td>
                      <td onMouseDown={(e) => { if (e.button === 0) pickRow(i, e) }}><span className={typeClass(k.type)}>{k.type}</span></td>
                      <td
                        className={k.ttl < 0 ? 'null' : ''}
                        title={k.ttl < 0 ? 'No expiry' : `${k.ttl} ms left`}
                        onMouseDown={(e) => { if (e.button === 0) pickRow(i, e) }}
                      >{fmtTtl(k.ttl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {loaded && nRows === 0 && !err && (
                <div className="tree-empty" style={{ padding: 12 }}>
                  {cursor !== null
                    ? 'No match yet in the part of the keyspace scanned so far. Load more continues the scan.'
                    : pattern.trim() || type ? 'No keys match' : `db${db} has no keys`}
                </div>
              )}
            </div>
          </div>
          <div className="rk-foot">
            <button disabled={cursor === null || loading} onClick={() => void scan(true, cursor)} title="Continue the scan where it stopped">
              {loading && nRows > 0 ? 'Loading…' : 'Load more'}
            </button>
            <span className="rk-hint">{cursor === null && loaded ? 'End of the keyspace' : ''}</span>
          </div>
        </div>
        {split.divider}
        <div className="rk-detail" ref={split.bRef} style={{ flex: `${1 - split.ratio} 1 0` }}>
          {focusKey !== null ? (
            <RedisKeyDetail
              dsId={t.dsId}
              db={db}
              keyName={focusKey}
              reloadToken={detailToken}
              onDetail={onDetail}
              onRenamed={jumpTo}
              onDeleted={() => {
                setKeys((l) => l.filter((k) => k.key !== focusKey))
                setSelRows(NO_ROWS)
                setCur(null)
                setTotal((n) => (n === null ? n : Math.max(0, n - 1)))
              }}
            />
          ) : (
            <div className="tree-empty rk-pad">{selSet.size > 1 ? `${selSet.size} keys selected` : 'Select a key to see its value'}</div>
          )}
        </div>
      </div>
      {creating && (
        <RedisNewKeyDialog
          dsId={t.dsId}
          db={db}
          onClose={(created) => {
            setCreating(false)
            if (created) jumpTo(created)
          }}
        />
      )}
    </div>
  )
}
