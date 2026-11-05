// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DynamoTableView from '../../src/renderer/src/DynamoTableView'
import type { TableRef } from '../../src/renderer/src/Explorer'
import { getTableView, setTableView } from '../../src/renderer/src/session'
import { tableKey } from '../../src/renderer/src/lib/refs'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'
import type { DynamoPage, DynamoTableInfo } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

const TOTAL = 250
const item = (i: number): Record<string, unknown> => ({ pk: 'p' + i, sk: i, name: 'n' + i, ...(i % 2 ? { extra: { a: [1, 2], b: 'x' } } : {}) })
const COLUMNS = [
  { name: 'pk', types: ['S'], key: 'HASH' as const },
  { name: 'sk', types: ['N'], key: 'RANGE' as const },
  { name: 'extra', types: ['M'] },
  { name: 'name', types: ['S'] }
]
const pageAt = (start: number, limit: number, n = TOTAL): DynamoPage => {
  const end = Math.min(n, start + limit)
  const idx = Array.from({ length: Math.max(0, end - start) }, (_, k) => start + k + 1)
  return {
    items: idx.map(item) as never,
    columns: COLUMNS,
    rows: idx.map((i) => {
      const it = item(i) as { pk: string; sk: number; name: string; extra?: unknown }
      return [it.pk, String(it.sk), it.extra ? JSON.stringify(it.extra) : null, it.name]
    }),
    next: end < n ? String(end) : null,
    columnsCapped: false
  }
}
const INFO: DynamoTableInfo = {
  name: 'orders', arn: 'arn:aws:dynamodb:eu-west-1:1:table/orders', status: 'ACTIVE', billingMode: 'PROVISIONED', rcu: 5, wcu: 2,
  itemCount: TOTAL, sizeBytes: 2048, createdAt: '2024-01-02T03:04:05.000Z',
  keySchema: [{ name: 'pk', keyType: 'HASH', attrType: 'S' }, { name: 'sk', keyType: 'RANGE', attrType: 'N' }],
  attributes: [{ name: 'pk', type: 'S' }, { name: 'sk', type: 'N' }, { name: 'gpk', type: 'B' }],
  indexes: [
    { name: 'by-gpk', kind: 'GSI', status: 'ACTIVE', keys: [{ name: 'gpk', keyType: 'HASH', attrType: 'B' }], projection: 'INCLUDE', nonKeyAttributes: ['a', 'b'] }
  ],
  stream: { enabled: true, viewType: 'NEW_IMAGE' }, ttl: { status: 'ENABLED', attribute: 'expires' }, tableClass: 'STANDARD', deletionProtection: false
}

let api: MockApi
let clip: ReturnType<typeof vi.fn>
let n = 0
const fresh = (over: Partial<TableRef> = {}): TableRef => ({
  dsId: 'ds', dsName: 'Ddb', database: '', schema: '', table: 'orders' + ++n, kind: 'table', engine: 'dynamodb', region: 'eu-west-1', ...over
})
const itemCalls = (): { limit: number; cursor?: string | null; where?: string }[] => api.dynamo.items.mock.calls.map((c) => c[2])
const bodyRows = (): HTMLElement[] => Array.from(document.querySelectorAll('tbody tr'))
const cell = (r: number, c: number): HTMLElement => bodyRows()[r].querySelectorAll('td')[c + 1] as HTMLElement
const rangeText = (): string => document.querySelector('.pageinfo')!.textContent!.replace(/\s+/g, ' ').trim()
const btn = (title: RegExp | string): HTMLButtonElement => screen.getByTitle(title) as HTMLButtonElement
const whereBox = (): HTMLInputElement => document.querySelector('.fb-field.where input') as HTMLInputElement
const gridEl = (): HTMLElement => document.querySelector('.gridwrap') as HTMLElement
const root = (): HTMLElement => document.querySelector('.tableview') as HTMLElement
const key = (k: string, init: Record<string, unknown> = {}): boolean => fireEvent.keyDown(gridEl(), { key: k, ...init })
const sel = (): number[] => bodyRows().flatMap((r, i) => (r.classList.contains('sel') ? [i] : []))

async function renderTV(props: Partial<React.ComponentProps<typeof DynamoTableView>> = {}, t = fresh()) {
  const r = render(<DynamoTableView t={t} {...props} />)
  await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0))
  return { ...r, t }
}

