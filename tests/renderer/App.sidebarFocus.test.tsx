// @vitest-environment jsdom
// Shift+Esc moves the keyboard focus into the Database Explorer tree (real App + real Explorer; only the heavy tab views are stubbed)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { DataSource } from '../../src/shared'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'
import { installApi } from './helpers/mockApi'

const h = vi.hoisted(() => ({
  session: { width: 300, sidebarHidden: false, consoleN: 0, tabs: [] as unknown[], consoleSql: {} as Record<string, string>, active: null as string | null, expanded: [] as string[], folders: [] as string[] },
  patches: [] as Record<string, unknown>[]
}))
// each stub has things Shift+Esc must work from: a grid-like focusable, a filter input and an editor textarea
vi.mock('../../src/renderer/src/TableView', async () => ({
  default: ({ t }: any) => (
    <div data-testid={'tv-' + t.table}>
      <div className="gridwrap" tabIndex={0} data-testid={'grid-' + t.table} />
      <input className="filter" data-testid={'filter-' + t.table} />
    </div>
  )
}))
vi.mock('../../src/renderer/src/DynamoTableView', async () => ({ default: () => <div /> }))
vi.mock('../../src/renderer/src/RedisKeyView', async () => ({ default: () => <div /> }))
vi.mock('../../src/renderer/src/RedisKeyTab', async () => ({ default: ({ t }: any) => <textarea data-testid={'rk-' + t.redisKey} /> }))
vi.mock('../../src/renderer/src/Console', async () => ({ default: ({ c }: any) => <textarea className="editor" data-testid={'console-' + c.id} /> }))
vi.mock('../../src/renderer/src/session', () => ({
  get initialSession() { return h.session },
  patchSession: (p: Record<string, unknown>) => void h.patches.push(p),
  saveTabs: () => undefined
}))

import App from '../../src/renderer/src/App'

Element.prototype.scrollIntoView = vi.fn()

const ds = (id: string): DataSource => ({ id, name: id.toUpperCase(), host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false })
const T = (name: string): { name: string; kind: string } => ({ name, kind: 'table' })
const row = (id: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).find((r) => r.dataset.id === id) ?? null
const selected = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row.sel')).map((r) => r.dataset.id!)
const tree = (): HTMLElement => document.querySelector('.explorer') as HTMLElement
const side = (): HTMLElement => document.querySelector('.side') as HTMLElement
const tabNames = (): string[] => Array.from(document.querySelectorAll('.tab .tabtitle')).map((t) => t.textContent!)
const shiftEsc = (target: Element = document.activeElement ?? document.body, init: KeyboardEventInit = {}): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(ev))
  return ev
}
/** a key aimed at whatever has the focus (like the real thing) */
const press = (k: string, init: KeyboardEventInit = {}): void => void fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init })

async function mount(sources: DataSource[] = [ds('d1'), ds('d2'), ds('d3')]): Promise<void> {
  installApi({
    listSources: sources,
    databases: ['app'],
    schemasAll: ['public'],
    tableNames: { public: ['users', 'orders'] },
    tables: async () => [T('users'), T('orders')]
  })
  render(<App />)
  await waitFor(() => expect(row(sources[sources.length - 1].id)).toBeTruthy())
}
/** opens a table tab by driving the tree with the keyboard from d1 */
async function openUsersViaKeyboard(): Promise<void> {
  shiftEsc(document.body)
  expect(selected()).toEqual(['d1'])
  press('ArrowRight')
  await waitFor(() => expect(row('d1/app')).toBeTruthy())
  press('ArrowDown')
  press('ArrowRight')
  await waitFor(() => expect(row('d1/app/public')).toBeTruthy())
  press('ArrowDown')
  press('ArrowRight')
  await waitFor(() => expect(row('d1/app/public/users')).toBeTruthy())
  press('ArrowDown')
  press('Enter')
  await waitFor(() => expect(tabNames()).toEqual(['users']))
}

beforeEach(() => {
  localStorage.clear()
  resetExplorerClick()
  h.session = { width: 300, sidebarHidden: false, consoleN: 0, tabs: [], consoleSql: {}, active: null, expanded: [], folders: [] }
  h.patches.length = 0
})
afterEach(cleanup)

