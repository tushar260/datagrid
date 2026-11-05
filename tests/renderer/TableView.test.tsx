// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TableView from '../../src/renderer/src/TableView'
import type { TableRef } from '../../src/renderer/src/Explorer'
import type { Column, RowsQuery } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

let api: MockApi
let n = 0
let clipboard: string[]
const COLS: Column[] = [
  { name: 'id', type: 'integer', nullable: false, isPk: true },
  { name: 'name', type: 'text', nullable: true, isPk: false },
  { name: 'note', type: 'text', nullable: true, isPk: false }
]
const mkRows = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: 'n' + (i + 1), note: i % 2 ? null : 'x' + (i + 1) }))

let data: Record<string, unknown>[]
let columns: Column[]
const queries = (): RowsQuery[] => api.rows.mock.calls.map((c) => c[0] as RowsQuery)
const lastQuery = (): RowsQuery => queries().at(-1)!

function setup(rowCount = 5, cols: Column[] = COLS): void {
  data = mkRows(rowCount)
  columns = cols
  api = installApi({
    rows: async (q: RowsQuery) => ({ columns, rows: data.slice(q.offset, q.offset + q.limit), total: data.length }),
    indexes: [{ name: 't_pkey', definition: 'CREATE UNIQUE INDEX t_pkey ON t (id)' }]
  })
}
const fresh = (kind = 'table'): TableRef => ({ dsId: 'ds', dsName: 'Local', database: 'app', schema: 'public', table: 't' + ++n, kind })

beforeEach(() => {
  localStorage.clear()
  clipboard = []
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn((s: string) => void clipboard.push(s)) }, configurable: true })
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  setup()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function renderTV(t: TableRef = fresh(), props: Partial<React.ComponentProps<typeof TableView>> = {}) {
  const r = render(<TableView t={t} {...props} />)
  await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0))
  return { ...r, t }
}
const grid = (): HTMLElement => document.querySelector('.gridwrap') as HTMLElement
const bodyRows = (): HTMLElement[] => Array.from(document.querySelectorAll('tbody tr'))
const cell = (r: number, c: number): HTMLElement => bodyRows()[r].querySelectorAll('td')[c + 1] as HTMLElement
const texts = (r: number): string[] => Array.from(bodyRows()[r].querySelectorAll('td')).map((t) => t.textContent!)
const curCell = (): HTMLElement | null => document.querySelector('td.cur')
const key = (k: string, init: Record<string, unknown> = {}): void => void fireEvent.keyDown(grid(), { key: k, ...init })
const editor = (): HTMLInputElement | null => document.querySelector('input.cell-edit')
const click = (el: Element, init: Record<string, unknown> = {}): void => {
  fireEvent.mouseDown(el, { button: 0, ...init })
}
const btn = (title: string | RegExp): HTMLButtonElement => screen.getByTitle(title) as HTMLButtonElement
const submitBtn = (): HTMLButtonElement => screen.getByRole('button', { name: /Submit/ }) as HTMLButtonElement
const rangeLabel = (): HTMLElement => document.querySelector('.range-label') as HTMLElement
const whereBox = (): HTMLInputElement => document.querySelector('.fb-field.where input') as HTMLInputElement
const orderBox = (): HTMLInputElement => document.querySelector('.fb-field.order input') as HTMLInputElement
// the suggestion popup (if open) would swallow Enter: close it first like a user pressing Escape would
const enter = (el: HTMLElement): void => void fireEvent.keyDown(el, { key: 'Enter' })
const enterFilter = (el: HTMLElement): void => {
  fireEvent.keyDown(el, { key: 'Escape' })
  enter(el)
}
const change = (el: HTMLElement, value: string): void => void fireEvent.change(el, { target: { value } })

describe('TableView: loading & display', () => {
  it('fetches page 1 with the default size and renders header, types, rows and gutter numbers', async () => {
    const t = fresh()
    await renderTV(t)
    expect(lastQuery()).toMatchObject({ dsId: 'ds', database: 'app', schema: 'public', table: t.table, limit: 100, offset: 0, where: '', orderExpr: '' })
    expect(Array.from(document.querySelectorAll('thead th')).map((h) => h.textContent)).toEqual(['#', '🔑 idinteger', 'nametext', 'notetext'])
    expect(bodyRows()).toHaveLength(5)
    expect(texts(0)).toEqual(['1', '1', 'n1', 'x1'])
    expect(texts(1)).toEqual(['2', '2', 'n2', 'null'])
    expect(cell(1, 2).classList.contains('null')).toBe(true)
    expect(rangeLabel().textContent).toBe('1-5')
    expect(document.querySelector('.range-total')!.textContent).toContain('of 5')
  })

  it('empty table: range 0-0, label disabled, no rows', async () => {
    setup(0)
    render(<TableView t={fresh()} />)
    await waitFor(() => expect(api.rows).toHaveBeenCalled())
    await waitFor(() => expect(rangeLabel()).toBeTruthy())
    expect(rangeLabel().textContent).toBe('0-0')
    expect(rangeLabel().classList.contains('off')).toBe(true)
    fireEvent.click(rangeLabel())
    expect(document.querySelector('.range-input')).toBeNull()
  })

  it('a load error shows the cleaned message and no hint for unknown errors', async () => {
    api.rows.mockRejectedValueOnce(new Error(`Error invoking remote method 'db:rows': error: permission denied for table x`))
    render(<TableView t={fresh()} />)
    await screen.findByText('Permission denied for table x')
    expect(document.querySelector('.hint-bar')).toBeNull()
  })

  it('inactive restored tabs do not fetch until first shown', async () => {
    const t = fresh()
    const { rerender } = render(<TableView t={t} active={false} />)
    await act(async () => { await Promise.resolve() })
    expect(api.rows).not.toHaveBeenCalled()
    rerender(<TableView t={t} active />)
    await waitFor(() => expect(api.rows).toHaveBeenCalledTimes(1))
  })

  it('views show no edit buttons; typing does not start an edit', async () => {
    await renderTV(fresh('view'))
    expect(screen.queryByTitle(/^Add row/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull()
    click(cell(0, 1))
    key('Enter')
    key('x')
    key('Delete')
    expect(editor()).toBeNull()
  })

  it('no primary key: warning shown; deleting reports it and marks nothing', async () => {
    const noPk = COLS.map((c) => ({ ...c, isPk: false }))
    setup(3, noPk)
    await renderTV()
    expect(screen.getByText(/No primary key: editing existing rows is disabled/)).toBeTruthy()
    click(cell(0, 0))
    key('Delete')
    expect(screen.getByText('Table has no primary key; cannot edit/delete rows')).toBeTruthy()
    expect(document.querySelector('tr.del')).toBeNull()
  })

  it('Structure tab lists columns and fetches indexes; Data tab returns', async () => {
    const t = fresh()
    await renderTV(t)
    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))
    await screen.findByText('t_pkey')
    expect(api.indexes).toHaveBeenCalledWith('ds', 'app', 'public', t.table)
    expect(screen.getAllByText('integer').length).toBeGreaterThan(0)
    expect(screen.getAllByText('yes').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    expect(bodyRows()).toHaveLength(5)
  })

  it('structure tab tolerates an indexes failure', async () => {
    api.indexes.mockRejectedValue(new Error('x'))
    await renderTV()
    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))
    await waitFor(() => expect(api.indexes).toHaveBeenCalled())
    expect(screen.getByText('Indexes')).toBeTruthy()
  })
})

