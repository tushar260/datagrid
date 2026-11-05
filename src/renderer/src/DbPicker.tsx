import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from './icons'
import { matchRule, type PatternRule, type RuleMode } from '../../shared'
import { DragHandle, clampSize, isSize, placeInViewport, readStored, writeStored, type Size } from './Resizable'

const PICKER_MIN: Size = { w: 280, h: 220 }
const PICKER_DEFAULT: Size = { w: 320, h: 400 }

const same = (a: Set<string>, b: string[]): boolean => a.size === b.length && b.every((x) => a.has(x))

/** Popup with a checklist of items (databases or schemas); ticked ones are shown in the explorer. */
export default function ListPicker({
  x, y, icon, placeholder, load, selected, defaultOf, onClose, onChange, rule, persistRule
}: {
  x: number
  y: number
  icon: IconName
  placeholder: string
  load: () => Promise<string[]>
  /** saved selection, or null for the default */
  selected: string[] | null
  defaultOf: (all: string[]) => string[]
  onClose: () => void
  /** null = back to the default selection */
  onChange: (list: string[] | null, rule?: PatternRule | null) => void
  /** saved pattern rule (takes precedence over `selected`) */
  rule?: PatternRule | null
  /** when true, "Select matching" saves the pattern itself so new matching items follow it */
  persistRule?: boolean
}): React.JSX.Element {
  const [all, setAll] = useState<string[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<RuleMode>(rule?.mode ?? 'starts')
  const [pat, setPat] = useState(rule?.pattern ?? '')
  const [activeRule, setActiveRule] = useState<PatternRule | null>(rule ?? null)

  useEffect(() => {
    load()
      .then((a) => {
        setAll(a)
        setChecked(
          new Set(
            rule ? a.filter((n) => matchRule(rule, n)) : selected ? a.filter((n) => selected.includes(n)) : defaultOf(a)
          )
        )
      })
      .catch((e: Error) => setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const shown = useMemo(() => (all ?? []).filter((n) => n.toLowerCase().includes(q.toLowerCase())), [all, q])
  const def = all ? defaultOf(all) : []
  const hasDefaultChoice = !!all && def.length !== all.length

  const commit = (next: Set<string>, r: PatternRule | null = null): void => {
    setChecked(next)
    setActiveRule(r)
    onChange(all && !r && same(next, def) ? null : [...next], r)
  }
  const regexBad =
    mode === 'regex' &&
    pat !== '' &&
    (() => {
      try {
        new RegExp(pat)
        return false
      } catch {
        return true
      }
    })()
  const applyPattern = (): void => {
    if (!all || regexBad) return
    const r: PatternRule = { mode, pattern: pat }
    commit(new Set(all.filter((n) => matchRule(r, n))), persistRule && pat ? r : null)
  }
  const toggle = (n: string): void => {
    const next = new Set(checked)
    next.has(n) ? next.delete(n) : next.add(n)
    commit(next)
  }
  // resizable popup: one remembered size per kind (databases / schemas / tables, known from the icon)
  const sizeKey = `datagrip-lite:picker-size:${icon}`
  const [size, setSize] = useState<Size>(() =>
    clampSize(readStored(sizeKey, PICKER_DEFAULT, isSize), PICKER_MIN, window.innerWidth, window.innerHeight)
  )
  const [pos] = useState(() => placeInViewport(x, y, size, window.innerWidth, window.innerHeight))
  const sizeRef = useRef(size)
  const dragStart = useRef(size)
  const fit = (s: Size): Size => clampSize(s, PICKER_MIN, window.innerWidth, window.innerHeight, pos.left, pos.top)
  const begin = (): void => {
    dragStart.current = sizeRef.current
  }
  const resize = (dx: number, dy: number, axis: 'x' | 'y' | 'xy'): void => {
    const s = fit({
      w: dragStart.current.w + (axis !== 'y' ? dx : 0),
      h: dragStart.current.h + (axis !== 'x' ? dy : 0)
    })
    sizeRef.current = s
    setSize(s)
  }
  const endResize = (): void => writeStored(sizeKey, sizeRef.current)
  const resetSize = (): void => {
    const s = fit(PICKER_DEFAULT)
    sizeRef.current = s
    setSize(s)
    writeStored(sizeKey, null)
  }
  const cur = fit(size)

  return (
    <div className="picker-bg" onMouseDown={onClose}>
      <div className="picker" style={{ left: pos.left, top: pos.top, width: cur.w, height: cur.h }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <input autoFocus placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="picker-pattern">
          <select value={mode} onChange={(e) => setMode(e.target.value as RuleMode)} title="Pattern type">
            <option value="starts">starts with</option>
            <option value="contains">contains</option>
            <option value="ends">ends with</option>
            <option value="regex">regex</option>
          </select>
          <input
            className={regexBad ? 'bad' : ''}
            placeholder={mode === 'regex' ? '^scrut_[0-9]+$' : 'scrut_'}
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyPattern()}
          />
          <button type="button" disabled={!all || !pat || !!regexBad} onClick={applyPattern} title="Tick exactly the items matching this pattern and untick the rest">
            Select matching
          </button>
        </div>
        {activeRule && (
          <div className="picker-rule">
            Rule saved: {activeRule.mode === 'regex' ? 'matches' : activeRule.mode === 'starts' ? 'starts with' : activeRule.mode === 'ends' ? 'ends with' : 'contains'} “{activeRule.pattern}” — new matching items appear automatically
          </div>
        )}
        <div className="picker-actions">
          <span>
            {checked.size} of {all?.length ?? '…'} shown
          </span>
          <span className="spacer" />
          <a onClick={() => all && commit(new Set(all))}>All</a>
          <a onClick={() => commit(new Set())}>None</a>
          {hasDefaultChoice && <a onClick={() => commit(new Set(def))}>Default</a>}
        </div>
        <div className="picker-list">
          {err && <div className="msg bad">{err}</div>}
          {!all && !err && <div className="tree-empty" style={{ padding: 10 }}>Loading…</div>}
          {shown.map((n) => (
            <label key={n} className="picker-row">
              <input type="checkbox" checked={checked.has(n)} onChange={() => toggle(n)} />
              <Icon name={icon} />
              <span title={n}>{n}</span>
            </label>
          ))}
          {all && shown.length === 0 && <div className="tree-empty" style={{ padding: 10 }}>No matches</div>}
        </div>
        <DragHandle className="picker-edge-r" cursor="ew-resize" onStart={begin} onDrag={(dx, dy) => resize(dx, dy, 'x')} onEnd={endResize} onReset={resetSize} />
        <DragHandle className="picker-edge-b" cursor="ns-resize" onStart={begin} onDrag={(dx, dy) => resize(dx, dy, 'y')} onEnd={endResize} onReset={resetSize} />
        <DragHandle
          className="picker-grip"
          cursor="nwse-resize"
          title="Drag to resize · double-click to reset"
          onStart={begin}
          onDrag={(dx, dy) => resize(dx, dy, 'xy')}
          onEnd={endResize}
          onReset={resetSize}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M11 3L3 11M11 7L7 11M11 11L11 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          </svg>
        </DragHandle>
      </div>
    </div>
  )
}
