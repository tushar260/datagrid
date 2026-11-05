import type React from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RedisNewKey } from '../../shared'
import { useModalClose } from './lib/useModalClose'
import { parseTtlInput } from './lib/redis'

const TYPES = ['string', 'hash', 'list', 'set', 'zset'] as const
type NewType = (typeof TYPES)[number]

const clean = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Modal for creating a key. It never overwrites: an existing key makes the server-side create fail with a clear message. */
export default function RedisNewKeyDialog({ dsId, db, onClose: onCloseProp }: {
  dsId: string
  db: number
  /** the created key's name, or null when cancelled */
  onClose: (created: string | null) => void
}): React.JSX.Element {
  const { ref, closing, close } = useModalClose(onCloseProp)
  const [name, setName] = useState('')
  const [type, setType] = useState<NewType>('string')
  const [value, setValue] = useState('')
  const [field, setField] = useState('')
  const [score, setScore] = useState('0')
  const [ttl, setTtl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(null)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [close])

  const submit = async (): Promise<void> => {
    if (!name) return setError('Key name is required')
    const secs = parseTtlInput(ttl)
    if (secs === undefined) return setError('TTL: use seconds (90) or 90s / 5m / 2h / 1d, or leave empty for no expiry')
    const spec: RedisNewKey =
      type === 'string' ? { type, value }
        : type === 'hash' ? { type, field, value }
          : type === 'list' ? { type, value }
            : type === 'set' ? { type, member: value }
              : { type, member: value, score: score.trim() }
    if (type === 'hash' && !field) return setError('Field name is required')
    if (type === 'zset' && !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^[-+]?inf$/i.test(score.trim())) return setError('Score must be a number')
    setBusy(true)
    setError('')
    try {
      await window.api.redis.create(dsId, db, name, spec, { ttl: secs })
      close(name)
    } catch (e) {
      setError(clean(e))
      setBusy(false)
    }
  }

  const valueLabel = type === 'set' || type === 'zset' ? 'Member' : type === 'string' ? 'Value' : type === 'hash' ? 'Field value' : 'First element'
  return createPortal(
    <div
      ref={ref}
      className={'modal-bg cd-bg' + (closing ? ' closing' : '')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(null)
      }}
    >
      <form
        className="modal cd-modal"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h3>New key in db{db}</h3>
        <label>
          Key
          <input autoFocus spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as NewType)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {type === 'hash' && (
          <label>
            Field
            <input spellCheck={false} value={field} onChange={(e) => setField(e.target.value)} />
          </label>
        )}
        {type === 'zset' && (
          <label>
            Score
            <input spellCheck={false} value={score} onChange={(e) => setScore(e.target.value)} />
          </label>
        )}
        <label>
          {valueLabel}
          {type === 'string' ? (
            <textarea spellCheck={false} rows={4} style={{ height: 'auto' }} value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
          )}
        </label>
        <label>
          TTL (optional)
          <input spellCheck={false} placeholder="no expiry · 90 · 5m · 2h · 1d" value={ttl} onChange={(e) => setTtl(e.target.value)} />
        </label>
        {error && <div className="msg bad pre cd-error">{error}</div>}
        <div className="modal-actions cd-actions">
          <span className="spacer" />
          <button type="button" onClick={() => close(null)}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>,
    document.body
  )
}
