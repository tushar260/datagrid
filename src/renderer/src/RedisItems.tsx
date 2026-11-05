import type React from 'react'
import { useState } from 'react'
import { isRedisBinaryName, redisDisplayName, type RedisItemOp, type RedisValue } from '../../shared'

/**
 * Item tables of the Redis detail pane: hash / list / set / zset with per-item editing, stream read-only.
 * Binary values (shown as `\xNN` escapes) are read-only: typing the escaped text back would store different bytes.
 */

type Items = Exclude<RedisValue, { kind: 'none' | 'unsupported' | 'string' }>

const BIN = 'Binary value: shown escaped, cannot be edited here'

interface Props {
  value: Items
  /** performs one item operation (the parent reloads the key afterwards); rejects with the error */
  onOp: (op: RedisItemOp) => Promise<boolean>
  onMore: () => void
  loadingMore: boolean
  busy: boolean
}

/** Multi-line capable inline editor: Cmd/Ctrl+Enter saves, Escape cancels. */
function Editor({ initial, onSave, onCancel, busy }: { initial: string; onSave: (v: string) => void; onCancel: () => void; busy: boolean }): React.JSX.Element {
  const [text, setText] = useState(initial)
  return (
    <span className="rk-edit">
      <textarea
        autoFocus
        spellCheck={false}
        rows={Math.min(6, text.split('\n').length)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(text) }
        }}
      />
      <button className="primary" disabled={busy || text === initial} onClick={() => onSave(text)} title="Save (Cmd/Ctrl+Enter)">Save</button>
      <button onClick={onCancel} title="Cancel (Escape)">Cancel</button>
    </span>
  )
}

/** A row of inputs under a table to add one item. */
function AddRow({ fields, button, onAdd, busy }: {
  fields: { ph: string; w?: number; num?: boolean }[]
  button: string | string[]
  onAdd: (vals: string[], which: number) => Promise<boolean>
  busy: boolean
}): React.JSX.Element {
  const [vals, setVals] = useState<string[]>(() => fields.map(() => ''))
  const buttons = Array.isArray(button) ? button : [button]
  const submit = async (which: number): Promise<void> => {
    if (await onAdd(vals, which)) setVals(fields.map(() => ''))
  }
  const ready = vals.every((v, i) => v !== '' || fields[i]?.ph === 'value')
  return (
    <div className="rk-add">
      {fields.map((f, i) => (
        <input
          key={i}
          placeholder={f.ph}
          value={vals[i]}
          style={f.w ? { width: f.w, flex: 'none' } : undefined}
          inputMode={f.num ? 'decimal' : undefined}
          onChange={(e) => setVals((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
          onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) void submit(0) }}
        />
      ))}
      {buttons.map((b, i) => (
        <button key={b} disabled={busy || !ready} onClick={() => void submit(i)}>{b}</button>
      ))}
    </div>
  )
}

