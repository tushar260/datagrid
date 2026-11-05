import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const fake = vi.hoisted(() => ({
  dir: '',
  displays: [] as { workArea: { x: number; y: number; width: number; height: number } }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  screen: { getAllDisplays: () => fake.displays }
}))

import { initialWindowState, trackWindowState } from '../../src/main/windowState'

const file = (): string => join(fake.dir, 'window-state.json')
const display = (x = 0, y = 0, width = 1920, height = 1080) => ({ workArea: { x, y, width, height } })
const save = (o: unknown): void => writeFileSync(file(), typeof o === 'string' ? o : JSON.stringify(o))
const good = { bounds: { x: 100, y: 100, width: 1000, height: 700 }, maximized: false, fullscreen: false }

beforeEach(() => {
  fake.dir = mkdtempSync(join(tmpdir(), 'dgl-ws-'))
  fake.displays = [display()]
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(fake.dir, { recursive: true, force: true })
})

describe('initialWindowState', () => {
  const DEFAULT = { options: { width: 1280, height: 800 }, maximized: false, fullscreen: false }

  it('defaults when there is no file', () => {
    expect(initialWindowState()).toEqual(DEFAULT)
  })

  it.each([
    ['not json', '{nope'],
    ['empty file', ''],
    ['json null', 'null'],
    ['no bounds', {}],
    ['bounds missing y', { bounds: { x: 1, width: 800, height: 600 } }],
    ['string coordinates', { bounds: { x: '1', y: 1, width: 800, height: 600 } }],
    ['NaN-ish (null in JSON)', { bounds: { x: null, y: 1, width: 800, height: 600 } }],
    ['too narrow', { bounds: { x: 0, y: 0, width: 479, height: 600 } }],
    ['too short', { bounds: { x: 0, y: 0, width: 800, height: 319 } }]
  ])('defaults for %s', (_n, content) => {
    save(content)
    expect(initialWindowState()).toEqual(DEFAULT)
  })

  it('restores bounds and flags; non-boolean flags become false', () => {
    save({ ...good, maximized: true, fullscreen: true })
    expect(initialWindowState()).toEqual({ options: good.bounds, maximized: true, fullscreen: true })
    save({ ...good, maximized: 'yes', fullscreen: 1 })
    expect(initialWindowState()).toMatchObject({ maximized: false, fullscreen: false })
  })

  it('only the four bounds fields are returned (extra junk dropped)', () => {
    save({ bounds: { ...good.bounds, junk: 1 } })
    expect(initialWindowState().options).toEqual(good.bounds)
  })

  it('accepts exactly the minimum size', () => {
    save({ bounds: { x: 0, y: 0, width: 480, height: 320 } })
    expect(initialWindowState().options).toEqual({ x: 0, y: 0, width: 480, height: 320 })
  })

  describe('display intersection', () => {
    it('window on a disconnected display (off-screen) -> default size, no position', () => {
      save({ bounds: { x: 5000, y: 0, width: 1000, height: 700 } })
      expect(initialWindowState()).toEqual(DEFAULT)
    })

    it('restores onto a second display when it is connected', () => {
      fake.displays = [display(), display(1920, 0)]
      save({ bounds: { x: 2000, y: 100, width: 1000, height: 700 } })
      expect(initialWindowState().options).toMatchObject({ x: 2000, y: 100 })
    })

    it('negative-origin displays (monitor to the left) work', () => {
      fake.displays = [display(-1920, 0), display(0, 0)]
      save({ bounds: { x: -1800, y: 50, width: 1000, height: 700 } })
      expect(initialWindowState().options).toMatchObject({ x: -1800 })
    })

    it('only a sliver (<200px wide) visible -> default', () => {
      save({ bounds: { x: 1920 - 199, y: 100, width: 1000, height: 700 } })
      expect(initialWindowState()).toEqual(DEFAULT)
      save({ bounds: { x: 1920 - 200, y: 100, width: 1000, height: 700 } })
      expect(initialWindowState().options).toMatchObject({ x: 1720 })
    })

    it('less than 100px of height visible -> default; exactly 100 ok', () => {
      save({ bounds: { x: 0, y: 1080 - 99, width: 1000, height: 700 } })
      expect(initialWindowState()).toEqual(DEFAULT)
      save({ bounds: { x: 0, y: 1080 - 100, width: 1000, height: 700 } })
      expect(initialWindowState().options).toMatchObject({ y: 980 })
    })

    it('title bar must stay reachable: y more than 20px above the work area -> default', () => {
      save({ bounds: { x: 0, y: -21, width: 1000, height: 700 } })
      expect(initialWindowState()).toEqual(DEFAULT)
      save({ bounds: { x: 0, y: -20, width: 1000, height: 700 } })
      expect(initialWindowState().options).toMatchObject({ y: -20 })
    })

    it('work area offset by a menu bar (starts at y=25): tolerance is relative to the work area, not 0', () => {
      fake.displays = [display(0, 25, 1920, 1055)]
      save({ bounds: { x: 0, y: 5, width: 1000, height: 700 } })
      expect(initialWindowState().options).toMatchObject({ y: 5 })
      save({ bounds: { x: 0, y: 4, width: 1000, height: 700 } })
      expect(initialWindowState()).toEqual(DEFAULT)
    })

    it('no displays at all -> default', () => {
      fake.displays = []
      save(good)
      expect(initialWindowState()).toEqual(DEFAULT)
    })
  })
})

