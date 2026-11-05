// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import Explorer from '../../src/renderer/src/Explorer'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'
import type { DataSource } from '../../src/shared'
import { installApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

const ds = (id: string): DataSource => ({
  id, name: id.toUpperCase(), host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false
})

beforeEach(() => {
  localStorage.clear()
  resetExplorerClick()
  installApi({ listSources: [ds('a'), ds('b'), ds('c')] })
})
afterEach(cleanup)

async function renderExplorer(): Promise<void> {
  render(
    <Explorer
      onOpen={() => {}} onEdit={() => {}} onConsole={() => {}} onTableRenamed={() => {}}
      onRefreshed={() => {}} onObjectGone={() => {}} reloadKey={0}
    />
  )
  await waitFor(() => expect(row('c')).toBeTruthy())
}
const row = (id: string): HTMLElement => document.querySelector(`.explorer .tree-row[data-id="${id}"]`) as HTMLElement
const selected = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row.sel')).map((r) => r.dataset.id!)
/** a real click: the mousedown is what tells the app "the last click was inside the explorer" */
const click = (id: string, init: Record<string, unknown> = {}): void => {
  fireEvent.mouseDown(row(id), init)
  fireEvent.click(row(id), init)
}
const esc = (init: Record<string, unknown> = {}, target: Element = document.body): void => {
  fireEvent.keyDown(target, { key: 'Escape', ...init })
}

describe('Explorer: Escape removes the selection', () => {
  it('a single selected row is deselected entirely', async () => {
    await renderExplorer()
    click('a')
    expect(selected()).toEqual(['a'])
    esc()
    expect(selected()).toEqual([])
  })

  it('a multi-selection collapses to the primary row; a second Escape clears it', async () => {
    await renderExplorer()
    click('a')
    click('c', { metaKey: true })
    expect(selected().sort()).toEqual(['a', 'c'])
    esc()
    expect(selected()).toEqual(['c'])
    esc()
    expect(selected()).toEqual([])
  })

  it('a Shift range collapses to the range end (the primary row)', async () => {
    await renderExplorer()
    click('a')
    click('c', { shiftKey: true })
    expect(selected().sort()).toEqual(['a', 'b', 'c'])
    esc()
    expect(selected()).toEqual(['c'])
  })

  it('arrow keys resume from the previously selected row after Escape', async () => {
    await renderExplorer()
    click('b')
    esc()
    expect(selected()).toEqual([])
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(selected()).toEqual(['c'])
    esc()
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(selected()).toEqual(['b'])
  })

  it('Enter does nothing while nothing is selected', async () => {
    await renderExplorer()
    click('a')
    esc()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(selected()).toEqual([])
  })

  it('Shift+Escape (sidebar toggle) and modified Escape do not clear the selection', async () => {
    await renderExplorer()
    click('a')
    esc({ shiftKey: true })
    esc({ metaKey: true })
    esc({ ctrlKey: true })
    esc({ altKey: true })
    expect(selected()).toEqual(['a'])
  })

  it('is ignored when the last click was outside the explorer', async () => {
    await renderExplorer()
    click('a')
    const other = document.createElement('div')
    document.body.appendChild(other)
    fireEvent.mouseDown(other)
    esc()
    expect(selected()).toEqual(['a'])
    other.remove()
  })

  it('an open context menu keeps Escape for itself: it closes, the selection stays', async () => {
    await renderExplorer()
    click('a')
    fireEvent.contextMenu(row('a'))
    expect(document.querySelector('.ctxmenu')).not.toBeNull()
    esc()
    await waitFor(() => expect(document.querySelector('.ctxmenu')).toBeNull())
    expect(selected()).toEqual(['a'])
    esc() // menu gone: now it clears
    expect(selected()).toEqual([])
  })

  it('Escape typed into an input (rename / filter) or while a modal is open leaves the selection alone', async () => {
    await renderExplorer()
    click('a')
    const input = document.createElement('input')
    document.querySelector('.explorer')!.appendChild(input)
    esc({}, input)
    expect(selected()).toEqual(['a'])
    const modal = document.createElement('div')
    modal.className = 'modal-bg'
    document.body.appendChild(modal)
    esc()
    expect(selected()).toEqual(['a'])
    modal.remove()
    esc()
    expect(selected()).toEqual([])
  })

  it('with nothing selected Escape is a no-op', async () => {
    await renderExplorer()
    fireEvent.mouseDown(row('a'))
    esc()
    expect(selected()).toEqual([])
  })

  it('does not persist any selection into the saved session', async () => {
    await renderExplorer()
    click('a')
    esc()
    expect(JSON.stringify(Object.entries(localStorage))).not.toMatch(/"sel"/)
  })
})
