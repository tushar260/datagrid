// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { reducedMotion, useTabAnimations } from '../../src/renderer/src/useTabAnimations'

let api!: ReturnType<typeof useTabAnimations>
let removed: string[]
let setKeys!: (k: string[]) => void
let setDrag!: (k: string | null) => void

function Harness({ initial, ready = true }: { initial: string[]; ready?: boolean }): React.JSX.Element {
  const [keys, sk] = useState(initial)
  const [dragKey, sd] = useState<string | null>(null)
  setKeys = sk
  setDrag = sd
  const strip = useRef<HTMLDivElement>(null)
  api = useTabAnimations({ keys, ready, dragKey, stripRef: strip, onRemove: (k) => { removed.push(k); sk((cur) => cur.filter((x) => x !== k)) } })
  return (
    <div ref={strip} className="strip">
      {keys.map((k) => (
        <div
          key={k}
          data-tabkey={k}
          className={(api.addedKeys.has(k) ? 'tab-new ' : '') + (api.closingKeys.has(k) ? 'closing' : '')}
          onAnimationEnd={(e) => api.onAnimationEnd(e, k)}
        />
      ))}
    </div>
  )
}
const el = (k: string): HTMLElement => document.querySelector(`[data-tabkey="${k}"]`) as HTMLElement
const animEnd = (target: Element, animationName: string): void => {
  // React picks the (possibly vendor-prefixed) event name by feature-detecting CSS animations, which jsdom lacks
  for (const type of ['animationend', 'webkitAnimationEnd']) {
    const ev = new Event(type, { bubbles: true })
    Object.defineProperty(ev, 'animationName', { value: animationName })
    act(() => void target.dispatchEvent(ev))
  }
}
const names = (): string[] => Array.from(document.querySelectorAll('[data-tabkey]')).map((n) => (n as HTMLElement).dataset.tabkey!)

beforeEach(() => {
  vi.useFakeTimers()
  removed = []
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as { matchMedia?: unknown }).matchMedia
})
const mm = (reduce: boolean): void => {
  window.matchMedia = vi.fn(() => ({ matches: reduce })) as unknown as typeof window.matchMedia
}

describe('reducedMotion', () => {
  it('is false without matchMedia, follows the media query otherwise', () => {
    expect(reducedMotion()).toBe(false)
    mm(true)
    expect(reducedMotion()).toBe(true)
    mm(false)
    expect(reducedMotion()).toBe(false)
  })
})

describe('useTabAnimations: close', () => {
  it('requestClose marks the tab closing and removes it after the fallback timeout (160ms)', () => {
    render(<Harness initial={['a', 'b']} />)
    act(() => api.requestClose('a'))
    expect(api.isClosing('a')).toBe(true)
    expect(el('a').className).toContain('closing')
    act(() => void vi.advanceTimersByTime(159))
    expect(removed).toEqual([])
    act(() => void vi.advanceTimersByTime(2))
    expect(removed).toEqual(['a'])
    expect(names()).toEqual(['b'])
    expect(api.isClosing('a')).toBe(false)
  })

  it('animationend (tab-out) removes immediately, and the later timeout does not remove it twice', () => {
    render(<Harness initial={['a', 'b']} />)
    act(() => api.requestClose('a'))
    animEnd(el('a'), 'tab-out')
    expect(removed).toEqual(['a'])
    act(() => void vi.advanceTimersByTime(500))
    expect(removed).toEqual(['a'])
  })

  it('repeated requestClose is a no-op; other animations / child animationend are ignored', () => {
    render(<Harness initial={['a']} />)
    act(() => api.requestClose('a'))
    act(() => api.requestClose('a'))
    animEnd(el('a'), 'something-else')
    expect(removed).toEqual([])
    act(() => void vi.advanceTimersByTime(300))
    expect(removed).toEqual(['a'])
  })

  it('reduced motion removes instantly; unknown key removes instantly', () => {
    mm(true)
    render(<Harness initial={['a', 'b']} />)
    act(() => api.requestClose('a'))
    expect(removed).toEqual(['a'])
    act(() => api.requestClose('ghost'))
    expect(removed).toEqual(['a', 'ghost'])
  })

  it('closing marks of tabs that vanish another way (bulk close) are forgotten', () => {
    render(<Harness initial={['a', 'b']} />)
    act(() => api.requestClose('a'))
    act(() => setKeys(['b']))
    expect(api.isClosing('a')).toBe(false)
    expect(api.closingKeys.size).toBe(0)
    act(() => void vi.advanceTimersByTime(500))
    expect(removed).toEqual([]) // finalize found nothing to do
  })
})

