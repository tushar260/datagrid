// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { DataSource } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

const h = vi.hoisted(() => ({
  session: { expanded: [] as string[], folders: [] as string[] },
  picker: null as null | Record<string, (...a: never[]) => unknown>
}))
vi.mock('../../src/renderer/src/session', () => ({
  get initialSession() { return h.session },
  patchSession: () => undefined
}))
vi.mock('../../src/renderer/src/DbPicker', () => ({
  default: (p: Record<string, never>) => {
    h.picker = p as never
    return <div className="picker-stub" data-icon={String(p.icon)} />
  }
}))
vi.mock('../../src/renderer/src/CreateDialogs', () => ({ default: () => <div className="create-stub" /> }))

import Explorer from '../../src/renderer/src/Explorer'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'

Element.prototype.scrollIntoView = vi.fn()

const ddb = (id: string, over: Partial<DataSource> = {}, dynamo: Partial<NonNullable<DataSource['dynamo']>> = {}): DataSource => ({
  id, name: 'Ddb', kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  dynamo: { region: 'eu-west-1', authMode: 'profile', profile: 'dev', ...dynamo }, ...over
})
const pg = (id: string): DataSource => ({ id, name: 'Pg', host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false })

let api: MockApi
let cb: Record<'onOpen' | 'onEdit' | 'onConsole' | 'onTableRenamed' | 'onRefreshed' | 'onObjectGone' | 'onSources', ReturnType<typeof vi.fn>>
let clip: ReturnType<typeof vi.fn>
let confirmFn: ReturnType<typeof vi.fn>

function setup(over: Record<string, unknown> = {}, tables: string[] = ['orders', 'alpha', 'Users']): void {
  api = installApi({
    listSources: [ddb('d1')],
    databases: ['app'],
    schemasAll: ['public'],
    tableNames: { public: [] },
    tables: [],
    renameSource: undefined,
    deleteSource: undefined,
    duplicateSource: undefined,
    disconnect: undefined,
    ...over,
    dynamo: { tables, describe: { arn: 'arn:aws:dynamodb:eu-west-1:1:table/orders' }, setTableFilter: undefined, ...((over.dynamo as object) ?? {}) }
  })
}

beforeEach(() => {
  h.session = { expanded: [], folders: [] }
  h.picker = null
  localStorage.clear()
  resetExplorerClick()
  clip = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  confirmFn = vi.fn(() => true)
  window.confirm = confirmFn as never
  cb = { onOpen: vi.fn(), onEdit: vi.fn(), onConsole: vi.fn(), onTableRenamed: vi.fn(), onRefreshed: vi.fn(), onObjectGone: vi.fn(), onSources: vi.fn() }
  setup()
})
afterEach(cleanup)

const ui = (): React.JSX.Element => <Explorer {...(Object.assign({}, cb, { reloadKey: 0 }) as React.ComponentProps<typeof Explorer>)} />
const row = (id: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).find((r) => r.dataset.id === id) ?? null
const R = (id: string): HTMLElement => {
  const r = row(id)
  if (!r) throw new Error('no row ' + id + ' in ' + ids().join(','))
  return r
}
const ids = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).map((r) => r.dataset.id!)
const badge = (id: string): string | null => R(id).querySelector('.badge')?.textContent ?? null
const click = (id: string, init: Record<string, unknown> = {}): void => {
  fireEvent.mouseDown(R(id), init)
  fireEvent.click(R(id), init)
}
const ctx = (id: string): void => void fireEvent.contextMenu(R(id), { clientX: 12, clientY: 34 })
const menuLabels = (): string[] => Array.from(document.querySelectorAll('.ctxmenu:not(.submenu) > .ctxitem')).map((i) => i.querySelector('span')!.textContent!)
const pick = (label: string): void => {
  const el = Array.from(document.querySelectorAll<HTMLElement>('.ctxitem')).find((i) => i.querySelector('span')?.textContent === label)
  if (!el) throw new Error(`no menu item "${label}" in [${menuLabels().join(' | ')}]`)
  fireEvent.click(el)
}
const key = (k: string, init: Record<string, unknown> = {}): void => void fireEvent.keyDown(document.body, { key: k, ...init })
const combo = (code: string, init: Record<string, unknown> = {}): void =>
  void fireEvent.keyDown(document.body, { key: code.replace('Key', '').toLowerCase(), code, ...init })