beforeEach(() => {
  localStorage.clear()
  resetExplorerClick()
  clip = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  api = installApi({
    dynamo: {
      describe: INFO,
      items: async (_id: string, _t: string, o: { limit: number; cursor?: string | null; where?: string }) =>
        o.where === 'none' ? { items: [], columns: COLUMNS.slice(0, 2), rows: [], next: null, columnsCapped: false } : pageAt(o.cursor ? Number(o.cursor) : 0, o.limit)
    }
  })
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('DynamoTableView: data tab', () => {
  it('scans the first page with the default page size and shows columns, key badges and the approximate total', async () => {
    const { t } = await renderTV()
    expect(api.dynamo.items).toHaveBeenCalledWith('ds', t.table, { limit: 100, cursor: null, where: '' })
    expect(api.dynamo.describe).toHaveBeenCalledWith('ds', t.table)
    expect(bodyRows()).toHaveLength(100)
    const heads = Array.from(document.querySelectorAll('thead th')).map((h) => h.textContent)
    expect(heads).toEqual(['#', 'PKpkS', 'SKskN', 'extraM', 'nameS'])
    expect(rangeText()).toBe('1-100 of ~250')
    expect(document.querySelector('.range-total')!.getAttribute('title')).toMatch(/Approximate item count/)
    expect(cell(0, 0).textContent).toBe('p1')
    expect(bodyRows()[1].querySelector('td.rn')!.textContent).toBe('2')
  })

  it('missing attributes show the null text; nested values show compact JSON', async () => {
    await renderTV()
    expect(cell(0, 2).textContent).toBe('{"a":[1,2],"b":"x"}')
    expect(cell(1, 2).textContent).toBe('null')
    expect(cell(1, 2).className).toContain('null')
    expect(cell(1, 2).title).toBe('NULL')
  })

  it('header sort is disabled with an explanation', async () => {
    await renderTV()
    const th = document.querySelectorAll('thead th')[1] as HTMLElement
    expect(th.title).toBe('Sorting is not supported by DynamoDB scans')
    const before = api.dynamo.items.mock.calls.length
    fireEvent.click(th)
    expect(api.dynamo.items.mock.calls.length).toBe(before)
  })

  it('editing controls are present but disabled with a tooltip', async () => {
    await renderTV()
    const tips = screen.getAllByTitle('Editing items is not supported yet') as HTMLButtonElement[]
    expect(tips.length).toBeGreaterThanOrEqual(4)
    expect(tips.every((b) => b.disabled)).toBe(true)
    expect(tips.map((b) => b.textContent)).toEqual(expect.arrayContaining(['Submit', 'Revert']))
    expect(screen.queryByPlaceholderText(/ORDER BY/i)).toBeNull()
    expect(document.querySelector('.fb-field.order')).toBeNull()
  })

  it('Next uses the LastEvaluatedKey cursor, Previous replays the stack, First returns; Last is disabled', async () => {
    await renderTV()
    expect(btn('Previous page').disabled).toBe(true)
    expect(btn('First page').disabled).toBe(true)
    expect(btn('DynamoDB cannot jump to the last page').disabled).toBe(true)
    fireEvent.click(btn('Next page'))
    await waitFor(() => expect(rangeText()).toBe('101-200 of ~250'))
    expect(itemCalls().at(-1)).toEqual({ limit: 100, cursor: '100', where: '' })
    expect(cell(0, 0).textContent).toBe('p101')
    expect(bodyRows()[0].querySelector('td.rn')!.textContent).toBe('101')
    fireEvent.click(btn('Next page'))
    await waitFor(() => expect(rangeText()).toBe('201-250 of 250')) // last page: the total is exact
    expect(itemCalls().at(-1)!.cursor).toBe('200')
    expect(btn('Next page').disabled).toBe(true)
    fireEvent.click(btn('Previous page'))
    await waitFor(() => expect(rangeText()).toBe('101-200 of ~250'))
    expect(itemCalls().at(-1)!.cursor).toBe('100')
    fireEvent.click(btn('First page'))
    await waitFor(() => expect(rangeText()).toBe('1-100 of ~250'))
    expect(itemCalls().at(-1)!.cursor).toBeNull()
    expect(btn('Previous page').disabled).toBe(true)
  })

  it('changing the page size restarts from the first page', async () => {
    await renderTV()
    fireEvent.click(btn('Next page'))
    await waitFor(() => expect(rangeText()).toContain('101-200'))
    fireEvent.change(document.querySelector('.toolbar select')!, { target: { value: '25' } })
    await waitFor(() => expect(rangeText()).toBe('1-25 of ~250'))
    expect(itemCalls().at(-1)).toEqual({ limit: 25, cursor: null, where: '' })
    expect(Array.from(document.querySelectorAll('.toolbar select option')).map((o) => o.textContent)).toEqual(['25', '50', '100', '500', '1000'])
  })

  it('an empty table says so; with a condition the message differs', async () => {
    api.dynamo.items.mockResolvedValue({ items: [], columns: COLUMNS.slice(0, 2), rows: [], next: null, columnsCapped: false })
    render(<DynamoTableView t={fresh()} />)
    expect(await screen.findByText('This table has no items')).toBeTruthy()
    expect(rangeText()).toBe('0-0 of 0')
    fireEvent.change(whereBox(), { target: { value: 'none' } })
    fireEvent.keyDown(whereBox(), { key: 'Enter' })
    expect(await screen.findByText('No items match this condition')).toBeTruthy()
  })

  it('an empty page that still has a cursor tells the user to continue', async () => {
    api.dynamo.items.mockResolvedValue({ items: [], columns: COLUMNS.slice(0, 2), rows: [], next: '5', columnsCapped: false })
    render(<DynamoTableView t={fresh()} />)
    expect(await screen.findByText(/more pages follow/)).toBeTruthy()
    expect(btn('Next page').disabled).toBe(false)
  })

  it('more than 200 attributes: a notice', async () => {
    api.dynamo.items.mockResolvedValue({ ...pageAt(0, 3), columnsCapped: true })
    render(<DynamoTableView t={fresh()} />)
    expect(await screen.findByText(/only the first 200 columns/)).toBeTruthy()
  })

  it('load errors are shown inline (and can be retried with reload)', async () => {
    api.dynamo.items.mockRejectedValueOnce(new Error("Error invoking remote method 'dynamo:items': Error: Access denied: nope"))
    render(<DynamoTableView t={fresh()} />)
    expect((await screen.findByText('Access denied: nope')).className).toContain('bad')
    fireEvent.click(btn(/^Reload/))
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(100))
    expect(document.querySelector('.msg.bad')).toBeNull()
  })
})

describe('DynamoTableView: table / index picker', () => {
  const picker = (): HTMLButtonElement => screen.getByRole('button', { name: 'Table or index' }) as HTMLButtonElement
  const openPicker = async (): Promise<void> => { await userEvent.click(picker()) }
  const options = (): string[] => Array.from(document.querySelectorAll('.idx-pop [role="option"]')).map((o) => o.textContent!.replace(/\s+/g, ' ').trim())

  it('shows the table by default and lists the table and its indexes with keys', async () => {
    const { t } = await renderTV()
    await waitFor(() => expect(picker()).toBeTruthy())
    expect(picker().textContent).toContain(t.table)
    await openPicker()
    expect(options()).toEqual([`✓${t.table}PK pk · SK sk`, 'by-gpkGSIPK gpk'])
    expect(screen.getByRole('combobox', { name: 'Search tables and indexes' })).toBe(document.activeElement)
  })

  it('is hidden for tables without indexes', async () => {
    api.dynamo.describe.mockResolvedValue({ ...INFO, indexes: [] })
    await renderTV()
    expect(screen.queryByRole('button', { name: 'Table or index' })).toBeNull()
  })

  it('picking an index reloads from the first page through that index, and shows its keys', async () => {
    const { t } = await renderTV()
    await waitFor(() => expect(picker()).toBeTruthy())
    fireEvent.click(btn('Next page'))
    await waitFor(() => expect(rangeText()).toBe('101-200 of ~250'))
    await openPicker()
    await userEvent.click(within(document.querySelector('.idx-pop') as HTMLElement).getByRole('option', { name: /by-gpk/ }))
    await waitFor(() => expect(itemCalls().at(-1)).toEqual({ limit: 100, cursor: null, where: '', index: 'by-gpk' }))
    expect(picker().textContent).toContain('by-gpk')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(getTableView(tableKey(t))?.index).toBe('by-gpk')
    expect(rangeText()).toBe('1-100 of ~250')
  })

  it('the condition is sent along with the index; choosing the table again drops it', async () => {
    const { t } = await renderTV()
    await waitFor(() => expect(picker()).toBeTruthy())
    await openPicker()
    await userEvent.click(within(document.querySelector('.idx-pop') as HTMLElement).getByRole('option', { name: /by-gpk/ }))
    await userEvent.type(whereBox(), "gpk = 'x'{Enter}")
    await waitFor(() => expect(itemCalls().at(-1)).toMatchObject({ index: 'by-gpk', where: "gpk = 'x'" }))
    await openPicker()
    await userEvent.click(within(document.querySelector('.idx-pop') as HTMLElement).getByRole('option', { name: new RegExp(t.table) }))
    await waitFor(() => expect(Object.keys(itemCalls().at(-1)!)).not.toContain('index'))
    expect(getTableView(tableKey(t))?.index).toBeUndefined()
  })

  it('searches fuzzily, navigates with the keyboard and closes with Escape', async () => {
    await renderTV()
    await waitFor(() => expect(picker()).toBeTruthy())
    await openPicker()
    await userEvent.keyboard('gpk')
    expect(options()).toEqual(['by-gpkGSIPK gpk'])
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    await openPicker()
    await userEvent.keyboard('zzzz')
    expect(screen.getByText('No matches')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await openPicker()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(itemCalls().at(-1)).toMatchObject({ index: 'by-gpk' }))
  })

  it('restores the saved index selection', async () => {
    const t = fresh()
    setTableView(tableKey(t), { page: 0, pageSize: 100, offset: 0, sort: null, where: '', orderExpr: '', index: 'by-gpk' })
    await renderTV({}, t)
    expect(itemCalls()[0]).toEqual({ limit: 100, cursor: null, where: '', index: 'by-gpk' })
    expect(picker().textContent).toContain('by-gpk')
  })
})

describe('DynamoTableView: WHERE', () => {
  it('Enter applies the condition (PartiQL path), restarts paging and drops the approximate total', async () => {
    await renderTV()
    fireEvent.click(btn('Next page'))
    await waitFor(() => expect(rangeText()).toContain('101-200'))
    fireEvent.change(whereBox(), { target: { value: "pk = 'p1'" } })
    expect(itemCalls().at(-1)!.where).toBe('') // typing alone does not query
    fireEvent.keyDown(whereBox(), { key: 'Enter' })
    await waitFor(() => expect(itemCalls().at(-1)).toEqual({ limit: 100, cursor: null, where: "pk = 'p1'" }))
    await waitFor(() => expect(rangeText()).toMatch(/^1-100/))
    expect(rangeText()).not.toContain('~')
  })

  it('shows the full-scan hint and no ORDER BY box', async () => {
    await renderTV()
    expect(document.querySelector('.fb-hint')!.textContent).toMatch(/scans the whole table/)
  })

  it('completes attribute names (key schema and columns seen) and PartiQL keywords', async () => {
    const user = userEvent.setup()
    await renderTV()
    await user.click(whereBox())
    await user.type(whereBox(), 'na')
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.cs-name, .si-name, span')?.textContent)).toContain('name')
    await user.clear(whereBox())
    await user.type(whereBox(), 'beg')
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    await user.keyboard('{Enter}')
    expect(whereBox().value).toBe('begins_with(, )')
    expect(whereBox().selectionStart).toBe('begins_with('.length) // caret in the first argument
    expect(whereBox().selectionEnd).toBe('begins_with('.length)
    // attribute names are suggested straight away for the first argument; picking one fills it in
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.sg-name')?.textContent)).toEqual(
      expect.arrayContaining(['pk', 'sk'])
    )
    expect(screen.getAllByRole('option').every((o) => !o.classList.contains('kw'))).toBe(true)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(whereBox().value).toBe('begins_with(sk, )')
    expect(whereBox().selectionStart).toBe('begins_with(sk'.length)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('inserts reserved attribute names double-quoted (PartiQL rules, not Postgres ones)', async () => {
    const user = userEvent.setup()
    api.dynamo.items.mockResolvedValue({
      items: [{ status: 'x' }] as never, columns: [{ name: 'status', types: ['S'] }], rows: [['x']], next: null, columnsCapped: false
    })
    render(<DynamoTableView t={fresh()} />)
    await screen.findByText('x')
    await user.click(whereBox())
    await user.type(whereBox(), 'sta')
    await user.keyboard('{Enter}')
    expect(whereBox().value).toBe('"status"')
  })

  it('the applied condition is remembered for the tab', async () => {
    const { t } = await renderTV()
    fireEvent.change(whereBox(), { target: { value: 'sk > 3' } })
    fireEvent.keyDown(whereBox(), { key: 'Enter' })
    await waitFor(() => expect(getTableView(tableKey(t))).toMatchObject({ where: 'sk > 3', pageSize: 100, orderExpr: '', sort: null }))
  })

  it('a restored tab starts from its saved condition and page size', async () => {
    const t = fresh()
    setTableView(tableKey(t), { page: 0, pageSize: 25, sort: null, where: 'sk = 7', orderExpr: '' })
    render(<DynamoTableView t={t} />)
    await waitFor(() => expect(api.dynamo.items).toHaveBeenCalled())
    expect(itemCalls()[0]).toEqual({ limit: 25, cursor: null, where: 'sk = 7' })
    expect(whereBox().value).toBe('sk = 7')
  })
})

describe('DynamoTableView: selection, copy and keyboard', () => {
  it('clicking selects the row and the cell; Cmd/Ctrl+C copies that cell value (like PostgreSQL grids)', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(2, 1), { button: 0 })
    expect(sel()).toEqual([2])
    expect(cell(2, 1).className).toContain('cur')
    key('c', { metaKey: true })
    expect(clip).toHaveBeenLastCalledWith('3')
    key('ArrowLeft')
    key('c', { ctrlKey: true })
    expect(clip).toHaveBeenLastCalledWith('p3')
    expect(clip).toHaveBeenCalledTimes(2)
  })

  it('Cmd/Ctrl+C on a nested value copies it as JSON; on a missing attribute it copies an empty string', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(0, 2), { button: 0 }) // item 1 has `extra`
    key('c', { metaKey: true })
    expect(JSON.parse(clip.mock.calls.at(-1)![0])).toEqual({ a: [1, 2], b: 'x' })
    fireEvent.mouseDown(cell(1, 2), { button: 0 }) // item 2 does not
    key('c', { metaKey: true })
    expect(clip).toHaveBeenLastCalledWith('')
  })

  it('clicking a cell moves keyboard focus to the grid (arrows work straight after the click)', async () => {
    await renderTV()
    whereBox().focus()
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    expect(document.activeElement).toBe(gridEl())
  })

  it('the Copy JSON button copies the whole item', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(2, 1), { button: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }))
    expect(JSON.parse(clip.mock.calls.at(-1)![0])).toEqual(item(3))
  })

  it('shift extends, cmd toggles; several rows copy as an array', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(1, 0), { button: 0 })
    fireEvent.mouseDown(cell(3, 0), { button: 0, shiftKey: true })
    expect(sel()).toEqual([1, 2, 3])
    fireEvent.mouseDown(cell(2, 0), { button: 0, metaKey: true })
    expect(sel()).toEqual([1, 3])
    fireEvent.mouseDown(cell(5, 0), { button: 0, ctrlKey: true })
    expect(sel()).toEqual([1, 3, 5])
    key('c', { metaKey: true })
    expect(JSON.parse(clip.mock.calls.at(-1)![0])).toEqual([item(2), item(4), item(6)])
    // toggling off every row clears the selection
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    fireEvent.mouseDown(cell(0, 0), { button: 0, metaKey: true })
    expect(sel()).toEqual([])
  })

  it('the row number gutter selects rows too', async () => {
    await renderTV()
    fireEvent.mouseDown(bodyRows()[2].querySelector('td.rn')!, { button: 0 })
    fireEvent.mouseDown(bodyRows()[4].querySelector('td.rn')!, { button: 0, shiftKey: true })
    expect(sel()).toEqual([2, 3, 4])
  })

  it('the Copy JSON button follows the selection', async () => {
    await renderTV()
    const b = screen.getByRole('button', { name: 'Copy JSON' }) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    expect(b.disabled).toBe(false)
    fireEvent.click(b)
    expect(JSON.parse(clip.mock.calls.at(-1)![0])).toEqual(item(1))
  })

  it('right-click copies the cell value: text as is, nested values as JSON', async () => {
    await renderTV()
    fireEvent.contextMenu(cell(0, 0))
    expect(clip).toHaveBeenLastCalledWith('p1')
    fireEvent.contextMenu(cell(0, 2))
    expect(JSON.parse(clip.mock.calls.at(-1)![0])).toEqual({ a: [1, 2], b: 'x' })
    fireEvent.contextMenu(cell(0, 1)) // numbers
    expect(clip).toHaveBeenLastCalledWith('1')
    fireEvent.contextMenu(cell(1, 2)) // missing attribute
    expect(clip).toHaveBeenLastCalledWith('')
  })

  it('arrow keys, Home / End, page keys and Tab move the cell cursor', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    const at = (): string => { const c = document.querySelector('td.cur')!; return `${bodyRows().indexOf(c.parentElement as HTMLElement)}:${Array.from(c.parentElement!.children).indexOf(c) - 1}` }
    key('ArrowDown'); expect(at()).toBe('1:0')
    key('ArrowRight'); expect(at()).toBe('1:1')
    key('ArrowUp'); expect(at()).toBe('0:1')
    key('ArrowLeft'); expect(at()).toBe('0:0')
    key('End'); expect(at()).toBe('0:3')
    key('Home'); expect(at()).toBe('0:0')
    key('ArrowDown', { metaKey: true }); expect(at()).toBe('99:0')
    key('ArrowUp', { metaKey: true }); expect(at()).toBe('0:0')
    key('End', { metaKey: true }); expect(at()).toBe('99:3')
    key('Home', { metaKey: true }); expect(at()).toBe('0:0')
    key('PageDown'); expect(Number(at().split(':')[0])).toBeGreaterThan(0)
    key('PageUp'); expect(at()).toBe('0:0')
    key('Tab'); expect(at()).toBe('0:1')
    key('Tab', { shiftKey: true }); expect(at()).toBe('0:0')
    key('ArrowRight'); key('ArrowRight'); key('ArrowRight'); key('Tab'); expect(at()).toBe('1:0')
    key('Tab', { shiftKey: true }); expect(at()).toBe('0:3')
  })

  it('Shift+arrows extend the selection, Cmd+A selects all, Escape clears', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(1, 0), { button: 0 })
    key('ArrowDown', { shiftKey: true })
    key('ArrowDown', { shiftKey: true })
    expect(sel()).toEqual([1, 2, 3])
    key('ArrowUp', { shiftKey: true })
    expect(sel()).toEqual([1, 2])
    key('a', { metaKey: true })
    expect(sel()).toHaveLength(100)
    key('Escape')
    expect(sel()).toEqual([])
    expect(document.querySelector('td.cur')).toBeTruthy() // the cell cursor stays
  })

  it('Tab at the very end leaves the grid (not prevented); Escape only acts while something is selected', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(99, 3), { button: 0 })
    expect(key('Tab')).toBe(true)
    expect(key('Escape')).toBe(false) // handled: the selection is cleared
    expect(sel()).toEqual([])
    expect(key('Escape')).toBe(true) // nothing left to clear: not handled
  })

  it('keys typed into the WHERE box do not move the grid cursor or copy', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    fireEvent.keyDown(whereBox(), { key: 'ArrowDown' })
    fireEvent.keyDown(whereBox(), { key: 'c', metaKey: true })
    expect(document.querySelector('td.cur')!.parentElement).toBe(bodyRows()[0])
    expect(clip).not.toHaveBeenCalled()
  })

  it('a new page clears the selection', async () => {
    await renderTV()
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    fireEvent.click(btn('Next page'))
    await waitFor(() => expect(rangeText()).toContain('101-200'))
    expect(sel()).toEqual([])
    expect(document.querySelector('td.cur')).toBeNull()
  })
})

