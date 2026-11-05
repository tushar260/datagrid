// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { DataSource, Folder } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

const h = vi.hoisted(() => ({
  session: { expanded: [] as string[], folders: [] as string[] },
  patch: [] as Record<string, unknown>[],
  picker: null as null | Record<string, (...a: never[]) => unknown>,
  createProps: null as null | { req: Record<string, unknown>; onClose: (created: boolean, name?: string) => void }
}))
vi.mock('../../src/renderer/src/session', () => ({
  get initialSession() { return h.session },
  patchSession: (p: Record<string, unknown>) => void h.patch.push(p)
}))
vi.mock('../../src/renderer/src/DbPicker', () => ({
  default: (p: Record<string, never>) => {
    h.picker = p as never
    return <div className="picker-stub" data-icon={String(p.icon)} />
  }
}))
vi.mock('../../src/renderer/src/CreateDialogs', () => ({
  default: (p: never) => {
    h.createProps = p
    return <div className="create-stub" />
  }
}))

import Explorer from '../../src/renderer/src/Explorer'
import { resetExplorerClick } from '../../src/renderer/src/lib/focusZone'

Element.prototype.scrollIntoView = vi.fn()

const mkDs = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id.toUpperCase(), host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false, ...over
})
const T = (name: string, kind = 'table'): { name: string; kind: string } => ({ name, kind })

let api: MockApi
let cb: {
  onOpen: ReturnType<typeof vi.fn>; onEdit: ReturnType<typeof vi.fn>; onConsole: ReturnType<typeof vi.fn>
  onTableRenamed: ReturnType<typeof vi.fn>; onRefreshed: ReturnType<typeof vi.fn>; onObjectGone: ReturnType<typeof vi.fn>
  onSources: ReturnType<typeof vi.fn>
}
let clip: ReturnType<typeof vi.fn>
let confirmFn: ReturnType<typeof vi.fn>

function setup(over: Record<string, unknown> = {}): void {
  api = installApi({
    listSources: [mkDs('d1', { name: 'Local' })],
    databases: ['app', 'other'],
    schemasAll: ['public', 'information_schema', 'extra'],
    tableNames: { public: ['users', 'orders', 'v'], extra: [] },
    tables: async (_d: string, _db: string, schema: string) => (schema === 'public' ? [T('users'), T('orders'), T('v', 'view')] : []),
    roles: ['alice', 'bob'],
    tablespaces: ['pg_default'],
    dropTable: undefined,
    dropDatabase: undefined,
    deleteSource: undefined,
    renameTable: undefined,
    ...over
  })
}

beforeEach(() => {
  h.session = { expanded: [], folders: [] }
  h.patch = []
  h.picker = null
  h.createProps = null
  localStorage.clear()
  resetExplorerClick()
  clip = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  confirmFn = vi.fn(() => true)
  window.confirm = confirmFn as never
  cb = {
    onOpen: vi.fn(), onEdit: vi.fn(), onConsole: vi.fn(), onTableRenamed: vi.fn(), onRefreshed: vi.fn(), onObjectGone: vi.fn(), onSources: vi.fn()
  }
  setup()
})
afterEach(cleanup)

type Extra = { activeTarget?: string | null; reloadKey?: number }
type ExplorerProps = React.ComponentProps<typeof Explorer>
const props = (extra: Extra = {}): ExplorerProps => ({ ...cb, reloadKey: 0, ...extra }) as unknown as ExplorerProps
function ui(extra: Extra = {}): React.JSX.Element {
  return <Explorer {...props(extra)} />
}
async function mount(extra: Extra = {}): Promise<ReturnType<typeof render>> {
  const r = render(ui(extra))
  await waitFor(() => expect(row('d1') ?? document.querySelector('.tree-row')).toBeTruthy())
  return r
}
const row = (id: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).find((r) => r.dataset.id === id) ?? null
const R = (id: string): HTMLElement => {
  const r = row(id)
  if (!r) throw new Error('no row ' + id + ' in ' + ids().join(','))
  return r
}
const ids = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')).map((r) => r.dataset.id!)
const selected = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.explorer .tree-row.sel')).map((r) => r.dataset.id!)
const badge = (id: string): string | null => R(id).querySelector('.badge')?.textContent ?? null
const click = (id: string, init: Record<string, unknown> = {}): void => {
  fireEvent.mouseDown(R(id), init)
  fireEvent.click(R(id), init)
}
const ctx = (id: string): void => void fireEvent.contextMenu(R(id), { clientX: 12, clientY: 34 })
const menuLabels = (): string[] => Array.from(document.querySelectorAll('.ctxmenu:not(.submenu) > .ctxitem')).map((i) => i.querySelector('span')!.textContent!)
const menuItem = (label: string): HTMLElement => {
  const el = Array.from(document.querySelectorAll<HTMLElement>('.ctxitem')).find((i) => i.querySelector('span')?.textContent === label)
  if (!el) throw new Error(`no menu item "${label}" in [${menuLabels().join(' | ')}]`)
  return el
}
const pick = (label: string): void => void fireEvent.click(menuItem(label))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** expand a node via its chevron and wait until `child` row is visible */
async function open(id: string, child?: string): Promise<void> {
  await waitFor(() => expect(R(id).querySelector('.arrow')).toBeTruthy())
  fireEvent.click(R(id).querySelector('.arrow')!)
  if (child) await waitFor(() => expect(row(child)).toBeTruthy())
}
async function openTables(): Promise<void> {
  await open('d1', 'd1/app')
  await open('d1/app', 'd1/app/public')
  await open('d1/app/public', 'd1/app/public/users')
}
const key = (k: string, init: Record<string, unknown> = {}): void => void fireEvent.keyDown(document.body, { key: k, ...init })
const combo = (code: string, init: Record<string, unknown> = {}): void => {
  const key = code === 'Backspace' ? 'Backspace' : code.replace('Key', '').toLowerCase()
  fireEvent.keyDown(document.body, { key, code, ...init })
}

describe('Explorer: empty & notices', () => {
  it('shows a hint when there are no data sources or folders', async () => {
    setup({ listSources: [], listFolders: [] })
    render(ui())
    expect(await within(document.body).findByText(/No data sources/)).toBeTruthy()
  })

  it('onSources receives the freshly loaded sources (and again on reload)', async () => {
    const onSources = vi.fn()
    const r = render(<Explorer {...props()} onSources={onSources} />)
    await waitFor(() => expect(onSources).toHaveBeenCalledTimes(1))
    expect(onSources.mock.calls[0][0].map((d: DataSource) => d.id)).toEqual(['d1'])
    r.rerender(<Explorer {...props({ reloadKey: 1 })} onSources={onSources} />)
    await waitFor(() => expect(onSources).toHaveBeenCalledTimes(2))
  })

  it('keychain banner lists the affected sources; Retry re-reads them; Restart relaunches the app', async () => {
    setup({ listSources: [mkDs('d1', { name: 'Local', passwordUnavailable: true }), mkDs('d2', { passwordUnavailable: true })] })
    await mount()
    const banner = document.querySelector('.keychain-banner') as HTMLElement
    expect(banner.textContent).toContain('Keychain access denied')
    expect(banner.textContent).toContain('Local, D2')
    // still denied after retry
    fireEvent.click(within(banner).getByText('Retry'))
    await waitFor(() => expect(banner.textContent).toContain('Still denied'))
    // fixed on the next retry
    api.listSources.mockResolvedValue([mkDs('d1', { name: 'Local' })])
    fireEvent.click(within(banner).getByText('Retry'))
    await waitFor(() => expect(document.querySelector('.keychain-banner')).toBeNull())
  })

  it('Restart App calls relaunch', async () => {
    setup({ listSources: [mkDs('d1', { passwordUnavailable: true })] })
    await mount()
    fireEvent.click(within(document.querySelector('.keychain-banner') as HTMLElement).getByText('Restart App'))
    expect(api.relaunch).toHaveBeenCalled()
  })

  it('a data source with an unreadable password gets the warning icon', async () => {
    setup({ listSources: [mkDs('d1', { passwordUnavailable: true }), mkDs('d2')] })
    await mount()
    expect(R('d1').querySelector('.ticon svg')!.outerHTML).not.toBe(R('d2').querySelector('.ticon svg')!.outerHTML)
  })
})

