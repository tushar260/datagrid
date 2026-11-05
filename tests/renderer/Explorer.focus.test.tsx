// @vitest-environment jsdom
// the Explorer's reaction to the Shift+Esc focus request: which row it selects
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import Explorer from '../../src/renderer/src/Explorer'
import { FOCUS_EXPLORER_EVENT, resetExplorerClick } from '../../src/renderer/src/lib/focusZone'
import type { DataSource } from '../../src/shared'
import { installApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

const ds = (id: string): DataSource => ({ id, name: id.toUpperCase(), host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false })
const row = (id: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).find((r) => r.dataset.id === id) ?? null
const selected = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row.sel')).map((r) => r.dataset.id!)
const focusRequest = (): void => void act(() => void window.dispatchEvent(new Event(FOCUS_EXPLORER_EVENT)))

async function mount(activeTarget: string | null): Promise<void> {
  render(
    <Explorer
      onOpen={() => {}} onEdit={() => {}} onConsole={() => {}} onTableRenamed={() => {}} onRefreshed={() => {}}
      onObjectGone={() => {}} reloadKey={0} activeTarget={activeTarget}
    />
  )
  await waitFor(() => expect(row('c')).toBeTruthy())
}

beforeEach(() => {
  localStorage.clear()
  resetExplorerClick()
  installApi({ listSources: [ds('a'), ds('b'), ds('c')] })
})
afterEach(cleanup)

describe('Explorer: focus request (Shift+Esc)', () => {
  it('focuses the tree root and selects the first row when nothing is selected and no tab is active', async () => {
    await mount(null)
    focusRequest()
    expect(document.activeElement).toBe(document.querySelector('.explorer'))
    expect(selected()).toEqual(['a'])
  })

  it("prefers the active tab's node; a node that is not visible falls back to its nearest visible ancestor", async () => {
    await mount('b/postgres/public/users') // the tree is collapsed: only the data source row `b` exists
    focusRequest()
    expect(selected()).toEqual(['b'])
  })

  it('the tree root is focusable but draws no ring of its own (tabIndex -1)', async () => {
    await mount(null)
    expect(document.querySelector('.explorer')!.getAttribute('tabindex')).toBe('-1')
  })
})
