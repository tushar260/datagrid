import type React from 'react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Column } from '../../shared'
import { candidates, ORDER_KEYWORDS, WHERE_KEYWORDS, wordAt, type Ctx, type Item } from './lib/suggest'

/** IDE-style completion input for the WHERE / ORDER BY boxes: suggests column names (+ a few keywords). */

const MAX_ITEMS = 10 // visible rows before the list scrolls (all matches are kept in the list)

export default function SuggestInput(props: {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  placeholder?: string
  columns: Column[]
  mode: 'where' | 'order'
  /** replaces the built-in keyword list (DynamoDB PartiQL) */
  keywords?: string[]
  /** how an inserted column name is written (default: Postgres quoting) */
  quote?: (name: string) => string
}): React.JSX.Element {
  const { value, onChange, columns, mode } = props
  const keywords = props.keywords ?? (mode === 'where' ? WHERE_KEYWORDS : ORDER_KEYWORDS)
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const caretRef = useRef<number | null>(null)
  const reopenRef = useRef(false) // after inserting a function call, suggest attributes for its first argument
  const id = useId()

  const items = useMemo(() => (ctx ? candidates(ctx, columns, keywords, props.quote) : []), [ctx, columns, keywords, props.quote])
  const open = items.length > 0
  const sel = Math.min(active, Math.max(0, items.length - 1))

  // put the caret right after inserted text once the controlled value has been re-rendered
  useLayoutEffect(() => {
    if (caretRef.current === null) return
    inputRef.current?.setSelectionRange(caretRef.current, caretRef.current)
    caretRef.current = null
    if (reopenRef.current && inputRef.current) {
      reopenRef.current = false
      refresh(inputRef.current)
    }
  }, [value])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel, open])

  const refresh = (el: HTMLInputElement, forced = false): void => {
    const w = wordAt(el.value, el.selectionStart ?? el.value.length)
    const next = w ? { ...w, forced } : null
    // typing ≥1 char (or `alias.`) opens; an empty word only opens when forced
    setCtx(next && (next.word || next.alias || next.fnArg || forced) ? next : null)
    setActive(0)
  }
  const close = (): void => setCtx(null)

  const accept = (item: Item): void => {
    if (!ctx) return
    const next = value.slice(0, ctx.start) + item.insert + value.slice(ctx.end)
    caretRef.current = ctx.start + item.insert.length - (item.caretBack ?? 0)
    reopenRef.current = !!item.caretBack
    onChange(next)
    close()
    inputRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === ' ') {
      e.preventDefault()
      refresh(e.currentTarget, true)
      return
    }
    if (open && !e.metaKey && !e.ctrlKey && !e.altKey) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActive((sel + 1) % items.length)
          return
        case 'ArrowUp':
          e.preventDefault()
          setActive((sel - 1 + items.length) % items.length)
          return
        case 'Enter':
        case 'Tab':
          if (e.shiftKey && e.key === 'Tab') break
          e.preventDefault() // accept the suggestion; Enter must not apply the filter
          accept(items[sel])
          return
        case 'Escape':
          e.preventDefault()
          e.stopPropagation()
          close()
          return
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'Home':
        case 'End':
          close()
          break
      }
    }
    props.onKeyDown?.(e)
  }

  return (
    <div className="suggest">
      <input
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${sel}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          refresh(e.target)
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
        onClick={close}
      />
      {open && (
        <div
          className="suggest-list"
          id={id}
          role="listbox"
          ref={listRef}
          style={{ maxHeight: MAX_ITEMS * 24 + 8 }}
          onMouseDown={(e) => e.preventDefault()} // keep the input focused (no blur)
        >
          {items.map((it, i) => (
            <div
              key={it.kind + it.label}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === sel}
              className={'suggest-item' + (i === sel ? ' on' : '') + (it.kind === 'kw' ? ' kw' : '')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                accept(it)
              }}
            >
              <span className="sg-name">{it.label}</span>
              {it.col?.isPk && <span className="sg-pk" title="Primary key">PK</span>}
              <span className="sg-type">{it.col ? it.col.type : 'keyword'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