describe('Explorer: tree rendering', () => {
  it('a data source row shows its name and host/user tooltip', async () => {
    await mount()
    expect(R('d1').querySelector('.tlabel')!.textContent).toBe('Local')
    expect(R('d1').dataset.tip2).toBe('h:5432 · u@postgres')
    expect(R('d1').querySelector('.ticon')!.getAttribute('data-tip')).toBe('Data Source')
  })

  it('expanding lists databases + Server Objects; the badge shows the total', async () => {
    await mount()
    await open('d1', 'd1/app')
    expect(ids()).toEqual(['d1', 'd1/app', 'd1/other', 'd1/__server'])
    await waitFor(() => expect(badge('d1')).toBe('2'))
  })

  it('visibleDbs limits the list and the badge reads "N of Total"', async () => {
    setup({ listSources: [mkDs('d1', { visibleDbs: ['app'] })] })
    await mount()
    await open('d1', 'd1/app')
    expect(ids()).toEqual(['d1', 'd1/app', 'd1/__server'])
    await waitFor(() => expect(badge('d1')).toBe('1 of 2'))
  })

  it('a database lists non-system schemas, with "N of Total" badge', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    expect(ids().filter((i) => i.startsWith('d1/app/'))).toEqual(['d1/app/public', 'd1/app/extra'])
    await waitFor(() => expect(badge('d1/app')).toBe('2 of 3'))
  })

  it('schemaFilter overrides the default hiding of system schemas', async () => {
    setup({ listSources: [mkDs('d1', { schemaFilter: { app: ['information_schema'] } })] })
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/information_schema')
    expect(ids().filter((i) => i.startsWith('d1/app/'))).toEqual(['d1/app/information_schema'])
  })

  it('schema count pill comes from tableNames before the schema is expanded', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    await waitFor(() => expect(badge('d1/app/public')).toBe('3'))
    expect(badge('d1/app/extra')).toBe('0')
    expect(api.tables).not.toHaveBeenCalled()
  })

  it('tableFilter makes the pill "N of Total" and hides filtered tables', async () => {
    setup({ listSources: [mkDs('d1', { tableFilter: { 'app/public': { list: ['users'] } } })] })
    await mount()
    await openTables()
    await waitFor(() => expect(badge('d1/app/public')).toBe('1 of 3'))
    expect(ids().filter((i) => i.startsWith('d1/app/public/'))).toEqual(['d1/app/public/users'])
  })

  it('a pattern rule filter applies to the table list', async () => {
    setup({ listSources: [mkDs('d1', { tableFilter: { 'app/public': { rule: { mode: 'starts', pattern: 'o' } } } })] })
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    await open('d1/app/public', 'd1/app/public/orders')
    expect(ids().filter((i) => i.startsWith('d1/app/public/'))).toEqual(['d1/app/public/orders'])
  })

  it('tables show kind-specific icon tips, a schema.table tooltip and are leaves', async () => {
    await mount()
    await openTables()
    expect(R('d1/app/public/users').dataset.tip).toBe('public.users')
    expect(R('d1/app/public/users').querySelector('.ticon')!.getAttribute('data-tip')).toBe('Table')
    expect(R('d1/app/public/v').querySelector('.ticon')!.getAttribute('data-tip')).toBe('View')
    expect(R('d1/app/public/users').querySelector('.arrow')).toBeNull()
  })

  it('double-clicking a table opens it with the full reference', async () => {
    await mount()
    await openTables()
    fireEvent.doubleClick(R('d1/app/public/v'))
    expect(cb.onOpen).toHaveBeenCalledWith({ dsId: 'd1', dsName: 'Local', database: 'app', schema: 'public', table: 'v', kind: 'view' })
  })

  it('double-clicking a non-leaf toggles it', async () => {
    await mount()
    fireEvent.doubleClick(R('d1'))
    await waitFor(() => expect(row('d1/app')).toBeTruthy())
    await waitFor(() => expect(R('d1').querySelector('.arrow')).toBeTruthy())
    fireEvent.doubleClick(R('d1'))
    await waitFor(() => expect(row('d1/app')).toBeNull())
  })

  it('an empty schema shows "empty"', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/extra')
    await open('d1/app/extra')
    await waitFor(() => expect(document.querySelector('.tree-empty')!.textContent).toBe('empty'))
  })

  it('load errors show cleaned-up text under the node', async () => {
    setup({ databases: async () => { throw new Error("Error invoking remote method 'db:databases': Error: connection refused") } })
    await mount()
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(document.querySelector('.tree-err')!.textContent).toBe('connection refused'))
  })

  it('Server Objects lists Roles and Tablespaces with counts and leaf entries', async () => {
    await mount()
    await open('d1', 'd1/__server')
    await open('d1/__server', 'd1/__server/Roles')
    await open('d1/__server/Roles', 'd1/__server/Roles/alice')
    await open('d1/__server/Tablespaces', 'd1/__server/Tablespaces/pg_default')
    expect(ids().filter((i) => i.includes('__server/'))).toEqual([
      'd1/__server/Roles', 'd1/__server/Roles/alice', 'd1/__server/Roles/bob', 'd1/__server/Tablespaces', 'd1/__server/Tablespaces/pg_default'
    ])
    await waitFor(() => expect(badge('d1/__server/Roles')).toBe('2'))
    expect(R('d1/__server/Roles/alice').querySelector('.ticon')!.getAttribute('data-tip')).toBe('Role')
    expect(R('d1/__server/Tablespaces/pg_default').querySelector('.ticon')!.getAttribute('data-tip')).toBe('Tablespace')
  })

  it('the filter box hides tables whose name does not match (case-insensitive)', async () => {
    await mount()
    await openTables()
    fireEvent.change(document.querySelector('.tree-filter')!, { target: { value: 'ORD' } })
    expect(ids().filter((i) => i.startsWith('d1/app/public/'))).toEqual(['d1/app/public/orders'])
    fireEvent.change(document.querySelector('.tree-filter')!, { target: { value: '' } })
    expect(ids().filter((i) => i.startsWith('d1/app/public/')).length).toBe(3)
  })

  it('rows are draggable only for data sources and folders', async () => {
    await mount()
    await openTables()
    expect(R('d1').getAttribute('draggable')).toBe('true')
    expect(R('d1/app').getAttribute('draggable')).toBe('false')
  })
})

