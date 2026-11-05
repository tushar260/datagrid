import type React from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalClose } from './lib/useModalClose'
import { buildAddColumn, buildCreateTable, validateNewTable, type NewColumn } from '../../shared'

export type CreateReq =
  | { kind: 'database'; dsId: string }
  | { kind: 'schema'; dsId: string; database: string }
  | { kind: 'table'; dsId: string; database: string; schema: string }
  | { kind: 'column'; dsId: string; database: string; schema: string; table: string }

const PG_TYPES = ['integer', 'bigint', 'text', 'varchar(255)', 'boolean', 'timestamp', 'timestamptz', 'date', 'numeric', 'uuid', 'jsonb', 'serial', 'bigserial']

const clean = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const newCol = (over?: Partial<NewColumn>): NewColumn => ({ name: '', type: 'text', nullable: true, isPk: false, default: '', ...over })

/** Modal for creating a database / schema / table / column. onClose(true) after a successful create. */
export default function CreateDialog({ req, onClose: onCloseProp }: { req: CreateReq; onClose: (created: boolean, name?: string) => void }): React.JSX.Element {
  const { ref: bgRef, closing, close: onClose } = useModalClose(onCloseProp)
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [roles, setRoles] = useState<string[]>([])
  const [cols, setCols] = useState<NewColumn[]>(() => (req.kind === 'table' ? [newCol({ name: 'id', type: 'serial', nullable: false, isPk: true })] : []))
  const [col, setCol] = useState<NewColumn>(() => newCol())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(false)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  useEffect(() => {
    if (req.kind === 'database' || req.kind === 'schema') {
      window.api.roles(req.dsId).then((r: string[]) => setRoles(r), () => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const wide = req.kind === 'table'
  const title =
    req.kind === 'database' ? 'New Database'
    : req.kind === 'schema' ? `New Schema in ${req.database}`
    : req.kind === 'table' ? `New Table in ${req.schema}`
    : `New Column in ${req.schema}.${req.table}`

  const validation = (): string | null => {
    if (req.kind === 'database' || req.kind === 'schema') return name.trim() ? null : 'Name is required'
    if (req.kind === 'table') return validateNewTable(name, cols)
    return validateNewTable(req.table, [col])
  }
  const check = validation()
  const preview =
    req.kind === 'table' ? (check ? '-- ' + check : buildCreateTable(req.schema, name, cols))
    : req.kind === 'column' ? (check ? '-- ' + check : buildAddColumn(req.schema, req.table, col))
    : ''

  const submit = async (): Promise<void> => {
    if (busy) return
    if (check) {
      setError(check)
      return
    }
    setBusy(true)
    setError('')
    try {
      if (req.kind === 'database') await window.api.createDatabase(req.dsId, name.trim(), owner.trim() || undefined)
      else if (req.kind === 'schema') await window.api.createSchema(req.dsId, req.database, name.trim(), owner.trim() || undefined)
      else if (req.kind === 'table') await window.api.createTable(req.dsId, req.database, req.schema, name.trim(), cols)
      else await window.api.addColumn(req.dsId, req.database, req.schema, req.table, col)
      onClose(true, name.trim())
    } catch (e) {
      setError(clean(e))
      setBusy(false)
    }
  }

  const setC = (i: number, patch: Partial<NewColumn>): void => setCols((l) => l.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  const colFields = (c: NewColumn, set: (p: Partial<NewColumn>) => void, focusName: boolean, withPk = true): React.JSX.Element => (
    <>
      <input placeholder="name" value={c.name} autoFocus={focusName} onChange={(e) => set({ name: e.target.value })} />
      <input placeholder="type" list="dgl-pg-types" value={c.type} onChange={(e) => set({ type: e.target.value })} />
      <input
        type="checkbox"
        title="Nullable"
        checked={!c.isPk && c.nullable}
        disabled={c.isPk}
        onChange={(e) => set({ nullable: e.target.checked })}
      />
      {withPk && (
        <input
          type="checkbox"
          title="Primary key"
          checked={c.isPk}
          onChange={(e) => set({ isPk: e.target.checked, nullable: e.target.checked ? false : c.nullable })}
        />
      )}
      <input placeholder="default (optional)" value={c.default ?? ''} onChange={(e) => set({ default: e.target.value })} />
    </>
  )

  // Portal to <body>: the dialog is mounted from the Explorer (inside the sidebar), so without this the
  // sticky grid headers / positioned content of `.main` (later in the DOM) would paint over it.
  return createPortal(
    <div
      ref={bgRef}
      className={'modal-bg cd-bg' + (closing ? ' closing' : '')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(false)
      }}
    >
      <form
        className={`modal cd-modal ${wide ? 'cd-table' : req.kind === 'column' ? 'cd-column' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h3>{title}</h3>
        {(req.kind === 'database' || req.kind === 'schema' || req.kind === 'table') && (
          <label>
            Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        {(req.kind === 'database' || req.kind === 'schema') && (
          <label>
            {req.kind === 'database' ? 'Owner (optional)' : 'Authorization / owner (optional)'}
            <input list="dgl-roles" value={owner} onChange={(e) => setOwner(e.target.value)} />
            <datalist id="dgl-roles">
              {roles.map((r) => <option key={r} value={r} />)}
            </datalist>
          </label>
        )}
        {req.kind === 'table' && (
          <>
            <div className="cd-cols">
              <div className="cd-row cd-head">
                <span>Column</span><span>Type</span><span className="cd-c" title="Nullable">Null</span><span className="cd-c" title="Primary key">PK</span><span>Default</span><span />
              </div>
              {cols.map((c, i) => (
                <div className="cd-row" key={i}>
                  {colFields(c, (p) => setC(i, p), false)}
                  <button type="button" className="cd-x" title="Remove column" onClick={() => setCols((l) => l.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>
            <div>
              <button type="button" onClick={() => setCols((l) => [...l, newCol()])}>+ Add Column</button>
            </div>
          </>
        )}
        {req.kind === 'column' && (
          <>
            <div className="cd-cols">
              <div className="cd-row cd-head">
                <span>Column</span><span>Type</span><span className="cd-c" title="Nullable">Null</span><span>Default</span>
              </div>
              <div className="cd-row">
                {colFields(col, (p) => setCol((c) => ({ ...c, ...p })), true, false)}
              </div>
            </div>
          </>
        )}
        {(req.kind === 'table' || req.kind === 'column') && (
          <>
            <datalist id="dgl-pg-types">
              {PG_TYPES.map((t) => <option key={t} value={t} />)}
            </datalist>
            <label>
              DDL preview
              <textarea className="ddl-preview cd-ddl" readOnly spellCheck={false} rows={Math.min(8, preview.split('\n').length + 1)} value={preview} />
            </label>
          </>
        )}
        {error && <div className="msg bad pre cd-error">{error}</div>}
        <div className="modal-actions cd-actions">
          <span className="spacer" />
          <button type="button" onClick={() => onClose(false)}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : req.kind === 'column' ? 'Add' : 'Create'}</button>
        </div>
      </form>
    </div>,
    document.body
  )
}