describe('useTabAnimations: open', () => {
  it('tabs present when `ready` first renders never animate; later additions get tab-new, cleared after 260ms', () => {
    render(<Harness initial={['a']} />)
    expect(api.addedKeys.size).toBe(0)
    act(() => setKeys(['a', 'b']))
    expect(el('b').className).toContain('tab-new')
    expect(el('a').className).not.toContain('tab-new')
    act(() => void vi.advanceTimersByTime(300))
    expect(el('b').className).not.toContain('tab-new')
  })

  it('tab-in animationend clears the class early', () => {
    render(<Harness initial={['a']} />)
    act(() => setKeys(['a', 'b']))
    animEnd(el('b'), 'tab-in')
    expect(el('b').className).not.toContain('tab-new')
  })

  it('nothing animates until ready; tabs added while not ready are treated as restored', () => {
    const { rerender } = render(<Harness initial={['a']} ready={false} />)
    act(() => setKeys(['a', 'b']))
    expect(api.addedKeys.size).toBe(0)
    rerender(<Harness initial={['a']} ready />)
    expect(api.addedKeys.size).toBe(0)
  })

  it('reduced motion: no tab-new', () => {
    mm(true)
    render(<Harness initial={['a']} />)
    act(() => setKeys(['a', 'b']))
    expect(api.addedKeys.size).toBe(0)
  })

  it('sets --tab-w to the natural width for the animation', () => {
    render(<Harness initial={['a']} />)
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 123 })
    act(() => setKeys(['a', 'b']))
    expect(el('b').style.getPropertyValue('--tab-w')).toBe('123px')
    act(() => api.requestClose('a'))
    expect(el('a').style.getPropertyValue('--tab-w')).toBe('123px')
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
  })
})

describe('useTabAnimations: reorder (FLIP)', () => {
  const lay = (positions: Record<string, number>): void => {
    for (const [k, v] of Object.entries(positions)) Object.defineProperty(el(k), 'offsetLeft', { configurable: true, get: () => positions[k] ?? v })
  }

  it('moved tabs start at their old offset and transition to 0', () => {
    render(<Harness initial={['a', 'b', 'c']} />)
    const pos: Record<string, number> = { a: 0, b: 100, c: 200 }
    for (const k of ['a', 'b', 'c']) Object.defineProperty(el(k), 'offsetLeft', { configurable: true, get: () => pos[k] })
    act(() => setDrag('zz')) // re-render so the hook records the layout
    act(() => setDrag(null))
    pos.a = 100
    pos.b = 0 // b and a swapped
    act(() => setKeys(['b', 'a', 'c']))
    expect(el('b').style.transition).toContain('transform')
    expect(el('b').style.transform).toBe('')
    act(() => void vi.advanceTimersByTime(300))
    expect(el('b').style.transition).toBe('')
  })

  it('the dragged tab is never animated', () => {
    render(<Harness initial={['a', 'b']} />)
    const pos: Record<string, number> = { a: 0, b: 100 }
    for (const k of ['a', 'b']) Object.defineProperty(el(k), 'offsetLeft', { configurable: true, get: () => pos[k] })
    act(() => setDrag('a'))
    pos.a = 100
    pos.b = 0
    act(() => setKeys(['b', 'a']))
    expect(el('a').style.transition).toBe('')
    void lay
  })

  it('reduced motion skips FLIP; add/remove (different sets) do not FLIP', () => {
    mm(true)
    render(<Harness initial={['a', 'b']} />)
    act(() => setKeys(['b', 'a']))
    expect(el('a').style.transition).toBe('')
    expect(el('b').style.transition).toBe('')
  })
})