describe('TableView: cell keyboard navigation', () => {
  it('arrows move the current cell and clamp at the edges', async () => {
    await renderTV()
    click(cell(0, 0))
    expect(curCell()).toBe(cell(0, 0))
    key('ArrowRight'); expect(curCell()).toBe(cell(0, 1))
    key('ArrowDown'); expect(curCell()).toBe(cell(1, 1))
    key('ArrowLeft'); key('ArrowLeft'); expect(curCell()).toBe(cell(1, 0))
    key('ArrowUp'); key('ArrowUp'); expect(curCell()).toBe(cell(0, 0))
    for (let i = 0; i < 10; i++) key('ArrowDown')
    expect(curCell()).toBe(cell(4, 0))
    for (let i = 0; i < 10; i++) key('ArrowRight')
    expect(curCell()).toBe(cell(4, 2))
  })

  it('Home/End jump within the row; Cmd+Up/Down jump to first/last row; Cmd+Home/End to corners', async () => {
    await renderTV()
    click(cell(2, 1))
    key('Home'); expect(curCell()).toBe(cell(2, 0))
    key('End'); expect(curCell()).toBe(cell(2, 2))
    key('ArrowUp', { metaKey: true }); expect(curCell()).toBe(cell(0, 2))
    key('ArrowDown', { ctrlKey: true }); expect(curCell()).toBe(cell(4, 2))
    key('Home', { metaKey: true }); expect(curCell()).toBe(cell(0, 0))
    key('End', { metaKey: true }); expect(curCell()).toBe(cell(4, 2))
  })

  it('PageUp / PageDown move by a page (clamped)', async () => {
    await renderTV()
    Object.defineProperty(grid(), 'clientHeight', { value: 88, configurable: true }) // (88/22)-1 = 3 rows
    click(cell(0, 0))
    key('PageDown'); expect(curCell()).toBe(cell(3, 0))
    key('PageDown'); expect(curCell()).toBe(cell(4, 0))
    key('PageUp'); expect(curCell()).toBe(cell(1, 0))
    key('PageUp'); expect(curCell()).toBe(cell(0, 0))
  })

  it('Tab walks cells row-major, wrapping to the next row; Shift+Tab goes back; leaves the grid at the ends', async () => {
    await renderTV()
    click(cell(0, 2))
    key('Tab'); expect(curCell()).toBe(cell(1, 0))
    key('Tab', { shiftKey: true }); expect(curCell()).toBe(cell(0, 2))
    click(cell(0, 0))
    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    grid().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false) // focus is allowed to leave
    click(cell(4, 2))
    const ev2 = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    grid().dispatchEvent(ev2)
    expect(ev2.defaultPrevented).toBe(false)
  })

  it('arrow keys are consumed (preventDefault) so the grid does not scroll natively', async () => {
    await renderTV()
    click(cell(0, 0))
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    grid().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('keys typed inside inputs/buttons are ignored by the grid handler', async () => {
    await renderTV()
    click(cell(0, 0))
    fireEvent.keyDown(whereBox(), { key: 'ArrowDown' })
    expect(curCell()).toBe(cell(0, 0))
  })

  it('Cmd/Ctrl+C copies the current value (edited value when pending); empty for null', async () => {
    await renderTV()
    click(cell(0, 1))
    key('c', { metaKey: true })
    expect(clipboard).toEqual(['n1'])
    click(cell(1, 2))
    key('c', { ctrlKey: true })
    expect(clipboard).toEqual(['n1', ''])
  })

  it('right-click copies the cell value', async () => {
    await renderTV()
    fireEvent.contextMenu(cell(2, 1))
    expect(clipboard).toEqual(['n3'])
  })
})

describe('TableView: editing', () => {
  it('Enter / F2 / double-click open an editor with the content selected', async () => {
    await renderTV()
    click(cell(0, 1))
    key('Enter')
    expect(editor()!.value).toBe('n1')
    expect(document.activeElement).toBe(editor())
    key('Escape') // not handled by the grid while the editor owns focus...
    fireEvent.keyDown(editor()!, { key: 'Escape' })
    expect(editor()).toBeNull()
    click(cell(1, 1))
    key('F2')
    expect(editor()!.value).toBe('n2')
    fireEvent.keyDown(editor()!, { key: 'Escape' })
    fireEvent.doubleClick(cell(2, 1))
    expect(editor()!.value).toBe('n3')
  })

  it('typing a character replaces the content with that character', async () => {
    await renderTV()
    click(cell(0, 1))
    key('z')
    expect(editor()!.value).toBe('z')
    expect(editor()!.selectionStart).toBe(1)
  })

  it('modifier combos do not start an edit', async () => {
    await renderTV()
    click(cell(0, 1))
    key('z', { metaKey: true })
    key('z', { altKey: true })
    expect(editor()).toBeNull()
  })

  it('Enter commits and moves down; Shift+Enter moves up; Tab moves right; Escape cancels', async () => {
    await renderTV()
    click(cell(1, 1))
    key('Enter')
    change(editor()!, 'edited')
    fireEvent.keyDown(editor()!, { key: 'Enter' })
    expect(editor()).toBeNull()
    expect(cell(1, 1).textContent).toBe('edited')
    expect(cell(1, 1).classList.contains('changed')).toBe(true)
    expect(curCell()).toBe(cell(2, 1))
    key('Enter')
    change(editor()!, 'e2')
    fireEvent.keyDown(editor()!, { key: 'Enter', shiftKey: true })
    expect(curCell()).toBe(cell(1, 1))
    click(cell(3, 1))
    key('Enter')
    change(editor()!, 'e3')
    fireEvent.keyDown(editor()!, { key: 'Tab' })
    expect(curCell()).toBe(cell(3, 2))
    expect(cell(3, 1).textContent).toBe('e3')
    key('Enter')
    change(editor()!, 'discard me')
    fireEvent.keyDown(editor()!, { key: 'Escape' })
    expect(cell(3, 2).textContent).toBe('null') // untouched (row 4's note is NULL)
  })

  it('editing back to the original value clears the pending change', async () => {
    await renderTV()
    click(cell(0, 1))
    key('Enter'); change(editor()!, 'other'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    expect(submitBtn().disabled).toBe(false)
    click(cell(0, 1))
    key('Enter'); change(editor()!, 'n1'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    expect(cell(0, 1).classList.contains('changed')).toBe(false)
    expect(submitBtn().disabled).toBe(true)
  })

  it('"<null>" sets NULL', async () => {
    await renderTV()
    click(cell(0, 1))
    key('Enter'); change(editor()!, '<null>'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    expect(cell(0, 1).textContent).toBe('null')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(api.apply).toHaveBeenCalled())
    expect(api.apply.mock.calls[0][4].updates).toEqual([{ pk: { id: '1' }, set: { name: null } }])
  })

  it('blur commits the typed text', async () => {
    await renderTV()
    click(cell(0, 1))
    key('Enter')
    change(editor()!, 'blurred')
    fireEvent.blur(editor()!)
    expect(cell(0, 1).textContent).toBe('blurred')
  })

  it('left/right/Home/End stay inside the editor and do not move the cell', async () => {
    await renderTV()
    click(cell(0, 1))
    key('Enter')
    fireEvent.keyDown(editor()!, { key: 'ArrowRight' })
    fireEvent.keyDown(editor()!, { key: 'Home' })
    expect(editor()).not.toBeNull()
    expect(curCell()).toBe(cell(0, 1))
  })

  it('ArrowDown / ArrowUp in the editor commit and move', async () => {
    await renderTV()
    click(cell(1, 1))
    key('Enter'); change(editor()!, 'a'); fireEvent.keyDown(editor()!, { key: 'ArrowDown' })
    expect(curCell()).toBe(cell(2, 1))
    key('Enter'); change(editor()!, 'b'); fireEvent.keyDown(editor()!, { key: 'ArrowUp' })
    expect(curCell()).toBe(cell(1, 1))
  })
})

describe('TableView: submit / revert', () => {
  it('Submit sends updates with pk values from the ORIGINAL row, then reloads', async () => {
    await renderTV()
    click(cell(2, 1))
    key('Enter'); change(editor()!, 'THREE'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    const calls0 = api.rows.mock.calls.length
    fireEvent.click(submitBtn())
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1))
    expect(api.apply).toHaveBeenCalledWith('ds', 'app', 'public', expect.stringMatching(/^t\d+$/), {
      updates: [{ pk: { id: '3' }, set: { name: 'THREE' } }], inserts: [], deletes: []
    })
    await waitFor(() => expect(api.rows.mock.calls.length).toBe(calls0 + 1))
    await waitFor(() => expect(submitBtn().disabled).toBe(true)) // pending cleared by the reload
  })

  it('Cmd/Ctrl+Enter commits an open edit and submits in one go', async () => {
    await renderTV()
    click(cell(0, 1))
    key('Enter')
    change(editor()!, 'quick')
    fireEvent.keyDown(editor()!, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1))
    expect(api.apply.mock.calls[0][4].updates).toEqual([{ pk: { id: '1' }, set: { name: 'quick' } }])
  })

  it('Ctrl+Enter from the grid submits pending changes; with nothing pending it does nothing', async () => {
    await renderTV()
    key('Enter', { ctrlKey: true })
    expect(api.apply).not.toHaveBeenCalled()
    click(cell(0, 1)); key('Enter'); change(editor()!, 'q'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    key('Enter', { ctrlKey: true })
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1))
  })

  it('shows "Submitting…" and ignores a second submit while in flight', async () => {
    let done!: () => void
    api.apply.mockImplementation(() => new Promise<void>((r) => (done = r)))
    await renderTV()
    click(cell(0, 1)); key('Enter'); change(editor()!, 'q'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    fireEvent.click(submitBtn())
    await screen.findByText(/Submitting…/)
    expect(submitBtn().disabled).toBe(true)
    key('Enter', { metaKey: true })
    expect(api.apply).toHaveBeenCalledTimes(1)
    done()
    await waitFor(() => expect(screen.queryByText(/Submitting…/)).toBeNull())
  })

  it('a failed submit keeps the pending edits and shows the server error', async () => {
    api.apply.mockRejectedValueOnce(new Error('Error invoking remote method \'db:apply\': Error: duplicate key value violates unique constraint "t_pkey"'))
    await renderTV()
    click(cell(0, 1)); key('Enter'); change(editor()!, 'q'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    fireEvent.click(submitBtn())
    await screen.findByText(/Duplicate key value violates unique constraint/)
    expect(cell(0, 1).textContent).toBe('q')
    expect(submitBtn().disabled).toBe(false)
  })

  it('Revert drops pending edits, deletes and inserts', async () => {
    await renderTV()
    click(cell(0, 1)); key('Enter'); change(editor()!, 'q'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    click(cell(2, 0)); key('Delete')
    fireEvent.click(btn(/^Add row/))
    fireEvent.blur(editor()!)
    expect(document.querySelector('tr.del')).not.toBeNull()
    fireEvent.click(btn('Revert'))
    expect(cell(0, 1).textContent).toBe('n1')
    expect(document.querySelector('tr.del')).toBeNull()
    expect(document.querySelector('tr.new')).toBeNull()
    expect(submitBtn().disabled).toBe(true)
  })

  it('Revert/Submit are enabled while an editor is open even if nothing is pending', async () => {
    await renderTV()
    click(cell(0, 1)); key('Enter')
    expect(submitBtn().disabled).toBe(false)
    expect(btn('Revert').disabled).toBe(false)
  })

  it('the Reload button re-fetches and drops pending edits', async () => {
    await renderTV()
    click(cell(0, 1)); key('Enter'); change(editor()!, 'q'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    const c0 = api.rows.mock.calls.length
    fireEvent.click(btn(/^Reload/))
    await waitFor(() => expect(api.rows.mock.calls.length).toBe(c0 + 1))
    await waitFor(() => expect(cell(0, 1).textContent).toBe('n1'))
  })
})

describe('TableView: add / delete rows', () => {
  it('Add row appends a "new" row, focuses its first cell in edit mode; Tab moves on; submit sends only typed columns', async () => {
    await renderTV()
    fireEvent.click(btn(/^Add row/))
    expect(document.querySelectorAll('tr.new')).toHaveLength(1)
    expect(editor()).not.toBeNull()
    expect(document.activeElement).toBe(editor())
    expect(bodyRows()[5].querySelector('td.rn')!.textContent).toBe('＋')
    change(editor()!, '99')
    fireEvent.keyDown(editor()!, { key: 'Tab' })
    expect(curCell()).toBe(cell(5, 1))
    key('Enter'); change(editor()!, 'new name'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(api.apply).toHaveBeenCalled())
    expect(api.apply.mock.calls[0][4]).toEqual({ updates: [], inserts: [{ id: '99', name: 'new name' }], deletes: [] })
  })

  it('adding while an edit is open commits that edit first', async () => {
    await renderTV()
    click(cell(0, 1)); key('Enter'); change(editor()!, 'kept')
    fireEvent.click(btn(/^Add row/))
    expect(cell(0, 1).textContent).toBe('kept')
  })

  it('"-" marks the selected row deleted (strike class), toggles back off, and clears the selection', async () => {
    await renderTV()
    click(cell(1, 0))
    fireEvent.click(btn(/^Delete/))
    expect(bodyRows()[1].classList.contains('del')).toBe(true)
    expect(curCell()).toBeNull()
    expect(btn(/^Delete/).disabled).toBe(true)
    click(cell(1, 0))
    key('Delete')
    expect(bodyRows()[1].classList.contains('del')).toBe(false) // all selected already deleted -> toggled off
  })

  it('submitting deletes sends pk values of each marked row', async () => {
    await renderTV()
    click(cell(0, 0)); key('Backspace')
    click(cell(2, 0)); key('Delete')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(api.apply).toHaveBeenCalled())
    expect(api.apply.mock.calls[0][4].deletes).toEqual([{ id: '1' }, { id: '3' }])
  })

  it('deleting a pending-insert row just drops it', async () => {
    await renderTV()
    fireEvent.click(btn(/^Add row/))
    fireEvent.blur(editor()!)
    key('Delete')
    expect(document.querySelector('tr.new')).toBeNull()
    expect(submitBtn().disabled).toBe(true)
  })

  it('Cmd/Ctrl+Backspace deletes the selected row', async () => {
    await renderTV()
    click(cell(0, 0))
    key('Backspace', { metaKey: true })
    expect(bodyRows()[0].classList.contains('del')).toBe(true)
  })

  it('Cmd-click on "-" deletes the selection and submits immediately', async () => {
    await renderTV()
    click(cell(1, 0))
    fireEvent.click(btn(/^Delete/), { metaKey: true })
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1))
    expect(api.apply.mock.calls[0][4]).toEqual({ updates: [], inserts: [], deletes: [{ id: '2' }] })
  })

  it('Cmd-click delete+submit keeps the pending delete when the server rejects it', async () => {
    api.apply.mockRejectedValueOnce(new Error('violates foreign key constraint'))
    await renderTV()
    click(cell(1, 0))
    fireEvent.click(btn(/^Delete/), { ctrlKey: true })
    await screen.findByText(/violates foreign key constraint/i)
    expect(bodyRows()[1].classList.contains('del')).toBe(true)
  })

  it('Cmd-click on "-" in a table without a primary key does not submit', async () => {
    setup(3, COLS.map((c) => ({ ...c, isPk: false })))
    await renderTV()
    click(cell(0, 0))
    fireEvent.click(btn(/^Delete/), { metaKey: true })
    expect(api.apply).not.toHaveBeenCalled()
  })
})

describe('TableView: Cmd/Ctrl+N adds a row', () => {
  it('works from the grid, from the WHERE box and from an open cell editor', async () => {
    await renderTV()
    click(cell(0, 0))
    key('n', { metaKey: true })
    expect(document.querySelectorAll('tr.new')).toHaveLength(1)
    expect(editor()).not.toBeNull()
    fireEvent.keyDown(editor()!, { key: 'n', ctrlKey: true })
    expect(document.querySelectorAll('tr.new')).toHaveLength(2)
    fireEvent.keyDown(whereBox(), { key: 'N', ctrlKey: true })
    expect(document.querySelectorAll('tr.new')).toHaveLength(3)
  })

  it('Shift/Alt variants and plain "n" are not add-row (plain n starts an edit)', async () => {
    await renderTV()
    click(cell(0, 1))
    key('n', { metaKey: true, shiftKey: true })
    key('n', { metaKey: true, altKey: true })
    expect(document.querySelector('tr.new')).toBeNull()
    key('n')
    expect(editor()!.value).toBe('n')
  })

  it('is ignored for views, while a modal is open, while submitting and in the Structure tab', async () => {
    await renderTV(fresh('view'))
    key('n', { metaKey: true })
    expect(document.querySelector('tr.new')).toBeNull()
    cleanup()
    await renderTV()
    const modal = document.createElement('div')
    modal.className = 'modal-bg'
    document.body.appendChild(modal)
    key('n', { metaKey: true })
    expect(document.querySelector('tr.new')).toBeNull()
    modal.remove()
    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))
    fireEvent.keyDown(document.querySelector('.tableview')!, { key: 'n', metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    expect(document.querySelector('tr.new')).toBeNull()
  })

  it('with focus on <body> (e.g. after a dialog closed) the active tab still adds a row; inactive tabs do not', async () => {
    await renderTV()
    fireEvent.keyDown(document.body, { key: 'n', metaKey: true })
    expect(document.querySelectorAll('tr.new')).toHaveLength(1)
    cleanup()
    const t = fresh()
    render(<TableView t={t} active={false} />)
    fireEvent.keyDown(document.body, { key: 'n', metaKey: true })
    expect(document.querySelector('tr.new')).toBeNull()
  })

  it('body-level Cmd+N is ignored when a create dialog (.cd-bg) is open', async () => {
    await renderTV()
    const d = document.createElement('div')
    d.className = 'cd-bg'
    document.body.appendChild(d)
    fireEvent.keyDown(document.body, { key: 'n', metaKey: true })
    expect(document.querySelector('tr.new')).toBeNull()
    d.remove()
  })

  it('the Add row button advertises the shortcut', async () => {
    await renderTV()
    expect(btn(/^Add row \((Ctrl\+N|⌘N)\)$/)).toBeTruthy()
  })
})

describe('TableView: multi-row selection', () => {
  const sel = (): number[] => bodyRows().map((r, i) => (r.classList.contains('sel') ? i : -1)).filter((i) => i >= 0)
  const gutter = (r: number): Element => bodyRows()[r].querySelector('td.rn')!

  it('plain click selects one row; Shift+click selects a range from the anchor', async () => {
    await renderTV()
    click(gutter(1))
    expect(sel()).toEqual([1])
    click(gutter(3), { shiftKey: true })
    expect(sel()).toEqual([1, 2, 3])
    click(gutter(0), { shiftKey: true })
    expect(sel()).toEqual([0, 1])
  })

  it('Cmd/Ctrl+click toggles individual rows (also non-contiguous)', async () => {
    await renderTV()
    click(gutter(0))
    click(gutter(2), { metaKey: true })
    click(gutter(4), { ctrlKey: true })
    expect(sel()).toEqual([0, 2, 4])
    click(gutter(2), { metaKey: true })
    expect(sel()).toEqual([0, 4])
  })

  it('toggling off the last selected row clears the selection', async () => {
    await renderTV()
    click(gutter(1))
    click(gutter(1), { metaKey: true })
    expect(sel()).toEqual([])
    expect(btn(/^Delete/).disabled).toBe(true)
  })

  it('Shift+Arrow extends the selection from the anchor; plain arrows collapse it', async () => {
    await renderTV()
    click(cell(1, 0))
    key('ArrowDown', { shiftKey: true })
    key('ArrowDown', { shiftKey: true })
    expect(sel()).toEqual([1, 2, 3])
    key('ArrowUp', { shiftKey: true })
    expect(sel()).toEqual([1, 2])
    key('ArrowDown')
    expect(sel()).toEqual([3])
  })

  it('Cmd/Ctrl+A selects every row; the delete button says how many', async () => {
    await renderTV()
    click(cell(0, 0))
    key('a', { metaKey: true })
    expect(sel()).toEqual([0, 1, 2, 3, 4])
    expect(btn(/^Delete 5 rows/)).toBeTruthy()
  })

  it('"-" on a multi-selection marks all of them; Delete key too', async () => {
    await renderTV()
    click(gutter(0))
    click(gutter(3), { shiftKey: true })
    fireEvent.click(btn(/^Delete 4 rows/))
    expect(Array.from(document.querySelectorAll('tbody tr.del'))).toHaveLength(4)
  })

  it('Cmd-click "-" with 3 selected rows deletes them in ONE apply call', async () => {
    await renderTV()
    click(gutter(0))
    click(gutter(2), { shiftKey: true })
    fireEvent.click(btn(/^Delete 3 rows/), { metaKey: true })
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1))
    expect(api.apply.mock.calls[0][4].deletes).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }])
  })

  it('selection can span loaded rows and pending-insert rows', async () => {
    await renderTV()
    fireEvent.click(btn(/^Add row/))
    fireEvent.blur(editor()!)
    click(gutter(4))
    click(gutter(5), { shiftKey: true })
    expect(bodyRows()[4].classList.contains('sel')).toBe(true)
    expect(bodyRows()[5].classList.contains('sel')).toBe(true)
    key('Delete')
    expect(document.querySelector('tr.new')).toBeNull()
    expect(bodyRows()[4].classList.contains('del')).toBe(true)
  })

  it('a reload resets the selection', async () => {
    await renderTV()
    click(gutter(0)); click(gutter(2), { shiftKey: true })
    fireEvent.click(btn(/^Reload/))
    await waitFor(() => expect(sel()).toEqual([]))
  })
})