async function mount(): Promise<void> {
  render(ui())
  await waitFor(() => expect(row('d1')).toBeTruthy())
}
async function openSource(): Promise<void> {
  fireEvent.click(R('d1').querySelector('.arrow')!)
  await waitFor(() => expect(row('d1/orders')).toBeTruthy())
}

describe('DynamoDB data source row', () => {
  it('shows the DynamoDB icon label and a tooltip with region and credentials', async () => {
    await mount()
    expect(R('d1').querySelector('.tlabel')!.textContent).toBe('Ddb')
    expect(R('d1').querySelector('.ticon')!.getAttribute('data-tip')).toBe('DynamoDB')
    expect(R('d1').dataset.tip2).toBe('eu-west-1 · profile dev')
  })

  it.each([
    [{ authMode: 'keys' as const, region: 'us-east-2' }, 'us-east-2 · access key'],
    [{ authMode: 'default' as const, region: '' }, 'default region · default credentials'],
    [{ authMode: 'default' as const, endpoint: 'http://localhost:8000' }, 'eu-west-1 · http://localhost:8000 · default credentials']
  ])('tooltip for %j', async (dynamo, tip) => {
    setup({ listSources: [ddb('d1', {}, dynamo)] })
    await mount()
    expect(R('d1').dataset.tip2).toBe(tip)
  })

  it('a source whose secret cannot be read gets the warning icon and appears in the Keychain banner', async () => {
    setup({ listSources: [ddb('d1', { passwordUnavailable: true }), ddb('d2', { name: 'Fine' })] })
    await mount()
    expect(R('d1').querySelector('.ticon svg')!.outerHTML).not.toBe(R('d2').querySelector('.ticon svg')!.outerHTML)
    expect((document.querySelector('.keychain-banner') as HTMLElement).textContent).toContain('Ddb')
  })
})

describe('DynamoDB tables in the tree', () => {
  it('tables sit directly under the source: no databases, schemas or server objects', async () => {
    await mount()
    await openSource()
    expect(ids()).toEqual(['d1', 'd1/orders', 'd1/alpha', 'd1/Users'])
    expect(api.dynamo.tables).toHaveBeenCalledWith('d1')
    expect(api.databases).not.toHaveBeenCalled()
    expect(api.schemasAll).not.toHaveBeenCalled()
    await waitFor(() => expect(badge('d1')).toBe('3'))
    expect(R('d1/orders').querySelector('.ticon')!.getAttribute('data-tip')).toBe('Table')
  })

  it('a table filter shows "N of Total" and hides the rest', async () => {
    setup({ listSources: [ddb('d1', { tableFilter: { dynamodb: { list: ['orders'] } } })] })
    await mount()
    await openSource()
    expect(ids()).toEqual(['d1', 'd1/orders'])
    await waitFor(() => expect(badge('d1')).toBe('1 of 3'))
  })

  it('a pattern rule works too', async () => {
    setup({ listSources: [ddb('d1', { tableFilter: { dynamodb: { rule: { mode: 'starts', pattern: 'A' } } } })] })
    await mount()
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(row('d1/alpha')).toBeTruthy())
    expect(ids()).toEqual(['d1', 'd1/alpha'])
    await waitFor(() => expect(badge('d1')).toBe('1 of 3'))
  })

  it('an account without tables shows an empty source', async () => {
    setup({}, [])
    await mount()
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(api.dynamo.tables).toHaveBeenCalled())
    expect(ids()).toEqual(['d1'])
  })

  it('the explorer filter box narrows the tables', async () => {
    await mount()
    await openSource()
    const input = document.querySelector('.tree-filter') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ord' } })
    await waitFor(() => expect(row('d1/alpha')).toBeNull())
    expect(row('d1/orders')).toBeTruthy()
  })

  it('a load error is not fatal', async () => {
    setup({ dynamo: { tables: vi.fn(async () => { throw new Error('No credentials found.') }) } })
    await mount()
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(api.dynamo.tables).toHaveBeenCalled())
    expect(row('d1')).toBeTruthy()
  })

  it('Postgres sources next to it are unchanged', async () => {
    setup({ listSources: [ddb('d1'), pg('p1')] })
    await mount()
    await waitFor(() => expect(row('p1')).toBeTruthy())
    fireEvent.click(R('p1').querySelector('.arrow')!)
    await waitFor(() => expect(row('p1/app')).toBeTruthy())
    expect(ids()).toContain('p1/__server')
    expect(R('p1').dataset.tip2).toBe('h:5432 · u@postgres · Refreshed just now') // + the cache note (see Explorer.cache.test)
  })
})

