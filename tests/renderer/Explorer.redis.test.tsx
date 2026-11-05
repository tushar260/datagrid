// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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

const redis = (id: string, over: Partial<DataSource> = {}, cfg: Partial<NonNullable<DataSource['redis']>> = {}): DataSource => ({
  id, name: 'Cache', kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  redis: { host: 'localhost', port: 6379, db: 0, tls: false, ...cfg }, ...over
})
const pg = (id: string): DataSource => ({ id, name: 'Pg', host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false })

let api: MockApi
let cb: Record<'onOpen' | 'onEdit' | 'onConsole' | 'onTableRenamed' | 'onRefreshed' | 'onObjectGone' | 'onSources', ReturnType<typeof vi.fn>>
let clip: ReturnType<typeof vi.fn>
let confirmFn: ReturnType<typeof vi.fn>

const DBS = { databases: [{ db: 0, keys: 1200 }, { db: 3, keys: 1 }, { db: 7, keys: 0 }], count: 16, cluster: false }

function setup(over: Record<string, unknown> = {}, databases: unknown = DBS): void {
  api = installApi({
    listSources: [redis('d1')],
    databases: ['app'],
    schemasAll: ['public'],
    tableNames: { public: [] },
    tables: [],
    renameSource: undefined,
    deleteSource: undefined,
    duplicateSource: undefined,
    disconnect: undefined,
    moveSource: undefined,
    ...over,
    redis: { databases, ...((over.redis as object) ?? {}) }
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
  await waitFor(() => expect(row('d1/db0')).toBeTruthy())
}
const ref = (db: number) => ({ dsId: 'd1', dsName: 'Cache', database: `db${db}`, schema: '', table: `db${db}`, kind: 'redis', engine: 'redis', db })

describe('Redis data source row', () => {
  it('shows the Redis icon with a "Redis" tooltip and host:port in the second tooltip line', async () => {
    await mount()
    expect(R('d1').querySelector('.ticon')!.getAttribute('data-tip')).toBe('Redis')
    expect(R('d1').dataset.tip2).toBe('localhost:6379')
  })

  it.each([
    [{ host: 'cache.local', port: 6380, tls: true, username: 'app' }, 'cache.local:6380 · TLS · app'],
    [{ host: 'h', port: 1 }, 'h:1']
  ])('tooltip for %j', async (cfg, tip) => {
    setup({ listSources: [redis('d1', {}, cfg)] })
    await mount()
    expect(R('d1').dataset.tip2).toBe(tip)
  })

  it('the Redis icon differs from the DynamoDB and warning icons', async () => {
    setup({
      listSources: [
        redis('d1'), redis('d2', { name: 'Bad', passwordUnavailable: true }),
        { id: 'x', name: 'D', kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false, dynamo: { region: 'r', authMode: 'default' } } as DataSource
      ]
    })
    await mount()
    await waitFor(() => expect(row('d2')).toBeTruthy())
    const svg = (id: string): string => R(id).querySelector('.ticon svg')!.outerHTML
    expect(new Set([svg('d1'), svg('d2'), svg('x')]).size).toBe(3)
    expect(R('d1').querySelector('.tlabel')!.textContent).toBe('Cache')
  })

  it('a source whose password cannot be read is listed in the Keychain banner', async () => {
    setup({ listSources: [redis('d1', { passwordUnavailable: true })] })
    await mount()
    expect((document.querySelector('.keychain-banner') as HTMLElement).textContent).toContain('Cache')
  })
})

describe('Redis databases in the tree', () => {
  it('databases sit directly under the source (no schemas / server objects) with key counts', async () => {
    await mount()
    await openSource()
    expect(ids()).toEqual(['d1', 'd1/db0', 'd1/db3', 'd1/db7'])
    expect(api.redis.databases).toHaveBeenCalledWith('d1')
    expect(api.databases).not.toHaveBeenCalled()
    expect(api.schemasAll).not.toHaveBeenCalled()
    await waitFor(() => expect(badge('d1')).toBe('3'))
    expect(badge('d1/db0')).toBe('1,200 keys')
    expect(badge('d1/db3')).toBe('1 key')
    expect(badge('d1/db7')).toBe('0 keys')
    expect(R('d1/db0').querySelector('.ticon')!.getAttribute('data-tip')).toBe('Redis Database')
    expect(R('d1/db0').dataset.tip).toBe('db0 · 1,200 keys')
    expect(R('d1/db3').dataset.tip).toBe('db3 · 1 key')
  })

  it('database rows are labelled with just their index and expand (scanning their keys) instead of opening a tab', async () => {
    await mount()
    await openSource()
    expect(R('d1/db3').querySelector('.tlabel')!.textContent).toBe('3')
    expect(api.redis.keyTree).not.toHaveBeenCalled()
    fireEvent.click(R('d1/db3').querySelector('.arrow')!)
    await waitFor(() => expect(api.redis.keyTree).toHaveBeenCalledWith('d1', 3, { max: 100000 }))
    expect(cb.onOpen).not.toHaveBeenCalled()
  })

  it('the explorer filter box narrows the databases', async () => {
    await mount()
    await openSource()
    fireEvent.change(document.querySelector('.tree-filter') as HTMLInputElement, { target: { value: 'db3' } })
    await waitFor(() => expect(row('d1/db0')).toBeNull())
    expect(row('d1/db3')).toBeTruthy()
  })

  it('a source without any keys still lists its configured database', async () => {
    setup({}, { databases: [{ db: 0, keys: 0 }], count: 16, cluster: false })
    await mount()
    await openSource()
    expect(ids()).toEqual(['d1', 'd1/db0'])
  })

  it('a load error is not fatal', async () => {
    setup({ redis: { databases: vi.fn(async () => { throw new Error('Connection refused') }) } })
    await mount()
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(api.redis.databases).toHaveBeenCalled())
    expect(row('d1')).toBeTruthy()
  })

  it('other kinds next to it are unchanged', async () => {
    setup({ listSources: [redis('d1'), pg('p1')] })
    await mount()
    await waitFor(() => expect(row('p1')).toBeTruthy())
    fireEvent.click(R('p1').querySelector('.arrow')!)
    await waitFor(() => expect(row('p1/app')).toBeTruthy())
    expect(ids()).toContain('p1/__server')
    expect(api.redis.databases).not.toHaveBeenCalled()
  })
})

describe('Redis menus', () => {
  it('source menu has only what applies (no create / drop / filter)', async () => {
    await mount()
    ctx('d1')
    expect(menuLabels()).toEqual([
      'New Query Console', 'Edit Data Source…', 'Rename', 'Duplicate', 'Refresh', 'Disconnect', 'Copy Name',
      ...menuLabels().filter((l) => /^Move to|Move out/.test(l)), 'Delete Data Source…'
    ])
  })

  it('database menu: Open Key Browser, New Query Console, Refresh, Copy Name', async () => {
    await mount()
    await openSource()
    ctx('d1/db3')
    expect(menuLabels()).toEqual(['Open Key Browser', 'New Query Console', 'Refresh', 'Copy Name'])
  })

  it('source: console on the configured database, edit, duplicate, disconnect, copy, delete', async () => {
    setup({ listSources: [redis('d1', {}, { db: 4 })] })
    await mount()
    ctx('d1')
    pick('New Query Console')
    expect(cb.onConsole).toHaveBeenCalledWith({ dsId: 'd1', dsName: 'Cache', database: 'db4', engine: 'redis', db: 4 })
    ctx('d1')
    pick('Edit Data Source…')
    expect(cb.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1', kind: 'redis' }))
    ctx('d1')
    pick('Duplicate')
    await waitFor(() => expect(api.duplicateSource).toHaveBeenCalledWith('d1'))
    ctx('d1')
    pick('Disconnect')
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith('d1'))
    ctx('d1')
    pick('Copy Name')
    expect(clip).toHaveBeenCalledWith('Cache')
    ctx('d1')
    pick('Delete Data Source…')
    expect(confirmFn.mock.calls.at(-1)![0]).toContain('does not touch the Redis server')
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
    fireEvent.change(input, { target: { value: 'Sessions' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.renameSource).toHaveBeenCalledWith('d1', 'Sessions'))
  })

  it('refresh of the source reloads its databases (and the badge counts)', async () => {
    await mount()
    await openSource()
    expect(api.redis.databases).toHaveBeenCalledTimes(1)
    ctx('d1')
    pick('Refresh')
    await waitFor(() => expect(api.redis.databases).toHaveBeenCalledTimes(2))
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
  })

  it('database: key browser, console on that db, refresh, copy name', async () => {
    await mount()
    await openSource()
    ctx('d1/db3')
    pick('Open Key Browser')
    expect(cb.onOpen).toHaveBeenCalledWith(ref(3))
    ctx('d1/db3')
    pick('New Query Console')
    expect(cb.onConsole).toHaveBeenCalledWith({ dsId: 'd1', dsName: 'Cache', database: 'db3', engine: 'redis', db: 3 })
    ctx('d1/db3')
    pick('Refresh')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/db3')
    ctx('d1/db3')
    pick('Copy Name')
    expect(clip).toHaveBeenCalledWith('db3')
  })

  it('double-click on a database only expands / collapses it (like DataGrip), it opens no tab', async () => {
    setup({ redis: { keyTree: vi.fn(async () => ({ keys: [{ key: 'a', type: 'string' }], complete: true, dbsize: 1 })) } })
    await mount()
    await openSource()
    fireEvent.doubleClick(R('d1/db7'))
    await waitFor(() => expect(row('d1/db7/strings')).toBeTruthy())
    expect(cb.onOpen).not.toHaveBeenCalled()
    fireEvent.doubleClick(R('d1/db7'))
    await waitFor(() => expect(row('d1/db7/strings')).toBeNull())
    expect(cb.onOpen).not.toHaveBeenCalled()
  })
})

describe('Redis keyboard shortcuts and multi-selection', () => {
  it('F4, ⇧⌘L, ⌥⌘C and ⌘R act on the selected database', async () => {
    await mount()
    await openSource()
    click('d1/db3')
    key('F4')
    expect(cb.onOpen).toHaveBeenCalledWith(ref(3))
    combo('KeyL', { metaKey: true, shiftKey: true })
    expect(cb.onConsole).toHaveBeenCalledWith({ dsId: 'd1', dsName: 'Cache', database: 'db3', engine: 'redis', db: 3 })
    combo('KeyC', { ctrlKey: true, altKey: true })
    expect(clip).toHaveBeenCalledWith('db3')
    combo('KeyR', { metaKey: true })
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/db3')
  })

  it('arrow keys walk the databases and Right / Left expand / collapse the source', async () => {
    await mount()
    click('d1')
    key('ArrowRight')
    await waitFor(() => expect(row('d1/db0')).toBeTruthy())
    key('ArrowDown')
    expect(R('d1/db0').classList.contains('sel')).toBe(true)
    key('ArrowDown')
    expect(R('d1/db3').classList.contains('sel')).toBe(true)
    key('ArrowUp')
    expect(R('d1/db0').classList.contains('sel')).toBe(true)
    key('ArrowLeft')
    expect(R('d1').classList.contains('sel')).toBe(true)
    key('ArrowLeft')
    await waitFor(() => expect(row('d1/db0')).toBeNull())
  })

  it('F4 on the source edits it', async () => {
    await mount()
    click('d1')
    key('F4')
    expect(cb.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }))
  })

  it('⌘⌫ on a database does nothing (no drop for Redis)', async () => {
    await mount()
    await openSource()
    click('d1/db3')
    combo('Backspace', { metaKey: true })
    expect(confirmFn).not.toHaveBeenCalled()
    expect(api.dropTable).not.toHaveBeenCalled()
    expect(api.dropDatabase).not.toHaveBeenCalled()
  })

  it('several databases: bulk Refresh and Copy Names, but no drop', async () => {
    await mount()
    await openSource()
    click('d1/db0')
    click('d1/db3', { metaKey: true })
    ctx('d1/db3')
    expect(menuLabels()).toEqual(['Refresh', 'Copy Names'])
    pick('Refresh')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/db0')
    expect(cb.onRefreshed).toHaveBeenCalledWith('d1/db3')
    ctx('d1/db3')
    pick('Copy Names')
    expect(clip).toHaveBeenCalledWith('db0\ndb3')
  })

  it('several sources of mixed kinds: Refresh refreshes Redis ones by id', async () => {
    setup({ listSources: [redis('d1'), redis('d2', { name: 'Other' })] })
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

describe('Redis drag & drop and folders', () => {
  const dt = (data: string) => ({ dataTransfer: { getData: () => data, setData: vi.fn() } })

  it('a Redis source can be dragged into a folder and lives inside it', async () => {
    setup({ listFolders: [{ id: 'f1', name: 'Caches', parentId: null }], listSources: [redis('d1')] })
    await mount()
    await waitFor(() => expect(row('folder:f1')).toBeTruthy())
    const d = dt('')
    fireEvent.dragStart(R('d1'), d)
    expect(d.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'ds:d1')
    fireEvent.drop(R('folder:f1'), dt('ds:d1'))
    await waitFor(() => expect(api.moveSource).toHaveBeenCalledWith('d1', 'f1'))
  })

  it('a Redis source inside a folder is rendered with its databases', async () => {
    setup({ listFolders: [{ id: 'f1', name: 'Caches', parentId: null }], listSources: [redis('d1', { folderId: 'f1' })] })
    render(ui())
    await waitFor(() => expect(row('folder:f1')).toBeTruthy())
    expect(row('d1')).toBeNull()
    fireEvent.click(R('folder:f1').querySelector('.arrow')!)
    await waitFor(() => expect(row('d1')).toBeTruthy())
    expect(R('d1').dataset.depth).toBe('1')
    fireEvent.click(R('d1').querySelector('.arrow')!)
    await waitFor(() => expect(row('d1/db3')).toBeTruthy())
  })
})
