// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DataSource } from '../../src/shared'
import { cacheKeys } from '../../src/shared'
import { primeIndex } from '../../src/renderer/src/lib/objectCache'
import { RECENT_KEY } from '../../src/renderer/src/lib/gotoIndex'
import { cacheFake, installApi, type MockApi } from './helpers/mockApi'

const h = vi.hoisted(() => ({
  explorer: null as null | Record<string, any>,
  session: { width: 300, sidebarHidden: false, consoleN: 0, tabs: [] as unknown[], consoleSql: {} as Record<string, string>, active: null as string | null },
  patch: [] as Record<string, unknown>[]
}))

vi.mock('../../src/renderer/src/Explorer', async () => ({
  default: (props: any) => {
    h.explorer = props
    const r = props.revealRequest
    return <div data-testid="explorer" data-reveal={r ? `${r.target}|${r.expand}|${r.n}` : ''} />
  }
}))
vi.mock('../../src/renderer/src/TableView', async () => ({ default: ({ t }: any) => <div data-testid={'pg-' + t.table} /> }))
vi.mock('../../src/renderer/src/DynamoTableView', async () => ({ default: ({ t }: any) => <div data-testid={'ddb-' + t.table} /> }))
vi.mock('../../src/renderer/src/RedisKeyView', async () => ({ default: ({ t }: any) => <div data-testid={'redis-' + t.table} /> }))
vi.mock('../../src/renderer/src/RedisKeyTab', async () => ({ default: ({ t }: any) => <div data-testid={'rkey-' + t.redisKey} /> }))
vi.mock('../../src/renderer/src/Console', async () => ({ default: ({ c }: any) => <div data-testid={'console-' + c.id} /> }))
vi.mock('../../src/renderer/src/session', () => ({
  get initialSession() { return h.session },
  patchSession: (p: Record<string, unknown>) => void h.patch.push(p),
  saveTabs: () => undefined
}))

import App from '../../src/renderer/src/App'

Element.prototype.scrollIntoView = vi.fn()

const srcs = (): DataSource[] => [{ id: 'pg', name: 'Pg', host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false }]
const at = Date.now()
const store = (): Parameters<typeof cacheFake>[0] => ({
  pg: {
    [cacheKeys.pgDbs]: { at, data: ['app'] },
    [cacheKeys.pgSchemas('app')]: { at, data: ['public'] },
    [cacheKeys.pgTables('app', 'public')]: { at, data: [{ name: 'users', kind: 'table' }, { name: 'orders', kind: 'table' }] }
  }
})
let api: MockApi
const modal = (): HTMLElement | null => document.querySelector('.modal.goto')
const key = (init: KeyboardEventInit): boolean => fireEvent.keyDown(document.body, init)
const flush = async (): Promise<void> => void (await act(async () => void (await new Promise((r) => setTimeout(r, 0)))))

beforeEach(() => {
  localStorage.clear()
  h.explorer = null
  h.patch = []
  h.session = { width: 300, sidebarHidden: false, consoleN: 0, tabs: [], consoleSql: {}, active: null }
  api = installApi({ cache: cacheFake(store()) })
})
afterEach(cleanup)

async function mount(): Promise<void> {
  await primeIndex()
  render(<App />)
  act(() => h.explorer!.onSources(srcs()))
  await flush()
}