describe('DynamoTableView: reload', () => {
  const cmdR = (el: Element | Window, init: Record<string, unknown> = {}): boolean => fireEvent.keyDown(el, { key: 'r', code: 'KeyR', metaKey: true, ...init })

  it('the toolbar button re-scans the current page (and re-describes)', async () => {
    await renderTV()
    fireEvent.click(btn('Next page'))
    await waitFor(() => expect(rangeText()).toContain('101-200'))
    const calls = api.dynamo.items.mock.calls.length
    const desc = api.dynamo.describe.mock.calls.length
    fireEvent.click(btn(/^Reload/))
    await waitFor(() => expect(api.dynamo.items.mock.calls.length).toBe(calls + 1))
    expect(itemCalls().at(-1)!.cursor).toBe('100')
    expect(api.dynamo.describe.mock.calls.length).toBe(desc + 1)
  })

  it('Cmd/Ctrl+R reloads and prevents the browser default', async () => {
    await renderTV()
    const calls = api.dynamo.items.mock.calls.length
    let notPrevented = true
    await act(async () => { notPrevented = cmdR(gridEl()) })
    expect(notPrevented).toBe(false)
    await waitFor(() => expect(api.dynamo.items.mock.calls.length).toBe(calls + 1))
    await act(async () => void cmdR(gridEl(), { metaKey: false, ctrlKey: true }))
    await waitFor(() => expect(api.dynamo.items.mock.calls.length).toBe(calls + 2))
  })

  it('is ignored for inactive tabs, repeats, modals, other modifiers and the explorer', async () => {
    const t = fresh()
    const { rerender } = render(<DynamoTableView t={t} active={false} />)
    const calls = api.dynamo.items.mock.calls.length
    cmdR(window)
    expect(api.dynamo.items.mock.calls.length).toBe(calls)
    rerender(<DynamoTableView t={t} active />)
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(100))
    const loaded = api.dynamo.items.mock.calls.length
    cmdR(window, { shiftKey: true })
    cmdR(window, { altKey: true })
    fireEvent.keyDown(window, { key: 'x', code: 'KeyX', metaKey: true })
    cmdR(window, { repeat: true })
    const modal = document.createElement('div')
    modal.className = 'modal-bg'
    document.body.append(modal)
    cmdR(window)
    modal.remove()
    expect(api.dynamo.items.mock.calls.length).toBe(loaded)
    const ex = document.createElement('div')
    ex.className = 'explorer'
    document.body.append(ex)
    cmdR(ex)
    expect(api.dynamo.items.mock.calls.length).toBe(loaded)
  })

  it('reloadToken (refresh from the explorer) reloads', async () => {
    const { rerender, t } = await renderTV({ reloadToken: 0 })
    const calls = api.dynamo.items.mock.calls.length
    rerender(<DynamoTableView t={t} reloadToken={1} />)
    await waitFor(() => expect(api.dynamo.items.mock.calls.length).toBe(calls + 1))
  })

  it('a restored background tab loads nothing until it is shown', async () => {
    const t = fresh()
    const { rerender } = render(<DynamoTableView t={t} active={false} />)
    await act(async () => { await Promise.resolve() })
    expect(api.dynamo.items).not.toHaveBeenCalled()
    expect(api.dynamo.describe).not.toHaveBeenCalled()
    rerender(<DynamoTableView t={t} active />)
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(100))
  })
})