describe('TableView: Escape removes the row selection', () => {
  const sel = (): number[] => bodyRows().map((r, i) => (r.classList.contains('sel') ? i : -1)).filter((i) => i >= 0)
  const gutter = (r: number): Element => bodyRows()[r].querySelector('td.rn')!

  it('clears a single selected row but keeps the cell cursor; "-" becomes disabled', async () => {
    await renderTV()
    click(cell(1, 1))
    expect(sel()).toEqual([1])
    expect(btn(/^Delete/).disabled).toBe(false)
    key('Escape')
    expect(sel()).toEqual([])
    expect(curCell()).toBe(cell(1, 1))
    expect(btn(/^Delete/).disabled).toBe(true)
  })

  it('clears a multi-selection entirely', async () => {
    await renderTV()
    click(gutter(0))
    click(gutter(3), { shiftKey: true })
    expect(sel()).toEqual([0, 1, 2, 3])
    key('Escape')
    expect(sel()).toEqual([])
    expect(btn(/^Delete/).disabled).toBe(true)
  })

  it('Delete / Cmd+Backspace do nothing after Escape (no hidden selection is deleted)', async () => {
    await renderTV()
    click(cell(1, 0))
    key('Escape')
    key('Delete')
    key('Backspace', { metaKey: true })
    expect(document.querySelector('tr.del')).toBeNull()
  })

  it('arrow keys keep working from the cursor and re-establish a selection', async () => {
    await renderTV()
    click(cell(1, 0))
    key('Escape')
    key('ArrowDown')
    expect(curCell()).toBe(cell(2, 0))
    expect(sel()).toEqual([2])
    expect(btn(/^Delete/).disabled).toBe(false)
  })

  it('a click, Shift+Arrow, Cmd+A or adding a row select again after Escape', async () => {
    await renderTV()
    click(cell(1, 0))
    key('Escape')
    click(cell(3, 0))
    expect(sel()).toEqual([3])
    key('Escape')
    key('a', { metaKey: true })
    expect(sel()).toEqual([0, 1, 2, 3, 4])
    key('Escape')
    key('ArrowDown', { shiftKey: true })
    expect(sel().length).toBeGreaterThan(0)
    key('Escape')
    fireEvent.click(btn(/^Add row/))
    expect(sel()).toEqual([5])
  })

  it('Cmd+click after Escape starts a fresh selection (the hidden row is not toggled in)', async () => {
    await renderTV()
    click(gutter(1))
    key('Escape')
    click(gutter(3), { metaKey: true })
    expect(sel()).toEqual([3])
  })

  it('while editing, the first Escape only cancels the edit; the next one clears the selection', async () => {
    await renderTV()
    click(cell(1, 1))
    key('Enter')
    change(editor()!, 'discard')
    fireEvent.keyDown(editor()!, { key: 'Escape' })
    expect(editor()).toBeNull()
    expect(cell(1, 1).textContent).toBe('n2')
    expect(sel()).toEqual([1])
    key('Escape')
    expect(sel()).toEqual([])
  })

  it('Shift+Escape (sidebar toggle) and modified Escape leave the selection alone', async () => {
    await renderTV()
    click(cell(1, 0))
    key('Escape', { shiftKey: true })
    key('Escape', { metaKey: true })
    expect(sel()).toEqual([1])
  })

  it('nothing selected: Escape is not consumed (bubbles on)', async () => {
    await renderTV()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    grid().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    click(cell(0, 0))
    const ev2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    grid().dispatchEvent(ev2)
    expect(ev2.defaultPrevented).toBe(true)
  })

  it('Escape in the range editor only closes the editor; in WHERE / ORDER BY it does not touch the grid selection', async () => {
    setup(250)
    await renderTV()
    click(cell(1, 0))
    fireEvent.click(rangeLabel())
    fireEvent.keyDown(document.querySelector('.range-input')!, { key: 'Escape' })
    expect(document.querySelector('.range-input')).toBeNull()
    expect(sel()).toEqual([1])
    fireEvent.keyDown(whereBox(), { key: 'Escape' })
    fireEvent.keyDown(orderBox(), { key: 'Escape' })
    expect(sel()).toEqual([1])
  })

  it('a suggestion popup swallows Escape (closes only the popup)', async () => {
    await renderTV()
    click(cell(1, 0))
    whereBox().focus()
    change(whereBox(), 'i')
    fireEvent.keyDown(whereBox(), { key: 'ArrowDown' })
    fireEvent.keyDown(whereBox(), { key: 'Escape' })
    expect(sel()).toEqual([1])
  })

  it('an inactive tab ignores Escape (and never loaded, so there is nothing to clear)', async () => {
    const { rerender } = render(<TableView t={fresh()} active={false} />)
    fireEvent.keyDown(document.querySelector('.tableview')!, { key: 'Escape' })
    expect(document.querySelector('tr.sel')).toBeNull()
    rerender(<TableView t={fresh()} active={false} />)
  })
})