describe('App: ⌘O "Go to database or table"', () => {
  it('⌘O opens it from anywhere; the keystroke is consumed', async () => {
    await mount()
    expect(modal()).toBeNull()
    const notPrevented = key({ key: 'o', code: 'KeyO', metaKey: true })
    expect(notPrevented).toBe(false) // preventDefault: no browser "open file"
    expect(modal()).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Search databases and tables'))
  })

  it('Ctrl+O works too (Linux / Windows)', async () => {
    await mount()
    key({ key: 'o', code: 'KeyO', ctrlKey: true })
    expect(modal()).toBeTruthy()
  })

  it('works on non-QWERTY layouts (matched by the physical key)', async () => {
    await mount()
    key({ key: 'ø', code: 'KeyO', metaKey: true })
    expect(modal()).toBeTruthy()
  })

  it('other combinations are not ours', async () => {
    await mount()
    key({ key: 'o', code: 'KeyO' })
    key({ key: 'o', code: 'KeyO', metaKey: true, shiftKey: true })
    key({ key: 'o', code: 'KeyO', metaKey: true, altKey: true })
    key({ key: 'p', code: 'KeyP', metaKey: true })
    expect(modal()).toBeNull()
  })

  it('works while the focus is in an input / editor-like element', async () => {
    await mount()
    const i = document.createElement('input')
    document.body.appendChild(i)
    i.focus()
    fireEvent.keyDown(i, { key: 'o', code: 'KeyO', metaKey: true })
    expect(modal()).toBeTruthy()
    i.remove()
  })

  it('the Go menu item (menu:goto) opens it', async () => {
    await mount()
    act(() => api._goto[0]())
    expect(modal()).toBeTruthy()
  })

  it('the menu accelerator and the keydown for one keystroke open it only once', async () => {
    await mount()
    act(() => {
      key({ key: 'o', code: 'KeyO', metaKey: true })
      api._goto[0]()
    })
    expect(document.querySelectorAll('.modal.goto')).toHaveLength(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(modal()).toBeNull()
  })

  it('is ignored while another modal is open (Settings)', async () => {
    await mount()
    act(() => api._settings[0]())
    expect(document.querySelector('.settings-modal')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 200)) // (past the double-fire guard)
    key({ key: 'o', code: 'KeyO', metaKey: true })
    act(() => api._goto[0]())
    expect(modal()).toBeNull()
  })

  it('is ignored over a confirm dialog (.cd-bg)', async () => {
    await mount()
    const bg = document.createElement('div')
    bg.className = 'cd-bg'
    document.body.appendChild(bg)
    key({ key: 'o', code: 'KeyO', metaKey: true })
    expect(modal()).toBeNull()
    bg.remove()
  })

  it('Esc closes it, and it can be opened again', async () => {
    await mount()
    key({ key: 'o', code: 'KeyO', metaKey: true })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(modal()).toBeNull()
    await new Promise((r) => setTimeout(r, 200))
    key({ key: 'o', code: 'KeyO', metaKey: true })
    expect(modal()).toBeTruthy()
  })

  it('searches the data sources the explorer reported', async () => {
    await mount()
    key({ key: 'o', code: 'KeyO', metaKey: true })
    fireEvent.change(screen.getByPlaceholderText('Search databases and tables'), { target: { value: 'ord' } })
    expect(Array.from(document.querySelectorAll('.goto-row .goto-name')).map((n) => n.textContent)).toEqual(['orders'])
  })

  it('choosing a table opens it in a tab (the same handler as the explorer) and remembers it', async () => {
    await mount()
    key({ key: 'o', code: 'KeyO', metaKey: true })
    const input = screen.getByPlaceholderText('Search databases and tables')
    fireEvent.change(input, { target: { value: 'users' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(screen.getByTestId('pg-users')).toBeTruthy()
    expect(document.querySelectorAll('.tab')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)[0]).toMatchObject({ name: 'users', schema: 'public', database: 'app' })
    expect(modal()).toBeNull()
  })

  it('choosing a table that is already open focuses its tab instead of duplicating it', async () => {
    await mount()
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 170)) // (past the double-fire guard)
      key({ key: 'o', code: 'KeyO', metaKey: true })
      const input = screen.getByPlaceholderText('Search databases and tables')
      fireEvent.change(input, { target: { value: 'users' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await flush()
    }
    expect(document.querySelectorAll('.tab')).toHaveLength(1)
  })

  it('a table opened from the explorer lands in the recent list too (shown when ⌘O opens with an empty query)', async () => {
    await mount()
    act(() => h.explorer!.onOpen({ dsId: 'pg', dsName: 'Pg', database: 'app', schema: 'public', table: 'orders', kind: 'table' }))
    key({ key: 'o', code: 'KeyO', metaKey: true })
    expect(Array.from(document.querySelectorAll('.goto-row .goto-name')).map((n) => n.textContent)).toEqual(['orders'])
  })

  it('choosing a database asks the explorer to select, expand and reveal it', async () => {
    await mount()
    key({ key: 'o', code: 'KeyO', metaKey: true })
    const input = screen.getByPlaceholderText('Search databases and tables')
    fireEvent.change(input, { target: { value: 'app' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    const [target, expand] = screen.getByTestId('explorer').getAttribute('data-reveal')!.split('|')
    expect(target).toBe('pg/app')
    expect(expand).toBe('true')
    expect(document.querySelectorAll('.tab')).toHaveLength(0) // not opened as a tab
  })

  it('choosing a database while the sidebar is hidden shows the sidebar', async () => {
    h.session.sidebarHidden = true
    await mount()
    expect((document.querySelector('.side') as HTMLElement).style.display).toBe('none')
    key({ key: 'o', code: 'KeyO', metaKey: true })
    const input = screen.getByPlaceholderText('Search databases and tables')
    fireEvent.change(input, { target: { value: 'app' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect((document.querySelector('.side') as HTMLElement).style.display).toBe('')
  })

  it('two reveals of the same database are two requests (a new n every time)', async () => {
    await mount()
    const reveal = (): string => screen.getByTestId('explorer').getAttribute('data-reveal')!
    const pick = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 170)) // (past the double-fire guard)
      key({ key: 'o', code: 'KeyO', metaKey: true })
      const input = screen.getByPlaceholderText('Search databases and tables')
      fireEvent.change(input, { target: { value: 'app' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await flush()
    }
    await pick()
    const first = reveal()
    await new Promise((r) => setTimeout(r, 5))
    await pick()
    expect(reveal()).not.toBe(first)
  })
})
