// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { installTooltips } from '../../src/renderer/src/Tooltip'

let clock = new Date('2026-01-01T00:00:00Z').getTime()
let tip: HTMLElement
const main = (): HTMLElement => tip.querySelector('.fast-tip-main')!
const sub = (): HTMLElement => tip.querySelector('.fast-tip-sub')!
const shown = (): boolean => tip.classList.contains('show')

function el(html: string): HTMLElement {
  const d = document.createElement('div')
  d.className = 't-host'
  d.innerHTML = html
  document.body.appendChild(d)
  return d.firstElementChild as HTMLElement
}
const over = (e: Element, x = 0): void => void fireEvent.mouseOver(e, { clientX: x })

beforeAll(() => {
  installTooltips()
  tip = document.querySelector('.fast-tip')!
})
beforeEach(() => {
  vi.useFakeTimers()
  clock += 10_000_000
  vi.setSystemTime(clock)
  fireEvent.mouseDown(document.body) // reset singleton state
  vi.advanceTimersByTime(5000) // leave any warm window
})
afterEach(() => {
  vi.useRealTimers()
  document.body.querySelectorAll('div.t-host').forEach((n) => n.remove())
})

describe('installTooltips', () => {
  it('is idempotent: only one tooltip element is ever created', () => {
    installTooltips()
    installTooltips()
    expect(document.querySelectorAll('.fast-tip')).toHaveLength(1)
    expect(tip.parentElement).toBe(document.body)
  })

  it('shows the data-tip text after the 180ms delay (not before)', () => {
    const a = el('<span data-tip="Hello">x</span>')
    over(a)
    vi.advanceTimersByTime(179)
    expect(shown()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(shown()).toBe(true)
    expect(main().textContent).toBe('Hello')
    expect(main().style.display).toBe('')
    expect(sub().style.display).toBe('none')
  })

  it('data-tip2 renders as the dim second line; either alone is enough', () => {
    over(el('<span data-tip="A" data-tip2="B">x</span>'))
    vi.advanceTimersByTime(200)
    expect([main().textContent, sub().textContent]).toEqual(['A', 'B'])
    expect(sub().style.display).toBe('')
    fireEvent.mouseDown(document.body)
    vi.advanceTimersByTime(1000)
    over(el('<span data-tip2="only second">y</span>'))
    vi.advanceTimersByTime(200)
    expect(shown()).toBe(true)
    expect(main().style.display).toBe('none')
    expect(sub().textContent).toBe('only second')
  })

  it('the innermost [data-tip] wins when nested', () => {
    const outer = el('<div data-tip="outer"><span data-tip="inner"><i>deep</i></span></div>')
    over(outer.querySelector('i')!)
    vi.advanceTimersByTime(200)
    expect(main().textContent).toBe('inner')
  })

  it('an element without any tip shows nothing, and hides a visible tip when entered', () => {
    const a = el('<span data-tip="A">a</span>')
    const plain = el('<span>plain</span>')
    over(plain)
    vi.advanceTimersByTime(500)
    expect(shown()).toBe(false)
    over(a)
    vi.advanceTimersByTime(200)
    expect(shown()).toBe(true)
    over(plain)
    expect(shown()).toBe(false)
  })

  it('leaving before the delay cancels the pending tooltip', () => {
    const a = el('<span data-tip="A">a</span>')
    over(a)
    vi.advanceTimersByTime(100)
    fireEvent.mouseOut(a, { relatedTarget: null })
    vi.advanceTimersByTime(500)
    expect(shown()).toBe(false)
  })

  it('mouseout that stays inside the window (relatedTarget set) does not hide', () => {
    const a = el('<span data-tip="A"><b>x</b></span>')
    over(a)
    vi.advanceTimersByTime(200)
    fireEvent.mouseOut(a, { relatedTarget: document.body })
    expect(shown()).toBe(true)
  })

  it('warm window: right after a tooltip hides, the next shows immediately; after 300ms it needs the delay again', () => {
    const a = el('<span data-tip="A">a</span>')
    const b = el('<span data-tip="B">b</span>')
    over(a)
    vi.advanceTimersByTime(200)
    expect(shown()).toBe(true)
    fireEvent.mouseOut(a, { relatedTarget: null }) // hides, starts warm window
    expect(shown()).toBe(false)
    vi.advanceTimersByTime(100)
    over(b)
    expect(shown()).toBe(true) // immediate
    expect(main().textContent).toBe('B')
    fireEvent.mouseOut(b, { relatedTarget: null })
    vi.advanceTimersByTime(300)
    over(a)
    expect(shown()).toBe(false)
    vi.advanceTimersByTime(180)
    expect(shown()).toBe(true)
  })

  it('moving directly between two targets swaps content immediately while visible', () => {
    const a = el('<span data-tip="A">a</span>')
    const b = el('<span data-tip="B" data-tip2="b2">b</span>')
    over(a)
    vi.advanceTimersByTime(200)
    over(b)
    expect(main().textContent).toBe('B')
    expect(sub().textContent).toBe('b2')
  })

  it.each(['mousedown', 'click', 'wheel', 'keydown', 'contextmenu', 'dragstart', 'scroll'])('%s hides the tooltip and cancels a pending one', (ev) => {
    const a = el('<span data-tip="A">a</span>')
    over(a)
    vi.advanceTimersByTime(200)
    expect(shown()).toBe(true)
    fireEvent(document.body, new Event(ev, { bubbles: true }))
    expect(shown()).toBe(false)
    // pending timer cancelled
    vi.advanceTimersByTime(1000)
    const b = el('<span data-tip="B">b</span>')
    over(b)
    vi.advanceTimersByTime(100)
    fireEvent(document.body, new Event(ev, { bubbles: true }))
    vi.advanceTimersByTime(500)
    expect(shown()).toBe(false)
  })

  it('window blur hides', () => {
    over(el('<span data-tip="A">a</span>'))
    vi.advanceTimersByTime(200)
    window.dispatchEvent(new Event('blur'))
    expect(shown()).toBe(false)
  })

  it('does not show for an element that was removed before the timer fired', () => {
    const a = el('<span data-tip="A">a</span>')
    over(a)
    a.remove()
    vi.advanceTimersByTime(300)
    expect(shown()).toBe(false)
  })

  it('re-entering the same element is a no-op (does not restart the timer)', () => {
    const a = el('<span data-tip="A"><i>x</i></span>')
    over(a)
    vi.advanceTimersByTime(100)
    over(a.querySelector('i')!) // same closest target
    vi.advanceTimersByTime(80)
    expect(shown()).toBe(true)
  })

  it('tree rows without data-tip show their label only when truncated', () => {
    const row = el('<div class="tree-row"><span class="tlabel">A very long table name</span></div>')
    const lab = row.querySelector('.tlabel') as HTMLElement
    Object.defineProperty(lab, 'scrollWidth', { value: 100, configurable: true })
    Object.defineProperty(lab, 'clientWidth', { value: 100, configurable: true })
    over(row)
    vi.advanceTimersByTime(300)
    expect(shown()).toBe(false) // fits
    fireEvent.mouseOut(row, { relatedTarget: null })
    Object.defineProperty(lab, 'scrollWidth', { value: 150, configurable: true })
    over(row)
    vi.advanceTimersByTime(300)
    expect(shown()).toBe(true)
    expect(main().textContent).toBe('A very long table name')
  })

  it('a tree row with an explicit data-tip uses it even when not truncated', () => {
    const row = el('<div class="tree-row" data-tip="explicit"><span class="tlabel">x</span></div>')
    over(row)
    vi.advanceTimersByTime(200)
    expect(main().textContent).toBe('explicit')
  })

  it('is placed below the target, clamped to the window, flipping above when there is no room', () => {
    const a = el('<span data-tip="A">a</span>')
    vi.spyOn(a, 'getBoundingClientRect').mockReturnValue({ left: 10, right: 20, top: 100, bottom: 120, width: 10, height: 20, x: 10, y: 100, toJSON() {} })
    over(a, 50)
    vi.advanceTimersByTime(200)
    expect(tip.style.top).toBe('123px')
    expect(parseInt(tip.style.left)).toBeGreaterThanOrEqual(6)
    fireEvent.mouseDown(document.body)
    vi.advanceTimersByTime(1000)
    Object.defineProperty(window, 'innerHeight', { value: 110, configurable: true })
    over(a, 50)
    vi.advanceTimersByTime(200)
    expect(parseInt(tip.style.top)).toBeLessThanOrEqual(100) // flipped above (tip height is 0 in jsdom)
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
  })
})