describe('trackWindowState', () => {
  type Handler = () => void
  function fakeWindow(over: Partial<{ maximized: boolean; fullscreen: boolean; destroyed: boolean }> = {}) {
    const handlers = new Map<string, Handler[]>()
    const w = {
      maximized: false, fullscreen: false, destroyed: false, ...over,
      bounds: { x: 10, y: 20, width: 900, height: 600 },
      normal: { x: 50, y: 60, width: 800, height: 500 },
      on(ev: string, fn: Handler) {
        handlers.set(ev, [...(handlers.get(ev) ?? []), fn])
        return w
      },
      emit(ev: string) {
        handlers.get(ev)?.forEach((f) => f())
      },
      has: (ev: string) => handlers.has(ev),
      isDestroyed: () => w.destroyed,
      isMaximized: () => w.maximized,
      isFullScreen: () => w.fullscreen,
      getBounds: () => w.bounds,
      getNormalBounds: () => w.normal
    }
    return w
  }
  const saved = (): unknown => JSON.parse(readFileSync(file(), 'utf8'))

  it('subscribes to resize/move/maximize/unmaximize/fullscreen/close', () => {
    const w = fakeWindow()
    trackWindowState(w as never)
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'close']) expect(w.has(ev)).toBe(true)
  })

  it('debounces: many resize events -> exactly one write after 400ms', () => {
    vi.useFakeTimers()
    const w = fakeWindow()
    trackWindowState(w as never)
    for (let i = 0; i < 20; i++) {
      w.emit('resize')
      vi.advanceTimersByTime(100)
    }
    expect(existsSync(file())).toBe(false) // still debouncing
    vi.advanceTimersByTime(400)
    expect(saved()).toEqual({ bounds: w.bounds, maximized: false, fullscreen: false })
  })

  it('maximized / fullscreen windows store the normal (restorable) bounds', () => {
    vi.useFakeTimers()
    const w = fakeWindow({ maximized: true })
    trackWindowState(w as never)
    w.emit('maximize')
    vi.advanceTimersByTime(400)
    expect(saved()).toEqual({ bounds: w.normal, maximized: true, fullscreen: false })
    w.maximized = false
    w.fullscreen = true
    w.emit('enter-full-screen')
    vi.advanceTimersByTime(400)
    expect(saved()).toEqual({ bounds: w.normal, maximized: false, fullscreen: true })
  })

  it('close saves synchronously and cancels the pending debounce', () => {
    vi.useFakeTimers()
    const w = fakeWindow()
    trackWindowState(w as never)
    w.emit('move')
    w.bounds = { x: 1, y: 2, width: 700, height: 500 }
    w.emit('close')
    expect(saved()).toMatchObject({ bounds: w.bounds })
    writeFileSync(file(), 'sentinel')
    vi.advanceTimersByTime(1000)
    expect(readFileSync(file(), 'utf8')).toBe('sentinel') // the pending timer was cleared
  })

  it('does not write for a destroyed window, and swallows write errors', () => {
    const w = fakeWindow({ destroyed: true })
    trackWindowState(w as never)
    w.emit('close')
    expect(existsSync(file())).toBe(false)
    w.destroyed = false
    rmSync(fake.dir, { recursive: true, force: true }) // userData vanished: writeFileSync throws
    expect(() => w.emit('close')).not.toThrow()
  })

  it('round trip: what was saved is what initialWindowState restores', () => {
    const w = fakeWindow({ maximized: true })
    trackWindowState(w as never)
    w.emit('close')
    expect(initialWindowState()).toEqual({ options: w.normal, maximized: true, fullscreen: false })
  })
})
