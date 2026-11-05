// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DataSource } from '../../src/shared'
import type { TableRef } from '../../src/renderer/src/Explorer'
import { installApi } from './helpers/mockApi'

const h = vi.hoisted(() => ({
  explorer: null as null | Record<string, (...a: any[]) => void> & { reloadKey: number; activeTarget: string | null },
  session: { width: 300, sidebarHidden: false, consoleN: 0, tabs: [] as unknown[], consoleSql: {} as Record<string, string>, active: null as string | null },
  saveTabs: [] as unknown[][]
}))

vi.mock('../../src/renderer/src/Explorer', async () => ({
  default: (props: any) => {
    h.explorer = props
    return <div data-testid="explorer" data-target={props.activeTarget ?? ''} />
  }
}))
vi.mock('../../src/renderer/src/TableView', async () => ({
  default: ({ t }: any) => <div data-testid={'pg-' + t.table} />
}))
vi.mock('../../src/renderer/src/DynamoTableView', async () => ({
  default: ({ t, active, reloadToken }: any) => (
    <div data-testid={'ddb-' + t.table} data-active={String(active)} data-token={reloadToken} data-region={t.region} />
  )
}))
vi.mock('../../src/renderer/src/Console', async () => ({
  default: ({ c }: any) => <div data-testid={'console-' + c.id} data-engine={c.engine ?? ''} data-region={c.region ?? ''} data-sql={c.sql ?? ''} />
}))
vi.mock('../../src/renderer/src/session', () => ({
  get initialSession() { return h.session },
  patchSession: () => undefined,
  saveTabs: (tabs: unknown[], active: string | null) => void h.saveTabs.push([tabs, active])
}))

import App from '../../src/renderer/src/App'

Element.prototype.scrollIntoView = vi.fn()

const ddbRef = (table: string, over: Partial<TableRef> = {}): TableRef => ({
  dsId: 'dd', dsName: 'Ddb', database: '', schema: '', table, kind: 'table', engine: 'dynamodb', region: 'eu-west-1', ...over
})
const pgRef = (table: string): TableRef => ({ dsId: 'pg', dsName: 'Pg', database: 'app', schema: 'public', table, kind: 'table' })
const srcs = (): DataSource[] => [
  { id: 'dd', name: 'Ddb', kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false, dynamo: { region: 'eu-west-1', authMode: 'default' } },
  { id: 'pg', name: 'Pg', host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false }
]
const tabs = (): HTMLElement[] => Array.from(document.querySelectorAll('.tab'))
const flush = (): void => void act(() => void vi.advanceTimersByTime(400))