export default function RedisItems({ value, onOp, onMore, loadingMore, busy }: Props): React.JSX.Element {
  const [edit, setEdit] = useState<string | null>(null)
  const save = async (op: RedisItemOp): Promise<void> => {
    if (await onOp(op)) setEdit(null)
  }
  const more = value.next !== null && value.next !== undefined
  const moreBtn = more ? (
    <div className="rk-more">
      <button disabled={loadingMore} onClick={onMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
    </div>
  ) : null
  const iconBtn = (title: string, onClick: () => void, label: string, disabled = false): React.JSX.Element => (
    <button className="rk-ib" title={title} disabled={disabled || busy} onClick={onClick}>{label}</button>
  )

  switch (value.kind) {
    case 'hash':
      return (
        <div className="rk-items" data-kind="hash">
          <table className="grid">
            <thead><tr><th>Field</th><th>Value</th><th className="rk-act" /></tr></thead>
            <tbody>
              {value.items.map((it) => (
                <tr key={it.field}>
                  <td title={redisDisplayName(it.field)}>{redisDisplayName(it.field)}</td>
                  <td className={'rk-val' + (edit === it.field ? ' editing' : '')} title={redisDisplayName(it.value)}>
                    {edit === it.field ? (
                      <Editor initial={it.value} busy={busy} onCancel={() => setEdit(null)} onSave={(v) => void save({ op: 'hset', field: it.field, value: v })} />
                    ) : (
                      redisDisplayName(it.value)
                    )}
                  </td>
                  <td className="rk-act">
                    {iconBtn(isRedisBinaryName(it.value) ? BIN : 'Edit value', () => setEdit(it.field), '✎', isRedisBinaryName(it.value))}
                    {iconBtn('Delete field', () => void onOp({ op: 'hdel', field: it.field }), '×')}
                  </td>
                </tr>
              ))}
              {value.items.length === 0 && <tr><td colSpan={3} className="null">Empty hash</td></tr>}
            </tbody>
          </table>
          {moreBtn}
          <AddRow key={value.kind} fields={[{ ph: 'field' }, { ph: 'value' }]} button="Add field" busy={busy} onAdd={async (v) => onOp({ op: 'hset', field: v[0], value: v[1] })} />
        </div>
      )
    case 'list':
      return (
        <div className="rk-items" data-kind="list">
          <table className="grid">
            <thead><tr><th className="rk-idx">Index</th><th>Value</th><th className="rk-act" /></tr></thead>
            <tbody>
              {value.items.map((it, i) => {
                const idx = value.offset + i
                const k = String(idx)
                return (
                  <tr key={idx}>
                    <td className="rk-idx">{idx}</td>
                    <td className={'rk-val' + (edit === k ? ' editing' : '')} title={redisDisplayName(it)}>
                      {edit === k ? (
                        <Editor initial={it} busy={busy} onCancel={() => setEdit(null)} onSave={(v) => void save({ op: 'lset', index: idx, value: v })} />
                      ) : (
                        redisDisplayName(it)
                      )}
                    </td>
                    <td className="rk-act">
                      {iconBtn(isRedisBinaryName(it) ? BIN : 'Edit value', () => setEdit(k), '✎', isRedisBinaryName(it))}
                      {iconBtn('Remove this value (the first element equal to it is removed)', () => void onOp({ op: 'lrem', value: it, count: 1 }), '×', isRedisBinaryName(it))}
                    </td>
                  </tr>
                )
              })}
              {value.items.length === 0 && <tr><td colSpan={3} className="null">Empty list</td></tr>}
            </tbody>
          </table>
          {moreBtn}
          <AddRow key={value.kind}
            fields={[{ ph: 'value' }]}
            button={['Push left', 'Push right']}
            busy={busy}
            onAdd={async (v, which) => onOp({ op: which === 0 ? 'lpush' : 'rpush', value: v[0] })}
          />
        </div>
      )
    case 'set':
      return (
        <div className="rk-items" data-kind="set">
          <table className="grid">
            <thead><tr><th>Member</th><th className="rk-act" /></tr></thead>
            <tbody>
              {value.items.map((m) => (
                <tr key={m}>
                  <td className="rk-val" title={redisDisplayName(m)}>{redisDisplayName(m)}</td>
                  <td className="rk-act">{iconBtn('Remove member', () => void onOp({ op: 'srem', member: m }), '×')}</td>
                </tr>
              ))}
              {value.items.length === 0 && <tr><td colSpan={2} className="null">Empty set</td></tr>}
            </tbody>
          </table>
          {moreBtn}
          <AddRow key={value.kind} fields={[{ ph: 'member' }]} button="Add member" busy={busy} onAdd={async (v) => onOp({ op: 'sadd', member: v[0] })} />
        </div>
      )
    case 'zset':
      return (
        <div className="rk-items" data-kind="zset">
          <table className="grid">
            <thead><tr><th className="rk-idx">Rank</th><th>Member</th><th>Score</th><th className="rk-act" /></tr></thead>
            <tbody>
              {value.items.map((it, i) => (
                <tr key={it.member}>
                  <td className="rk-idx">{value.offset + i}</td>
                  <td className="rk-val" title={redisDisplayName(it.member)}>{redisDisplayName(it.member)}</td>
                  <td className={'rk-val' + (edit === it.member ? ' editing' : '')}>
                    {edit === it.member ? (
                      <Editor initial={it.score} busy={busy} onCancel={() => setEdit(null)} onSave={(v) => void save({ op: 'zadd', member: it.member, score: v.trim() })} />
                    ) : (
                      it.score
                    )}
                  </td>
                  <td className="rk-act">
                    {iconBtn('Edit score', () => setEdit(it.member), '✎')}
                    {iconBtn('Remove member', () => void onOp({ op: 'zrem', member: it.member }), '×')}
                  </td>
                </tr>
              ))}
              {value.items.length === 0 && <tr><td colSpan={4} className="null">Empty sorted set</td></tr>}
            </tbody>
          </table>
          {moreBtn}
          <AddRow key={value.kind}
            fields={[{ ph: 'score', w: 90, num: true }, { ph: 'member' }]}
            button="Add member"
            busy={busy}
            onAdd={async (v) => onOp({ op: 'zadd', member: v[1], score: v[0].trim() })}
          />
        </div>
      )
    case 'stream':
      return (
        <div className="rk-items" data-kind="stream">
          <table className="grid">
            <thead><tr><th>ID</th><th>Fields</th></tr></thead>
            <tbody>
              {value.entries.map((e) => {
                const text = e.fields.map((f) => `${redisDisplayName(f.field)}=${redisDisplayName(f.value)}`).join('  ')
                return (
                  <tr key={e.id}>
                    <td>{e.id}</td>
                    <td className="rk-val" title={text}>{text}</td>
                  </tr>
                )
              })}
              {value.entries.length === 0 && <tr><td colSpan={2} className="null">Empty stream</td></tr>}
            </tbody>
          </table>
          {moreBtn}
          <div className="rk-note">Streams are read-only here; use the console (XADD, XDEL …) to change them.</div>
        </div>
      )
  }
}
