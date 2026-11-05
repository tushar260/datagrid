import type React from 'react'
import { useState } from 'react'
import type { RedisCommandEntry, RedisReply } from '../../shared'
import { replyText } from './lib/redis'

/** redis-cli style rendering of console replies (types are told apart by colour; nested arrays are indented and numbered). */

function Reply({ r }: { r: RedisReply }): React.JSX.Element {
  switch (r.kind) {
    case 'nil':
      return <span className="rr-nil">(nil)</span>
    case 'integer':
      return <span className="rr-int">(integer) {r.value}</span>
    case 'status':
      return <span className="rr-status">{r.value}</span>
    case 'error':
      return <span className="rr-err">(error) {r.message}</span>
    case 'bulk':
      // a multi-line value (INFO, CONFIG ...) reads better raw; short strings are quoted so spaces / emptiness are visible
      return r.value.includes('\n') ? <span className="rr-str rr-block">{r.value}</span> : <span className="rr-str">"{r.value}"</span>
    case 'array':
      if (!r.items.length) return <span className="rr-nil">(empty array)</span>
      return (
        <div className="rr-list">
          {r.items.map((x, i) => (
            <div key={i} className="rr-item">
              <span className="rr-idx">{i + 1})</span>
              <div className="rr-val">
                <Reply r={x} />
              </div>
            </div>
          ))}
        </div>
      )
  }
}

export default function RedisResults({ entries, durationMs }: { entries: RedisCommandEntry[]; durationMs: number }): React.JSX.Element {
  const [copied, setCopied] = useState<number | null>(null)
  const copy = (i: number): void => {
    void navigator.clipboard.writeText(replyText(entries[i].reply))
    setCopied(i)
    window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200)
  }
  return (
    <>
      <div className="msg ok">
        {entries.length} command{entries.length === 1 ? '' : 's'} · {durationMs} ms
      </div>
      <div className="rr">
        {entries.map((e, i) => (
          <div key={i} className="rr-entry">
            <div className="rr-cmd">
              <span className="rr-prompt">&gt;</span>
              <span className="rr-line">{e.line}</span>
              <span className="rr-ms">{e.durationMs} ms</span>
              <button className="link-btn" onClick={() => copy(i)}>{copied === i ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="rr-reply">
              <Reply r={e.reply} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
