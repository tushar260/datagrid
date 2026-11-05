import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { STORAGE_PREFIX, splitStatements, type DynamoStatementResult, type QueryResult, type RedisCommandResult } from '../../shared'
import RedisResults from './RedisReplyView'
import { setConsoleSql } from './session'
import { useConsoleSuggest } from './ConsoleSuggest'
import { appendPage } from './lib/dynamoPaging'
import { DragHandle, clamp, isRatio, readStored, writeStored } from './Resizable'

const SPLIT_KEY = `${STORAGE_PREFIX}console-split`
const SPLIT_DEFAULT = 0.38

export interface ConsoleRef {
  id: string
  title: string
  dsId: string
  dsName: string
  database: string
  schema?: string
  sql?: string
  /** 'dynamodb' = PartiQL console (no database / schema; `region` is shown); 'redis' = command console on logical database `db` */
  engine?: 'dynamodb' | 'redis'
  region?: string
  db?: number
}

/** One executed PartiQL statement: its result, or the error that stopped the run. */
interface DynEntry {
  statement: string
  r?: DynamoStatementResult
  err?: string
  more?: boolean
  moreErr?: string
}

const clean = (e: unknown): string =>
  String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function Console({ c }: { c: ConsoleRef }): React.JSX.Element {
  const [sql, setSql] = useState(c.sql ?? '')
  const [res, setRes] = useState<QueryResult | null>(null)
  const [err, setErr] = useState('')
  const [running, setRunning] = useState(false)
  const [active, setActive] = useState(0)
  const dynamo = c.engine === 'dynamodb'
  const redis = c.engine === 'redis'
  const [rres, setRres] = useState<RedisCommandResult | null>(null)
  const [dres, setDres] = useState<DynEntry[]>([])
  const ta = useRef<HTMLTextAreaElement>(null)
  // table / column / keyword completion in the editor (metadata loaded lazily and cached per console)
  const cs = useConsoleSuggest(ta, c.dsId, c.database, c.schema, c.engine)
  // editor height as a fraction of the console; dragged via the splitter below the editor
  const root = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(() => readStored(SPLIT_KEY, SPLIT_DEFAULT, isRatio))
  const splitRef = useRef(split)
  const splitStart = useRef(split)
  // keep unsaved SQL across restarts (results are never persisted)
  useEffect(() => setConsoleSql(c.id, sql), [c.id, sql])

  const run = async (): Promise<void> => {
    const el = ta.current
    // run the selection if there is one, otherwise the whole console
    const sel = el && el.selectionStart !== el.selectionEnd ? sql.slice(el.selectionStart, el.selectionEnd) : sql
    if (!sel.trim()) return
    if (dynamo) return void runPartiql(sel)
    if (redis) return void runRedis(sel)
    setRunning(true)
    setErr('')
    try {
      const r = await window.api.query(c.dsId, c.database, c.schema, sel)
      setRes(r)
      setActive(Math.max(0, r.results.length - 1))
    } catch (e) {
      setRes(null)
      setErr(clean(e))
    } finally {
      setRunning(false)
      // DDL changes what can be completed
      if (/\b(create|alter|drop|truncate|rename)\b/i.test(sel)) cs.refresh()
    }
  }

  /** Redis: one command per line (a failing line stops the run; earlier replies stay). */
  const runRedis = async (text: string): Promise<void> => {
    setRunning(true)
    setErr('')
    try {
      setRres(await window.api.redis.command(c.dsId, c.db ?? 0, text))
    } catch (e) {
      setRres(null)
      setErr(clean(e))
    } finally {
      setRunning(false)
    }
  }

  /** PartiQL: `;`-separated statements run one after another; the first error stops the run (earlier results stay). */
  const runPartiql = async (text: string): Promise<void> => {
    const statements = splitStatements(text)
    if (!statements.length) return
    setRunning(true)
    const out: DynEntry[] = []
    setDres([])
    try {
      for (const statement of statements) {
        try {
          out.push({ statement, r: await window.api.dynamo.partiql(c.dsId, statement) })
        } catch (e) {
          out.push({ statement, err: clean(e) })
          break
        }
      }
    } finally {
      setDres(out)
      setActive(Math.max(0, out.length - 1))
      setRunning(false)
    }
  }
  const loadMore = async (i: number): Promise<void> => {
    const e = dres[i]
    if (!e?.r?.next || e.more) return
    setDres((l) => l.map((x, k) => (k === i ? { ...x, more: true, moreErr: undefined } : x)))
    try {
      const nx = await window.api.dynamo.partiql(c.dsId, e.statement, { nextToken: e.r.next })
      setDres((l) => l.map((x, k) => (k === i && x.r ? { ...x, more: false, r: { ...appendPage(x.r, nx), durationMs: x.r.durationMs + nx.durationMs } } : x)))
    } catch (er) {
      setDres((l) => l.map((x, k) => (k === i ? { ...x, more: false, moreErr: clean(er) } : x)))
    }
  }

  const cur = res?.results[active]
  const dcur = dres[active]

  return (
    <div className="console" ref={root}>
      <div className="toolbar">
        <button className="primary" disabled={running} onClick={run} title="Run (Cmd/Ctrl+Enter). Runs the selection if any.">
          {running ? 'Running…' : '▶ Run'}
        </button>
        <span className="ctx">
          {redis ? `${c.dsName} / db${c.db ?? 0}` : dynamo ? `${c.dsName} / ${c.region ?? ''}` : `${c.dsName} / ${c.database}${c.schema ? ` / ${c.schema}` : ''}`}
        </span>
        {!redis && (
          <button
            className={'cs-refresh' + (cs.loading ? ' loading' : '')}
            onClick={cs.refresh}
            title={dynamo ? "Refresh table and attribute suggestions (Ctrl+Space completes)" : "Refresh table and column suggestions (Ctrl+Space completes)"}
          >
            ⟳
          </button>
        )}
        <span className="spacer" />
        <span className="hint">⌘/Ctrl+Enter to run</span>
      </div>
      <textarea
        ref={ta}
        className="editor"
        style={{ height: `${split * 100}%` }}
        spellCheck={false}
        value={sql}
        placeholder={redis ? 'Write Redis commands here, one per line, e.g. GET mykey' : dynamo ? "Write PartiQL here, e.g. SELECT * FROM \"table\"" : "-- write SQL here"}
        onChange={(e) => {
          setSql(e.target.value)
          cs.onInput(e)
        }}
        onBlur={cs.close}
        onClick={cs.close}
        onWheel={cs.close}
        onKeyDown={(e) => {
          if (cs.onKeyDown(e)) return // completion popup consumed the key
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void run()
          }
          if (e.key === 'Tab') {
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: a, selectionEnd: b } = el
            setSql(sql.slice(0, a) + '  ' + sql.slice(b))
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
          }
        }}
      />
      {cs.popup}
      <DragHandle
        className="split-h"
        cursor="ns-resize"
        title="Drag to resize the editor · double-click to reset"
        onStart={() => (splitStart.current = splitRef.current)}
        onDrag={(_dx, dy) => {
          const h = root.current?.clientHeight || 1
          const r = clamp(splitStart.current + dy / h, 0.1, 0.85)
          splitRef.current = r
          setSplit(r)
        }}
        onEnd={() => writeStored(SPLIT_KEY, splitRef.current)}
        onReset={() => {
          splitRef.current = SPLIT_DEFAULT
          setSplit(SPLIT_DEFAULT)
          writeStored(SPLIT_KEY, null)
        }}
      />
      <div className="results">
        {err && <div className="msg bad pre">{err}</div>}
        {redis && rres && <RedisResults entries={rres.results} durationMs={rres.durationMs} />}
        {dynamo && dres.length > 1 && (
          <div className="subtabs">
            {dres.map((e, i) => (
              <button key={i} className={i === active ? 'on' : ''} onClick={() => setActive(i)}>
                {i + 1}: {e.r?.command ?? 'ERROR'}
              </button>
            ))}
          </div>
        )}
        {dynamo && dcur?.err && <div className="msg bad pre">{dcur.err}</div>}
        {dynamo && dcur?.r && (
          <>
            <div className="msg ok">
              {dcur.r.columns.length
                ? `${dcur.r.rows.length} item${dcur.r.rows.length === 1 ? '' : 's'}`
                : `${dcur.r.command} completed`}
              {' · '}
              {dcur.r.durationMs} ms
              {dcur.r.next && (
                <>
                  {' · '}
                  <button className="link-btn" disabled={dcur.more} onClick={() => void loadMore(active)}>
                    {dcur.more ? 'Loading…' : 'Load more'}
                  </button>
                </>
              )}
            </div>
            {dcur.moreErr && <div className="msg bad pre">{dcur.moreErr}</div>}
            {dcur.r.columns.length > 0 && (
              <div className="gridwrap">
                <table className="grid">
                  <thead>
                    <tr>
                      <th className="rn">#</th>
                      {dcur.r.columns.map((col) => (
                        <th key={col.name}>
                          {col.key && <span className="keybadge">{col.key === 'HASH' ? 'PK' : 'SK'}</span>}
                          {col.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dcur.r.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="rn">{i + 1}</td>
                        {r.map((v, j) => (
                          <td key={j} className={v === null ? 'null' : ''} title={v ?? 'NULL'}>
                            {v === null ? 'null' : v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {res && res.results.length > 1 && (
          <div className="subtabs">
            {res.results.map((r, i) => (
              <button key={i} className={i === active ? 'on' : ''} onClick={() => setActive(i)}>
                {i + 1}: {r.command}
              </button>
            ))}
          </div>
        )}
        {cur && (
          <>
            <div className="msg ok">
              {cur.fields.length
                ? `${cur.rows.length}${cur.truncated ? '+' : ''} row${cur.rows.length === 1 ? '' : 's'}`
                : `${cur.command} ${cur.rowCount ?? ''}`.trim()}
              {' · '}
              {res!.durationMs} ms{cur.truncated ? ' · showing first 5000 rows' : ''}
            </div>
            {cur.fields.length > 0 && (
              <div className="gridwrap">
                <table className="grid">
                  <thead>
                    <tr>
                      <th className="rn">#</th>
                      {cur.fields.map((f, i) => (
                        <th key={i}>{f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cur.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="rn">{i + 1}</td>
                        {r.map((v, j) => (
                          <td key={j} className={v === null ? 'null' : ''} title={v ?? 'NULL'}>
                            {v === null ? 'null' : v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
