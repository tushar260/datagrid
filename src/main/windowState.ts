import { app, screen, type BrowserWindow, type BrowserWindowConstructorOptions, type Rectangle } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

/** Remembers the main window's size/position/maximized/fullscreen state across restarts (window-state.json in userData). */

interface SavedState {
  bounds: Rectangle
  maximized: boolean
  fullscreen: boolean
}

const DEFAULT_SIZE = { width: 1280, height: 800 }
const MIN = { width: 480, height: 320 }
const file = (): string => join(app.getPath('userData'), 'window-state.json')

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function read(): SavedState | null {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as Partial<SavedState>
    const b = s.bounds
    if (!b || !num(b.x) || !num(b.y) || !num(b.width) || !num(b.height)) return null
    if (b.width < MIN.width || b.height < MIN.height) return null
    return { bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, maximized: s.maximized === true, fullscreen: s.fullscreen === true }
  } catch {
    return null
  }
}

/** True when a decent part of the rectangle (title-bar area included) is on some connected display. */
function visible(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y)
    return w >= 200 && h >= 100 && b.y >= a.y - 20 // keep the title bar reachable
  })
}

export interface InitialWindow {
  options: BrowserWindowConstructorOptions
  maximized: boolean
  fullscreen: boolean
}

export function initialWindowState(): InitialWindow {
  const s = read()
  if (!s || !visible(s.bounds)) return { options: { ...DEFAULT_SIZE }, maximized: false, fullscreen: false }
  return { options: { ...s.bounds }, maximized: s.maximized, fullscreen: s.fullscreen }
}

/** Saves on resize/move (debounced), on maximize/fullscreen changes, and synchronously on close. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    timer = null
    if (win.isDestroyed()) return
    try {
      const maximized = win.isMaximized()
      const fullscreen = win.isFullScreen()
      // while maximized/fullscreen keep the restorable (normal) bounds, not the screen-sized ones
      const bounds = maximized || fullscreen ? win.getNormalBounds() : win.getBounds()
      const state: SavedState = { bounds, maximized, fullscreen }
      writeFileSync(file(), JSON.stringify(state, null, 2))
    } catch {
      /* best effort */
    }
  }
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as 'resize', later)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save()
  })
}
