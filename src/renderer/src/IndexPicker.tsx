import type React from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DynamoIndexInfo } from '../../shared'
import { fuzzyFilter } from './lib/fuzzy'

interface Entry {
  /** '' = the table itself */
  value: string
  group: 'Table' | 'Index'
  name: string
  tag: string
  keys: string
}

const keySummary = (keys: { name: string; keyType: string }[]): string =>
  keys.map((k) => `${k.keyType === 'HASH' ? 'PK' : 'SK'} ${k.name}`).join(' · ')

/** "Select a table or index": the table itself or one of its GSIs / LSIs, with a fuzzy search box. */
export default function IndexPicker(props: {
  table: string
  tableKeys?: { name: string; keyType: string }[]
  indexes: DynamoIndexInfo[]
  value: string
  onChange: (index: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const { table, indexes, value, onChange } = props
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [{ value: '', group: 'Table', name: table, tag: 'Table', keys: keySummary(props.tableKeys ?? []) }]
    for (const x of indexes) out.push({ value: x.name, group: 'Index', name: x.name, tag: x.kind, keys: keySummary(x.keys) })
    // a saved selection whose index is not known (yet): keep it visible so the choice is not lost
    if (value && !indexes.some((x) => x.name === value)) out.push({ value, group: 'Index', name: value, tag: 'Index', keys: '' })
    return out
  }, [table, indexes, value, props.tableKeys])

  const shown = useMemo(
    () => fuzzyFilter(q.trim(), entries, (e) => [e.name, e.keys, e.tag]).map((m) => m.item),
    [q, entries]
  )
  const sel = Math.min(active, Math.max(0, shown.length - 1))
  const current = entries.find((e) => e.value === value) ?? entries[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [sel, open])

  const openList = (): void => {
    if (props.disabled) return
    setQ('')
    setActive(Math.max(0, entries.findIndex((e) => e.value === value)))
    setOpen(true)
  }
  const accept = (e: Entry): void => {
    setOpen(false)
    onChange(e.value)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (shown.length) setActive((sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[sel]) accept(shown[sel])
    }
  }

  // group headings between runs of the same group (the list is already ordered Table, then Index)
  let lastGroup = ''
  return (
    <div className="idx-pick" ref={rootRef}>
      <button
        type="button"
        className="idx-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Table or index"
        disabled={props.disabled}
        title="Read the table itself, or one of its secondary indexes (GSI / LSI)"
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <span className="idx-kind">{current.group}</span>
        <span className="idx-cur">{current.name}</span>
        {current.group === 'Index' && <span className="idx-tag">{current.tag}</span>}
        <span className="idx-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="idx-pop" onKeyDown={onKeyDown}>
          <input
            autoFocus
            className="idx-search"
            role="combobox"
            aria-expanded
            aria-controls={id}
            aria-activedescendant={shown.length ? `${id}-${sel}` : undefined}
            aria-label="Search tables and indexes"
            placeholder="Find tables and indexes"
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
          />
          <div className="idx-list" id={id} role="listbox" ref={listRef}>
            {shown.length === 0 && <div className="idx-empty">No matches</div>}
            {shown.map((e, i) => {
              const head = e.group !== lastGroup ? e.group : ''
              lastGroup = e.group
              return (
                <div key={e.value || '\0table'}>
                  {head && <div className="idx-group">{head}</div>}
                  <div
                    id={`${id}-${i}`}
                    role="option"
                    aria-selected={i === sel}
                    className={'idx-item' + (i === sel ? ' on' : '') + (e.value === value ? ' cur' : '')}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => accept(e)}
                  >
                    <span className="idx-check" aria-hidden>{e.value === value ? '✓' : ''}</span>
                    <span className="idx-name">{e.name}</span>
                    {e.group === 'Index' && <span className="idx-tag">{e.tag}</span>}
                    <span className="idx-keys">{e.keys}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
