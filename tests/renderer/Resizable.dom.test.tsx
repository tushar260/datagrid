// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { DragHandle, isRatio, isSize, readStored, useRatioSplit, writeStored } from '../../src/renderer/src/Resizable'
import { useLinger } from '../../src/renderer/src/useLinger'

beforeEach(() => {
  localStorage.clear()
  const captured = new Set<number>()
  Element.prototype.setPointerCapture = vi.fn((id: number) => void captured.add(id))
  Element.prototype.releasePointerCapture = vi.fn((id: number) => void captured.delete(id))
  Element.prototype.hasPointerCapture = vi.fn((id: number) => captured.has(id))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const ptr = (el: Element, type: string, init: Record<string, unknown> = {}): void => {
  // jsdom may not implement PointerEvent: React listens to the bubbling event type either way
  fireEvent(el, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }), { pointerId: 1 }))
}

describe('readStored / writeStored', () => {
  it('missing -> fallback; valid -> value; invalid shape -> fallback; corrupt JSON -> fallback', () => {
    expect(readStored('k', 0.4, isRatio)).toBe(0.4)
    writeStored('k', 0.7)
    expect(readStored('k', 0.4, isRatio)).toBe(0.7)
    writeStored('k', 5)
    expect(readStored('k', 0.4, isRatio)).toBe(0.4)
    localStorage.setItem('k', '{nope')
    expect(readStored('k', 0.4, isRatio)).toBe(0.4)
  })
  it('null removes the key', () => {
    writeStored('k', 0.5)
    writeStored('k', null)
    expect(localStorage.getItem('k')).toBeNull()
  })
  it('swallows a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => writeStored('k', 1)).not.toThrow()
    expect(readStored('k', 'fb', (v): v is string => typeof v === 'string')).toBe('fb')
  })
})

describe('validators', () => {
  it.each([[0.5, true], [0, false], [1, false], [-0.1, false], [NaN, false], ['0.5', false], [null, false], [Infinity, false], [0.0001, true], [0.9999, true]])(
    'isRatio(%j) = %s', (v, ok) => expect(isRatio(v)).toBe(ok)
  )
  it.each([[{ w: 1, h: 2 }, true], [{ w: 1 }, false], [{ w: NaN, h: 1 }, false], [null, false], [[1, 2], false], ['x', false], [{ w: '1', h: 2 }, false]])(
    'isSize(%j) = %s', (v, ok) => expect(isSize(v)).toBe(ok)
  )
})