beforeEach(() => {
  vi.useFakeTimers()
  h.explorer = null
  h.saveTabs.length = 0
  h.session = { width: 300, sidebarHidden: false, consoleN: 0, tabs: [], consoleSql: {}, active: null }
  installApi()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function mount(): Promise<void> {
  render(<App />)
  act(() => h.explorer!.onSources(srcs()))
  flush()
}

describe('App: DynamoDB tabs', () => {
  it('a DynamoDB table opens in DynamoTableView with the DynamoDB icon and a "source / region" tooltip', async () => {
    await mount()
    act(() => h.explorer!.onOpen(ddbRef('orders')))
    expect(screen.getByTestId('ddb-orders').dataset.active).toBe('true')
    expect(screen.queryByTestId('pg-orders')).toBeNull()
    const tab = tabs()[0]
    expect(tab.dataset.tip).toBe('Ddb / eu-west-1')
    expect(tab.querySelector('.tabtitle')!.textContent).toBe('orders')
    act(() => h.explorer!.onOpen(pgRef('orders')))
    expect(tabs()).toHaveLength(2)
    expect(screen.getByTestId('pg-orders')).toBeTruthy()
    expect(tabs()[1].dataset.tip).toBe('Pg / app.public')
    expect(tabs()[0].querySelector('.ticon svg')!.outerHTML).not.toBe(tabs()[1].querySelector('.ticon svg')!.outerHTML)
    expect(screen.getByTestId('explorer').dataset.target).toBe('pg/app/public/orders')
  })

  it('the Explorer is told the DynamoDB tree id of the active tab', async () => {
    await mount()
    act(() => h.explorer!.onOpen(ddbRef('orders')))
    expect(screen.getByTestId('explorer').dataset.target).toBe('dd/orders')
  })

  it('the same table name in another region is another tab; re-opening the same one reloads it', async () => {
    await mount()
    act(() => h.explorer!.onOpen(ddbRef('orders')))
    act(() => h.explorer!.onOpen(ddbRef('orders', { region: 'us-east-1' })))
    expect(tabs()).toHaveLength(2)
    expect(screen.getAllByTestId('ddb-orders').map((e) => e.dataset.region)).toEqual(['eu-west-1', 'us-east-1'])
    act(() => h.explorer!.onOpen(ddbRef('orders')))
    expect(tabs()).toHaveLength(2)
    expect(screen.getAllByTestId('ddb-orders')[0].dataset.token).toBe('1')
  })

  it('refreshing a table in the tree reloads its open tab', async () => {
    await mount()
    act(() => h.explorer!.onOpen(ddbRef('orders')))
    act(() => h.explorer!.onRefreshed('dd/orders'))
    expect(screen.getByTestId('ddb-orders').dataset.token).toBe('1')
    act(() => h.explorer!.onRefreshed('dd')) // the whole source
    expect(screen.getByTestId('ddb-orders').dataset.token).toBe('2')
    act(() => h.explorer!.onRefreshed('pg'))
    expect(screen.getByTestId('ddb-orders').dataset.token).toBe('2')
  })

  it('a PartiQL console opens with its prefill and the engine / region', async () => {
    await mount()
    act(() => h.explorer!.onConsole({ dsId: 'dd', dsName: 'Ddb', database: '', engine: 'dynamodb', region: 'eu-west-1', sql: 'SELECT * FROM "orders"' }))
    const c = document.querySelector('[data-testid^="console-"]') as HTMLElement
    expect(c.dataset).toMatchObject({ engine: 'dynamodb', region: 'eu-west-1', sql: 'SELECT * FROM "orders"' })
    expect(tabs()[0].querySelector('.tabtitle')!.textContent).toBe('Ddb console')
    expect(tabs()[0].dataset.tip).toBe('Ddb / eu-west-1')
    expect(screen.getByTestId('explorer').dataset.target).toBe('dd')
    act(() => h.explorer!.onConsole({ dsId: 'dd', dsName: 'Ddb', database: '', engine: 'dynamodb', region: '' }))
    expect(tabs()[1].querySelector('.tabtitle')!.textContent).toBe('Ddb console 2')
    expect(tabs()[1].dataset.tip).toBe('Ddb / default region')
  })

  it('removing the data source closes its DynamoDB tabs only', async () => {
    await mount()
    act(() => h.explorer!.onOpen(ddbRef('orders')))
    act(() => h.explorer!.onOpen(pgRef('t')))
    act(() => h.explorer!.onObjectGone({ dsId: 'dd' }))
    flush()
    expect(tabs().map((t) => t.querySelector('.tabtitle')!.textContent)).toEqual(['t'])
  })

  it('the session saves the engine and region, and restoring brings the tabs back (unknown sources dropped)', async () => {
    h.session.tabs = [
      { type: 'table', t: ddbRef('orders', { dsName: 'old name' }) },
      { type: 'table', t: ddbRef('gone', { dsId: 'deleted' }) },
      { type: 'console', c: { id: 'c1', title: 'Ddb console', dsId: 'dd', dsName: 'x', database: '', engine: 'dynamodb', region: 'eu-west-1' } }
    ]
    h.session.consoleSql = { c1: 'SELECT * FROM "orders"' }
    h.session.active = 't|ddb|dd|eu-west-1|orders'
    await mount()
    expect(tabs().map((t) => t.querySelector('.tabtitle')!.textContent)).toEqual(['orders', 'Ddb console'])
    expect(screen.getByTestId('ddb-orders').dataset.active).toBe('true')
    expect(tabs()[0].dataset.tip).toBe('Ddb / eu-west-1') // the data source's current name
    expect((document.querySelector('[data-testid="console-c1"]') as HTMLElement).dataset.sql).toBe('SELECT * FROM "orders"')
    const [saved] = h.saveTabs.at(-1) as [{ type: string; t?: TableRef; c?: any }[]]
    expect(saved[0].t).toMatchObject({ engine: 'dynamodb', region: 'eu-west-1', table: 'orders' })
    expect(saved[1].c).toMatchObject({ engine: 'dynamodb', region: 'eu-west-1' })
  })

  it('closing a DynamoDB tab removes it', async () => {
    await mount()
    act(() => h.explorer!.onOpen(ddbRef('orders')))
    fireEvent.click(tabs()[0].querySelector('.x')!)
    flush()
    expect(tabs()).toHaveLength(0)
    expect(screen.queryByTestId('ddb-orders')).toBeNull()
  })
})