describe('TableView: paging & range editor', () => {
  beforeEach(() => setup(250))

  it('buttons page by the page size; first/prev disabled at the start, next/last at the end', async () => {
    await renderTV()
    expect(rangeLabel().textContent).toBe('1-100')
    expect(screen.getByText('⏮').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByText('▶'))
    await waitFor(() => expect(rangeLabel().textContent).toBe('101-200'))
    expect(lastQuery()).toMatchObject({ offset: 100, limit: 100 })
    expect(texts(0)[0]).toBe('101')
    fireEvent.click(screen.getByText('⏭'))
    await waitFor(() => expect(rangeLabel().textContent).toBe('151-250'))
    expect(screen.getByText('▶').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByText('◀'))
    await waitFor(() => expect(rangeLabel().textContent).toBe('51-150'))
    fireEvent.click(screen.getByText('⏮'))
    await waitFor(() => expect(rangeLabel().textContent).toBe('1-100'))
  })

  it('page-size select: preset options and changing it re-fetches', async () => {
    await renderTV()
    const sel = document.querySelector('.toolbar select') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(['50', '100', '500', '1000'])
    fireEvent.change(sel, { target: { value: '50' } })
    await waitFor(() => expect(lastQuery().limit).toBe(50))
    expect(bodyRows()).toHaveLength(50)
  })

  const openRange = async (): Promise<HTMLInputElement> => {
    fireEvent.click(rangeLabel())
    const input = document.querySelector('.range-input') as HTMLInputElement
    expect(input).toBeTruthy()
    return input
  }
  const type = (input: HTMLInputElement, v: string): void => change(input, v)

  it('clicking the label opens an editor prefilled with the current range, focused', async () => {
    await renderTV()
    const input = await openRange()
    expect(input.value).toBe('1-100')
    expect(document.activeElement).toBe(input)
  })

  it('"101-150" sets offset 100 / limit 50 and shows a custom page-size option; gutter numbers follow the offset', async () => {
    await renderTV()
    const input = await openRange()
    type(input, '101-150')
    enter(input)
    await waitFor(() => expect(lastQuery()).toMatchObject({ offset: 100, limit: 50 }))
    await waitFor(() => expect(texts(0)[0]).toBe('101'))
    expect(texts(49)[0]).toBe('150')
    expect(rangeLabel().textContent).toBe('101-150')
    const sel = document.querySelector('.toolbar select') as HTMLSelectElement
    expect(Array.from(sel.options).some((o) => o.textContent === '50')).toBe(true)
  })

  it('a custom size appears as "custom (N)" and is selected', async () => {
    await renderTV()
    const input = await openRange()
    type(input, '1-75')
    enter(input)
    await waitFor(() => expect(lastQuery().limit).toBe(75))
    const sel = document.querySelector('.toolbar select') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(['50', 'custom (75)', '100', '500', '1000'])
    expect(sel.value).toBe('75')
  })

  it('"200" alone keeps the page size and starts at row 200; "200-" likewise', async () => {
    await renderTV()
    let input = await openRange()
    type(input, '200'); enter(input)
    await waitFor(() => expect(lastQuery()).toMatchObject({ offset: 199, limit: 100 }))
    input = await openRange()
    type(input, '10-'); enter(input)
    await waitFor(() => expect(lastQuery()).toMatchObject({ offset: 9, limit: 100 }))
  })

  it('end past the total is clamped to the total', async () => {
    await renderTV()
    const input = await openRange()
    type(input, '200-9999'); enter(input)
    await waitFor(() => expect(lastQuery()).toMatchObject({ offset: 199, limit: 51 }))
  })

  it.each([
    ['abc', /Use e\.g\./],
    ['0-10', /at least 1/],
    ['500', /past the end \(250\)/],
    ['50-10', /End row must be at least/]
  ])('invalid %j: error shown, editor stays open, no fetch', async (text, msg) => {
    await renderTV()
    const before = api.rows.mock.calls.length
    const input = await openRange()
    type(input, text)
    enter(input)
    expect(document.querySelector('.range-err')!.textContent).toMatch(msg)
    expect(document.querySelector('.range-input')!.classList.contains('bad')).toBe(true)
    expect(api.rows.mock.calls.length).toBe(before)
  })

  it('more than 10000 rows at once is refused', async () => {
    setup(30000)
    await renderTV()
    const input = await openRange()
    type(input, '1-10001'); enter(input)
    expect(document.querySelector('.range-err')!.textContent).toMatch(/At most 10000/)
    type(document.querySelector('.range-input') as HTMLInputElement, '1-10000'); enter(document.querySelector('.range-input')!)
    await waitFor(() => expect(lastQuery()).toMatchObject({ offset: 0, limit: 10000 }))
  })

  it('typing clears the error; Escape closes without changes; blur with invalid text cancels leniently', async () => {
    await renderTV()
    let input = await openRange()
    type(input, 'zzz'); enter(input)
    expect(document.querySelector('.range-err')).not.toBeNull()
    type(document.querySelector('.range-input') as HTMLInputElement, '5')
    expect(document.querySelector('.range-err')).toBeNull()
    fireEvent.keyDown(document.querySelector('.range-input')!, { key: 'Escape' })
    expect(document.querySelector('.range-input')).toBeNull()
    input = await openRange()
    type(input, 'zzz')
    fireEvent.blur(input)
    expect(document.querySelector('.range-input')).toBeNull()
    expect(document.querySelector('.range-err')).toBeNull()
  })

  it('blur with a valid range applies it', async () => {
    await renderTV()
    const input = await openRange()
    type(input, '11-20')
    fireEvent.blur(input)
    await waitFor(() => expect(lastQuery()).toMatchObject({ offset: 10, limit: 10 }))
  })

  it('unchanged range just closes the editor without a fetch', async () => {
    await renderTV()
    const before = api.rows.mock.calls.length
    const input = await openRange()
    enter(input)
    expect(document.querySelector('.range-input')).toBeNull()
    expect(api.rows.mock.calls.length).toBe(before)
  })

  it('Cmd/Ctrl+G focuses the range editor (opening it)', async () => {
    await renderTV()
    fireEvent.keyDown(window, { key: 'g', metaKey: true })
    const input = document.querySelector('.range-input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(window, { key: 'g', metaKey: true, shiftKey: true }) // other combos are ignored
  })

  it('Cmd+G is ignored by inactive tabs', async () => {
    render(<TableView t={fresh()} active={false} />)
    fireEvent.keyDown(window, { key: 'g', metaKey: true })
    expect(document.querySelector('.range-input')).toBeNull()
    expect(api.rows).not.toHaveBeenCalled()
  })

  it('a stale offset past the end jumps to the last page', async () => {
    data = mkRows(250)
    localStorage.clear()
    const t = fresh()
    // simulate a restored session with an offset beyond the data
    const { setTableView, tableKey } = await import('../../src/renderer/src/session')
    setTableView(tableKey(t), { page: 0, pageSize: 100, offset: 900, sort: null, where: '', orderExpr: '' })
    render(<TableView t={t} />)
    await waitFor(() => expect(lastQuery()).toMatchObject({ offset: 150, limit: 100 }))
  })

  it('remembers its view state per table and restores it on remount', async () => {
    const t = fresh()
    const first = await renderTV(t)
    const input = await openRange()
    type(input, '51-100'); enter(input)
    await waitFor(() => expect(lastQuery()).toMatchObject({ offset: 50, limit: 50 }))
    first.unmount()
    api.rows.mockClear()
    render(<TableView t={t} />)
    await waitFor(() => expect(api.rows).toHaveBeenCalled())
    expect(lastQuery()).toMatchObject({ offset: 50, limit: 50 })
  })
})

describe('TableView: WHERE / ORDER BY / sorting', () => {
  it('Enter in WHERE applies it (and resets to the first page)', async () => {
    await renderTV()
    change(whereBox(), 'id > 2')
    expect(lastQuery().where).toBe('')
    enterFilter(whereBox())
    await waitFor(() => expect(lastQuery()).toMatchObject({ where: 'id > 2', offset: 0 }))
  })

  it('Enter in ORDER BY applies both boxes; orderExpr replaces any header sort', async () => {
    await renderTV()
    fireEvent.click(screen.getByText('name').closest('th')!)
    await waitFor(() => expect(lastQuery().orderBy).toEqual({ column: 'name', desc: false }))
    change(orderBox(), 'id desc')
    enterFilter(orderBox())
    await waitFor(() => expect(lastQuery().orderExpr).toBe('id desc'))
    expect(lastQuery().orderBy).toBeUndefined()
    expect(document.querySelector('.sortmark')).toBeNull()
  })

  it('Cmd+Enter in a filter box does not apply it (that is Submit)', async () => {
    await renderTV()
    change(whereBox(), 'id > 2')
    const before = api.rows.mock.calls.length
    fireEvent.keyDown(whereBox(), { key: 'Enter', metaKey: true })
    expect(api.rows.mock.calls.length).toBe(before)
  })

  it('header click cycles asc -> desc -> none, shows the marker, and clears the ORDER BY box', async () => {
    await renderTV()
    const th = (): HTMLElement => screen.getByText('name').closest('th') as HTMLElement
    fireEvent.click(th())
    await waitFor(() => expect(lastQuery().orderBy).toEqual({ column: 'name', desc: false }))
    expect(th().querySelector('.sortmark')!.textContent).toBe(' ▲')
    fireEvent.click(th())
    await waitFor(() => expect(lastQuery().orderBy).toEqual({ column: 'name', desc: true }))
    expect(th().querySelector('.sortmark')!.textContent).toBe(' ▼')
    fireEvent.click(th())
    await waitFor(() => expect(lastQuery().orderBy).toBeUndefined())
    expect(th().querySelector('.sortmark')).toBeNull()
    // switching column restarts at ascending
    fireEvent.click(th())
    fireEvent.click(screen.getByText('note').closest('th')!)
    await waitFor(() => expect(lastQuery().orderBy).toEqual({ column: 'note', desc: false }))
  })

  it('clicking a header after typing an ORDER BY makes the header sort win (clears the box)', async () => {
    await renderTV()
    change(orderBox(), 'id desc')
    enterFilter(orderBox())
    await waitFor(() => expect(lastQuery().orderExpr).toBe('id desc'))
    fireEvent.click(screen.getByText('name').closest('th')!)
    await waitFor(() => expect(lastQuery()).toMatchObject({ orderExpr: '', orderBy: { column: 'name', desc: false } }))
    expect(orderBox().value).toBe('')
  })

  it('a bad WHERE shows the error banner, keeps previous rows hidden out, and the box keeps its text', async () => {
    api.rows.mockImplementation(async (q: RowsQuery) => {
      if (q.where) throw new Error(`Error invoking remote method 'db:rows': error: syntax error at or near "nope"`)
      return { columns, rows: data.slice(0, 5), total: 5 }
    })
    await renderTV()
    change(whereBox(), 'nope nope')
    enterFilter(whereBox())
    await screen.findByText('Syntax error at or near "nope"')
    expect(whereBox().value).toBe('nope nope')
  })

  describe('whereFix hints', () => {
    const uuidCols: Column[] = [
      { name: 'id', type: 'uuid', nullable: false, isPk: true },
      { name: 'Title', type: 'text', nullable: true, isPk: false }
    ]
    beforeEach(() => {
      setup(3, uuidCols)
      api.rows.mockImplementation(async (q: RowsQuery) => {
        if (/like/i.test(q.where ?? '') && !/::text/.test(q.where ?? '')) throw new Error('operator does not exist: uuid ~~ unknown')
        if (/title/.test(q.where ?? '') && !/"Title"/.test(q.where ?? '')) throw new Error('column "title" does not exist')
        if (q.orderExpr === 'title') throw new Error('column "title" does not exist')
        return { columns, rows: data.slice(q.offset, q.offset + q.limit), total: data.length }
      })
    })

    it('uuid LIKE: shows the hint with an "Apply fix" button that rewrites the WHERE with ::text and re-runs', async () => {
      await renderTV()
      change(whereBox(), "id like '1%'")
      enterFilter(whereBox())
      await screen.findByText('Operator does not exist: uuid ~~ unknown')
      const bar = document.querySelector('.hint-bar')!
      expect(bar.textContent).toContain('only works on text')
      expect(bar.querySelectorAll('code').length).toBeGreaterThan(0)
      fireEvent.click(within(bar as HTMLElement).getByRole('button', { name: 'Apply fix' }))
      await waitFor(() => expect(lastQuery().where).toBe("id::text like '1%'"))
      expect(whereBox().value).toBe("id::text like '1%'")
      await waitFor(() => expect(document.querySelector('.msg.bad')).toBeNull())
      expect(bodyRows()).toHaveLength(3)
      expect(document.querySelector('.hint-bar')).toBeNull()
    })

    it('wrong-case column in WHERE: fix quotes it', async () => {
      await renderTV()
      change(whereBox(), "title = 'x'")
      enterFilter(whereBox())
      await screen.findByText('Column "title" does not exist')
      fireEvent.click(await screen.findByRole('button', { name: 'Apply fix' }))
      await waitFor(() => expect(lastQuery().where).toBe(`"Title" = 'x'`))
    })

    it('wrong-case column in ORDER BY: the fix rewrites the ORDER BY box, not the WHERE', async () => {
      await renderTV()
      change(orderBox(), 'title')
      enterFilter(orderBox())
      await screen.findByText('Column "title" does not exist')
      fireEvent.click(await screen.findByRole('button', { name: 'Apply fix' }))
      await waitFor(() => expect(lastQuery().orderExpr).toBe('"Title"'))
      expect(whereBox().value).toBe('')
      expect(orderBox().value).toBe('"Title"')
    })

    it('hint without a fix (generic column not found) shows text only, no button', async () => {
      api.rows.mockImplementation(async (q: RowsQuery) => {
        if (q.where) throw new Error('column "zzz" does not exist')
        return { columns, rows: data.slice(0, 3), total: 3 }
      })
      await renderTV()
      change(whereBox(), 'zzz = 1')
      enterFilter(whereBox())
      await screen.findByText(/Column not found - check the name\/case/)
      expect(screen.queryByRole('button', { name: 'Apply fix' })).toBeNull()
    })

    it('invalid input syntax gets an informational hint', async () => {
      api.rows.mockImplementation(async (q: RowsQuery) => {
        if (q.where) throw new Error('invalid input syntax for type uuid: "abc"')
        return { columns, rows: data.slice(0, 3), total: 3 }
      })
      await renderTV()
      change(whereBox(), "id = 'abc'")
      enterFilter(whereBox())
      await screen.findByText(/Value doesn't match the column type \(uuid\)/)
    })
  })
})

describe('TableView: reload tokens', () => {
  it('a bumped reloadToken re-fetches; the initial token does not', async () => {
    const t = fresh()
    const { rerender } = render(<TableView t={t} reloadToken={0} />)
    await waitFor(() => expect(api.rows).toHaveBeenCalledTimes(1))
    rerender(<TableView t={t} reloadToken={1} />)
    await waitFor(() => expect(api.rows).toHaveBeenCalledTimes(2))
  })

  it('soft reload with unsaved edits is ignored (edits protected); a hard reload discards them', async () => {
    const t = fresh()
    const { rerender } = render(<TableView t={t} reloadToken={0} />)
    await waitFor(() => expect(bodyRows().length).toBe(5))
    click(cell(0, 1)); key('Enter'); change(editor()!, 'dirty'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    rerender(<TableView t={t} reloadToken={1} reloadSoft />)
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(api.rows).toHaveBeenCalledTimes(1)
    expect(cell(0, 1).textContent).toBe('dirty')
    rerender(<TableView t={t} reloadToken={2} reloadSoft={false} />)
    await waitFor(() => expect(api.rows).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(cell(0, 1).textContent).toBe('n1'))
  })

  it('soft reload while clean does reload', async () => {
    const t = fresh()
    const { rerender } = render(<TableView t={t} reloadToken={0} />)
    await waitFor(() => expect(api.rows).toHaveBeenCalledTimes(1))
    rerender(<TableView t={t} reloadToken={1} reloadSoft />)
    await waitFor(() => expect(api.rows).toHaveBeenCalledTimes(2))
  })

  it('a reload also refreshes the Structure tab indexes', async () => {
    const t = fresh()
    const { rerender } = render(<TableView t={t} reloadToken={0} />)
    await waitFor(() => expect(bodyRows().length).toBe(5))
    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))
    await waitFor(() => expect(api.indexes).toHaveBeenCalledTimes(1))
    rerender(<TableView t={t} reloadToken={1} />)
    await waitFor(() => expect(api.indexes).toHaveBeenCalledTimes(2))
  })
})

describe('TableView: loading overlay', () => {
  it('shows a loading overlay while rows are in flight and removes it after the fade', async () => {
    let done!: (v: unknown) => void
    api.rows.mockImplementationOnce(() => new Promise((r) => (done = r)))
    render(<TableView t={fresh()} />)
    await screen.findByText('Loading rows…')
    expect(document.querySelector('.gridbox')!.classList.contains('busy')).toBe(true)
    await act(async () => done({ columns: COLS, rows: data.slice(0, 2), total: 2 }))
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(2))
    await waitFor(() => expect(screen.queryByText('Loading rows…')).toBeNull(), { timeout: 1500 })
  })

  it('the grid ignores keys while loading', async () => {
    const { rerender } = await renderTV()
    let done!: (v: unknown) => void
    api.rows.mockImplementationOnce(() => new Promise((r) => (done = r)))
    click(cell(0, 0))
    fireEvent.click(btn(/^Reload/))
    await waitFor(() => expect(screen.queryByText('Loading rows…')).not.toBeNull())
    key('ArrowDown')
    key('Delete')
    await act(async () => done({ columns: COLS, rows: data, total: 5 }))
    expect(document.querySelector('tr.del')).toBeNull()
    void rerender
  })
})

