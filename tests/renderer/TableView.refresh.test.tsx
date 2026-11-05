// @vitest-environment jsdom
// Cmd/Ctrl+R: reloads the grid of the active table tab (like the toolbar ⟳ button); the Explorer keeps its own tree refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TableView from '../../src/renderer/src/TableView'
import Explorer, { type TableRef } from '../../src/renderer/src/Explorer'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'
import type { Column, DataSource, RowsQuery } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

const COLS: Column[] = [
  { name: 'id', type: 'integer', nullable: false, isPk: true },
  { name: 'name', type: 'text', nullable: true, isPk: false }
]
const DATA = Array.from({ length: 250 }, (_, i) => ({ id: String(i + 1), name: 'n' + (i + 1) }))

let api: MockApi
let n = 0
const fresh = (): TableRef => ({ dsId: 'ds', dsName: 'Local', database: 'app', schema: 'public', table: 'r' + ++n, kind: 'table' })
const queries = (): RowsQuery[] => api.rows.mock.calls.map((c) => c[0] as RowsQuery)
const nRows = (): number => api.rows.mock.calls.length
const grid = (): HTMLElement => document.querySelector('.gridwrap') as HTMLElement
const bodyRows = (): HTMLElement[] => Array.from(document.querySelectorAll('tbody tr'))
const cell = (r: number, c: number): HTMLElement => bodyRows()[r].querySelectorAll('td')[c + 1] as HTMLElement
const whereBox = (): HTMLInputElement => document.querySelector('.fb-field.where input') as HTMLInputElement
const cmdR = (el: Element | Window, init: Record<string, unknown> = {}): boolean =>
  fireEvent.keyDown(el, { key: 'r', code: 'KeyR', metaKey: true, ...init })
const ctrlR = (el: Element | Window): boolean => cmdR(el, { metaKey: false, ctrlKey: true })

async function renderTV(props: Partial<React.ComponentProps<typeof TableView>> = {}, t = fresh()) {
  const r = render(<TableView t={t} {...props} />)
  await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0))
  return { ...r, t }
}