describe('DragHandle', () => {
  const setup = (over: Partial<React.ComponentProps<typeof DragHandle>> = {}) => {
    const fns = { onStart: vi.fn(), onDrag: vi.fn(), onEnd: vi.fn(), onReset: vi.fn() }
    const r = render(<DragHandle cursor="ew-resize" className="x" title="t" {...fns} {...over} />)
    return { ...fns, el: r.container.firstElementChild as HTMLElement }
  }

  it('reports total movement since pointer-down and ends on pointer-up (releases capture)', () => {
    const { el, onStart, onDrag, onEnd } = setup()
    ptr(el, 'pointerdown', { clientX: 100, clientY: 50 })
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(Element.prototype.setPointerCapture).toHaveBeenCalled()
    ptr(el, 'pointermove', { clientX: 130, clientY: 40 })
    ptr(el, 'pointermove', { clientX: 90, clientY: 80 })
    expect(onDrag.mock.calls).toEqual([[30, -10], [-10, 30]])
    ptr(el, 'pointerup')
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(Element.prototype.releasePointerCapture).toHaveBeenCalled()
    ptr(el, 'pointermove', { clientX: 500, clientY: 500 })
    expect(onDrag).toHaveBeenCalledTimes(2) // no more reports after release
  })

  it('moves without a prior pointer-down are ignored; non-primary buttons do not start a drag', () => {
    const { el, onDrag, onStart } = setup()
    ptr(el, 'pointermove', { clientX: 5, clientY: 5 })
    ptr(el, 'pointerdown', { button: 2, clientX: 1, clientY: 1 })
    ptr(el, 'pointermove', { clientX: 9, clientY: 9 })
    expect(onStart).not.toHaveBeenCalled()
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('pointer-cancel also ends; pointer-up without a drag does not call onEnd', () => {
    const { el, onEnd } = setup()
    ptr(el, 'pointerup')
    expect(onEnd).not.toHaveBeenCalled()
    ptr(el, 'pointerdown', { clientX: 0, clientY: 0 })
    ptr(el, 'pointercancel')
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('double-click calls onReset and does not bubble', () => {
    const parent = vi.fn()
    const fns = { onDrag: vi.fn(), onReset: vi.fn() }
    const { container } = render(<div onDoubleClick={parent}><DragHandle cursor="ns-resize" {...fns} /></div>)
    fireEvent.doubleClick(container.querySelector('.drag-handle')!)
    expect(fns.onReset).toHaveBeenCalledTimes(1)
    expect(parent).not.toHaveBeenCalled()
  })

  it('applies cursor, class and title; renders children', () => {
    const { el } = setup({ children: <i className="kid" /> })
    expect(el.style.cursor).toBe('ew-resize')
    expect(el.className).toContain('drag-handle x')
    expect(el.title).toBe('t')
    expect(el.querySelector('.kid')).not.toBeNull()
  })
})

describe('useRatioSplit', () => {
  function Harness({ k }: { k: string }): React.JSX.Element {
    const { ratio, aRef, bRef, divider } = useRatioSplit(k, 0.5)
    return (
      <div>
        <div ref={aRef} data-testid="a" style={{ flex: `${ratio} 1 0` }} />
        {divider}
        <div ref={bRef} data-testid="b" style={{ flex: `${1 - ratio} 1 0` }} />
        <output>{ratio.toFixed(3)}</output>
      </div>
    )
  }
  const widths = (el: HTMLElement, w: number): void => void Object.defineProperty(el, 'offsetWidth', { value: w, configurable: true })

  it('starts from the stored ratio, follows drags (clamped) and persists on release', () => {
    localStorage.setItem('split', '0.3')
    const { container, getByTestId } = render(<Harness k="split" />)
    expect(container.querySelector('output')!.textContent).toBe('0.300')
    widths(getByTestId('a'), 300)
    widths(getByTestId('b'), 700)
    const h = container.querySelector('.drag-handle')!
    ptr(h, 'pointerdown', { clientX: 300 })
    ptr(h, 'pointermove', { clientX: 400 })
    expect(container.querySelector('output')!.textContent).toBe('0.400')
    ptr(h, 'pointermove', { clientX: 5000 })
    expect(container.querySelector('output')!.textContent).toBe('0.850')
    ptr(h, 'pointermove', { clientX: -5000 })
    expect(container.querySelector('output')!.textContent).toBe('0.150')
    ptr(h, 'pointerup')
    expect(JSON.parse(localStorage.getItem('split')!)).toBe(0.15)
  })

  it('double-click restores the default and clears storage', () => {
    localStorage.setItem('split', '0.8')
    const { container } = render(<Harness k="split" />)
    fireEvent.doubleClick(container.querySelector('.drag-handle')!)
    expect(container.querySelector('output')!.textContent).toBe('0.500')
    expect(localStorage.getItem('split')).toBeNull()
  })

  it('a garbage stored value falls back to the default', () => {
    localStorage.setItem('split', '"x"')
    const { container } = render(<Harness k="split" />)
    expect(container.querySelector('output')!.textContent).toBe('0.500')
  })
})

describe('useLinger', () => {
  it('false until shown; stays true for ms after turning off; re-showing cancels the fade-out', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ on }) => useLinger(on, 200), { initialProps: { on: false } })
    expect(result.current).toBe(false)
    rerender({ on: true })
    expect(result.current).toBe(true)
    rerender({ on: false })
    expect(result.current).toBe(true)
    act(() => void vi.advanceTimersByTime(199))
    expect(result.current).toBe(true)
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current).toBe(false)
    rerender({ on: true })
    rerender({ on: false })
    act(() => void vi.advanceTimersByTime(100))
    rerender({ on: true })
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current).toBe(true)
  })

  it('never shown -> never lingers', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ on }) => useLinger(on, 200), { initialProps: { on: false } })
    rerender({ on: false })
    expect(result.current).toBe(false)
  })
})