describe('DynamoTableView: structure tab', () => {
  const section = (name: string): HTMLElement => document.querySelector(`table[data-section="${name}"]`) as HTMLElement
  const texts = (el: HTMLElement): string[][] => Array.from(el.querySelectorAll('tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent!))

  async function openStructure() {
    const r = await renderTV()
    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))
    await waitFor(() => expect(section('keys')).toBeTruthy())
    return r
  }

  it('key schema, attributes, indexes and table info', async () => {
    await openStructure()
    expect(texts(section('keys'))).toEqual([['pk', 'String (S)', 'HASH'], ['sk', 'Number (N)', 'RANGE']])
    expect(texts(section('attributes'))).toEqual([['pk', 'String (S)'], ['sk', 'Number (N)'], ['gpk', 'Binary (B)']])
    expect(texts(section('indexes'))).toEqual([['by-gpk', 'GSI', 'gpk (HASH)', 'INCLUDE: a, b', 'ACTIVE']])
    const info = Object.fromEntries(texts(section('info')).map(([k, v]) => [k, v]))
    expect(info).toMatchObject({
      Status: 'ACTIVE', 'Billing mode': 'PROVISIONED', 'Capacity (RCU / WCU)': '5 / 2', 'Item count': '250', Size: '2.0 KB',
      Created: '2024-01-02T03:04:05.000Z', ARN: INFO.arn, TTL: 'ENABLED (expires)', Streams: 'enabled (NEW_IMAGE)',
      'Table class': 'STANDARD', 'Deletion protection': 'disabled'
    })
    expect(screen.queryByPlaceholderText('WHERE')).toBeNull() // the data tab content is gone
  })

  it('on-demand tables, no indexes, no TTL information', async () => {
    api.dynamo.describe.mockResolvedValue({
      ...INFO, billingMode: 'PAY_PER_REQUEST', indexes: [], ttl: null, stream: { enabled: false }, tableClass: undefined,
      deletionProtection: undefined, sizeBytes: 5 * 1024 * 1024 * 1024, createdAt: null, itemCount: 1234567
    })
    await openStructure()
    expect(texts(section('indexes'))).toEqual([['No secondary indexes']])
    const info = Object.fromEntries(texts(section('info')).map(([k, v]) => [k, v]))
    expect(info['Billing mode']).toBe('PAY_PER_REQUEST')
    expect(info).not.toHaveProperty('Capacity (RCU / WCU)')
    expect(info).not.toHaveProperty('Table class')
    expect(info).not.toHaveProperty('Deletion protection')
    expect(info).toMatchObject({ TTL: 'unknown', Streams: 'disabled', Created: '-', Size: '5.00 GB', 'Item count': '1,234,567' })
  })

  it.each([
    [10, '10 B'], [1536, '1.5 KB'], [3 * 1024 * 1024, '3.0 MB']
  ])('size %i shows as %s', async (bytes, text) => {
    api.dynamo.describe.mockResolvedValue({ ...INFO, sizeBytes: bytes })
    await openStructure()
    expect(texts(section('info')).find(([k]) => k === 'Size')![1]).toBe(text)
  })

  it('LSI, key-only projections and provisioned index status', async () => {
    api.dynamo.describe.mockResolvedValue({
      ...INFO, indexes: [{ name: 'l', kind: 'LSI', keys: [{ name: 'pk', keyType: 'HASH', attrType: 'S' }, { name: 'x', keyType: 'RANGE', attrType: 'S' }], projection: 'KEYS_ONLY', nonKeyAttributes: [] }]
    })
    await openStructure()
    expect(texts(section('indexes'))).toEqual([['l', 'LSI', 'pk (HASH), x (RANGE)', 'KEYS_ONLY', '']])
  })

  it('a describe failure is shown on the Structure tab; the Data tab keeps working', async () => {
    api.dynamo.describe.mockRejectedValue(new Error("Error invoking remote method 'dynamo:describe': Error: Not found: no such table"))
    await renderTV()
    expect(document.querySelectorAll('tbody tr').length).toBe(100)
    expect(rangeText()).toBe('1-100') // no approximate total without DescribeTable
    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))
    expect((await screen.findByText('Not found: no such table')).className).toContain('bad')
  })

  it('switching back to Data keeps the page', async () => {
    await openStructure()
    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    expect(bodyRows()).toHaveLength(100)
    expect(within(root()).getByRole('button', { name: 'Data' }).className).toBe('on')
  })
})