describe('Explorer: header toolbar', () => {
  const btn = (tip: string): HTMLButtonElement => document.querySelector(`.explorer-head [data-tip="${tip}"]`) as HTMLButtonElement

  it('New data source → onEdit(null)', async () => {
    await mount()
    fireEvent.click(btn('New data source'))
    expect(cb.onEdit).toHaveBeenCalledWith(null)
  })

  it('Refresh all reloads every loaded node in place and keeps the tree expanded', async () => {
    await mount()
    await open('d1', 'd1/app')
    api.databases.mockClear()
    fireEvent.click(btn('Refresh all'))
    // no remount: the children are still there right away (never a collapsed flash)
    expect(row('d1/app')).toBeTruthy()
    await waitFor(() => expect(api.databases).toHaveBeenCalled())
    expect(ids()).toContain('d1/app')
  })

  it('Refresh all keeps expansion, selection and the session, picks up new data, and does not touch never-loaded nodes', async () => {
    let names = ['users', 'orders', 'v']
    setup({
      listSources: [mkDs('d1', { name: 'Local' })],
      databases: ['app', 'other'],
      schemasAll: ['public'],
      tableNames: { public: ['users'] },
      tables: async (_d: string, _db: string, schema: string) =>
        schema === 'public' ? names.map((n) => T(n, n === 'v' ? 'view' : 'table')) : []
    })
    await mount()
    await openTables()
    click('d1/app/public/orders')
    await sleep(500)
    expect(selected()).toEqual(['d1/app/public/orders'])
    const before = ids()
    const patches = h.patch.length
    api.databases.mockClear()
    api.schemasAll.mockClear()
    api.tables.mockClear()
    names = ['users', 'orders', 'v', 'fresh']

    fireEvent.click(btn('Refresh all'))
    // expansion, rows and selection survive immediately and after the reload settles
    expect(ids()).toEqual(before)
    expect(selected()).toEqual(['d1/app/public/orders'])
    await waitFor(() => expect(row('d1/app/public/fresh')).toBeTruthy())
    expect(api.databases).toHaveBeenCalled()
    expect(api.schemasAll).toHaveBeenCalled()
    expect(api.schemasAll.mock.calls.every((c) => c[1] === 'app')).toBe(true) // 'other' was never loaded -> no connection to it
    expect(ids()).toEqual(before.flatMap((i) => (i === 'd1/app/public/v' ? [i, 'd1/app/public/fresh'] : [i])))
    expect(selected()).toEqual(['d1/app/public/orders'])
    // the session's expansion was never reset (no node was unmounted)
    await sleep(500)
    expect(h.patch.slice(patches).filter((p) => 'expanded' in p)).toEqual([])
    // the nodes stay open: collapsing one afterwards still works
    fireEvent.click(R('d1/app/public').querySelector('.arrow')!)
    await waitFor(() => expect(row('d1/app/public/users')).toBeNull())
  })

  it('Refresh all shows the loader for at least ~0.45s on reloaded nodes', async () => {
    await mount()
    await open('d1', 'd1/app')
    await sleep(500)
    fireEvent.click(btn('Refresh all'))
    await waitFor(() => expect(R('d1').querySelector('.loader')).toBeTruthy())
    await waitFor(() => expect(R('d1').querySelector('.loader')).toBeNull(), { timeout: 2000 })
    expect(row('d1/app')).toBeTruthy()
  })

  it('Collapse All closes everything, Expand All only reopens already-loaded nodes (no new queries)', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    await sleep(500)
    fireEvent.click(btn('Collapse All'))
    await waitFor(() => expect(ids()).toEqual(['d1']))
    api.databases.mockClear()
    api.schemasAll.mockClear()
    fireEvent.click(btn('Expand All (loaded)'))
    await waitFor(() => expect(ids()).toEqual(['d1', 'd1/app', 'd1/other', 'd1/__server']))
    expect(api.databases).not.toHaveBeenCalled()
    expect(api.schemasAll).not.toHaveBeenCalled()
  })

  it('Select Opened Object is disabled without an active tab', async () => {
    await mount()
    expect(btn('Select Opened Object').disabled).toBe(true)
  })

  it('Select Opened Object expands the path, selects the table and scrolls to it', async () => {
    await mount({ activeTarget: 'd1/app/public/orders' })
    expect(btn('Select Opened Object').disabled).toBe(false)
    fireEvent.click(btn('Select Opened Object'))
    await waitFor(() => expect(selected()).toEqual(['d1/app/public/orders']), { timeout: 3000 })
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('Select Opened Object opens the folder chain containing the source', async () => {
    const folders: Folder[] = [{ id: 'f1', name: 'Work', parentId: null }, { id: 'f2', name: 'Sub', parentId: 'f1' }]
    setup({ listSources: [mkDs('d1', { name: 'Local', folderId: 'f2' })], listFolders: folders })
    await mount({ activeTarget: 'd1' })
    expect(ids()).toEqual(['folder:f1'])
    fireEvent.click(btn('Select Opened Object'))
    await waitFor(() => expect(selected()).toEqual(['d1']), { timeout: 3000 })
    expect(ids()).toEqual(['folder:f1', 'folder:f2', 'd1'])
  })
})

describe('Explorer: selection', () => {
  it('click selects one row; cmd/ctrl-click toggles; shift-click extends a range in tree order', async () => {
    setup({ listSources: [mkDs('d1'), mkDs('d2'), mkDs('d3'), mkDs('d4')] })
    await mount()
    click('d1')
    expect(selected()).toEqual(['d1'])
    click('d3', { ctrlKey: true })
    expect(selected()).toEqual(['d1', 'd3'])
    click('d1', { metaKey: true })
    expect(selected()).toEqual(['d3'])
    click('d4', { shiftKey: true }) // the anchor is the last cmd-clicked row (d1)
    expect(selected()).toEqual(['d1', 'd2', 'd3', 'd4'])
    click('d3')
    click('d1', { shiftKey: true })
    expect(selected()).toEqual(['d1', 'd2', 'd3'])
  })

  it('shift-click without an anchor just selects the row', async () => {
    setup({ listSources: [mkDs('d1'), mkDs('d2')] })
    await mount()
    click('d2', { shiftKey: true })
    expect(selected()).toEqual(['d2'])
  })

  it('right-click selects the row if it is not already in the selection', async () => {
    setup({ listSources: [mkDs('d1'), mkDs('d2')] })
    await mount()
    click('d1')
    ctx('d2')
    expect(selected()).toEqual(['d2'])
  })

  it('the chevron selects the row and toggles it without a double toggle', async () => {
    await mount()
    await open('d1', 'd1/app')
    expect(selected()).toEqual(['d1'])
  })
})

describe('Explorer: context menus', () => {
  it('data source menu', async () => {
    await mount()
    ctx('d1')
    expect(menuLabels()).toEqual([
      'New Query Console', 'New Database…', 'Edit Data Source…', 'Rename', 'Duplicate', 'Refresh', 'Disconnect',
      'Sort Databases', 'Copy Name', 'Delete Data Source…'
    ])
    expect(menuItem('Delete Data Source…').classList.contains('danger')).toBe(true)
    expect(menuItem('Edit Data Source…').querySelector('.kbd')!.textContent).toBe('F4')
  })

  it('database menu', async () => {
    await mount()
    await open('d1', 'd1/app')
    ctx('d1/app')
    expect(menuLabels()).toEqual(['New Query Console', 'New Schema…', 'Refresh', 'Copy Name', 'Drop Database…'])
  })

  it('schema menu', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    ctx('d1/app/public')
    expect(menuLabels()).toEqual(['New Query Console', 'New Table…', 'New View…', 'Refresh', 'Copy Name'])
  })

  it('table menu has New Column…, a view menu does not', async () => {
    await mount()
    await openTables()
    ctx('d1/app/public/users')
    expect(menuLabels()).toEqual([
      'Open Table', 'New Query Console', 'New Column…', 'Rename', 'Copy Name', 'Copy Qualified Name', 'Copy SELECT Statement', 'Refresh', 'Drop…'
    ])
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.ctxmenu')).toBeNull()
    ctx('d1/app/public/v')
    expect(menuLabels()).not.toContain('New Column…')
  })

  it('right-click on empty space offers New Folder / New Data Source…', async () => {
    await mount()
    fireEvent.contextMenu(document.querySelector('.tree')!, { clientX: 1, clientY: 2 })
    expect(menuLabels()).toEqual(['New Folder', 'New Data Source…'])
    pick('New Data Source…')
    expect(cb.onEdit).toHaveBeenCalledWith(null)
    expect(document.querySelector('.ctxmenu')).toBeNull()
  })

  it('the menu closes on outside click and on Escape; it opens at the pointer', async () => {
    await mount()
    ctx('d1')
    expect((document.querySelector('.ctxmenu') as HTMLElement).style.left).toBe('12px')
    expect((document.querySelector('.ctxmenu') as HTMLElement).style.top).toBe('34px')
    fireEvent.click(window)
    expect(document.querySelector('.ctxmenu')).toBeNull()
    ctx('d1')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.ctxmenu')).toBeNull()
  })

  it('Sort Databases has a submenu with a ✓ on the current sort; choosing one calls setSort and refreshes', async () => {
    setup({ listSources: [mkDs('d1', { dbSort: 'size-desc' })] })
    await mount()
    ctx('d1')
    const sub = Array.from(document.querySelectorAll('.submenu .ctxitem span')).map((s) => s.textContent)
    expect(sub).toEqual(['    Name (A → Z)', '    Name (Z → A)', '✓ Size (largest first)', '    Size (smallest first)'])
    fireEvent.click(menuItem('Sort Databases')) // clicking the parent does nothing
    expect(document.querySelector('.ctxmenu')).not.toBeNull()
    fireEvent.click(Array.from(document.querySelectorAll('.submenu .ctxitem')).find((i) => i.textContent!.includes('Z → A'))!)
    await waitFor(() => expect(api.setSort).toHaveBeenCalledWith('d1', 'name-desc'))
    await waitFor(() => expect(cb.onRefreshed).toHaveBeenCalledWith('d1'))
  })

  describe('actions', () => {
    it('New Query Console variants carry the right scope/SQL', async () => {
      await mount()
      await openTables()
      ctx('d1'); pick('New Query Console')
      expect(cb.onConsole).toHaveBeenLastCalledWith({ dsId: 'd1', dsName: 'Local', database: 'postgres' })
      ctx('d1/app'); pick('New Query Console')
      expect(cb.onConsole).toHaveBeenLastCalledWith({ dsId: 'd1', dsName: 'Local', database: 'app' })
      ctx('d1/app/public'); pick('New Query Console')
      expect(cb.onConsole).toHaveBeenLastCalledWith({ dsId: 'd1', dsName: 'Local', database: 'app', schema: 'public' })
      ctx('d1/app/public/users'); pick('New Query Console')
      expect(cb.onConsole).toHaveBeenLastCalledWith({ dsId: 'd1', dsName: 'Local', database: 'app', schema: 'public', sql: 'select * from "public"."users" limit 100;\n' })
      ctx('d1/app/public'); pick('New View…')
      expect(cb.onConsole).toHaveBeenLastCalledWith({
        dsId: 'd1', dsName: 'Local', database: 'app', schema: 'public',
        sql: 'create view "public".view_name as\nselect *\nfrom "public".table_name;\n'
      })
    })

    it('identifiers in generated SQL are quoted/escaped', async () => {
      setup({ databases: ['app'], schemasAll: ['we"ird'], tableNames: {}, tables: async () => [T('ta"ble')] })
      await mount()
      await open('d1', 'd1/app')
      await open('d1/app', 'd1/app/we"ird')
      await open('d1/app/we"ird', 'd1/app/we"ird/ta"ble')
      ctx('d1/app/we"ird/ta"ble'); pick('Copy SELECT Statement')
      expect(clip).toHaveBeenLastCalledWith('select * from "we""ird"."ta""ble";')
      ctx('d1/app/we"ird'); pick('New View…')
      expect(cb.onConsole.mock.calls.at(-1)![0].sql).toContain('create view "we""ird".view_name')
    })

    it('copy variants write to the clipboard', async () => {
      await mount()
      await openTables()
      ctx('d1'); pick('Copy Name'); expect(clip).toHaveBeenLastCalledWith('Local')
      ctx('d1/app'); pick('Copy Name'); expect(clip).toHaveBeenLastCalledWith('app')
      ctx('d1/app/public'); pick('Copy Name'); expect(clip).toHaveBeenLastCalledWith('public')
      ctx('d1/app/public/users'); pick('Copy Name'); expect(clip).toHaveBeenLastCalledWith('users')
      ctx('d1/app/public/users'); pick('Copy Qualified Name'); expect(clip).toHaveBeenLastCalledWith('public.users')
      ctx('d1/app/public/users'); pick('Copy SELECT Statement'); expect(clip).toHaveBeenLastCalledWith('select * from "public"."users";')
    })

    it('Open Table / Edit Data Source…', async () => {
      await mount()
      await openTables()
      ctx('d1/app/public/orders'); pick('Open Table')
      expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ table: 'orders', kind: 'table' }))
      ctx('d1'); pick('Edit Data Source…')
      expect(cb.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }))
    })

    it('Duplicate calls the API and reloads the sources', async () => {
      await mount()
      api.listSources.mockClear()
      ctx('d1'); pick('Duplicate')
      await waitFor(() => expect(api.duplicateSource).toHaveBeenCalledWith('d1'))
      await waitFor(() => expect(api.listSources).toHaveBeenCalled())
    })

    it('Disconnect closes the pool and then refreshes the node', async () => {
      await mount()
      ctx('d1'); pick('Disconnect')
      await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith('d1'))
      await waitFor(() => expect(cb.onRefreshed).toHaveBeenCalledWith('d1'))
    })

    it('Refresh reports the id upward and reloads the node', async () => {
      await mount()
      await open('d1', 'd1/app')
      api.databases.mockClear()
      ctx('d1'); pick('Refresh')
      expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
      await waitFor(() => expect(api.databases).toHaveBeenCalledTimes(1))
    })

    it('refreshing a collapsed, never-loaded node loads it (fills the count pill)', async () => {
      await mount()
      expect(api.databases).not.toHaveBeenCalled()
      ctx('d1'); pick('Refresh')
      await waitFor(() => expect(api.databases).toHaveBeenCalled())
      await waitFor(() => expect(badge('d1')).toBe('2'))
    })

    it('table Refresh refreshes the schema and the table', async () => {
      await mount()
      await openTables()
      ctx('d1/app/public/users'); pick('Refresh')
      expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public')
      expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public/users')
    })

    it('Delete Data Source: cancelled confirm does nothing; confirmed deletes and reports the object gone', async () => {
      await mount()
      confirmFn.mockReturnValueOnce(false)
      ctx('d1'); pick('Delete Data Source…')
      expect(api.deleteSource).not.toHaveBeenCalled()
      ctx('d1'); pick('Delete Data Source…')
      expect(confirmFn).toHaveBeenLastCalledWith('Remove data source "Local"? This does not touch the database.')
      await waitFor(() => expect(api.deleteSource).toHaveBeenCalledWith('d1'))
      await waitFor(() => expect(cb.onObjectGone).toHaveBeenCalledWith({ dsId: 'd1' }))
    })

    it('Drop Database: confirm text, API call, onObjectGone, refresh of the source', async () => {
      await mount()
      await open('d1', 'd1/app')
      confirmFn.mockReturnValueOnce(false)
      ctx('d1/app'); pick('Drop Database…')
      expect(api.dropDatabase).not.toHaveBeenCalled()
      ctx('d1/app'); pick('Drop Database…')
      expect(confirmFn.mock.calls.at(-1)![0]).toContain('Drop database "app"?')
      await waitFor(() => expect(api.dropDatabase).toHaveBeenCalledWith('d1', 'app'))
      await waitFor(() => expect(cb.onObjectGone).toHaveBeenCalledWith({ dsId: 'd1', database: 'app' }))
      expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
    })

    it('Drop Database failure shows the cleaned error and does not report the object gone', async () => {
      setup({ dropDatabase: async () => { throw new Error("Error invoking remote method 'x': Error: database is being accessed by other users") } })
      await mount()
      await open('d1', 'd1/app')
      ctx('d1/app'); pick('Drop Database…')
      await waitFor(() => expect(document.querySelector('.explorer > .tree-err')!.textContent).toBe('database is being accessed by other users'))
      expect(cb.onObjectGone).not.toHaveBeenCalled()
    })

    it('Drop table / view: passes the kind, reports gone, refreshes the schema; failure shows an error', async () => {
      await mount()
      await openTables()
      ctx('d1/app/public/v'); pick('Drop…')
      expect(confirmFn.mock.calls.at(-1)![0]).toBe('Drop view public.v? This cannot be undone.')
      await waitFor(() => expect(api.dropTable).toHaveBeenCalledWith('d1', 'app', 'public', 'v', 'view'))
      await waitFor(() => expect(cb.onObjectGone).toHaveBeenCalledWith({ dsId: 'd1', database: 'app', schema: 'public', table: 'v' }))
      expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public')
      api.dropTable.mockRejectedValueOnce(new Error('cannot drop users because other objects depend on it'))
      ctx('d1/app/public/users'); pick('Drop…')
      await waitFor(() => expect(document.querySelector('.explorer > .tree-err')!.textContent).toContain('other objects depend on it'))
    })

    it('Drop… declined by the user does nothing', async () => {
      await mount()
      await openTables()
      confirmFn.mockReturnValue(false)
      ctx('d1/app/public/users'); pick('Drop…')
      expect(api.dropTable).not.toHaveBeenCalled()
    })
  })

  describe('rename', () => {
    const typeAndEnter = (value: string): void => {
      const input = document.querySelector('.tree-input') as HTMLInputElement
      input.value = value
      fireEvent.keyDown(input, { key: 'Enter' })
    }

    it('renaming a data source asks for a name inline and calls renameSource', async () => {
      await mount()
      ctx('d1'); pick('Rename')
      const input = document.querySelector('.tree-input') as HTMLInputElement
      expect(input.value).toBe('Local')
      typeAndEnter('Prod')
      await waitFor(() => expect(api.renameSource).toHaveBeenCalledWith('d1', 'Prod'))
      expect(document.querySelector('.tree-input')).toBeNull()
    })

    it('unchanged / blank names and Escape do not rename', async () => {
      await mount()
      ctx('d1'); pick('Rename'); typeAndEnter('Local')
      ctx('d1'); pick('Rename'); typeAndEnter('   ')
      ctx('d1'); pick('Rename')
      fireEvent.keyDown(document.querySelector('.tree-input')!, { key: 'Escape' })
      await sleep(10)
      expect(api.renameSource).not.toHaveBeenCalled()
      expect(document.querySelector('.tree-input')).toBeNull()
    })

    it('renaming a table: API call, onTableRenamed, schema refresh', async () => {
      await mount()
      await openTables()
      ctx('d1/app/public/users'); pick('Rename')
      expect((document.querySelector('.tree-input') as HTMLInputElement).value).toBe('users')
      typeAndEnter('people')
      await waitFor(() => expect(api.renameTable).toHaveBeenCalledWith('d1', 'app', 'public', 'users', 'people'))
      await waitFor(() => expect(cb.onTableRenamed).toHaveBeenCalledWith('d1', 'app', 'public', 'users', 'people'))
      expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public')
    })

    it('renaming a table that is in an explicit table filter updates the filter list', async () => {
      setup({
        listSources: [mkDs('d1', { tableFilter: { 'app/public': { list: ['users', 'orders'] } } })],
        renameTable: undefined
      })
      await mount()
      await openTables()
      ctx('d1/app/public/users'); pick('Rename')
      typeAndEnter('people')
      await waitFor(() => expect(api.setTableFilter).toHaveBeenCalledWith('d1', 'app', 'public', { list: ['orders', 'people'] }))
    })

    it('a failing rename shows the error and does not report the rename', async () => {
      await mount()
      await openTables()
      api.renameTable.mockRejectedValueOnce(new Error('relation "orders" already exists'))
      ctx('d1/app/public/users'); pick('Rename')
      typeAndEnter('orders')
      await waitFor(() => expect(document.querySelector('.explorer > .tree-err')!.textContent).toContain('already exists'))
      expect(cb.onTableRenamed).not.toHaveBeenCalled()
    })

    it('renaming a table to its own name is a no-op', async () => {
      await mount()
      await openTables()
      ctx('d1/app/public/users'); pick('Rename')
      typeAndEnter('users')
      expect(api.renameTable).not.toHaveBeenCalled()
    })
  })
})