beforeEach(() => {
  localStorage.clear()
  resetExplorerClick()
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  api = installApi({
    rows: async (q: RowsQuery) => ({ columns: COLS, rows: DATA.slice(q.offset, q.offset + q.limit), total: DATA.length })
  })
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('TableView: Cmd/Ctrl+R reloads the grid', () => {
  it('reloads from a focused grid cell, preventing the default and keeping offset / limit / filters / sort', async () => {
    await renderTV()
    // apply a filter first; offset / page size stay as they are
    fireEvent.change(whereBox(), { target: { value: 'id > 1' } })
    fireEvent.keyDown(whereBox(), { key: 'Escape' })
    fireEvent.keyDown(whereBox(), { key: 'Enter' })
    await waitFor(() => expect(queries().at(-1)!.where).toBe('id > 1'))
    fireEvent.mouseDown(cell(1, 1), { button: 0 })
    const before = nRows()
    const q0 = queries().at(-1)!
    let notPrevented = true
    await act(async () => { notPrevented = cmdR(grid()) })
    expect(notPrevented).toBe(false) // preventDefault was called
    await waitFor(() => expect(nRows()).toBe(before + 1))
    expect(queries().at(-1)).toEqual(q0)
  })

  it('works with Ctrl+R too', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    const before = nRows()
    await act(async () => void ctrlR(grid()))
    await waitFor(() => expect(nRows()).toBe(before + 1))
  })

  it('works from the WHERE input and keeps the applied (not the typed) filter', async () => {
    await renderTV()
    fireEvent.change(whereBox(), { target: { value: 'id < 3' } })
    fireEvent.keyDown(whereBox(), { key: 'Escape' })
    fireEvent.keyDown(whereBox(), { key: 'Enter' })
    await waitFor(() => expect(queries().at(-1)!.where).toBe('id < 3'))
    whereBox().focus()
    fireEvent.change(whereBox(), { target: { value: 'id < 3 and' } }) // typed, not applied
    const before = nRows()
    await act(async () => void cmdR(whereBox()))
    await waitFor(() => expect(nRows()).toBe(before + 1))
    expect(queries().at(-1)!.where).toBe('id < 3')
  })

  it('works from an open cell editor and drops pending edits like the toolbar button', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(0, 1), { button: 0 })
    fireEvent.keyDown(grid(), { key: 'Enter' })
    const ed = document.querySelector('input.cell-edit') as HTMLInputElement
    fireEvent.change(ed, { target: { value: 'changed' } })
    fireEvent.keyDown(ed, { key: 'Enter' })
    expect(cell(0, 1).textContent).toBe('changed')
    const before = nRows()
    await act(async () => void cmdR(grid()))
    await waitFor(() => expect(nRows()).toBe(before + 1))
    await waitFor(() => expect(cell(0, 1).textContent).toBe('n1'))
  })

  it('works from the toolbar and when nothing is focused (body) without an Explorer click', async () => {
    await renderTV()
    const before = nRows()
    await act(async () => void cmdR(screen.getByTitle(/^Reload/)))
    await waitFor(() => expect(nRows()).toBe(before + 1))
    await act(async () => void cmdR(document.body))
    await waitFor(() => expect(nRows()).toBe(before + 2))
  })

  it('also reloads the Structure tab (columns + indexes)', async () => {
    await renderTV()
    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))
    await waitFor(() => expect(api.indexes).toHaveBeenCalledTimes(1))
    const before = nRows()
    await act(async () => void cmdR(document.body))
    await waitFor(() => expect(nRows()).toBe(before + 1))
    await waitFor(() => expect(api.indexes).toHaveBeenCalledTimes(2))
  })

  it('shows the loading state while reloading', async () => {
    await renderTV()
    let done!: (v: unknown) => void
    api.rows.mockImplementationOnce(() => new Promise((r) => (done = r)))
    await act(async () => void cmdR(grid()))
    await screen.findByText('Loading rows…')
    await act(async () => done({ columns: COLS, rows: DATA.slice(0, 100), total: DATA.length }))
    await waitFor(() => expect(screen.queryByText('Loading rows…')).toBeNull(), { timeout: 1500 })
  })

  it('does one fetch per keystroke (the Explorer handler does not also fire) and ignores key repeat', async () => {
    await renderTV()
    const before = nRows()
    await act(async () => void cmdR(grid()))
    await waitFor(() => expect(nRows()).toBe(before + 1))
    await act(async () => void cmdR(grid(), { repeat: true }))
    await new Promise((r) => setTimeout(r, 30))
    expect(nRows()).toBe(before + 1)
  })

  it('ignores other combos (Shift/Alt+R, plain R, Cmd+T)', async () => {
    await renderTV()
    const before = nRows()
    cmdR(grid(), { shiftKey: true })
    cmdR(grid(), { altKey: true })
    fireEvent.keyDown(grid(), { key: 'r', code: 'KeyR' })
    fireEvent.keyDown(grid(), { key: 't', code: 'KeyT', metaKey: true })
    await new Promise((r) => setTimeout(r, 30))
    expect(nRows()).toBe(before)
  })
})

describe('TableView: Cmd/Ctrl+R with several tabs / dialogs', () => {
  it('inactive tab ignores it, the active one reloads (exactly once)', async () => {
    const ta = fresh()
    const tb = fresh()
    render(<><TableView t={ta} active={false} /><TableView t={tb} active /></>)
    await waitFor(() => expect(api.rows).toHaveBeenCalledTimes(1)) // the inactive tab loads lazily: nothing fetched yet
    expect(queries()[0].table).toBe(tb.table)
    await act(async () => void cmdR(document.body))
    await waitFor(() => expect(api.rows).toHaveBeenCalledTimes(2))
    expect(queries().map((q) => q.table)).toEqual([tb.table, tb.table])
  })

  it('ignores Cmd+R while a modal dialog is open', async () => {
    await renderTV()
    const bg = document.createElement('div')
    bg.className = 'modal-bg'
    document.body.appendChild(bg)
    const before = nRows()
    await act(async () => void cmdR(document.body))
    await new Promise((r) => setTimeout(r, 30))
    expect(nRows()).toBe(before)
    bg.className = 'cd-bg'
    await act(async () => void cmdR(document.body))
    await new Promise((r) => setTimeout(r, 30))
    expect(nRows()).toBe(before)
    bg.remove()
    await act(async () => void cmdR(document.body))
    await waitFor(() => expect(nRows()).toBe(before + 1))
  })

  it('does not reload while a submit is running (the toolbar button is disabled then too)', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(0, 1), { button: 0 })
    fireEvent.keyDown(grid(), { key: 'Enter' })
    fireEvent.change(document.querySelector('input.cell-edit')!, { target: { value: 'z' } })
    fireEvent.keyDown(document.querySelector('input.cell-edit')!, { key: 'Enter' })
    let done!: (v: unknown) => void
    api.apply.mockImplementationOnce(() => new Promise((r) => (done = r)))
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }))
    await waitFor(() => expect(api.apply).toHaveBeenCalled())
    const before = nRows()
    await act(async () => void cmdR(grid()))
    await new Promise((r) => setTimeout(r, 30))
    expect(nRows()).toBe(before)
    await act(async () => done({}))
  })
})

