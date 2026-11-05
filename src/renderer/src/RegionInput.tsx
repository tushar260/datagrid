import type React from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AWS_REGIONS } from '../../shared'
import { fuzzyFilter } from './lib/fuzzy'

/** Human names, so "virginia", "frankfurt" or "tokyo" find the region too. */
export const REGION_NAMES: Record<string, string> = {
  'us-east-1': 'US East (N. Virginia)', 'us-east-2': 'US East (Ohio)', 'us-west-1': 'US West (N. California)', 'us-west-2': 'US West (Oregon)',
  'af-south-1': 'Africa (Cape Town)', 'ap-east-1': 'Asia Pacific (Hong Kong)', 'ap-south-1': 'Asia Pacific (Mumbai)', 'ap-south-2': 'Asia Pacific (Hyderabad)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)', 'ap-northeast-2': 'Asia Pacific (Seoul)', 'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-southeast-1': 'Asia Pacific (Singapore)', 'ap-southeast-2': 'Asia Pacific (Sydney)', 'ap-southeast-3': 'Asia Pacific (Jakarta)', 'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ca-central-1': 'Canada (Central)', 'ca-west-1': 'Canada West (Calgary)', 'eu-central-1': 'Europe (Frankfurt)', 'eu-central-2': 'Europe (Zurich)',
  'eu-west-1': 'Europe (Ireland)', 'eu-west-2': 'Europe (London)', 'eu-west-3': 'Europe (Paris)', 'eu-north-1': 'Europe (Stockholm)',
  'eu-south-1': 'Europe (Milan)', 'eu-south-2': 'Europe (Spain)', 'il-central-1': 'Israel (Tel Aviv)', 'me-south-1': 'Middle East (Bahrain)',
  'me-central-1': 'Middle East (UAE)', 'sa-east-1': 'South America (Sao Paulo)', 'us-gov-east-1': 'AWS GovCloud (US-East)', 'us-gov-west-1': 'AWS GovCloud (US-West)',
  'cn-north-1': 'China (Beijing)', 'cn-northwest-1': 'China (Ningxia)'
}

const MAX_ITEMS = 8 // visible rows before the list scrolls

/** Region text box with a fuzzy-matching suggestion list (free text is still allowed, e.g. "local"). */
export default function RegionInput(props: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  regions?: readonly string[]
}): React.JSX.Element {
  const { value, onChange } = props
  const regions = props.regions ?? AWS_REGIONS
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const matches = useMemo(
    () => fuzzyFilter(value.trim(), regions, (r) => (REGION_NAMES[r] ? [r, REGION_NAMES[r]] : [r])),
    [value, regions]
  )
  // the only candidate is exactly what was typed: nothing left to suggest
  const items = matches.length === 1 && matches[0].item === value.trim() ? [] : matches
  const shown = open && items.length > 0
  const sel = Math.min(active, Math.max(0, items.length - 1))

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [sel, shown])

  const accept = (region: string): void => {
    onChange(region)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!shown) {
        setOpen(true)
        return
      }
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((sel + d + items.length) % items.length)
    } else if (shown && (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey))) {
      // Enter picks the suggestion instead of submitting the dialog; Tab picks it and moves on
      if (e.key === 'Enter') e.preventDefault()
      accept(items[sel].item)
    } else if (shown && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // closes the list, not the dialog
      setOpen(false)
    }
  }

  return (
    <div className="suggest region-input">
      <input
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        aria-activedescendant={shown ? `${id}-${sel}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <div
          className="suggest-list"
          id={id}
          role="listbox"
          ref={listRef}
          style={{ maxHeight: MAX_ITEMS * 24 + 8 }}
          onMouseDown={(e) => e.preventDefault()} // keep the input focused (no blur)
        >
          {items.map((m, i) => (
            <div
              key={m.item}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === sel}
              className={'suggest-item' + (i === sel ? ' on' : '')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                accept(m.item)
              }}
            >
              <span className="sg-name">{highlight(m.item, m.positions)}</span>
              <span className="sg-type">{REGION_NAMES[m.item] ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The matched characters in bold. */
function highlight(text: string, positions: number[]): React.ReactNode {
  if (!positions.length) return text
  const hit = new Set(positions)
  return Array.from(text).map((ch, i) => (hit.has(i) ? <b key={i} className="sg-hit">{ch}</b> : ch))
}