describe('Explorer: creating objects (dialog wiring)', () => {
  it('New Database… opens the dialog for the data source', async () => {
    await mount()
    ctx('d1'); pick('New Database…')
    expect(document.querySelector('.create-stub')).toBeTruthy()
    expect(h.createProps!.req).toEqual({ kind: 'database', dsId: 'd1', nodeId: 'd1' })
  })

  it('New Schema… / New Table… / New Column… pass their scope', async () => {
    await mount()
    await openTables()
    ctx('d1/app'); pick('New Schema…')
    expect(h.createProps!.req).toEqual({ kind: 'schema', dsId: 'd1', database: 'app', nodeId: 'd1/app' })
    act(() => h.createProps!.onClose(false))
    ctx('d1/app/public'); pick('New Table…')
    expect(h.createProps!.req).toEqual({ kind: 'table', dsId: 'd1', database: 'app', schema: 'public', nodeId: 'd1/app/public' })
    act(() => h.createProps!.onClose(false))
    ctx('d1/app/public/users'); pick('New Column…')
    expect(h.createProps!.req).toEqual({ kind: 'column', dsId: 'd1', database: 'app', schema: 'public', table: 'users', nodeId: 'd1/app/public/users' })
  })

  it('cancelling closes the dialog without refreshing', async () => {
    await mount()
    ctx('d1'); pick('New Database…')
    act(() => h.createProps!.onClose(false))
    expect(document.querySelector('.create-stub')).toBeNull()
    expect(cb.onRefreshed).not.toHaveBeenCalled()
  })

  it('a created database expands the data source and refreshes it', async () => {
    await mount()
    ctx('d1'); pick('New Database…')
    act(() => h.createProps!.onClose(true, 'newdb'))
    expect(document.querySelector('.create-stub')).toBeNull()
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
    await waitFor(() => expect(row('d1/app')).toBeTruthy())
  })

  it('a created table is added to an explicit table filter so it does not stay hidden', async () => {
    setup({ listSources: [mkDs('d1', { tableFilter: { 'app/public': { list: ['users'] } } })] })
    await mount()
    await openTables()
    ctx('d1/app/public'); pick('New Table…')
    act(() => h.createProps!.onClose(true, 'fresh'))
    await waitFor(() => expect(api.setTableFilter).toHaveBeenCalledWith('d1', 'app', 'public', { list: ['users', 'fresh'] }))
  })

  it('a pattern rule filter is left alone when creating a table', async () => {
    setup({ listSources: [mkDs('d1', { tableFilter: { 'app/public': { rule: { mode: 'contains', pattern: 'x' } } } })] })
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    ctx('d1/app/public'); pick('New Table…')
    act(() => h.createProps!.onClose(true, 'fresh'))
    await sleep(20)
    expect(api.setTableFilter).not.toHaveBeenCalled()
  })

  it('a created column also refreshes the parent schema (open table views reload)', async () => {
    await mount()
    await openTables()
    ctx('d1/app/public/users'); pick('New Column…')
    act(() => h.createProps!.onClose(true, 'age'))
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public/users')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public')
  })
})