describe('Shift+Esc focuses the Explorer tree', () => {
  it('from the main area: the tree takes the focus and the first row is selected when nothing was', async () => {
    await mount()
    expect(selected()).toEqual([])
    const ev = shiftEsc(document.body)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(tree())
    expect(selected()).toEqual(['d1'])
  })

  it('from a focused grid, a filter input and a textarea (console / Redis key editor)', async () => {
    await mount()
    await openUsersViaKeyboard()
    const grid = document.querySelector<HTMLElement>('[data-testid="grid-users"]')!
    const filter = document.querySelector<HTMLElement>('[data-testid="filter-users"]')!
    for (const el of [grid, filter]) {
      el.focus()
      expect(document.activeElement).toBe(el)
      shiftEsc(el)
      expect(document.activeElement).toBe(tree())
    }
    // a textarea (console editor / Redis key value) in another tab
    const ta = document.createElement('textarea')
    document.querySelector('.content')!.appendChild(ta)
    ta.focus()
    const ev = shiftEsc(ta)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(tree())
    ta.remove()
  })

  it('from the explorer filter input too (it is inside the sidebar, but not the tree)', async () => {
    await mount()
    const input = document.querySelector<HTMLInputElement>('.tree-filter')!
    input.focus()
    shiftEsc(input)
    expect(document.activeElement).toBe(tree())
    expect(selected()).toEqual(['d1'])
  })

  it('Arrow Down / Up move between rows', async () => {
    await mount()
    shiftEsc(document.body)
    press('ArrowDown')
    expect(selected()).toEqual(['d2'])
    press('ArrowDown')
    expect(selected()).toEqual(['d3'])
    press('ArrowUp')
    expect(selected()).toEqual(['d2'])
  })

  it('Right / Left expand and collapse; Enter opens a table', async () => {
    await mount()
    await openUsersViaKeyboard()
    expect(selected()).toEqual(['d1/app/public/users'])
    // collapse the schema again with Left (go to the parent first, then collapse)
    press('ArrowLeft')
    expect(selected()).toEqual(['d1/app/public'])
    press('ArrowLeft')
    await waitFor(() => expect(row('d1/app/public/users')).toBeNull())
  })

  it('prefers the selected row (a click earlier) over the first one', async () => {
    await mount()
    fireEvent.mouseDown(row('d2')!)
    fireEvent.click(row('d2')!)
    expect(selected()).toEqual(['d2'])
    shiftEsc(document.body)
    expect(selected()).toEqual(['d2'])
    expect(document.activeElement).toBe(tree())
    press('ArrowDown')
    expect(selected()).toEqual(['d3'])
  })

  it('a multi-selection is kept', async () => {
    await mount()
    fireEvent.mouseDown(row('d1')!)
    fireEvent.click(row('d1')!)
    fireEvent.mouseDown(row('d3')!)
    fireEvent.click(row('d3')!, { metaKey: true })
    expect(selected().sort()).toEqual(['d1', 'd3'])
    shiftEsc(document.body)
    expect(selected().sort()).toEqual(['d1', 'd3'])
  })

  it('after Escape cleared the selection the last selected row comes back', async () => {
    await mount()
    fireEvent.mouseDown(row('d2')!)
    fireEvent.click(row('d2')!)
    fireEvent.keyDown(tree(), { key: 'Escape' })
    expect(selected()).toEqual([])
    shiftEsc(document.body)
    expect(selected()).toEqual(['d2'])
  })

  it('arrows reach the tree only while it has the focus: once the focus is in the grid they leave the tree alone', async () => {
    await mount()
    await openUsersViaKeyboard()
    const before = selected()
    const grid = document.querySelector<HTMLElement>('[data-testid="grid-users"]')!
    grid.focus() // e.g. Ctrl+Tab into the tab: the "last click" is still the tree
    fireEvent.keyDown(grid, { key: 'ArrowUp' })
    fireEvent.keyDown(grid, { key: 'Enter' })
    expect(selected()).toEqual(before)
    expect(tabNames()).toEqual(['users'])
  })

  it('is a no-op while a modal dialog is open (no focus stolen from behind it)', async () => {
    await mount()
    const modal = document.createElement('div')
    modal.className = 'modal-bg'
    const input = document.createElement('input')
    modal.appendChild(input)
    document.body.appendChild(modal)
    input.focus()
    const ev = shiftEsc(input)
    expect(ev.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(selected()).toEqual([])
    modal.remove()
  })

  it('does not react to plain Escape or Shift+Esc with Ctrl / Cmd / Alt', async () => {
    await mount()
    shiftEsc(document.body, { shiftKey: false })
    shiftEsc(document.body, { ctrlKey: true })
    shiftEsc(document.body, { metaKey: true })
    shiftEsc(document.body, { altKey: true })
    expect(document.activeElement).not.toBe(tree())
    expect(selected()).toEqual([])
  })

  it('reveals a collapsed sidebar first, then focuses the tree', async () => {
    h.session.sidebarHidden = true
    await mount()
    expect(side().style.display).toBe('none')
    shiftEsc(document.body)
    expect(side().style.display).toBe('')
    expect(document.activeElement).toBe(tree())
    expect(selected()).toEqual(['d1'])
    press('ArrowDown')
    expect(selected()).toEqual(['d2'])
  })

  it('a second Shift+Esc gives the focus back to where it was (and re-hides a sidebar it had revealed)', async () => {
    await mount()
    await openUsersViaKeyboard()
    const grid = document.querySelector<HTMLElement>('[data-testid="grid-users"]')!
    grid.focus()
    shiftEsc(grid)
    expect(document.activeElement).toBe(tree())
    shiftEsc()
    expect(document.activeElement).toBe(grid)
    expect(side().style.display).toBe('') // it was visible: stays visible
  })

  it('the tree row stays visibly selected while the tree has focus (focus-within style hook)', async () => {
    await mount()
    shiftEsc(document.body)
    expect(row('d1')!.classList.contains('sel')).toBe(true)
    expect(tree().matches(':focus-within')).toBe(true)
  })

  it('plain Escape inside the tree still clears the selection', async () => {
    await mount()
    shiftEsc(document.body)
    expect(selected()).toEqual(['d1'])
    press('Escape')
    expect(selected()).toEqual([])
  })
})
