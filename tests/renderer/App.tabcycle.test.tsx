// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { installApi, type MockApi } from './helpers/mockApi'

// App is rendered with its heavy children replaced by tiny stand-ins that expose the focus targets the real ones have.
vi.mock('../../src/renderer/src/Explorer', async () => {
  const React = await import('react')
  return {
    default: (p: { onOpen: (t: unknown) => void; onConsole: (c: unknown) => void; onSources: (s: unknown[]) => void }) => {
      React.useEffect(() => p.onSources([{ id: 'ds', name: 'DS' }]), []) // eslint-disable-line react-hooks/exhaustive-deps
      const ref = (table: string): unknown => ({ dsId: 'ds', dsName: 'DS', database: 'd', schema: 's', table, kind: 'table' })
      return (
        <div>
          <button onClick={() => p.onOpen(ref('a'))}>open a</button>
          <button onClick={() => p.onOpen(ref('b'))}>open b</button>
          <button onClick={() => p.onConsole({ dsId: 'ds', dsName: 'DS', database: 'd' })}>open console</button>
          <input data-testid="explorer-input" />
        </div>
      )
    }
  }
})
vi.mock('../../src/renderer/src/TableView', () => ({
  default: (p: { t: { table: string } }) => <div className="gridwrap" tabIndex={0} data-testid={'grid-' + p.t.table} />
}))
vi.mock('../../src/renderer/src/Console', () => ({
  default: () => <textarea className="editor" data-testid="console-editor" />
}))
vi.mock('../../src/renderer/src/DataSourceDialog', () => ({ default: () => null }))

import App from '../../src/renderer/src/App'

let api: MockApi
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  api = installApi()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const tabTitles = (): string[] => Array.from(document.querySelectorAll('.tabbar .tab')).map((t) => t.querySelector('.tabtitle')!.textContent!)
const activeTitle = (): string | undefined => document.querySelector('.tabbar .tab.on .tabtitle')?.textContent ?? undefined
const click = (name: string): void => void fireEvent.click(screen.getByText(name))
/** Ctrl+Tab style keydown on `target`; returns false when it was preventDefault-ed. Advances the clock past the double-fire guard. */
const press = (init: KeyboardEventInit, target: Element | Window = document.body): boolean => {
  vi.advanceTimersByTime(300)
  return fireEvent.keyDown(target, { key: 'Tab', ...init })
}

function openThree(): void {
  render(<App />)
  click('open a')
  click('open b')
  click('open console')
}

describe('App: Ctrl+Tab / Ctrl+Shift+Tab switch editor tabs', () => {
  it('Ctrl+Tab goes to the next tab and wraps around', () => {
    openThree()
    expect(tabTitles()).toHaveLength(3)
    expect(activeTitle()).toMatch(/console/) // the last opened tab is active
    expect(press({ ctrlKey: true })).toBe(false) // preventDefault called
    expect(activeTitle()).toBe('a')
    press({ ctrlKey: true })
    expect(activeTitle()).toBe('b')
  })

  it('Ctrl+Shift+Tab goes to the previous tab and wraps around', () => {
    openThree()
    click('open a') // activates tab a
    expect(activeTitle()).toBe('a')
    press({ ctrlKey: true, shiftKey: true })
    expect(activeTitle()).toMatch(/console/)
    press({ ctrlKey: true, shiftKey: true })
    expect(activeTitle()).toBe('b')
  })

  it('works from inside inputs / the console textarea and stops the key from reaching them', () => {
    openThree()
    const editor = screen.getByTestId('console-editor')
    const seen = vi.fn()
    editor.addEventListener('keydown', seen)
    editor.focus()
    expect(press({ ctrlKey: true }, editor)).toBe(false)
    expect(seen).not.toHaveBeenCalled()
    expect(activeTitle()).toBe('a')
    const input = screen.getByTestId('explorer-input')
    input.focus()
    press({ ctrlKey: true }, input)
    expect(activeTitle()).toBe('b')
  })

  it('moves keyboard focus into the new tab (grid container / console editor)', () => {
    openThree()
    press({ ctrlKey: true }) // console -> a
    expect(document.activeElement).toBe(screen.getByTestId('grid-a'))
    press({ ctrlKey: true }) // a -> b
    expect(document.activeElement).toBe(screen.getByTestId('grid-b'))
    press({ ctrlKey: true }) // b -> console
    expect(document.activeElement).toBe(screen.getByTestId('console-editor'))
  })

  it('keeps every tab mounted (pending edits survive switching)', () => {
    openThree()
    press({ ctrlKey: true })
    expect(screen.getByTestId('grid-a')).toBeTruthy()
    expect(screen.getByTestId('grid-b')).toBeTruthy()
    expect(screen.getByTestId('console-editor')).toBeTruthy()
  })

  it('does nothing (but still prevents the default focus move) with 0 or 1 tabs', () => {
    render(<App />)
    expect(press({ ctrlKey: true })).toBe(false)
    expect(tabTitles()).toEqual([])
    click('open a')
    const before = document.activeElement
    expect(press({ ctrlKey: true })).toBe(false)
    expect(press({ ctrlKey: true, shiftKey: true })).toBe(false)
    expect(activeTitle()).toBe('a')
    expect(document.activeElement).toBe(before)
  })

  it('ignores other modifier combos', () => {
    openThree()
    const start = activeTitle()
    expect(press({})).toBe(true) // plain Tab is left alone
    expect(press({ metaKey: true })).toBe(true) // Cmd+Tab is the OS app switcher
    expect(press({ ctrlKey: true, metaKey: true })).toBe(true)
    expect(press({ ctrlKey: true, altKey: true })).toBe(true)
    expect(activeTitle()).toBe(start)
  })

  it('is ignored while a modal dialog is open', () => {
    openThree()
    const start = activeTitle()
    for (const cls of ['modal-bg', 'cd-bg']) {
      const bg = document.createElement('div')
      bg.className = cls
      document.body.appendChild(bg)
      expect(press({ ctrlKey: true })).toBe(true)
      expect(activeTitle()).toBe(start)
      bg.remove()
    }
    press({ ctrlKey: true })
    expect(activeTitle()).not.toBe(start)
  })

  it('also works through the Window menu IPC items, and the key + menu twin only fires once', () => {
    openThree()
    expect(api._nextTab).toHaveLength(1)
    expect(api._prevTab).toHaveLength(1)
    vi.advanceTimersByTime(300)
    act(() => api._nextTab[0]())
    expect(activeTitle()).toBe('a')
    act(() => api._nextTab[0]()) // same instant: dropped by the guard
    fireEvent.keyDown(document.body, { key: 'Tab', ctrlKey: true })
    expect(activeTitle()).toBe('a')
    vi.advanceTimersByTime(300)
    act(() => api._prevTab[0]())
    expect(activeTitle()).toMatch(/console/)
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<App />)
    unmount()
    expect(api._nextTab).toHaveLength(0)
    expect(api._prevTab).toHaveLength(0)
  })
})