describe('TableView: Cmd+R and the Explorer', () => {
  const ds: DataSource = { id: 'ds1', name: 'Local', host: 'h', port: 5432, user: 'u', password: '', database: 'app', ssl: false }
  const explorerProps = () => ({
    onOpen: vi.fn(), onEdit: vi.fn(), onConsole: vi.fn(), onTableRenamed: vi.fn(), onObjectGone: vi.fn(), onRefreshed: vi.fn(), reloadKey: 0
  })

  async function mountBoth() {
    api.listSources.mockResolvedValue([ds])
    const props = explorerProps()
    const t = fresh()
    render(<><Explorer {...props} /><div id="pane"><TableView t={t} active /></div></>)
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0))
    const label = await screen.findByText('Local')
    return { props, label }
  }

  it('after a click in the tree: Cmd+R refreshes the selected tree node and does NOT reload the grid', async () => {
    const { props, label } = await mountBoth()
    fireEvent.mouseDown(label, { button: 0 })
    fireEvent.click(label)
    const before = nRows()
    await act(async () => void cmdR(document.body))
    expect(props.onRefreshed).toHaveBeenCalledTimes(1)
    expect(props.onRefreshed).toHaveBeenCalledWith('ds1')
    await new Promise((r) => setTimeout(r, 30))
    expect(nRows()).toBe(before)
  })

  it('with focus on an element inside the tree: grid is not reloaded either', async () => {
    const { props, label } = await mountBoth()
    fireEvent.mouseDown(label, { button: 0 })
    fireEvent.click(label)
    const before = nRows()
    await act(async () => void cmdR(label))
    expect(props.onRefreshed).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 30))
    expect(nRows()).toBe(before)
  })

  it('after a click in the grid: Cmd+R reloads the grid once and the tree is not refreshed', async () => {
    const { props, label } = await mountBoth()
    fireEvent.mouseDown(label, { button: 0 })
    fireEvent.click(label) // tree was last clicked...
    fireEvent.mouseDown(cell(0, 0), { button: 0 }) // ...then the user clicks into the grid
    const before = nRows()
    await act(async () => void cmdR(document.body))
    await waitFor(() => expect(nRows()).toBe(before + 1))
    expect(props.onRefreshed).not.toHaveBeenCalled()
  })

  it('even if the tree was clicked last, a keystroke targeted inside the grid reloads the grid, not the tree', async () => {
    const { props, label } = await mountBoth()
    fireEvent.mouseDown(label, { button: 0 })
    fireEvent.click(label)
    const before = nRows()
    await act(async () => void cmdR(grid()))
    await waitFor(() => expect(nRows()).toBe(before + 1))
    expect(props.onRefreshed).not.toHaveBeenCalled()
  })

  it('Ctrl+R in the tree behaves like Cmd+R there', async () => {
    const { props, label } = await mountBoth()
    fireEvent.mouseDown(label, { button: 0 })
    fireEvent.click(label)
    await act(async () => void ctrlR(document.body))
    expect(props.onRefreshed).toHaveBeenCalledWith('ds1')
  })
})