describe('Explorer: count-pill pickers', () => {
  it('the data source pill opens the database picker and saves visibleDbs', async () => {
    await mount()
    await open('d1', 'd1/app')
    await waitFor(() => expect(badge('d1')).toBe('2'))
    fireEvent.click(R('d1').querySelector('.badge')!)
    expect(document.querySelector('.picker-stub')!.getAttribute('data-icon')).toBe('database')
    expect(h.picker!.selected).toBeNull()
    await h.picker!.load()
    expect(api.databases).toHaveBeenCalled()
    act(() => void h.picker!.onChange(['app'] as never))
    await waitFor(() => expect(api.setVisibleDbs).toHaveBeenCalledWith('d1', ['app']))
    act(() => void h.picker!.onClose())
    expect(document.querySelector('.picker-stub')).toBeNull()
  })

  it('the database pill opens the schema picker; default selection hides system schemas', async () => {
    setup({ listSources: [mkDs('d1', { schemaFilter: { app: ['public'] } })] })
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    await waitFor(() => expect(badge('d1/app')).toBe('1 of 3'))
    fireEvent.click(R('d1/app').querySelector('.badge')!)
    expect(document.querySelector('.picker-stub')!.getAttribute('data-icon')).toBe('schema')
    expect(h.picker!.selected).toEqual(['public'])
    expect((h.picker!.defaultOf as (a: string[]) => string[])(['public', 'pg_catalog', 'information_schema', 'x'])).toEqual(['public', 'x'])
    act(() => void h.picker!.onChange(['public', 'extra'] as never))
    await waitFor(() => expect(api.setSchemaFilter).toHaveBeenCalledWith('d1', 'app', ['public', 'extra']))
  })

  it('the schema pill opens the table picker; a rule is persisted as a rule, a list as a list, none as null', async () => {
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    await waitFor(() => expect(badge('d1/app/public')).toBe('3'))
    fireEvent.click(R('d1/app/public').querySelector('.badge')!)
    expect(document.querySelector('.picker-stub')!.getAttribute('data-icon')).toBe('table')
    expect(h.picker!.persistRule).toBe(true)
    expect(await (h.picker!.load as () => Promise<string[]>)()).toEqual(['users', 'orders', 'v'])
    const rule = { mode: 'starts', pattern: 'u' }
    act(() => void h.picker!.onChange(null as never, rule as never))
    await waitFor(() => expect(api.setTableFilter).toHaveBeenLastCalledWith('d1', 'app', 'public', { rule }))
    act(() => void h.picker!.onChange(['users'] as never, null as never))
    await waitFor(() => expect(api.setTableFilter).toHaveBeenLastCalledWith('d1', 'app', 'public', { list: ['users'] }))
    act(() => void h.picker!.onChange(null as never, null as never))
    await waitFor(() => expect(api.setTableFilter).toHaveBeenLastCalledWith('d1', 'app', 'public', null))
  })

  it('pill clicks do not select the row or toggle it', async () => {
    await mount()
    await open('d1', 'd1/app')
    await waitFor(() => expect(badge('d1')).toBe('2'))
    click('d1/app')
    fireEvent.click(R('d1').querySelector('.badge')!)
    expect(selected()).toEqual(['d1/app'])
    expect(row('d1/app')).toBeTruthy()
  })
})

