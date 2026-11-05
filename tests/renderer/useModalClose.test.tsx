// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import SettingsDialog from '../../src/renderer/src/SettingsDialog'
import { installApi } from './helpers/mockApi'
import { useModalClose } from '../../src/renderer/src/lib/useModalClose'

function Probe({ onClose }: { onClose: (n: number) => void }): React.JSX.Element {
  const { ref, closing, close } = useModalClose(onClose)
  return (
    <div ref={ref} data-testid="bg" className={closing ? 'closing' : ''}>
      <button onClick={() => close(7)}>close</button>
    </div>
  )
}

let animationName = 'none'
const realGcs = window.getComputedStyle.bind(window)
beforeEach(() => {
  animationName = 'none'
  installApi()
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const cs = realGcs(el, pseudo)
    return new Proxy(cs, { get: (t, k) => (k === 'animationName' ? animationName : Reflect.get(t, k)) })
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useModalClose', () => {
  it('closes immediately (with the arguments) when the backdrop has no animation', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledWith(7)
    expect(screen.getByTestId('bg').className).toBe('')
  })

  it('with an animation it adds .closing and closes on animationend (once)', () => {
    animationName = 'modal-bg-in'
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    fireEvent.click(screen.getByText('close')) // a second request while leaving is ignored
    expect(screen.getByTestId('bg').className).toBe('closing')
    expect(onClose).not.toHaveBeenCalled()
    // an animation of a child does not count
    fireEvent.animationEnd(screen.getByText('close'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.animationEnd(screen.getByTestId('bg'))
    fireEvent.animationEnd(screen.getByTestId('bg'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledWith(7)
  })

  it('falls back to a timer when animationend never arrives', () => {
    vi.useFakeTimers()
    animationName = 'modal-bg-in'
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    act(() => { vi.advanceTimersByTime(399) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('unmounting while leaving never calls onClose', () => {
    vi.useFakeTimers()
    animationName = 'modal-bg-in'
    const onClose = vi.fn()
    const { unmount } = render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    unmount()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('dialogs use it', () => {
  it('Settings: Done / Esc / backdrop first mark the dialog as closing, then close on animationend', () => {
    animationName = 'modal-bg-in'
    const onClose = vi.fn()
    render(<SettingsDialog onClose={onClose} />)
    const bg = document.querySelector('.modal-bg') as HTMLElement
    fireEvent.click(screen.getByText('Done'))
    expect(bg.classList.contains('closing')).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.animationEnd(bg)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Settings: Esc closes right away when animations are off', () => {
    const onClose = vi.fn()
    render(<SettingsDialog onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
