import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { redisDisplayName, type RedisItemOp, type RedisKeyDetail as Detail, type RedisValue } from '../../shared'
import RedisItems from './RedisItems'
import { base64Hex, fmtBytes, fmtTtl, parseTtlInput, prettyJson, ttlInputOf, typeClass, valueCopyText } from './lib/redis'

/**
 * Detail pane of the Redis key browser: header (type, rename, TTL, size), then a viewer / editor chosen by the key's type.
 * Everything that changes the key goes through window.api.redis.* and is followed by a reload of the key.
 */

const clean = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  dsId: string
  db: number
  keyName: string
  /** bumped by the parent to reload (toolbar / Cmd+R) */
  reloadToken: number
  /** the key was loaded (or reloaded): lets the grid refresh its type / TTL cells */
  onDetail: (d: Detail) => void
  onRenamed: (to: string) => void
  onDeleted: () => void
}

export default function RedisKeyDetail({ dsId, db, keyName, reloadToken, onDetail, onRenamed, onDeleted }: Props): React.JSX.Element {
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [text, setText] = useState('') // string editor content
  const [ttlText, setTtlText] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedValue, setCopiedValue] = useState(false)
  const gen = useRef(0) // drops answers for a key / reload that is no longer current
  const onDetailRef = useRef(onDetail)
  onDetailRef.current = onDetail

  const load = useCallback(async (): Promise<void> => {
    const g = ++gen.current
    setLoading(true)
    setErr('')
    try {
      const r = await window.api.redis.get(dsId, db, keyName)
      if (g !== gen.current) return
      setD(r)
      setText(r.value.kind === 'string' ? r.value.text : '')
      setTtlText(ttlInputOf(r.ttl))
      onDetailRef.current(r)
    } catch (e) {
      if (g === gen.current) setErr(clean(e))
    } finally {
      if (g === gen.current) setLoading(false)
    }
  }, [dsId, db, keyName])

  // a different key starts from a clean slate (no flash of the previous key's value)
  useEffect(() => {
    setD(null)
    setRenaming(null)
    setCopied(false)
    setCopiedValue(false)
    void load()
    return () => {
      gen.current++
    }
  }, [load])
  /**
   * A user-asked reload (the parent's token: Cmd/Ctrl+R, tree refresh, toolbar; or the ⟳ button). It overwrites the value, so
   * while the string editor holds unsaved text it asks first (`window.confirm`); declining keeps the text and the loaded value.
   */
  const reloadAsked = (): void => {
    if (strDirty && !window.confirm(`Discard your unsaved changes to "${redisDisplayName(keyName)}" and reload it?`)) return
    void load()
  }
  const first = useRef(reloadToken)
  useEffect(() => {
    if (reloadToken !== first.current) reloadAsked()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  /** Runs a write; true when it worked (the error is shown otherwise). `reload` = fetch the key again afterwards. */
  const act = async (fn: () => Promise<unknown>, reload = true): Promise<boolean> => {
    setBusy(true)
    setErr('')
    try {
      await fn()
      if (reload) await load()
      return true
    } catch (e) {
      setErr(clean(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const moreItems = async (): Promise<void> => {
    const v = d?.value
    if (!v || loadingMore || (v.kind !== 'hash' && v.kind !== 'list' && v.kind !== 'set' && v.kind !== 'zset' && v.kind !== 'stream') || v.next === null) return
    setLoadingMore(true)
    try {
      const g = gen.current
      const r = await window.api.redis.get(dsId, db, keyName, typeof v.next === 'number' ? { offset: v.next } : { cursor: v.next })
      if (g !== gen.current) return
      const nv = r.value
      setD((cur) => {
        if (!cur || cur.value.kind !== nv.kind) return cur
        const o = cur.value
        // SSCAN / HSCAN may repeat an element between pages
        const merged: RedisValue =
          o.kind === 'hash' && nv.kind === 'hash'
            ? { ...nv, items: [...o.items, ...nv.items.filter((x) => !o.items.some((y) => y.field === x.field))] }
            : o.kind === 'set' && nv.kind === 'set'
              ? { ...nv, items: [...o.items, ...nv.items.filter((x) => !o.items.includes(x))] }
              : o.kind === 'list' && nv.kind === 'list'
                ? { ...nv, offset: o.offset, items: [...o.items, ...nv.items] }
                : o.kind === 'zset' && nv.kind === 'zset'
                  ? { ...nv, offset: o.offset, items: [...o.items, ...nv.items] }
                  : o.kind === 'stream' && nv.kind === 'stream'
                    ? { ...nv, entries: [...o.entries, ...nv.entries] }
                    : nv
        return { ...cur, value: merged }
      })
    } catch (e) {
      setErr(clean(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const onOp = (op: RedisItemOp): Promise<boolean> => act(() => window.api.redis.item(dsId, db, keyName, op))

  const applyTtl = async (): Promise<void> => {
    const s = parseTtlInput(ttlText)
    if (s === undefined) return void setErr('TTL: use seconds (90) or 90s / 5m / 2h / 1d, or leave empty for no expiry')
    await act(() => window.api.redis.setTtl(dsId, db, keyName, s))
  }
  const doRename = async (): Promise<void> => {
    const to = renaming
    if (to === null || !to || to === keyName) return void setRenaming(null)
    if (await act(() => window.api.redis.rename(dsId, db, keyName, to), false)) onRenamed(to)
  }
  const doDelete = async (): Promise<void> => {
    if (!window.confirm(`Delete key "${redisDisplayName(keyName)}"? This cannot be undone.`)) return
    if (await act(() => window.api.redis.delete(dsId, db, [keyName]), false)) onDeleted()
  }
  const copyKey = (): void => {
    void navigator.clipboard.writeText(redisDisplayName(keyName))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const copyValue = (): void => {
    if (!d) return
    void navigator.clipboard.writeText(valueCopyText(d.value, strV ? text : undefined))
    setCopiedValue(true)
    window.setTimeout(() => setCopiedValue(false), 1200)
  }

  const v = d?.value
  const gone = !!d && (d.ttl === -2 || v?.kind === 'none')
  const strV = v?.kind === 'string' ? v : null
  const strDirty = !!strV && !strV.binary && !strV.truncated && text !== strV.text
  const pretty = strV && !strV.binary ? prettyJson(text) : null
  const saveString = (): Promise<boolean> => act(() => window.api.redis.setString(dsId, db, keyName, text, { keepTtl: true }))

  return (
    <div className={'rk-detail-in' + (loading && d ? ' reloading' : '')} data-testid="redis-detail" aria-busy={loading}>
      <div className="rk-head">
        {d && !gone && <span className={typeClass(d.type)}>{d.type}</span>}
        {renaming === null ? (
          <span className="rk-name" title={redisDisplayName(keyName)}>{redisDisplayName(keyName)}</span>
        ) : (
          <input
            className="rk-rename"
            autoFocus
            spellCheck={false}
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRename()
              else if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null) }
            }}
          />
        )}
        <span className="spacer" />
        {d && !gone && strV && !strV.binary && (
          <>
            <span className="rk-head-actions" data-testid="redis-string-actions">
              <button
                className="primary"
                disabled={busy || !strDirty}
                title="Save (Cmd/Ctrl+Enter). The expiry is kept."
                onClick={() => void saveString()}
              >Save</button>
              <button disabled={!strDirty} onClick={() => setText(strV.text)}>Revert</button>
              <button
                disabled={strV.truncated || !pretty || pretty === text}
                title={pretty ? 'Pretty-print the JSON in the editor (Save to store it)' : 'The value is not a JSON object / array'}
                onClick={() => pretty && setText(pretty)}
              >Format JSON</button>
            </span>
            <span className="rk-sep" aria-hidden="true" />
          </>
        )}
        {renaming === null ? (
          <>
            <button disabled={busy || gone || !d} onClick={() => setRenaming(redisDisplayName(keyName))} title="Rename the key (fails when the new name already exists)">Rename</button>
            <button onClick={copyKey} title="Copy the key name">{copied ? 'Copied' : 'Copy'}</button>
            <button disabled={!d || gone} onClick={copyValue} title="Copy the loaded value (strings as text, collections as JSON)">{copiedValue ? 'Copied value' : 'Copy value'}</button>
            <button onClick={reloadAsked} disabled={loading} title="Reload this key (Cmd/Ctrl+R)">⟳</button>
            <button className="danger" disabled={busy || gone || !d} onClick={() => void doDelete()} title="Delete this key">Delete</button>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={() => void doRename()}>Rename</button>
            <button onClick={() => setRenaming(null)}>Cancel</button>
          </>
        )}
      </div>

      {err && <div className="msg bad pre">{err}</div>}
      {!d && !err && <div className="tree-empty rk-pad">Loading…</div>}
      {gone && (
        <div className="msg warn">
          This key no longer exists (deleted or expired). <button className="link-btn" onClick={() => void load()}>Reload</button>
        </div>
      )}

      {d && !gone && (
        <>
          <div className="rk-meta">
            <span className="rk-ttl">
              <label>TTL</label>
              <input
                value={ttlText}
                placeholder="no expiry"
                spellCheck={false}
                title="Seconds, or 90s / 5m / 2h / 1d. Empty = no expiry"
                onChange={(e) => setTtlText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void applyTtl() }}
              />
              <button disabled={busy || ttlText === ttlInputOf(d.ttl)} onClick={() => void applyTtl()}>Set</button>
              <button disabled={busy || d.ttl < 0} onClick={() => void act(() => window.api.redis.setTtl(dsId, db, keyName, null))} title="Remove the expiry">Persist</button>
            </span>
            <span className="rk-fact" title={d.ttl < 0 ? 'The key does not expire' : `${d.ttl} ms left`}>{d.ttl < 0 ? 'No expiry' : `Expires in ${fmtTtl(d.ttl)}`}</span>
            {d.length !== null && <span className="rk-fact">{d.length.toLocaleString()} {d.type === 'string' ? 'bytes' : 'items'}</span>}
            {d.size !== null && <span className="rk-fact" title="MEMORY USAGE">{fmtBytes(d.size)} in memory</span>}
            {d.encoding && <span className="rk-fact">{d.encoding}</span>}
          </div>

          <div className="rk-value">
            {strV && (
              <div className="rk-string">
                {strV.binary ? (
                  <>
                    <div className="msg warn">Binary value ({strV.bytes.toLocaleString()} bytes): shown as hex, read-only.</div>
                    <pre className="rk-hex">{base64Hex(strV.base64)}</pre>
                  </>
                ) : (
                  <>
                    {strV.truncated && (
                      <div className="msg warn">Only the first part of this {fmtBytes(strV.bytes)} value is loaded; editing is disabled so it cannot be cut off.</div>
                    )}
                    <textarea
                      className="rk-text"
                      spellCheck={false}
                      readOnly={strV.truncated}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && strDirty) {
                          e.preventDefault()
                          void saveString()
                        }
                      }}
                    />
                  </>
                )}
              </div>
            )}
            {v && (v.kind === 'hash' || v.kind === 'list' || v.kind === 'set' || v.kind === 'zset' || v.kind === 'stream') && (
              <RedisItems key={`${keyName}\u0000${v.kind}`} value={v} onOp={onOp} onMore={() => void moreItems()} loadingMore={loadingMore} busy={busy} />
            )}
            {v?.kind === 'unsupported' && (
              <div className="msg warn">Values of type “{v.type}” (a module type) cannot be shown here. Use the console to work with them.</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
