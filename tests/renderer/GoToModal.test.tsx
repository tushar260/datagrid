// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import GoToModal, { GOTO_MAX_ROWS } from '../../src/renderer/src/GoToModal'
import { RECENT_KEY, recordRecent } from '../../src/renderer/src/lib/gotoIndex'
import { cached, primeIndex } from '../../src/renderer/src/lib/objectCache'
import { cacheKeys, type DataSource } from '../../src/shared'
import { cacheFake, installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

const T = (name: string, kind = 'table'): { name: string; kind: string } => ({ name, kind })
const pg = (id = 'pg', o: Partial<DataSource> = {}): DataSource => ({ id, name: 'Prod', host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false, ...o })
const ddb = (id = 'dy', o: Partial<DataSource> = {}): DataSource => ({ ...pg(id, { name: 'Dyn', kind: 'dynamodb', host: '', port: 0, user: '', database: '' }), dynamo: { region: 'eu-west-1', authMode: 'default' }, ...o })
const rd = (id = 'rd', o: Partial<DataSource> = {}): DataSource => ({ ...pg(id, { name: 'Cache', kind: 'redis', host: '', port: 0, user: '', database: '' }), redis: { host: 'localhost', port: 6379, db: 0, tls: false }, ...o })

const at = Date.now()
const stored = (): Record<string, Record<string, { at: number; data: unknown }>> => ({
  pg: {
    [cacheKeys.pgDbs]: { at, data: ['app', 'analytics'] },
    [cacheKeys.pgSchemas('app')]: { at, data: ['public', 'information_schema', 'billing'] },
    [cacheKeys.pgSchemas('analytics')]: { at, data: ['public'] },
    [cacheKeys.pgTables('app', 'public')]: { at, data: [T('users'), T('user_roles'), T('orders'), T('order_view', 'view')] },
    [cacheKeys.pgTables('app', 'information_schema')]: { at, data: [T('columns')] },
    [cacheKeys.pgTables('app', 'billing')]: { at, data: [T('invoices'), T('keys_table')] },
    [cacheKeys.pgTables('analytics', 'public')]: { at, data: [T('events'), T('users')] }
  },
  dy: { [cacheKeys.ddbTables]: { at, data: ['Orders', 'Sessions'] } },
  rd: { [cacheKeys.redisDbs]: { at, data: { databases: [{ db: 0, keys: 5, expires: 0 }, { db: 3, keys: 2, expires: 0 }], count: 16, cluster: false } } }
})

let api: MockApi
const onClose = vi.fn()
const onOpenTable = vi.fn()
const onRevealDb = vi.fn()

async function open(sources: DataSource[] = [pg(), ddb(), rd()], store = stored()): Promise<void> {
  api = installApi({ cache: cacheFake(store) })
  await primeIndex()
  render(<GoToModal sources={sources} onClose={onClose} onOpenTable={onOpenTable} onRevealDb={onRevealDb} />)
}
const input = (): HTMLInputElement => screen.getByPlaceholderText('Search databases and tables') as HTMLInputElement
const type = (q: string): void => void fireEvent.change(input(), { target: { value: q } })
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.goto-row'))
const names = (): string[] => rows().map((r) => r.querySelector('.goto-name')!.textContent!)
const sfx = (): string[] => rows().map((r) => r.querySelector('.goto-sfx')!.textContent!)
const selected = (): string => document.querySelector('.goto-row.on .goto-name')!.textContent!
const press = (key: string, init: Record<string, unknown> = {}): void => void fireEvent.keyDown(input(), { key, ...init })

beforeEach(() => {
  localStorage.clear()
  onClose.mockReset()
  onOpenTable.mockReset()
  onRevealDb.mockReset()
})
afterEach(cleanup)

describe('GoToModal: look', () => {
  it('a top-aligned popup with the Database header, a focused search field and the placeholder', async () => {
    await open()
    const dlg = screen.getByRole('dialog', { name: 'Go to database or table' })
    expect(dlg.classList.contains('modal')).toBe(true)
    expect(dlg.classList.contains('goto')).toBe(true)
    expect(dlg.parentElement!.classList.contains('modal-bg')).toBe(true)
    expect(within(dlg).getByText('Database').classList.contains('on')).toBe(true)
    expect(input().placeholder).toBe('Search databases and tables')
    expect(document.activeElement).toBe(input())
    expect(dlg.querySelector('.goto-search svg')).toBeTruthy() // magnifier
  })

  it('shows the key hints and how many names are indexed', async () => {
    await open()
    expect(document.querySelector('.goto-keys')!.textContent).toBe('↑↓ navigate · ⏎ open · esc close')
    expect(document.querySelector('.goto-count')!.textContent).toMatch(/^\d+ indexed$/)
  })

  it('an empty query with no history says what to do', async () => {
    await open()
    expect(screen.getByText('Type to search databases and tables')).toBeTruthy()
    expect(rows()).toHaveLength(0)
  })

  it('with nothing indexed at all it says so', async () => {
    await open([pg()], {})
    expect(screen.getByText(/Nothing is indexed yet/)).toBeTruthy()
  })
})

describe('GoToModal: what is searched', () => {
  it('finds tables, views, databases of every data source kind', async () => {
    await open()
    type('order')
    expect(names()).toContain('orders') // PostgreSQL
    expect(names()).toContain('Orders') // DynamoDB
    expect(names()).toContain('order_view')
    type('analytics')
    expect(names()).toEqual(['analytics'])
    type('db3')
    expect(names()).toEqual(['db3'])
  })

  it('Redis databases are matchable by name (db0, db3...)', async () => {
    await open()
    type('db')
    expect(names().sort()).toEqual(['db0', 'db3'])
  })

  it('matches names only: not the data source name, the schema, or key names', async () => {
    await open()
    type('prod') // the data source is called "Prod"
    expect(names()).toEqual([])
    type('billing') // a schema
    expect(names()).toEqual([])
    type('public')
    expect(names()).toEqual([])
    type('information') // system schema
    expect(names()).toEqual([])
    type('eu-west') // the DynamoDB region
    expect(names()).toEqual([])
  })

  it('system schemas stay hidden; tables of a schema are findable', async () => {
    await open()
    type('columns')
    expect(names()).toEqual([])
    type('invoices')
    expect(names()).toEqual(['invoices'])
  })

  it('respects the explorer filters (visible databases, schemas, tables)', async () => {
    await open([pg('pg', { visibleDbs: ['app'], schemaFilter: { app: ['public'] }, tableFilter: { 'app/public': { list: ['users'] } } })])
    type('e') // would match plenty (events, user_roles, invoices, ... are all hidden)
    expect(names()).toEqual(['users'])
    type('p')
    expect(names()).toEqual(['app'])
    type('s')
    expect(names()).toEqual(['users'])
  })

  it('a removed data source disappears from the results', async () => {
    await open([pg()])
    type('sessions')
    expect(names()).toEqual([])
  })

  it('PostgreSQL results are labelled "kind database.schema [data source]", others "kind [data source]"', async () => {
    await open()
    type('users')
    expect(sfx()).toContain('table app.public [Prod]')
    expect(sfx()).toContain('table analytics.public [Prod]')
    type('order_view')
    expect(sfx()).toEqual(['view app.public [Prod]'])
    type('sessions')
    expect(sfx()).toEqual(['table [Dyn]'])
    type('analytics')
    expect(sfx()).toEqual(['database [Prod]'])
    type('db3')
    expect(sfx()).toEqual(['database [Cache]'])
  })

  it('tags rows with their kind (for the icon) ', async () => {
    await open()
    type('o')
    const kinds = new Set(rows().map((r) => r.dataset.kind))
    expect(kinds.has('table')).toBe(true)
    expect(kinds.has('view')).toBe(true)
  })
})

describe('GoToModal: ranking and highlighting', () => {
  it('exact beats prefix beats fuzzy; shorter first among equals', async () => {
    await open()
    type('users')
    expect(names().slice(0, 2)).toEqual(['users', 'users']) // both databases' users
    type('user')
    expect(names().slice(0, 2)).toEqual(['users', 'users'])
    expect(names().indexOf('user_roles')).toBeGreaterThan(1)
  })

  it('fuzzy: "usrl" finds user_roles, "ordv" finds order_view', async () => {
    await open()
    type('usrl')
    expect(names()).toEqual(['user_roles'])
    type('ordv')
    expect(names()).toEqual(['order_view'])
  })

  it('bold-highlights the matched characters', async () => {
    await open()
    type('usrl')
    const bold = Array.from(rows()[0].querySelectorAll('.goto-name b')).map((b) => b.textContent)
    expect(bold.join('')).toBe('usrl'.slice(0, 0) + 'usrl') // u s r l
    expect(rows()[0].querySelector('.goto-name')!.textContent).toBe('user_roles')
  })

  it('a prefix match is highlighted as one run', async () => {
    await open()
    type('inv')
    expect(Array.from(rows()[0].querySelectorAll('.goto-name b')).map((b) => b.textContent)).toEqual(['inv'])
  })

  it('is case-insensitive and ignores spaces', async () => {
    await open()
    type('  INVOICES ')
    expect(names()).toEqual(['invoices'])
  })

  it('caps the list at ' + GOTO_MAX_ROWS + ' rows and says "+"', async () => {
    const many = Array.from({ length: 450 }, (_, i) => T('tbl_' + i))
    await open([pg()], { pg: { [cacheKeys.pgDbs]: { at, data: ['a'] }, [cacheKeys.pgSchemas('a')]: { at, data: ['public'] }, [cacheKeys.pgTables('a', 'public')]: { at, data: many } } })
    type('tbl')
    expect(rows()).toHaveLength(GOTO_MAX_ROWS)
    expect(document.querySelector('.goto-count')!.textContent).toBe('200+ results')
    type('tbl_449')
    expect(document.querySelector('.goto-count')!.textContent).toBe('1 result')
  })

  it('says when nothing matches', async () => {
    await open()
    type('zzzzqq')
    expect(screen.getByText('No databases or tables match')).toBeTruthy()
    expect(document.querySelector('.goto-count')!.textContent).toBe('0 results')
  })

  it('the first result is selected after every keystroke', async () => {
    await open()
    type('o')
    press('ArrowDown')
    press('ArrowDown')
    type('or')
    expect(rows()[0].classList.contains('on')).toBe(true)
  })
})

describe('GoToModal: keyboard and mouse', () => {
  beforeEach(async () => {
    await open()
    type('o') // many rows
  })
  it('↓ / ↑ move the selection and wrap around', () => {
    const n = rows().length
    expect(n).toBeGreaterThan(3)
    const first = selected()
    press('ArrowDown')
    expect(selected()).toBe(names()[1])
    press('ArrowUp')
    expect(selected()).toBe(first)
    press('ArrowUp') // wraps to the last
    expect(rows()[n - 1].classList.contains('on')).toBe(true)
    press('ArrowDown') // and back to the first
    expect(rows()[0].classList.contains('on')).toBe(true)
  })
  it('Home / End / PageDown / PageUp', () => {
    const n = rows().length
    press('End')
    expect(rows()[n - 1].classList.contains('on')).toBe(true)
    press('Home')
    expect(rows()[0].classList.contains('on')).toBe(true)
    press('PageDown')
    expect(rows()[Math.min(8, n - 1)].classList.contains('on')).toBe(true)
    press('PageUp')
    expect(rows()[0].classList.contains('on')).toBe(true)
  })
  it('exactly one row is selected and the combobox points at it', () => {
    press('ArrowDown')
    expect(document.querySelectorAll('.goto-row.on')).toHaveLength(1)
    expect(input().getAttribute('aria-activedescendant')).toBe('goto-row-1')
    expect(rows()[1].getAttribute('aria-selected')).toBe('true')
  })
  it('hovering selects (the pointer and the keys share one highlight)', () => {
    fireEvent.mouseMove(rows()[2])
    expect(rows()[2].classList.contains('on')).toBe(true)
    expect(rows()[0].classList.contains('on')).toBe(false)
  })
  it('modifier keys are not navigation', () => {
    press('ArrowDown', { metaKey: true })
    expect(rows()[0].classList.contains('on')).toBe(true)
  })
  it('arrow keys on an empty list do nothing and do not throw', () => {
    type('zzzzqq')
    expect(() => press('ArrowDown')).not.toThrow()
    expect(() => press('Enter')).not.toThrow()
    expect(onOpenTable).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
  it('keeps the selected row in view', () => {
    ;(Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear()
    press('ArrowDown')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})

describe('GoToModal: opening things', () => {
  it('Enter on a PostgreSQL table opens it like the explorer does, and closes', async () => {
    await open()
    type('invoices')
    press('Enter')
    expect(onOpenTable).toHaveBeenCalledWith({ dsId: 'pg', dsName: 'Prod', database: 'app', schema: 'billing', table: 'invoices', kind: 'table' })
    expect(onRevealDb).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking a view opens it as a view', async () => {
    await open()
    type('order_view')
    fireEvent.click(rows()[0])
    expect(onOpenTable).toHaveBeenCalledWith(expect.objectContaining({ table: 'order_view', kind: 'view', schema: 'public' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('a DynamoDB table opens as a DynamoDB tab', async () => {
    await open()
    type('sessions')
    press('Enter')
    expect(onOpenTable).toHaveBeenCalledWith({ dsId: 'dy', dsName: 'Dyn', database: '', schema: '', table: 'Sessions', kind: 'table', engine: 'dynamodb', region: 'eu-west-1' })
  })

  it('a PostgreSQL database is selected + expanded in the explorer, not opened as a tab', async () => {
    await open()
    type('analytics')
    press('Enter')
    expect(onRevealDb).toHaveBeenCalledWith('pg/analytics')
    expect(onOpenTable).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('a Redis database is revealed at its node', async () => {
    await open()
    type('db3')
    press('Enter')
    expect(onRevealDb).toHaveBeenCalledWith('rd/db3')
  })

  it('Enter opens the highlighted row, not the first', async () => {
    await open()
    type('users')
    press('ArrowDown')
    press('Enter')
    expect(onOpenTable).toHaveBeenCalledTimes(1)
    expect(onOpenTable.mock.calls[0][0]).toMatchObject({ table: 'users' })
  })

  it('the same table name in two databases stays distinguishable', async () => {
    await open()
    type('users')
    const dbs = sfx().filter((s) => s.startsWith('table '))
    expect(dbs).toEqual(expect.arrayContaining(['table app.public [Prod]', 'table analytics.public [Prod]']))
    fireEvent.click(rows().find((r) => r.querySelector('.goto-sfx')!.textContent!.includes('analytics.public'))!)
    expect(onOpenTable.mock.calls[0][0]).toMatchObject({ database: 'analytics', table: 'users' })
  })
})

describe('GoToModal: closing', () => {
  it('Escape closes (and nothing is opened)', async () => {
    await open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpenTable).not.toHaveBeenCalled()
  })
  it('Escape in the input closes too', async () => {
    await open()
    press('Escape')
    expect(onClose).toHaveBeenCalled()
  })
  it('clicking the backdrop closes; clicking inside does not', async () => {
    await open()
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.querySelector('.modal-bg')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('plays the exit animation: onClose waits for animationend when the backdrop animates', async () => {
    const real = window.getComputedStyle.bind(window)
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, p?: string | null) => new Proxy(real(el, p), { get: (t, k) => (k === 'animationName' ? 'modal-out' : Reflect.get(t, k)) }))
    await open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.modal-bg')!.classList.contains('closing')).toBe(true)
    fireEvent.animationEnd(document.querySelector('.modal-bg')!)
    expect(onClose).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('GoToModal: recently opened (empty query)', () => {
  const R = (name: string, o: Record<string, unknown> = {}): void =>
    recordRecent({ dsId: 'pg', engine: 'postgres', kind: 'table', name, database: 'app', schema: 'public', ...o } as never)

  it('lists the most recent first', async () => {
    R('orders')
    R('users')
    R('Sessions', { dsId: 'dy', engine: 'dynamodb', database: undefined, schema: undefined, region: 'eu-west-1' })
    await open()
    expect(names()).toEqual(['Sessions', 'users', 'orders'])
    expect(screen.getByText('Recently opened')).toBeTruthy()
    expect(sfx()[0]).toBe('table [Dyn]')
  })
  it('works even when the name is not in the index any more (it is a shortcut to open the tab)', async () => {
    R('gone_table')
    await open()
    expect(names()).toEqual(['gone_table'])
    press('Enter')
    expect(onOpenTable).toHaveBeenCalledWith(expect.objectContaining({ table: 'gone_table', database: 'app', schema: 'public' }))
  })
  it('opening something moves it to the top of the list', async () => {
    R('a')
    R('b')
    await open()
    type('invoices')
    press('Enter')
    const l = JSON.parse(localStorage.getItem(RECENT_KEY)!)
    expect(l.map((x: { name: string }) => x.name)).toEqual(['invoices', 'b', 'a'])
  })
  it('opening a database is remembered too', async () => {
    await open()
    type('analytics')
    press('Enter')
    cleanup()
    await open()
    expect(names()).toEqual(['analytics'])
    expect(sfx()).toEqual(['database [Prod]'])
  })
  it('entries of removed data sources are skipped', async () => {
    R('x', { dsId: 'removed' })
    R('y')
    await open()
    expect(names()).toEqual(['y'])
  })
  it('clearing the query goes back to the recent list', async () => {
    R('orders')
    await open()
    type('inv')
    expect(names()).toEqual(['invoices'])
    type('')
    expect(names()).toEqual(['orders'])
  })
})

describe('GoToModal: indexing the other data sources', () => {
  const partial = (): ReturnType<typeof stored> => ({ pg: stored().pg }) // DynamoDB and Redis never loaded

  it('offers "Index N more data sources" for the sources that have no lists yet', async () => {
    await open([pg(), ddb(), rd()], partial())
    expect(screen.getByRole('button', { name: 'Index 2 more data sources' })).toBeTruthy()
  })
  it('singular for one', async () => {
    await open([pg(), ddb()], partial())
    expect(screen.getByRole('button', { name: 'Index 1 more data source' })).toBeTruthy()
  })
  it('no button when everything is known', async () => {
    await open()
    expect(screen.queryByRole('button', { name: /Index \d+ more/ })).toBeNull()
  })
  it('loads the lists, shows progress, and the new names become searchable', async () => {
    await open([pg(), ddb(), rd()], partial())
    let release!: () => void
    api.dynamo.tables.mockImplementation(() => new Promise((r) => (release = () => r(['Invoices2024']))))
    api.redis.databases.mockResolvedValue({ databases: [{ db: 7, keys: 1, expires: 0 }], count: 16, cluster: false })
    fireEvent.click(screen.getByRole('button', { name: 'Index 2 more data sources' }))
    await waitFor(() => expect(screen.getByText(/Indexing \d\/2…/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Index/ })).toBeNull()
    act(() => release())
    await waitFor(() => expect(screen.queryByText(/Indexing/)).toBeNull())
    type('invoices2024')
    expect(names()).toEqual(['Invoices2024'])
    type('db7')
    expect(names()).toEqual(['db7'])
    expect(screen.queryByRole('button', { name: /Index/ })).toBeNull()
  })
  it('a source that fails is noted dimly and does not block the others', async () => {
    await open([pg(), ddb(), rd()], partial())
    api.dynamo.tables.mockRejectedValue(new Error("Error invoking remote method 'dynamo:tables': Error: expired token"))
    api.redis.databases.mockResolvedValue({ databases: [{ db: 1, keys: 1, expires: 0 }], count: 16, cluster: false })
    fireEvent.click(screen.getByRole('button', { name: 'Index 2 more data sources' }))
    await waitFor(() => expect(document.querySelector('.goto-note')).toBeTruthy())
    expect(document.querySelector('.goto-note')!.textContent).toBe('Dyn: expired token')
    await waitFor(() => expect(screen.queryByText(/Indexing/)).toBeNull())
    type('db1')
    expect(names()).toEqual(['db1'])
    // the failed one can be retried
    expect(screen.getByRole('button', { name: 'Index 1 more data source' })).toBeTruthy()
  })
  it('never lists keys while indexing Redis', async () => {
    await open([pg(), rd()], partial())
    api.redis.databases.mockResolvedValue({ databases: [{ db: 0, keys: 100, expires: 0 }], count: 16, cluster: false })
    fireEvent.click(screen.getByRole('button', { name: /Index/ }))
    await waitFor(() => expect(screen.queryByText(/Indexing/)).toBeNull())
    expect(api.redis.keyTree).not.toHaveBeenCalled()
    expect(api.redis.scan).not.toHaveBeenCalled()
  })
  it('closing cancels: sources not started yet are never contacted', async () => {
    const srcs = [pg(), ...Array.from({ length: 8 }, (_, i) => ddb('d' + i))]
    await open(srcs, partial())
    const started: string[] = []
    let release: (() => void)[] = []
    api.dynamo.tables.mockImplementation((id: string) => {
      started.push(id)
      return new Promise((r) => release.push(() => r(['t'])))
    })
    fireEvent.click(screen.getByRole('button', { name: /Index 8 more/ }))
    await waitFor(() => expect(started).toHaveLength(3)) // concurrency 3
    cleanup() // the modal is gone (unmount aborts)
    release.forEach((r) => r())
    await new Promise((r) => setTimeout(r, 30))
    expect(started).toHaveLength(3)
  })
  it('names that appear while the modal is open (the explorer loads a source) show up without reopening', async () => {
    await open([pg(), ddb()], partial())
    type('fresh')
    expect(names()).toEqual([])
    await act(async () => {
      await cached('dy', cacheKeys.ddbTables, async () => ['FreshTable'])
      await new Promise((r) => setTimeout(r, 90)) // the modal coalesces bursts into one rebuild
    })
    expect(names()).toEqual(['FreshTable'])
    expect(screen.queryByRole('button', { name: /Index/ })).toBeNull()
  })
})
