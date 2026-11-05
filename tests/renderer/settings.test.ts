// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('../../src/renderer/src/lib/settings')
const KEY = 'datagrip-lite:settings'

/** settings.ts reads localStorage at import time, so each test imports a fresh copy. */
async function load(stored?: unknown): Promise<Mod> {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  document.documentElement.className = ''
  if (stored !== undefined) localStorage.setItem(KEY, typeof stored === 'string' ? stored : JSON.stringify(stored))
  vi.resetModules()
  return import('../../src/renderer/src/lib/settings')
}
const saved = (): any => JSON.parse(localStorage.getItem(KEY)!)

beforeEach(() => localStorage.clear())

describe('normalizeSettings', () => {
  it('returns the defaults for junk input', async () => {
    const m = await load()
    for (const x of [undefined, null, 5, 'x', [], true]) expect(m.normalizeSettings(x)).toEqual(m.DEFAULT_SETTINGS)
  })

  it('keeps valid values and replaces invalid ones field by field', async () => {
    const m = await load()
    const s = m.normalizeSettings({
      uiFont: 'linux', uiSize: 15.4, monoFont: 'nope', monoSize: 99, density: 'compact', pageSize: 77, nullText: '∅', motion: 'off', restoreTabs: 'yes'
    })
    expect(s).toEqual({ ...m.DEFAULT_SETTINGS, uiFont: 'linux', uiSize: 15, monoSize: 20, density: 'compact', nullText: '∅', motion: 'off' })
  })

  it('clamps sizes to their ranges and rejects non-finite numbers', async () => {
    const m = await load()
    expect(m.normalizeSettings({ uiSize: 1 }).uiSize).toBe(11)
    expect(m.normalizeSettings({ uiSize: 100 }).uiSize).toBe(18)
    expect(m.normalizeSettings({ monoSize: 1 }).monoSize).toBe(10)
    expect(m.normalizeSettings({ uiSize: NaN }).uiSize).toBe(13)
    expect(m.normalizeSettings({ monoSize: Infinity }).monoSize).toBe(12)
    expect(m.normalizeSettings({ uiSize: '14' }).uiSize).toBe(13)
  })

  it('only accepts the offered page sizes', async () => {
    const m = await load()
    for (const n of m.PAGE_SIZE_CHOICES) expect(m.normalizeSettings({ pageSize: n }).pageSize).toBe(n)
    expect(m.normalizeSettings({ pageSize: 123 }).pageSize).toBe(100)
  })
})

describe('cssVars / applySettings', () => {
  it('maps every font choice to a stack with a generic fallback', async () => {
    const m = await load()
    for (const f of m.UI_FONTS) {
      const v = m.cssVars({ ...m.DEFAULT_SETTINGS, uiFont: f.id })['--ui-font']
      expect(v).toBe(f.stack)
      expect(v).toMatch(/sans-serif$/)
    }
    for (const f of m.MONO_FONTS) {
      const v = m.cssVars({ ...m.DEFAULT_SETTINGS, monoFont: f.id })['--mono']
      expect(v).toBe(f.stack)
      expect(v).toMatch(/monospace$/)
    }
    expect(m.UI_FONTS.map((f) => f.id)).toEqual(['google', 'macos', 'linux'])
    expect(m.UI_FONTS[0].stack).toContain('Google Sans')
    expect(m.UI_FONTS[1].stack).toContain('-apple-system')
    expect(m.UI_FONTS[2].stack).toContain('Ubuntu')
  })

  it('derives sizes and row density', async () => {
    const m = await load()
    const v = m.cssVars({ ...m.DEFAULT_SETTINGS, uiSize: 15, monoSize: 14, density: 'comfortable' })
    expect(v['--ui-fs']).toBe('15px')
    expect(v['--grid-fs']).toBe('14px')
    expect(v['--editor-fs']).toBe('15px')
    expect(v['--cell-py']).toBe('5px')
    expect(v['--row-h']).toBe('30px')
    expect(m.cssVars({ ...m.DEFAULT_SETTINGS, density: 'compact' })['--row-h']).toBe('18px')
    expect(m.cssVars(m.DEFAULT_SETTINGS)['--row-h']).toBe('22px')
  })

  it('writes the variables onto the root element and toggles the no-motion class', async () => {
    const m = await load()
    const el = document.createElement('div')
    m.applySettings({ ...m.DEFAULT_SETTINGS, uiSize: 16, motion: 'off' }, el)
    expect(el.style.getPropertyValue('--ui-fs')).toBe('16px')
    expect(el.classList.contains('no-motion')).toBe(true)
    m.applySettings({ ...m.DEFAULT_SETTINGS, motion: 'system' }, el)
    expect(el.classList.contains('no-motion')).toBe(false)
  })
})