describe('TableView: Escape clears the row selection', () => {
  const sel = (): number[] => bodyRows().map((r, i) => (r.classList.contains('sel') ? i : -1)).filter((i) => i >= 0)

  it('Escape removes the highlight (and delete does nothing) but the cell cursor stays; arrows re-select', async () => {
    await renderTV()
    click(cell(1, 1))
    expect(sel()).toEqual([1])
    key('Escape')
    expect(sel()).toEqual([])
    expect(curCell()).toBe(cell(1, 1))
    expect(btn(/^Delete/).disabled).toBe(true)
    key('Delete')
    expect(document.querySelector('tr.del')).toBeNull()
    key('ArrowDown')
    expect(sel()).toEqual([2])
    expect(curCell()).toBe(cell(2, 1))
  })

  it('Escape clears a multi-row selection; a click selects again', async () => {
    await renderTV()
    click(bodyRows()[0].querySelector('td.rn')!)
    click(bodyRows()[3].querySelector('td.rn')!, { shiftKey: true })
    expect(sel()).toEqual([0, 1, 2, 3])
    key('Escape')
    expect(sel()).toEqual([])
    click(cell(2, 0))
    expect(sel()).toEqual([2])
  })

  it('Shift+Escape is left for the sidebar toggle (bubbles, selection kept)', async () => {
    const outer = vi.fn()
    render(<div onKeyDown={outer}><TableView t={fresh()} /></div>)
    await waitFor(() => expect(bodyRows().length).toBe(5))
    click(cell(0, 0))
    key('Escape', { shiftKey: true })
    expect(sel()).toEqual([0])
    expect(outer).toHaveBeenCalled()
  })

  it('Escape with nothing selected is not consumed', async () => {
    await renderTV()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    grid().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('TableView: Cmd/Ctrl+R reloads the grid', () => {
  const press = (target: EventTarget = document.body, init: Record<string, unknown> = {}): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(ev)
    return ev
  }
  afterEach(async () => (await import('../../src/renderer/src/lib/focusZone')).resetExplorerClick())

  it('re-fetches rows (same paging / filters) and drops pending edits', async () => {
    await renderTV()
    click(cell(0, 1)); key('Enter'); change(editor()!, 'dirty'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    const c0 = api.rows.mock.calls.length
    const ev = press(grid())
    expect(ev.defaultPrevented).toBe(true)
    await waitFor(() => expect(api.rows.mock.calls.length).toBe(c0 + 1))
    await waitFor(() => expect(cell(0, 1).textContent).toBe('n1'))
  })

  it('works with Ctrl and from <body>; ignores Shift/Alt combos, other letters and held-down repeats', async () => {
    await renderTV()
    const c0 = api.rows.mock.calls.length
    press(document.body, { metaKey: false, ctrlKey: true })
    await waitFor(() => expect(api.rows.mock.calls.length).toBe(c0 + 1))
    press(document.body, { shiftKey: true })
    press(document.body, { altKey: true })
    press(document.body, { key: 'x' })
    press(document.body, { repeat: true })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(api.rows.mock.calls.length).toBe(c0 + 1)
  })

  it('is ignored for inactive tabs and while a dialog is open', async () => {
    await renderTV()
    const c0 = api.rows.mock.calls.length
    const d = document.createElement('div')
    d.className = 'modal-bg'
    document.body.appendChild(d)
    expect(press().defaultPrevented).toBe(false)
    d.remove()
    cleanup()
    api.rows.mockClear()
    render(<TableView t={fresh()} active={false} />)
    press()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(api.rows).not.toHaveBeenCalled()
    void c0
  })

  it('belongs to the Explorer when focus is inside .explorer, or on <body> right after clicking in it', async () => {
    await renderTV()
    const c0 = api.rows.mock.calls.length
    const ex = document.createElement('div')
    ex.className = 'explorer'
    const inner = document.createElement('button')
    ex.appendChild(inner)
    document.body.appendChild(ex)
    expect(press(inner).defaultPrevented).toBe(false)
    const fz = await import('../../src/renderer/src/lib/focusZone')
    const stop = fz.trackExplorerClicks()
    fireEvent.mouseDown(inner)
    expect(fz.explorerClicked()).toBe(true)
    expect(press(document.body).defaultPrevented).toBe(false)
    fireEvent.mouseDown(grid())
    expect(fz.explorerClicked()).toBe(false)
    expect(press(document.body).defaultPrevented).toBe(true)
    stop()
    ex.remove()
    await waitFor(() => expect(api.rows.mock.calls.length).toBe(c0 + 1))
  })

  it('does nothing while a submit is in flight', async () => {
    let done!: () => void
    api.apply.mockImplementation(() => new Promise<void>((r) => (done = r)))
    await renderTV()
    click(cell(0, 1)); key('Enter'); change(editor()!, 'q'); fireEvent.keyDown(editor()!, { key: 'Enter' })
    fireEvent.click(submitBtn())
    await screen.findByText(/Submitting…/)
    const c0 = api.rows.mock.calls.length
    press()
    expect(api.rows.mock.calls.length).toBe(c0)
    done()
    await waitFor(() => expect(screen.queryByText(/Submitting…/)).toBeNull())
  })

  it('the toolbar button advertises the shortcut', async () => {
    await renderTV()
    expect(btn(/^Reload \((Ctrl\+R|⌘R)\)$/)).toBeTruthy()
  })
})

describe('userEvent smoke (real keyboard events)', () => {
  it('type to edit then Enter via user-event updates the cell', async () => {
    const user = userEvent.setup()
    await renderTV()
    await user.click(cell(0, 1))
    grid().focus()
    await user.keyboard('Q')
    expect(editor()!.value).toBe('Q')
    await user.keyboard('rst{Enter}')
    expect(cell(0, 1).textContent).toBe('Qrst')
  })
})