describe('DynamoTableView: WHERE error hint', () => {
  const BAD = "pk = 'employee#scrut-dev' and sk begins_with('tushar@scrut.io')"
  const GOOD = "pk = 'employee#scrut-dev' and begins_with(sk, 'tushar@scrut.io')"
  const wrapped = new Error(
    "Error invoking remote method 'dynamo:items': Error: ValidationException: Statement wasn't well formed, can't be processed: Unexpected token after expression"
  )

  it('offers "Apply fix" for `sk begins_with(...)`; applying it fixes the box, re-runs and clears the error', async () => {
    await renderTV()
    api.dynamo.items.mockImplementation(async (_id: string, _t: string, o: { limit: number; cursor?: string | null; where?: string }) => {
      if (o.where === BAD) throw wrapped
      return pageAt(0, o.limit)
    })
    fireEvent.change(whereBox(), { target: { value: BAD } })
    fireEvent.keyDown(whereBox(), { key: 'Enter' })
    expect((await screen.findByText(/Statement wasn't well formed/)).className).toContain('bad')
    const bar = document.querySelector('.hint-bar') as HTMLElement
    expect(bar.querySelector('code')!.textContent).toBe("sk begins_with('tushar@scrut.io')")
    expect(bar.textContent).toContain("begins_with(sk, 'tushar@scrut.io')")
    fireEvent.click(screen.getByText('Apply fix'))
    await waitFor(() => expect(document.querySelector('.msg.bad')).toBeNull())
    expect(whereBox().value).toBe(GOOD)
    expect(itemCalls().at(-1)!.where).toBe(GOOD)
    expect(document.querySelector('.hint-bar')).toBeNull()
  })

  it('shows no hint for errors it cannot fix', async () => {
    await renderTV()
    api.dynamo.items.mockRejectedValue(new Error('Error: ValidationException: nope'))
    fireEvent.change(whereBox(), { target: { value: "pk = 'a'" } })
    fireEvent.keyDown(whereBox(), { key: 'Enter' })
    await screen.findByText('Error: ValidationException: nope')
    expect(document.querySelector('.hint-bar')).toBeNull()
  })
})
