import { describe, expect, it } from 'vitest'
import { clamp, clampSize, placeInViewport, splitRatio } from '../../src/renderer/src/Resizable'

const MIN = { w: 280, h: 220 }

describe('Resizable helpers', () => {
  it('clamp keeps values in range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(50, 0, 10)).toBe(10)
    expect(clamp(5, 20, 10)).toBe(20)
  })
  it('clampSize enforces min and viewport-minus-margin max', () => {
    expect(clampSize({ w: 10, h: 10 }, MIN, 1000, 800)).toEqual(MIN)
    expect(clampSize({ w: 5000, h: 5000 }, MIN, 1000, 800)).toEqual({ w: 984, h: 784 })
  })
  it('clampSize keeps the far edges on-screen for a given origin', () => {
    expect(clampSize({ w: 5000, h: 5000 }, MIN, 1000, 800, 300, 100)).toEqual({ w: 692, h: 692 })
  })
  it('placeInViewport shifts the popup back on-screen', () => {
    expect(placeInViewport(900, 700, { w: 320, h: 400 }, 1000, 800)).toEqual({ left: 672, top: 392 })
    expect(placeInViewport(-20, -20, { w: 320, h: 400 }, 1000, 800)).toEqual({ left: 8, top: 8 })
  })
  it('splitRatio follows the divider and clamps', () => {
    expect(splitRatio(600, 400, 0)).toBeCloseTo(0.6)
    expect(splitRatio(600, 400, 100)).toBeCloseTo(0.7)
    expect(splitRatio(600, 400, -900)).toBe(0.15)
    expect(splitRatio(600, 400, 900)).toBe(0.85)
  })
})
