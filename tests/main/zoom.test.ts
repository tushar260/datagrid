import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ZOOM_STEPS, ZOOM_MIN, ZOOM_MAX, clampPercent, factorToPercent, nextZoom, percentToFactor, readZoom, stepZoom, writeZoom } from '../../src/main/zoom'
import { ZOOM_MAX_PERCENT, ZOOM_MIN_PERCENT } from '../../src/shared'

describe('zoom steps', () => {
  it('match Chrome and are strictly increasing around 100', () => {
    expect([...ZOOM_STEPS]).toEqual([25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500])
    expect(ZOOM_MIN).toBe(25)
    expect(ZOOM_MAX).toBe(500)
  })
})

describe('clampPercent / factors', () => {
  it('clamps and rounds', () => {
    expect(clampPercent(5)).toBe(25)
    expect(clampPercent(9999)).toBe(500)
    expect(clampPercent(110.4)).toBe(110)
    expect(clampPercent(110.6)).toBe(111)
  })
  it('falls back to 100 for junk', () => {
    expect(clampPercent(NaN)).toBe(100)
    expect(clampPercent(Infinity)).toBe(100)
    expect(clampPercent('x' as unknown as number)).toBe(100)
  })
  it('converts percent <-> factor', () => {
    expect(percentToFactor(110)).toBeCloseTo(1.1)
    expect(percentToFactor(100)).toBe(1)
    expect(percentToFactor(1000)).toBe(5)
    expect(factorToPercent(1.25)).toBe(125)
    expect(factorToPercent(0.1)).toBe(25)
  })
})

describe('nextZoom', () => {
  it('steps in from 100 through the table', () => {
    let p = 100
    const seen: number[] = []
    for (let i = 0; i < 9; i++) seen.push((p = nextZoom(p, 'in')))
    expect(seen).toEqual([110, 125, 150, 175, 200, 250, 300, 400, 500])
  })
  it('steps out from 100 through the table', () => {
    let p = 100
    const seen: number[] = []
    for (let i = 0; i < 8; i++) seen.push((p = nextZoom(p, 'out')))
    expect(seen).toEqual([90, 80, 75, 67, 50, 33, 25, 25])
  })
  it('stays at the ends', () => {
    expect(nextZoom(500, 'in')).toBe(500)
    expect(nextZoom(25, 'out')).toBe(25)
  })
  it('snaps arbitrary values to the neighbouring step in the direction of travel', () => {
    expect(nextZoom(107, 'in')).toBe(110)
    expect(nextZoom(107, 'out')).toBe(100)
    expect(nextZoom(110, 'out')).toBe(100)
    expect(nextZoom(99, 'in')).toBe(100)
    expect(nextZoom(1, 'in')).toBe(33) // clamped to 25 first
    expect(nextZoom(9999, 'out')).toBe(400)
  })
  it('treats junk as 100', () => {
    expect(nextZoom(NaN, 'in')).toBe(110)
    expect(nextZoom(NaN, 'out')).toBe(90)
  })
})

describe('stepZoom (menu items and on-screen controls)', () => {
  it('in / out reuse nextZoom', () => {
    expect(stepZoom(100, 'in')).toBe(110)
    expect(stepZoom(100, 'out')).toBe(90)
    expect(stepZoom(107, 'in')).toBe(nextZoom(107, 'in'))
    expect(stepZoom(500, 'in')).toBe(500)
    expect(stepZoom(25, 'out')).toBe(25)
  })
  it('reset goes back to 100 from anywhere', () => {
    for (const p of [25, 90, 100, 250, 500]) expect(stepZoom(p, 'reset')).toBe(100)
  })
  it('walks the whole table and back', () => {
    let p = 100
    for (let i = 0; i < 20; i++) p = stepZoom(p, 'in')
    expect(p).toBe(500)
    for (let i = 0; i < 20; i++) p = stepZoom(p, 'out')
    expect(p).toBe(25)
  })
  it('ignores junk directions and junk values', () => {
    expect(stepZoom(125, 'sideways' as never)).toBe(125)
    expect(stepZoom(NaN, 'in')).toBe(110)
  })
  it('the shared range used by the renderer matches the step table', () => {
    expect(ZOOM_MIN_PERCENT).toBe(ZOOM_MIN)
    expect(ZOOM_MAX_PERCENT).toBe(ZOOM_MAX)
  })
})

describe('persistence', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zoom-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const file = (): string => join(dir, 'zoom.json')

  it('round-trips', () => {
    writeZoom(file(), 125)
    expect(readZoom(file())).toBe(125)
  })
  it('clamps on write and read', () => {
    writeZoom(file(), 9000)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ percent: 500 })
    writeFileSync(file(), JSON.stringify({ percent: 1 }))
    expect(readZoom(file())).toBe(25)
  })
  it('returns null for missing / corrupt / wrong-typed files', () => {
    expect(readZoom(file())).toBeNull()
    writeFileSync(file(), '{nope')
    expect(readZoom(file())).toBeNull()
    writeFileSync(file(), JSON.stringify({ percent: '110' }))
    expect(readZoom(file())).toBeNull()
    writeFileSync(file(), 'null')
    expect(readZoom(file())).toBeNull()
  })
  it('does not throw when the directory is missing', () => {
    expect(() => writeZoom(join(dir, 'nope', 'zoom.json'), 110)).not.toThrow()
  })
})