describe('persistence', () => {
  it('starts with the defaults when nothing / corrupt / old-version data is stored', async () => {
    expect((await load()).getSettings()).toEqual((await load()).DEFAULT_SETTINGS)
    let m = await load('{not json')
    expect(m.getSettings()).toEqual(m.DEFAULT_SETTINGS)
    m = await load({ v: 99, settings: { uiSize: 17 } })
    expect(m.getSettings().uiSize).toBe(13)
    m = await load({ v: 1, settings: 'junk' })
    expect(m.getSettings()).toEqual(m.DEFAULT_SETTINGS)
  })

  it('loads stored settings and applies them on initSettings', async () => {
    const m = await load({ v: 1, settings: { uiFont: 'macos', uiSize: 16, motion: 'off', restoreTabs: false } })
    expect(m.getSettings()).toMatchObject({ uiFont: 'macos', uiSize: 16, restoreTabs: false })
    m.initSettings()
    expect(document.documentElement.style.getPropertyValue('--ui-fs')).toBe('16px')
    expect(document.documentElement.style.getPropertyValue('--ui-font')).toContain('-apple-system')
    expect(document.documentElement.classList.contains('no-motion')).toBe(true)
  })

  it('updateSettings validates, saves, applies and notifies', async () => {
    const m = await load()
    const spy = vi.fn()
    const off = m.subscribeSettings(spy)
    const s = m.updateSettings({ monoFont: 'linux', monoSize: 14, density: 'compact' })
    expect(s).toMatchObject({ monoFont: 'linux', monoSize: 14, density: 'compact' })
    expect(m.getSettings()).toBe(s)
    expect(saved()).toEqual({ v: 1, settings: s })
    expect(document.documentElement.style.getPropertyValue('--mono')).toContain('DejaVu')
    expect(document.documentElement.style.getPropertyValue('--row-h')).toBe('18px')
    expect(spy).toHaveBeenCalledTimes(1)
    m.updateSettings({ uiSize: 9999 as number })
    expect(m.getSettings().uiSize).toBe(18)
    off()
    m.updateSettings({ uiSize: 12 })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('survives a reload', async () => {
    let m = await load()
    m.updateSettings({ uiFont: 'linux', nullText: 'NULL', pageSize: 500 })
    vi.resetModules()
    m = await import('../../src/renderer/src/lib/settings')
    expect(m.getSettings()).toMatchObject({ uiFont: 'linux', nullText: 'NULL', pageSize: 500 })
  })

  it('resetSettings restores the defaults', async () => {
    const m = await load()
    m.updateSettings({ uiFont: 'linux', uiSize: 17, restoreTabs: false })
    expect(m.resetSettings()).toEqual(m.DEFAULT_SETTINGS)
    expect(saved().settings).toEqual(m.DEFAULT_SETTINGS)
    expect(document.documentElement.style.getPropertyValue('--ui-fs')).toBe('13px')
  })

  it('still works when localStorage throws', async () => {
    const m = await load()
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => m.updateSettings({ uiSize: 15 })).not.toThrow()
    expect(m.getSettings().uiSize).toBe(15)
    spy.mockRestore()
  })
})

describe('stepFontSizes', () => {
  it('moves both sizes by one px, clamps, and resets to the defaults', async () => {
    const m = await load()
    const base = m.DEFAULT_SETTINGS
    expect(m.stepFontSizes(base, 'in')).toEqual({ uiSize: 14, monoSize: 13 })
    expect(m.stepFontSizes(base, 'out')).toEqual({ uiSize: 12, monoSize: 11 })
    expect(m.stepFontSizes({ ...base, uiSize: 18, monoSize: 20 }, 'in')).toEqual({ uiSize: 18, monoSize: 20 })
    expect(m.stepFontSizes({ ...base, uiSize: 11, monoSize: 10 }, 'out')).toEqual({ uiSize: 11, monoSize: 10 })
    expect(m.stepFontSizes({ ...base, uiSize: 17, monoSize: 3 }, 'reset')).toEqual({ uiSize: 13, monoSize: 12 })
    expect(m.stepFontSizes({ ...base, uiSize: 15, monoSize: 14 }, 'bogus' as never)).toEqual({ uiSize: 15, monoSize: 14 })
  })
})

describe('cacheObjects (Cache database objects locally)', () => {
  it('is on by default', async () => {
    const m = await load()
    expect(m.DEFAULT_SETTINGS.cacheObjects).toBe(true)
    expect(m.getSettings().cacheObjects).toBe(true)
  })
  it('only a real boolean is accepted; anything else falls back to on', async () => {
    const m = await load()
    expect(m.normalizeSettings({ cacheObjects: false }).cacheObjects).toBe(false)
    expect(m.normalizeSettings({ cacheObjects: true }).cacheObjects).toBe(true)
    for (const v of ['no', 0, null, 'false', []]) expect(m.normalizeSettings({ cacheObjects: v }).cacheObjects).toBe(true)
  })
  it('settings saved before the option existed load with it on', async () => {
    const m = await load({ v: 1, settings: { uiSize: 15 } })
    expect(m.getSettings()).toMatchObject({ uiSize: 15, cacheObjects: true })
  })
  it('is saved, restored and reset to on', async () => {
    let m = await load()
    m.updateSettings({ cacheObjects: false })
    expect(saved().settings.cacheObjects).toBe(false)
    m = await load(saved())
    expect(m.getSettings().cacheObjects).toBe(false)
    m.resetSettings()
    expect(m.getSettings().cacheObjects).toBe(true)
  })
})