describe('DynamoDB menus', () => {
  it('source menu has only what applies', async () => {
    await mount()
    ctx('d1')
    expect(menuLabels()).toEqual([
      'New Query Console', 'Edit Data Source…', 'Rename', 'Duplicate', 'Refresh', 'Disconnect', 'Copy Name', 'Delete Data Source…'
    ])
  })

  it('table menu: Open, New Query Console, Refresh, Copy Name, Copy ARN (no drop / create)', async () => {
    await mount()
    await openSource()
    ctx('d1/orders')
    expect(menuLabels()).toEqual(['Open Table', 'New Query Console', 'Refresh', 'Copy Name', 'Copy ARN'])
  })

  it('source: console, edit, duplicate, disconnect, copy name, delete', async () => {
    await mount()
    ctx('d1')
    pick('New Query Console')
    expect(cb.onConsole).toHaveBeenCalledWith({ dsId: 'd1', dsName: 'Ddb', database: '', engine: 'dynamodb', region: 'eu-west-1' })
    ctx('d1')
    pick('Edit Data Source…')
    expect(cb.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1', kind: 'dynamodb' }))
    ctx('d1')
    pick('Duplicate')
    await waitFor(() => expect(api.duplicateSource).toHaveBeenCalledWith('d1'))
    ctx('d1')
    pick('Disconnect')
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith('d1'))
    ctx('d1')
    pick('Copy Name')
    expect(clip).toHaveBeenCalledWith('Ddb')
    ctx('d1')
    pick('Delete Data Source…')
    expect(confirmFn.mock.calls.at(-1)![0]).toContain('does not touch the DynamoDB tables')
    await waitFor(() => expect(api.deleteSource).toHaveBeenCalledWith('d1'))
    await waitFor(() => expect(cb.onObjectGone).toHaveBeenCalledWith({ dsId: 'd1' }))
  })

  it('declining the delete confirmation does nothing', async () => {
    confirmFn.mockReturnValue(false)
    await mount()
    ctx('d1')
    pick('Delete Data Source…')
    expect(api.deleteSource).not.toHaveBeenCalled()
  })

  it('rename goes through renameSource', async () => {
    await mount()
    ctx('d1')
    pick('Rename')
    const input = document.querySelector('.tree-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Prod tables' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.renameSource).toHaveBeenCalledWith('d1', 'Prod tables'))
  })

  it('refresh of the source reloads its tables', async () => {
    await mount()
    await openSource()
    expect(api.dynamo.tables).toHaveBeenCalledTimes(1)
    ctx('d1')
    pick('Refresh')
    await waitFor(() => expect(api.dynamo.tables).toHaveBeenCalledTimes(2))
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
  })

  it('table: open, prefilled console, refresh, copy name, copy ARN', async () => {
    await mount()
    await openSource()
    ctx('d1/orders')
    pick('Open Table')
    expect(cb.onOpen).toHaveBeenCalledWith({
      dsId: 'd1', dsName: 'Ddb', database: '', schema: '', table: 'orders', kind: 'table', engine: 'dynamodb', region: 'eu-west-1'
    })
    ctx('d1/orders')
    pick('New Query Console')
    expect(cb.onConsole).toHaveBeenCalledWith({
      dsId: 'd1', dsName: 'Ddb', database: '', engine: 'dynamodb', region: 'eu-west-1', sql: 'SELECT * FROM "orders"'
    })
    ctx('d1/orders')
    pick('Refresh')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/orders')
    ctx('d1/orders')
    pick('Copy Name')
    expect(clip).toHaveBeenCalledWith('orders')
    ctx('d1/orders')
    pick('Copy ARN')
    await waitFor(() => expect(clip).toHaveBeenCalledWith('arn:aws:dynamodb:eu-west-1:1:table/orders'))
    expect(api.dynamo.describe).toHaveBeenCalledWith('d1', 'orders')
  })

  it('the console prefill quotes awkward table names', async () => {
    setup({}, ['we"ird name'])
    await mount()
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(row('d1/we"ird name')).toBeTruthy())
    ctx('d1/we"ird name')
    pick('New Query Console')
    expect(cb.onConsole.mock.calls[0][0].sql).toBe('SELECT * FROM "we""ird name"')
  })

  it('Copy ARN failure is shown, not thrown', async () => {
    setup({ dynamo: { describe: vi.fn(async () => { throw new Error("Error invoking remote method 'dynamo:describe': Error: Access denied: nope") }) } })
    await mount()
    await openSource()
    ctx('d1/orders')
    pick('Copy ARN')
    await waitFor(() => expect(document.body.textContent).toContain('Access denied: nope'))
    expect(clip).not.toHaveBeenCalled()
  })

  it('double-click opens the table', async () => {
    await mount()
    await openSource()
    fireEvent.doubleClick(R('d1/alpha'))
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ table: 'alpha', engine: 'dynamodb', region: 'eu-west-1' }))
  })
})

