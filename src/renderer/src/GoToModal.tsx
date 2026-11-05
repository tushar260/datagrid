import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DataSource } from '../../shared'
import type { TableRef } from './Explorer'
import { Icon, type IconName } from './icons'
import { rankFuzzy } from './lib/fuzzy'
import {
  buildGotoEntries, databaseNodeId, entrySuffix, indexSources, recentEntries, recordRecent, tableRefOf, unindexed,
  type GotoEntry, type IndexProgress
} from './lib/gotoIndex'
import { peekIndex, subscribeIndex } from './lib/objectCache'
import { useModalClose } from './lib/useModalClose'

/** most rows the list shows (the fuzzy ranking is capped to this; refine the query to see others) */
export const GOTO_MAX_ROWS = 200

const iconOf = (e: GotoEntry): IconName =>
  e.kind === 'database' ? (e.engine === 'redis' ? 'redis' : 'database')
  : e.engine === 'dynamodb' ? 'dynamodb'
  : e.kind === 'view' || e.kind === 'matview' ? 'view'
  : 'table'

/** the name with its matched characters emphasised (bold / bright), the rest in the normal colour */
function Highlighted({ name, positions }: { name: string; positions: number[] }): React.JSX.Element {
  if (!positions.length) return <>{name}</>
  const on = new Set(positions)
  const out: React.ReactNode[] = []
  for (let i = 0; i < name.length; ) {
    const hit = on.has(i)
    let j = i
    while (j < name.length && on.has(j) === hit) j++
    out.push(hit ? <b key={i}>{name.slice(i, j)}</b> : name.slice(i, j))
    i = j
  }
  return <>{out}</>
}

interface Props {
  sources: DataSource[]
  onClose: () => void
  /** a table / view / DynamoDB table was chosen: the App's own open handler (tabs dedupe / focus like in the explorer) */
  onOpenTable: (t: TableRef) => void
  /** a database was chosen: select + expand it in the explorer (the tree node id: `ds/db`, Redis `ds/db3`) */
  onRevealDb: (nodeId: string) => void
}

/**
 * ⌘O "Go to database / table": a Search Everywhere style popup that fuzzy-matches the names of databases and tables of ALL
 * data sources (never data source, schema or key names). The names come from the local object cache plus what the explorer
 * has loaded (lib/objectCache index); "Index N more data sources" loads the lists of sources that were never opened.
 */
