// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import ZoomIndicator, { ZOOM_BADGE_MS } from '../../src/renderer/src/ZoomIndicator'
import { installApi, type MockApi } from './helpers/mockApi'

let api: MockApi
beforeEach(() => {
  vi.useFakeTimers()
  api = installApi()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const zoom = (p: number): void => void act(() => api._zoom.forEach((f) => f(p)))
const badge = (): HTMLElement | null => document.querySelector('.zoom-badge')

describe('ZoomIndicator', () => {
  it('renders nothing until the first zoom change', () => {
    render(<ZoomIndicator />)
    expect(badge()).toBeNull()
  })

  it('shows the percentage, counter-scales to stay the same visual size, and fades after the timeout', () => {
    render(<ZoomIndicator />)
    zoom(125)
    expect(badge()!.textContent).toBe('125%')
    expect(badge()!.classList.contains('show')).toBe(true)
    expect(badge()!.style.transform).toContain(`scale(${100 / 125})`)
    expect(badge()!.getAttribute('aria-hidden')).toBe('false')
    act(() => void vi.advanceTimersByTime(ZOOM_BADGE_MS - 1))
    expect(badge()!.classList.contains('show')).toBe(true)
    act(() => void vi.advanceTimersByTime(1))
    expect(badge()!.classList.contains('show')).toBe(false)
    expect(badge()!.getAttribute('aria-hidden')).toBe('true')
    expect(badge()!.textContent).toBe('125%') // stays in the DOM for the CSS fade
  })

  it('a second change restarts the timer and updates the text', () => {
    render(<ZoomIndicator />)
    zoom(110)
    act(() => void vi.advanceTimersByTime(1000))
    zoom(120)
    act(() => void vi.advanceTimersByTime(1000))
    expect(badge()!.classList.contains('show')).toBe(true)
    expect(badge()!.textContent).toBe('120%')
    act(() => void vi.advanceTimersByTime(300))
    expect(badge()!.classList.contains('show')).toBe(false)
  })

  it('shows again after having faded', () => {
    render(<ZoomIndicator />)
    zoom(100)
    act(() => void vi.advanceTimersByTime(2000))
    zoom(90)
    expect(badge()!.classList.contains('show')).toBe(true)
    expect(badge()!.textContent).toBe('90%')
  })

  it('unsubscribes and clears its timer on unmount', () => {
    const { unmount } = render(<ZoomIndicator />)
    zoom(100)
    expect(api._zoom).toHaveLength(1)
    unmount()
    expect(api._zoom).toHaveLength(0)
    expect(() => act(() => void vi.advanceTimersByTime(5000))).not.toThrow()
  })
})