describe('Explorer: multi-selection bulk actions', () => {
  it('right-clicking inside a multi-selection of tables offers Refresh / Copy Names / Drop N Tables…', async () => {
    await mount()
    await openTables()
    click('d1/app/public/users')
    click('d1/app/public/orders', { metaKey: true })
    ctx('d1/app/public/users')
    expect(menuLabels()).toEqual(['Refresh', 'Copy Names', 'Drop 2 Tables…'])
    expect(selected().length).toBe(2)
  })

  it('Copy Names joins with newlines', async () => {
    await mount()
    await openTables()
    click('d1/app/public/users')
    click('d1/app/public/orders', { shiftKey: true })
    ctx('d1/app/public/users'); pick('Copy Names')
    expect(clip).toHaveBeenCalledWith('users\norders')
  })

  it('Drop N Tables…: confirm lists the names, each table is dropped with its kind, then the selection clears', async () => {
    await mount()
    await openTables()
    click('d1/app/public/users')
    click('d1/app/public/v', { shiftKey: true })
    ctx('d1/app/public/users'); pick('Drop 3 Tables…')
    const msg = confirmFn.mock.calls.at(-1)![0] as string
    expect(msg).toContain('Drop 3 tables/views?')
    expect(msg).toContain('  • users\n  • orders\n  • v')
    await waitFor(() => expect(api.dropTable).toHaveBeenCalledTimes(3))
    expect(api.dropTable.mock.calls.map((c) => [c[3], c[4]])).toEqual([['users', 'table'], ['orders', 'table'], ['v', 'view']])
    expect(cb.onObjectGone).toHaveBeenCalledTimes(3)
    expect(cb.onObjectGone).toHaveBeenCalledWith({ dsId: 'd1', database: 'app', schema: 'public', table: 'v' })
    await waitFor(() => expect(selected()).toEqual([]))
  })

  it('declining the confirm drops nothing', async () => {
    await mount()
    await openTables()
    click('d1/app/public/users')
    click('d1/app/public/orders', { metaKey: true })
    confirmFn.mockReturnValue(false)
    ctx('d1/app/public/users'); pick('Drop 2 Tables…')
    expect(api.dropTable).not.toHaveBeenCalled()
    expect(selected().length).toBe(2)
  })

  it('failures are collected into one message while the others still drop', async () => {
    await mount()
    await openTables()
    api.dropTable.mockRejectedValueOnce(new Error("Error invoking remote method 'db:dropTable': Error: in use"))
    click('d1/app/public/users')
    click('d1/app/public/orders', { metaKey: true })
    ctx('d1/app/public/users'); pick('Drop 2 Tables…')
    await waitFor(() => expect(document.querySelector('.explorer > .tree-err')!.textContent).toBe('Could not drop some tables: users (in use)'))
    expect(api.dropTable).toHaveBeenCalledTimes(2)
    expect(cb.onObjectGone).toHaveBeenCalledTimes(1)
  })

  it('long lists in the confirm are cut at 12 with "… and N more"', async () => {
    const many = Array.from({ length: 15 }, (_, i) => 't' + String(i).padStart(2, '0'))
    setup({ tables: async () => many.map((n) => T(n)), tableNames: { public: many } })
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    await open('d1/app/public', 'd1/app/public/t00')
    click('d1/app/public/t00')
    click('d1/app/public/t14', { shiftKey: true })
    ctx('d1/app/public/t00'); pick('Drop 15 Tables…')
    const msg = confirmFn.mock.calls.at(-1)![0] as string
    expect(msg).toContain('• t11')
    expect(msg).not.toContain('• t12')
    expect(msg).toContain('… and 3 more')
  })

  it('bulk database drop: confirm, API calls, onObjectGone per database, source refreshed', async () => {
    await mount()
    await open('d1', 'd1/app')
    click('d1/app')
    click('d1/other', { metaKey: true })
    ctx('d1/app')
    expect(menuLabels()).toEqual(['Refresh', 'Copy Names', 'Drop 2 Databases…'])
    pick('Drop 2 Databases…')
    expect(confirmFn.mock.calls.at(-1)![0]).toContain('Drop 2 databases?')
    await waitFor(() => expect(api.dropDatabase).toHaveBeenCalledTimes(2))
    expect(cb.onObjectGone).toHaveBeenCalledWith({ dsId: 'd1', database: 'other' })
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
  })

  it('bulk data source delete', async () => {
    setup({ listSources: [mkDs('d1'), mkDs('d2'), mkDs('d3')] })
    await mount()
    click('d1')
    click('d3', { shiftKey: true })
    ctx('d2')
    expect(menuLabels()).toEqual(['Refresh', 'Copy Names', 'Delete 3 Data Sources…'])
    pick('Delete 3 Data Sources…')
    expect(confirmFn.mock.calls.at(-1)![0]).toContain('Remove 3 data sources?')
    await waitFor(() => expect(api.deleteSource).toHaveBeenCalledTimes(3))
    expect(cb.onObjectGone).toHaveBeenCalledWith({ dsId: 'd2' })
  })

  it('mixed kinds only offer Refresh and Copy Names', async () => {
    await mount()
    await open('d1', 'd1/app')
    click('d1')
    click('d1/app', { metaKey: true })
    ctx('d1')
    expect(menuLabels()).toEqual(['Refresh', 'Copy Names'])
  })

  it('bulk Refresh refreshes each selected node (tables refresh their schema too)', async () => {
    await mount()
    await openTables()
    click('d1/app/public/users')
    click('d1/app/public/orders', { metaKey: true })
    ctx('d1/app/public/users'); pick('Refresh')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public/users')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public/orders')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app/public')
  })

  it('bulk Refresh on databases/schemas uses the right ids', async () => {
    await mount()
    await open('d1', 'd1/app')
    click('d1/app')
    click('d1/other', { metaKey: true })
    ctx('d1/app'); pick('Refresh')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/app')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/other')
  })
})