export default function GoToModal({ sources, onClose: onCloseProp, onOpenTable, onRevealDb }: Props): React.JSX.Element {
  const { ref: bgRef, closing, close } = useModalClose(onCloseProp)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // the index changes while sources load (the explorer, the indexer): coalesce bursts into one rebuild
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let t = 0
    const off = subscribeIndex(() => {
      if (!t) t = window.setTimeout(() => ((t = 0), setVersion((v) => v + 1)), 60)
    })
    return () => (off(), window.clearTimeout(t))
  }, [])
  const entries = useMemo(() => buildGotoEntries(sources, peekIndex), [sources, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const missing = useMemo(() => unindexed(sources, peekIndex), [sources, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(
    () =>
      query.trim()
        ? rankFuzzy(query, entries, GOTO_MAX_ROWS).map((r) => ({ e: r.item, positions: r.positions }))
        : recentEntries(sources).map((e) => ({ e, positions: [] as number[] })),
    [query, entries, sources]
  )
  useEffect(() => setSel(0), [query])
  const cur = Math.min(sel, rows.length - 1)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.goto-row.on')?.scrollIntoView?.({ block: 'nearest' })
  }, [cur, rows])

  // ---- indexing the sources nobody opened yet (max 3 at a time, cancelled by closing) ----
  const abort = useRef({ aborted: false })
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  const [errors, setErrors] = useState<{ id: string; name: string; message: string }[]>([])
  useEffect(() => {
    abort.current = { aborted: false }
    const a = abort.current
    return () => void (a.aborted = true)
  }, [])
  const startIndexing = (): void => {
    if (progress) return
    setErrors([])
    void indexSources(missing, peekIndex, {
      signal: abort.current,
      onProgress: (p) => !abort.current.aborted && setProgress(p),
      onError: (ds, message) => !abort.current.aborted && setErrors((cur) => [...cur.filter((x) => x.id !== ds.id), { id: ds.id, name: ds.name, message }])
    }).then(() => !abort.current.aborted && (setProgress(null), setVersion((v) => v + 1)))
  }

  const choose = (e: GotoEntry): void => {
    recordRecent(e)
    if (e.kind === 'database') onRevealDb(databaseNodeId(e))
    else onOpenTable(tableRefOf(e))
    close()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const n = rows.length
    const go = (i: number): void => {
      e.preventDefault()
      if (n) setSel(i)
    }
    if (e.key === 'ArrowDown') go((cur + 1) % Math.max(n, 1))
    else if (e.key === 'ArrowUp') go((cur - 1 + n) % Math.max(n, 1))
    else if (e.key === 'PageDown') go(Math.min(n - 1, cur + 8))
    else if (e.key === 'PageUp') go(Math.max(0, cur - 8))
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(n - 1)
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[cur]) choose(rows[cur].e)
    }
  }

  const total = rows.length
  const hint = !query.trim()
    ? rows.length
      ? 'Recently opened'
      : entries.length
        ? 'Type to search databases and tables'
        : 'Nothing is indexed yet: open a data source in the explorer or index the data sources below'
    : total
      ? ''
      : 'No databases or tables match'

  return createPortal(
    <div
      ref={bgRef}
      className={'modal-bg goto-bg' + (closing ? ' closing' : '')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal goto" role="dialog" aria-label="Go to database or table">
        <div className="goto-tabs">
          <span className="goto-tab on">Database</span>
        </div>
        <div className="goto-search">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <circle cx="6.8" cy="6.8" r="4.6" />
            <path d="M10.4 10.4 14 14" />
          </svg>
          <input
            autoFocus
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded
            aria-controls="goto-list"
            aria-activedescendant={rows[cur] ? 'goto-row-' + cur : undefined}
            placeholder="Search databases and tables"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="goto-list" id="goto-list" role="listbox" ref={listRef}>
          {hint && <div className="goto-hint">{hint}</div>}
          {rows.map(({ e, positions }, i) => (
            <div
              key={e.id}
              id={'goto-row-' + i}
              role="option"
              aria-selected={i === cur}
              className={'goto-row' + (i === cur ? ' on' : '')}
              data-kind={e.kind}
              onMouseMove={() => i !== cur && setSel(i)}
              onClick={() => choose(e)}
            >
              <span className="ticon"><Icon name={iconOf(e)} /></span>
              <span className="goto-name"><Highlighted name={e.name} positions={positions} /></span>
              <span className="goto-sfx">{entrySuffix(e)}</span>
            </div>
          ))}
        </div>
        {errors.map((x) => (
          <div key={x.id} className="goto-note" role="status">{x.name}: {x.message}</div>
        ))}
        <div className="goto-foot">
          <span className="goto-count">
            {query.trim() ? `${total}${total >= GOTO_MAX_ROWS ? '+' : ''} ${total === 1 ? 'result' : 'results'}` : `${entries.length.toLocaleString()} indexed`}
          </span>
          {progress ? (
            <span className="goto-progress" role="status">Indexing {progress.done}/{progress.total}…</span>
          ) : missing.length > 0 ? (
            <button type="button" className="goto-index" onClick={startIndexing}>
              Index {missing.length} more data {missing.length === 1 ? 'source' : 'sources'}
            </button>
          ) : null}
          <span className="spacer" />
          <span className="goto-keys">↑↓ navigate · ⏎ open · esc close</span>
        </div>
      </div>
    </div>,
    document.body
  )
}
