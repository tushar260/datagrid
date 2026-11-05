import { readFileSync, writeFileSync } from 'fs'

/** Browser-style zoom: pure helpers (no Electron import, so they are unit-testable) + tiny persistence. */

/** Chrome's zoom steps, in percent. */
export const ZOOM_STEPS: readonly number[] = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]
export const ZOOM_DEFAULT = 100
export const ZOOM_MIN = ZOOM_STEPS[0] // === ZOOM_MIN_PERCENT (shared with the renderer, asserted in tests)
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1] // === ZOOM_MAX_PERCENT

/** Clamps to [ZOOM_MIN, ZOOM_MAX] and rounds; anything that is not a finite number becomes 100. */
export function clampPercent(percent: number): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return ZOOM_DEFAULT
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent)))
}

/** The value for webContents.setZoomFactor (e.g. 110 -> 1.1). */
export function percentToFactor(percent: number): number {
  return clampPercent(percent) / 100
}

/** Inverse of percentToFactor (1.1 -> 110); used for the 'zoom-changed' wheel event / reading the current factor back. */
export function factorToPercent(factor: number): number {
  return clampPercent(factor * 100)
}

/**
 * The next step when zooming in / out. Arbitrary current values snap to the neighbouring step in that
 * direction (107 -> in: 110, out: 100); at the ends the value stays put.
 */
export function nextZoom(percent: number, dir: 'in' | 'out'): number {
  const cur = clampPercent(percent)
  if (dir === 'in') return ZOOM_STEPS.find((s) => s > cur) ?? ZOOM_MAX
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < cur) return ZOOM_STEPS[i]
  return ZOOM_MIN
}

/** What the menu items / the on-screen zoom controls do: one step in/out, or back to 100. Junk `dir` values leave the zoom unchanged. */
export function stepZoom(percent: number, dir: 'in' | 'out' | 'reset'): number {
  if (dir === 'reset') return ZOOM_DEFAULT
  if (dir === 'in' || dir === 'out') return nextZoom(percent, dir)
  return clampPercent(percent)
}

/** Reads the persisted zoom percent (`{ "percent": 110 }`); null when missing/corrupt. */
export function readZoom(file: string): number | null {
  try {
    const p = (JSON.parse(readFileSync(file, 'utf8')) as { percent?: unknown }).percent
    return typeof p === 'number' && Number.isFinite(p) ? clampPercent(p) : null
  } catch {
    return null
  }
}

export function writeZoom(file: string, percent: number): void {
  try {
    writeFileSync(file, JSON.stringify({ percent: clampPercent(percent) }))
  } catch {
    /* best effort */
  }
}