describe('Explorer: keyboard', () => {
  it('Arrow Down/Up move the selection; Shift extends a range', async () => {
    setup({ listSources: [mkDs('d1'), mkDs('d2'), mkDs('d3')] })
    await mount()
    click('d1')
    key('ArrowDown')
    expect(selected()).toEqual(['d2'])
    key('ArrowDown', { shiftKey: true })
    expect(selected()).toEqual(['d2', 'd3'])
    key('ArrowUp')
    expect(selected()).toEqual(['d2'])
    key('ArrowUp')
    key('ArrowUp') // clamps at the top
    expect(selected()).toEqual(['d1'])
  })

  it('arrows with no selection start at the first row', async () => {
    setup({ listSources: [mkDs('d1'), mkDs('d2')] })
    await mount()
    fireEvent.mouseDown(R('d2'))
    key('ArrowDown')
    expect(selected()).toEqual(['d1'])
  })

  it('Right expands, Right again moves to the first child, Left on a child moves to the parent, Left collapses', async () => {
    await mount()
    click('d1')
    key('ArrowRight')
    await waitFor(() => expect(row('d1/app')).toBeTruthy())
    key('ArrowRight')
    expect(selected()).toEqual(['d1/app'])
    key('ArrowLeft') // db is closed: go to the parent
    expect(selected()).toEqual(['d1'])
    key('ArrowLeft')
    await waitFor(() => expect(row('d1/app')).toBeNull())
  })

  it('Right on a leaf does nothing', async () => {
    await mount()
    await openTables()
    click('d1/app/public/users')
    key('ArrowRight')
    expect(selected()).toEqual(['d1/app/public/users'])
  })

  it('Enter opens a table, toggles a node', async () => {
    await mount()
    click('d1')
    key('Enter')
    await waitFor(() => expect(row('d1/app')).toBeTruthy())
    await open('d1/app', 'd1/app/public')
    await open('d1/app/public', 'd1/app/public/orders')
    click('d1/app/public/orders')
    key('Enter')
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ table: 'orders' }))
  })

  it('arrow/enter keys with a modifier are not navigation', async () => {
    setup({ listSources: [mkDs('d1'), mkDs('d2')] })
    await mount()
    click('d1')
    key('ArrowDown', { metaKey: true })
    key('ArrowDown', { altKey: true })
    expect(selected()).toEqual(['d1'])
  })

  it('F4 opens the selected table / edits the selected source', async () => {
    await mount()
    click('d1')
    key('F4')
    expect(cb.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }))
    await openTables()
    click('d1/app/public/users')
    key('F4')
    expect(cb.onOpen).toHaveBeenCalledWith(expect.objectContaining({ table: 'users' }))
  })

  it('F2 starts renaming', async () => {
    await mount()
    click('d1')
    key('F2')
    expect(document.querySelector('.tree-input')).toBeTruthy()
  })

  it('⇧⌘L opens a console; ⌥⌘C copies the name', async () => {
    await mount()
    click('d1')
    combo('KeyL', { metaKey: true, shiftKey: true })
    expect(cb.onConsole).toHaveBeenCalledWith({ dsId: 'd1', dsName: 'Local', database: 'postgres' })
    combo('KeyC', { ctrlKey: true, altKey: true })
    expect(clip).toHaveBeenCalledWith('Local')
  })

  it('⌘R refreshes the selected item', async () => {
    await mount()
    click('d1')
    combo('KeyR', { metaKey: true })
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
  })

  it('⌘⌫ / Ctrl+Delete drops the selected table (after confirming)', async () => {
    await mount()
    await openTables()
    click('d1/app/public/orders')
    combo('Backspace', { metaKey: true })
    await waitFor(() => expect(api.dropTable).toHaveBeenCalledWith('d1', 'app', 'public', 'orders', 'table'))
    fireEvent.keyDown(document.body, { key: 'Delete', ctrlKey: true })
    await waitFor(() => expect(api.dropTable).toHaveBeenCalledTimes(2))
  })

  it('⌘⌫ with a multi-selection runs the bulk drop; with mixed kinds nothing happens', async () => {
    await mount()
    await openTables()
    click('d1/app/public/users')
    click('d1/app/public/orders', { metaKey: true })
    combo('Backspace', { metaKey: true })
    expect(confirmFn.mock.calls.at(-1)![0]).toContain('Drop 2 tables/views?')
    await waitFor(() => expect(api.dropTable).toHaveBeenCalledTimes(2))
  })

  it('shortcuts are ignored while typing in an input, or when the last click was outside the explorer', async () => {
    await mount()
    click('d1')
    const input = document.querySelector('.tree-filter') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'F4' })
    expect(cb.onEdit).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    key('F4')
    expect(cb.onEdit).not.toHaveBeenCalled()
  })

  it('shortcuts are ignored while a modal is open or during inline editing', async () => {
    await mount()
    click('d1')
    const modal = document.createElement('div')
    modal.className = 'modal-bg'
    document.body.append(modal)
    fireEvent.keyDown(modal, { key: 'F4' })
    modal.remove()
    expect(cb.onEdit).not.toHaveBeenCalled()
    key('F2')
    key('F4') // editing now
    expect(cb.onEdit).not.toHaveBeenCalled()
  })

  it('shortcut with no matching menu item does nothing (e.g. ⇧⌘L on a Server Objects row)', async () => {
    await mount()
    await open('d1', 'd1/__server')
    click('d1/__server')
    combo('KeyL', { metaKey: true, shiftKey: true })
    expect(cb.onConsole).not.toHaveBeenCalled()
  })

  it('folders: Right/Left expand/collapse, Enter toggles', async () => {
    setup({ listSources: [mkDs('d1', { folderId: 'f1' })], listFolders: [{ id: 'f1', name: 'Work', parentId: null }] })
    await mount()
    click('folder:f1')
    key('ArrowRight')
    expect(ids()).toEqual(['folder:f1', 'd1'])
    key('ArrowLeft')
    expect(ids()).toEqual(['folder:f1'])
    key('Enter')
    expect(ids()).toEqual(['folder:f1', 'd1'])
    key('Enter')
    expect(ids()).toEqual(['folder:f1'])
  })
})