describe('DynamoDB keyboard shortcuts and multi-selection', () => {
  it('F4, ⇧⌘L, ⌥⌘C and ⌘R act on the selected table', async () => {
    await mount()
    await openSource()
    click('d1/orders')
    key('F4')
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ table: 'orders', engine: 'dynamodb' }))
    combo('KeyL', { metaKey: true, shiftKey: true })
    expect(cb.onConsole).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT * FROM "orders"', engine: 'dynamodb' }))
    combo('KeyC', { ctrlKey: true, altKey: true })
    expect(clip).toHaveBeenCalledWith('orders')
    combo('KeyR', { metaKey: true })
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/orders')
  })

  it('F4 on the source edits it', async () => {
    await mount()
    click('d1')
    key('F4')
    expect(cb.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }))
  })

  it('⌘⌫ on a table does nothing (no drop for DynamoDB)', async () => {
    await mount()
    await openSource()
    click('d1/orders')
    combo('Backspace', { metaKey: true })
    expect(confirmFn).not.toHaveBeenCalled()
    expect(api.dropTable).not.toHaveBeenCalled()
  })

  it('several tables: bulk Refresh and Copy Names, but no drop', async () => {
    await mount()
    await openSource()
    click('d1/orders')
    click('d1/alpha', { metaKey: true })
    ctx('d1/alpha')
    expect(menuLabels()).toEqual(['Refresh', 'Copy Names'])
    pick('Refresh')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/orders')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/alpha')
    ctx('d1/alpha')
    pick('Copy Names')
    expect(clip).toHaveBeenCalledWith('orders\nalpha')
    expect(api.dropTable).not.toHaveBeenCalled()
  })

  it('several sources of mixed kinds: Refresh refreshes DynamoDB ones by id', async () => {
    setup({ listSources: [ddb('d1'), ddb('d2', { name: 'Other' })] })
    await mount()
    await waitFor(() => expect(row('d2')).toBeTruthy())
    click('d1')
    click('d2', { metaKey: true })
    ctx('d2')
    pick('Refresh')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d2')
  })
})

describe('DynamoDB table filter picker', () => {
  async function openPicker(): Promise<Record<string, (...a: never[]) => unknown>> {
    await mount()
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(row('d1/alpha')).toBeTruthy())
    await waitFor(() => expect(R('d1').querySelector('.badge')).toBeTruthy())
    fireEvent.click(R('d1').querySelector('.badge')!)
    await waitFor(() => expect(h.picker).toBeTruthy())
    return h.picker!
  }

  it('lists the DynamoDB tables and saves list / rule / reset under the dynamodb key', async () => {
    const p = await openPicker()
    expect(within(document.body).getByText('', { selector: '.picker-stub' }).getAttribute('data-icon')).toBe('table')
    await expect((p.load as () => Promise<string[]>)()).resolves.toEqual(['orders', 'alpha', 'Users'])
    expect(api.databases).not.toHaveBeenCalled()
    ;(p.onChange as (l: string[] | null, r: unknown) => void)(['orders'], null)
    await waitFor(() => expect(api.dynamo.setTableFilter).toHaveBeenCalledWith('d1', { list: ['orders'] }))
    ;(p.onChange as (l: string[] | null, r: unknown) => void)(null, { mode: 'starts', pattern: 'o' })
    await waitFor(() => expect(api.dynamo.setTableFilter).toHaveBeenCalledWith('d1', { rule: { mode: 'starts', pattern: 'o' } }))
    ;(p.onChange as (l: string[] | null, r: unknown) => void)(null, null)
    await waitFor(() => expect(api.dynamo.setTableFilter).toHaveBeenCalledWith('d1', null))
    expect(api.setTableFilter).not.toHaveBeenCalled() // the Postgres channel is not used
  })

  it('passes the saved filter to the picker', async () => {
    setup({ listSources: [ddb('d1', { tableFilter: { dynamodb: { list: ['alpha'] } } })] })
    const p = await openPicker()
    expect(p.selected).toEqual(['alpha'])
    expect(p.rule).toBeNull()
  })
})
