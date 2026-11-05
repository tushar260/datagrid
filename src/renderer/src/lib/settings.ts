import { useSyncExternalStore } from 'react'

/**
 * App-level settings (appearance, data grid, general). Stored in localStorage under a versioned key, applied to the
 * document as CSS variables / classes, and readable from anywhere via getSettings() / useSettings().
 * Corrupt or out-of-range stored values fall back to the defaults field by field.
 */

// 'datagrip-lite:' is a legacy persisted prefix (pre-DataGrid name): do not rename or users' saved settings / session reset.
const KEY = 'datagrip-lite:settings'
const VERSION = 1

export type UiFont = 'google' | 'macos' | 'linux'
export type MonoFont = 'google' | 'macos' | 'linux'
export type Density = 'compact' | 'normal' | 'comfortable'
export type Motion = 'system' | 'off'
export type NullText = 'null' | 'NULL' | '[null]' | '∅'

export interface Settings {
  uiFont: UiFont
  uiSize: number
  monoFont: MonoFont
  monoSize: number
  density: Density
  pageSize: number
  nullText: NullText
  motion: Motion
  restoreTabs: boolean
  /** keep the explorer's lists (databases, tables, keys...) on disk so the next start needs no refetch */
  cacheObjects: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  uiFont: 'google',
  uiSize: 13,
  monoFont: 'google',
  monoSize: 12,
  density: 'normal',
  pageSize: 100,
  nullText: 'null',
  motion: 'system',
  restoreTabs: true,
  cacheObjects: true
}

export const UI_FONTS: { id: UiFont; label: string; stack: string }[] = [
  { id: 'google', label: 'Google Sans', stack: "'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { id: 'macos', label: 'macOS (San Francisco)', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif" },
  { id: 'linux', label: 'Linux (system UI)', stack: "system-ui, 'Ubuntu', 'Cantarell', 'Noto Sans', 'DejaVu Sans', 'Liberation Sans', sans-serif" }
]
export const MONO_FONTS: { id: MonoFont; label: string; stack: string }[] = [
  { id: 'google', label: 'Google Sans Code', stack: "'Google Sans Code', ui-monospace, Menlo, monospace" },
  { id: 'macos', label: 'macOS (SF Mono / Menlo)', stack: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, Monaco, monospace" },
  { id: 'linux', label: 'Linux (DejaVu / Ubuntu Mono)', stack: "'DejaVu Sans Mono', 'Ubuntu Mono', 'Liberation Mono', 'Noto Sans Mono', monospace" }
]
export const DENSITIES: { id: Density; label: string; padY: number; rowH: number }[] = [
  { id: 'compact', label: 'Compact', padY: 0, rowH: 18 },
  { id: 'normal', label: 'Default', padY: 2, rowH: 22 },
  { id: 'comfortable', label: 'Comfortable', padY: 5, rowH: 30 }
]
export const NULL_TEXTS: NullText[] = ['null', 'NULL', '[null]', '∅']
export const PAGE_SIZE_CHOICES = [50, 100, 500, 1000]
export const UI_SIZE_RANGE = { min: 11, max: 18 }
export const MONO_SIZE_RANGE = { min: 10, max: 20 }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt)
const int = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt

/** Turns anything (parsed JSON, partial objects, junk) into a complete, valid Settings object. */
export function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS
  if (!isObj(raw)) return { ...d }
  return {
    uiFont: pick(raw.uiFont, UI_FONTS.map((f) => f.id), d.uiFont),
    uiSize: int(raw.uiSize, UI_SIZE_RANGE.min, UI_SIZE_RANGE.max, d.uiSize),
    monoFont: pick(raw.monoFont, MONO_FONTS.map((f) => f.id), d.monoFont),
    monoSize: int(raw.monoSize, MONO_SIZE_RANGE.min, MONO_SIZE_RANGE.max, d.monoSize),
    density: pick(raw.density, DENSITIES.map((x) => x.id), d.density),
    pageSize: PAGE_SIZE_CHOICES.includes(raw.pageSize as number) ? (raw.pageSize as number) : d.pageSize,
    nullText: pick(raw.nullText, NULL_TEXTS, d.nullText),
    motion: pick(raw.motion, ['system', 'off'] as const, d.motion),
    restoreTabs: typeof raw.restoreTabs === 'boolean' ? raw.restoreTabs : d.restoreTabs,
    cacheObjects: typeof raw.cacheObjects === 'boolean' ? raw.cacheObjects : d.cacheObjects
  }
}

/** The CSS custom properties the stylesheet reads (see `:root` fallbacks in styles.css). */
export function cssVars(s: Settings): Record<string, string> {
  const dens = DENSITIES.find((x) => x.id === s.density) ?? DENSITIES[1]
  return {
    '--ui-font': (UI_FONTS.find((f) => f.id === s.uiFont) ?? UI_FONTS[0]).stack,
    '--ui-fs': `${s.uiSize}px`,
    '--mono': (MONO_FONTS.find((f) => f.id === s.monoFont) ?? MONO_FONTS[0]).stack,
    '--grid-fs': `${s.monoSize}px`,
    '--editor-fs': `${s.monoSize + 1}px`,
    '--cell-py': `${dens.padY}px`,
    '--row-h': `${dens.rowH}px`
  }
}

/** Writes the settings onto <html>: CSS variables plus the `no-motion` class. */
export function applySettings(s: Settings, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(cssVars(s))) root.style.setProperty(k, v)
  root.classList.toggle('no-motion', s.motion === 'off')
}

/** What Increase / Decrease / Reset Font Size do: both font sizes move together by one px (clamped); reset restores the defaults. */
export function stepFontSizes(s: Settings, dir: 'in' | 'out' | 'reset'): Pick<Settings, 'uiSize' | 'monoSize'> {
  if (dir === 'reset') return { uiSize: DEFAULT_SETTINGS.uiSize, monoSize: DEFAULT_SETTINGS.monoSize }
  const d = dir === 'in' ? 1 : dir === 'out' ? -1 : 0
  return {
    uiSize: Math.min(UI_SIZE_RANGE.max, Math.max(UI_SIZE_RANGE.min, s.uiSize + d)),
    monoSize: Math.min(MONO_SIZE_RANGE.max, Math.max(MONO_SIZE_RANGE.min, s.monoSize + d))
  }
}

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const j: unknown = JSON.parse(raw)
    return isObj(j) && j.v === VERSION ? normalizeSettings(j.settings) : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

let current: Settings = read()
const listeners = new Set<() => void>()

export const getSettings = (): Settings => current

/** Applies a partial change: validated, persisted, applied to the document, and broadcast to subscribers. */
export function updateSettings(patch: Partial<Settings>): Settings {
  current = normalizeSettings({ ...current, ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, settings: current }))
  } catch {
    /* quota / unavailable: ignore */
  }
  applySettings(current)
  listeners.forEach((l) => l())
  return current
}

export const resetSettings = (): Settings => updateSettings({ ...DEFAULT_SETTINGS })

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Apply the stored settings to the document (call once before the first render). */
export function initSettings(): void {
  current = read()
  applySettings(current)
}

export const useSettings = (): Settings => useSyncExternalStore(subscribeSettings, getSettings, getSettings)