describe('Explorer: folders', () => {
  const FOLDERS: Folder[] = [
    { id: 'f1', name: 'Work', parentId: null },
    { id: 'f2', name: 'Alpha', parentId: null },
    { id: 'f3', name: 'Sub', parentId: 'f1' }
  ]
  const dt = (data: string): { dataTransfer: { getData: () => string; setData: ReturnType<typeof vi.fn> } } => ({ dataTransfer: { getData: () => data, setData: vi.fn() } })
  beforeEach(() => {
    setup({
      listFolders: FOLDERS,
      listSources: [mkDs('d1', { name: 'Root', folderId: null }), mkDs('d2', { name: 'InWork', folderId: 'f1' }), mkDs('d3', { name: 'InSub', folderId: 'f3' })]
    })
  })

  it('folders are listed alphabetically before sources; they start collapsed', async () => {
    await mount()
    expect(ids()).toEqual(['folder:f2', 'folder:f1', 'd1'])
  })

  it('expanding a folder shows its sub-folders and sources, indented', async () => {
    await mount()
    fireEvent.click(R('folder:f1').querySelector('.arrow')!)
    expect(ids()).toEqual(['folder:f2', 'folder:f1', 'folder:f3', 'd2', 'd1'])
    expect(R('folder:f3').dataset.depth).toBe('1')
    expect(R('d2').dataset.depth).toBe('1')
    fireEvent.doubleClick(R('folder:f1'))
    expect(ids()).toEqual(['folder:f2', 'folder:f1', 'd1'])
  })

  it('folder expansion is persisted into the session', async () => {
    await mount()
    fireEvent.click(R('folder:f1').querySelector('.arrow')!)
    expect(h.patch.at(-1)).toEqual({ folders: ['f1'] })
    fireEvent.click(R('folder:f1').querySelector('.arrow')!)
    expect(h.patch.at(-1)).toEqual({ folders: [] })
  })

  it('folder menu', async () => {
    await mount()
    ctx('folder:f1')
    expect(menuLabels()).toEqual(['New Folder', 'New Data Source…', 'Rename', 'Refresh', 'Delete Folder'])
  })

  it('New Data Source… in a folder passes the folder id', async () => {
    await mount()
    ctx('folder:f1'); pick('New Data Source…')
    expect(cb.onEdit).toHaveBeenCalledWith(null, 'f1')
  })

  it('New Folder from the folder menu expands the parent, edits inline and creates it there', async () => {
    await mount()
    ctx('folder:f1'); pick('New Folder')
    expect(ids()).toContain('folder:f3')
    const input = document.querySelector('.tree-input') as HTMLInputElement
    expect(input.value).toBe('New Folder')
    input.value = 'Fresh'
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith('Fresh', 'f1'))
  })

  it('the toolbar button creates a top-level folder; blank names and Escape create nothing', async () => {
    await mount()
    fireEvent.click(document.querySelector('[data-tip="New folder"]')!)
    let input = document.querySelector('.tree-input') as HTMLInputElement
    input.value = 'Top'
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith('Top', null))
    fireEvent.click(document.querySelector('[data-tip="New folder"]')!)
    input = document.querySelector('.tree-input') as HTMLInputElement
    input.value = '  '
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(document.querySelector('[data-tip="New folder"]')!)
    fireEvent.keyDown(document.querySelector('.tree-input')!, { key: 'Escape' })
    await sleep(10)
    expect(api.createFolder).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.tree-input')).toBeNull()
  })

  it('Rename edits the folder name inline and calls renameFolder', async () => {
    await mount()
    ctx('folder:f1'); pick('Rename')
    const input = document.querySelector('.tree-input') as HTMLInputElement
    expect(input.value).toBe('Work')
    input.value = 'Play'
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.renameFolder).toHaveBeenCalledWith('f1', 'Play'))
  })

  it('Delete Folder calls the API', async () => {
    await mount()
    ctx('folder:f2'); pick('Delete Folder')
    await waitFor(() => expect(api.deleteFolder).toHaveBeenCalledWith('f2'))
  })

  it('Refresh on a folder refreshes the sources in it and in its sub-folders', async () => {
    await mount()
    ctx('folder:f1'); pick('Refresh')
    expect(cb.onRefreshed.mock.calls.map((c) => c[0]).sort()).toEqual(['d2', 'd3'])
  })

  it('drag & drop: a data source onto a folder moves it (and expands the folder)', async () => {
    await mount()
    fireEvent.drop(R('folder:f2'), dt('ds:d1'))
    await waitFor(() => expect(api.moveSource).toHaveBeenCalledWith('d1', 'f2'))
    expect(ids()).toContain('folder:f2')
    expect(h.patch.some((p) => Array.isArray(p.folders) && (p.folders as string[]).includes('f2'))).toBe(true)
  })

  it('drag & drop: a folder onto another folder moves it, onto itself is ignored', async () => {
    await mount()
    fireEvent.drop(R('folder:f2'), dt('folder:f1'))
    await waitFor(() => expect(api.moveFolder).toHaveBeenCalledWith('f1', 'f2'))
    api.moveFolder.mockClear()
    fireEvent.drop(R('folder:f2'), dt('folder:f2'))
    await sleep(10)
    expect(api.moveFolder).not.toHaveBeenCalled()
  })

  it('drag & drop onto the empty tree area moves to the top level', async () => {
    await mount()
    fireEvent.drop(document.querySelector('.tree')!, dt('ds:d2'))
    await waitFor(() => expect(api.moveSource).toHaveBeenCalledWith('d2', null))
    fireEvent.drop(document.querySelector('.tree')!, dt('folder:f3'))
    await waitFor(() => expect(api.moveFolder).toHaveBeenCalledWith('f3', null))
  })

  it('drops of unknown payloads are ignored', async () => {
    await mount()
    fireEvent.drop(R('folder:f2'), dt('hello'))
    fireEvent.drop(R('folder:f2'), dt(''))
    await sleep(10)
    expect(api.moveSource).not.toHaveBeenCalled()
    expect(api.moveFolder).not.toHaveBeenCalled()
  })

  it('drag-over highlights the target folder (class "drop") and drag-leave clears it', async () => {
    await mount()
    fireEvent.dragOver(R('folder:f2'))
    expect(R('folder:f2').classList.contains('drop')).toBe(true)
    fireEvent.dragLeave(R('folder:f2'))
    expect(R('folder:f2').classList.contains('drop')).toBe(false)
    fireEvent.dragOver(document.querySelector('.tree')!)
    expect(document.querySelector('.tree')!.classList.contains('drop')).toBe(true)
    fireEvent.dragLeave(document.querySelector('.tree')!)
    expect(document.querySelector('.tree')!.classList.contains('drop')).toBe(false)
  })

  it('dragging a data source row / folder row sets the payload', async () => {
    await mount()
    const a = dt('').dataTransfer
    fireEvent.dragStart(R('d1'), { dataTransfer: a })
    expect(a.setData).toHaveBeenCalledWith('text/plain', 'ds:d1')
    const b = dt('').dataTransfer
    fireEvent.dragStart(R('folder:f1'), { dataTransfer: b })
    expect(b.setData).toHaveBeenCalledWith('text/plain', 'folder:f1')
  })

  it('source menus offer "Remove from Folder" and "Move to" other folders', async () => {
    await mount()
    fireEvent.click(R('folder:f1').querySelector('.arrow')!)
    ctx('d2')
    const labels = menuLabels()
    expect(labels).toContain('Remove from Folder')
    expect(labels).toContain('Move to 📁 Alpha')
    expect(labels).toContain('Move to 📁 Sub')
    expect(labels).not.toContain('Move to 📁 Work')
    pick('Remove from Folder')
    await waitFor(() => expect(api.moveSource).toHaveBeenCalledWith('d2', null))
    ctx('d1')
    expect(menuLabels()).not.toContain('Remove from Folder')
    pick('Move to 📁 Alpha')
    await waitFor(() => expect(api.moveSource).toHaveBeenCalledWith('d1', 'f2'))
  })

  it('a failing folder operation shows the error', async () => {
    api.deleteFolder.mockRejectedValue(new Error("Error invoking remote method 'x': Error: nope"))
    await mount()
    ctx('folder:f2'); pick('Delete Folder')
    await waitFor(() => expect(document.querySelector('.explorer > .tree-err')!.textContent).toBe('nope'))
  })
})

describe('Explorer: session restore', () => {
  it('re-expands nodes that were open last time, walking down lazily', async () => {
    h.session.expanded = ['d1', 'd1/app', 'd1/app/public']
    await mount()
    await waitFor(() => expect(row('d1/app/public/users')).toBeTruthy(), { timeout: 3000 })
    expect(row('d1/other')).toBeTruthy()
    expect(R('d1/other').querySelector('.arrow')).toBeTruthy()
  })

  it('skips ids that no longer exist, and prunes them from the persisted state', async () => {
    h.session.expanded = ['gone', 'gone/x', 'd1', 'd1/vanished']
    await mount()
    await waitFor(() => expect(row('d1/app')).toBeTruthy())
    expect(h.patch[0]).toEqual({ expanded: ['d1', 'd1/vanished'] })
  })

  it('does not auto-expand sources whose password is unreadable (and keeps them for a later run)', async () => {
    h.session.expanded = ['d1']
    setup({ listSources: [mkDs('d1', { passwordUnavailable: true })] })
    await mount()
    await sleep(50)
    expect(api.databases).not.toHaveBeenCalled()
    expect(h.patch[0]).toEqual({ expanded: ['d1'] })
  })

  it('opening and closing nodes is persisted (sorted by insertion) after the first load', async () => {
    await mount()
    await open('d1', 'd1/app')
    expect(h.patch.at(-1)).toEqual({ expanded: ['d1'] })
    await open('d1/app', 'd1/app/public')
    expect(h.patch.at(-1)).toEqual({ expanded: ['d1', 'd1/app'] })
    await sleep(500)
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect((h.patch.at(-1) as { expanded: string[] }).expanded).not.toContain('d1'))
  })

  it('open folders from the session are restored; unknown folder ids dropped', async () => {
    h.session.folders = ['f1', 'ghost']
    setup({ listFolders: [{ id: 'f1', name: 'Work', parentId: null }], listSources: [mkDs('d2', { folderId: 'f1' })] })
    await mount()
    await waitFor(() => expect(ids()).toEqual(['folder:f1', 'd2']))
    await waitFor(() => expect(h.patch.some((p) => JSON.stringify(p.folders) === '["f1"]')).toBe(true))
  })
})

describe('Explorer: reload & refresh coordination', () => {
  it('a changed reloadKey re-reads sources and folders', async () => {
    const r = await mount()
    api.listSources.mockClear()
    r.rerender(ui({ reloadKey: 1 }))
    await waitFor(() => expect(api.listSources).toHaveBeenCalled())
    expect(api.listFolders).toHaveBeenCalled()
  })

  it('refreshing a parent reloads its open descendants; unrelated prefixes (public vs publicity) are not matched', async () => {
    setup({ schemasAll: ['public', 'publicity'], tableNames: {}, tables: async () => [T('t')] })
    await mount()
    await open('d1', 'd1/app')
    await open('d1/app', 'd1/app/public')
    await open('d1/app/public', 'd1/app/public/t')
    await open('d1/app/publicity', 'd1/app/publicity/t')
    api.tables.mockClear()
    ctx('d1/app/public'); pick('Refresh')
    await waitFor(() => expect(api.tables).toHaveBeenCalledTimes(1))
    await sleep(30)
    expect(api.tables).toHaveBeenCalledTimes(1)
    expect(api.tables.mock.calls[0][2]).toBe('public')
  })
})
