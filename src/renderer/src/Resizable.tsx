import type React from 'react'
import { useRef, useState } from 'react'

/** Clamp `n` into [lo, hi]; when the range is inverted `lo` wins. */
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, Math.max(lo, hi)))

export interface Size {
  w: number
  h: number
}

/** Popup margin kept free around the viewport edges. */
export const EDGE_MARGIN = 8

/**
 * Clamp a popup size to [min, viewport - 2*margin]; when `left`/`top` are given, also keep the
 * popup's far edges inside the viewport (so dragging never pushes it off-screen).
 */
export function clampSize(s: Size, min: Size, vw: number, vh: number, left?: number, top?: number): Size {
  const maxW = vw - 2 * EDGE_MARGIN - (left === undefined ? 0 : Math.max(0, left - EDGE_MARGIN))
  const maxH = vh - 2 * EDGE_MARGIN - (top === undefined ? 0 : Math.max(0, top - EDGE_MARGIN))
  return { w: clamp(Math.round(s.w), min.w, maxW), h: clamp(Math.round(s.h), min.h, maxH) }
}

/** Top-left that keeps a w x h popup fully inside the viewport (preferred position x,y). */
export const placeInViewport = (x: number, y: number, size: Size, vw: number, vh: number): { left: number; top: number } => ({
  left: clamp(x, EDGE_MARGIN, vw - EDGE_MARGIN - size.w),
  top: clamp(y, EDGE_MARGIN, vh - EDGE_MARGIN - size.h)
})

export function readStored<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const v: unknown = JSON.parse(raw)
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function writeStored(key: string, value: unknown | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: size just isn't remembered */
  }
}

export const isSize = (v: unknown): v is Size =>
  !!v && typeof v === 'object' && Number.isFinite((v as Size).w) && Number.isFinite((v as Size).h)
export const isRatio = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1

/**
 * Generic drag handle driven by pointer events + setPointerCapture. Reports the total pointer
 * movement since pointer-down; double-click calls `onReset`.
 */
export function DragHandle({
  className,
  cursor,
  title,
  onStart,
  onDrag,
  onEnd,
  onReset,
  children
}: {
  className?: string
  cursor: React.CSSProperties['cursor']
  title?: string
  onStart?: () => void
  onDrag: (dx: number, dy: number) => void
  onEnd?: () => void
  onReset?: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const origin = useRef<{ x: number; y: number } | null>(null)
  const finish = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!origin.current) return
    origin.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    onEnd?.()
  }
  return (
    <div
      className={'drag-handle ' + (className ?? '')}
      style={{ cursor }}
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        origin.current = { x: e.clientX, y: e.clientY }
        onStart?.()
      }}
      onPointerMove={(e) => {
        if (origin.current) onDrag(e.clientX - origin.current.x, e.clientY - origin.current.y)
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onReset?.()
      }}
    >
      {children}
    </div>
  )
}

/** Pure: new share of element A after dragging the divider by `dx` (A and B measured at drag start). */
export const splitRatio = (wa: number, wb: number, dx: number, lo = 0.15, hi = 0.85): number =>
  clamp(wa + wb > 0 ? (wa + dx) / (wa + wb) : 0.5, lo, hi)

/**
 * Horizontal split between two sibling fields A and B (attach `aRef`/`bRef`, style each with
 * `flex: ${ratio} 1 0` / `${1 - ratio} 1 0`, render `divider` between them). The ratio persists in
 * localStorage under `key`; double-click on the divider restores `def`.
 */
export function useRatioSplit(
  key: string,
  def: number
): {
  ratio: number
  aRef: React.RefObject<HTMLDivElement | null>
  bRef: React.RefObject<HTMLDivElement | null>
  divider: React.JSX.Element
} {
  const [ratio, setRatio] = useState(() => readStored(key, def, isRatio))
  const cur = useRef(ratio)
  const start = useRef({ wa: 0, wb: 0 })
  const aRef = useRef<HTMLDivElement>(null)
  const bRef = useRef<HTMLDivElement>(null)
  const divider = (
    <DragHandle
      className="split-v"
      cursor="ew-resize"
      title="Drag to resize · double-click to reset"
      onStart={() => {
        start.current = { wa: aRef.current?.offsetWidth ?? 0, wb: bRef.current?.offsetWidth ?? 0 }
      }}
      onDrag={(dx) => {
        const r = splitRatio(start.current.wa, start.current.wb, dx)
        cur.current = r
        setRatio(r)
      }}
      onEnd={() => writeStored(key, cur.current)}
      onReset={() => {
        cur.current = def
        setRatio(def)
        writeStored(key, null)
      }}
    />
  )
  return { ratio, aRef, bRef, divider }
}
