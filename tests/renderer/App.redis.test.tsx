// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DataSource } from '../../src/shared'
import type { TableRef } from '../../src/renderer/src/Explorer'
import { installApi } from './helpers/mockApi'

const h = vi.hoisted(() => ({
  explorer: null as null | Record<string, (...a: any[]) => void> & { reloadKey: number; activeTarget: string | null },
  session: { width: 300, sidebarHidden: false, consoleN: 0, tabs: [] as unknown[], consoleSql: {} as Record<string, string>, active: null as string | null },
  saveTabs: [] as unknown[][],
  keyTabs: {} as Record<string, any>
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
  default: ({ t }: any) => <div data-testid={'ddb-' + t.table} />
}))
vi.mock('../../src/renderer/src/RedisKeyView', async () => ({
  default: ({ t, active, reloadToken }: any) => (
    <div
      data-testid={'redis-' + t.table} data-active={String(active)} data-token={reloadToken} data-db={t.db}
      data-filter={t.redisFilter ? JSON.stringify(t.redisFilter) : ''}
    />
  )
}))
vi.mock('../../src/renderer/src/RedisKeyTab', async () => ({
  default: (p: any) => {
    h.keyTabs[p.t.redisKey] = p
    return <div data-testid={'rkey-' + p.t.redisKey} data-active={String(p.active)} data-token={p.reloadToken} data-db={p.t.db} />
  }
}))
vi.mock('../../src/renderer/src/Console', async () => ({
  default: ({ c }: any) => <div data-testid={'console-' + c.id} data-engine={c.engine ?? ''} data-region={c.region ?? ''} data-db={c.db ?? ''} data-sql={c.sql ?? ''} />
}))
vi.mock('../../src/renderer/src/session', () => ({
  get initialSession() { return h.session },
  patchSession: () => undefined,
  saveTabs: (tabs: unknown[], active: string | null) => void h.saveTabs.push([tabs, active])
}))

import App from '../../src/renderer/src/App'

Element.prototype.scrollIntoView = vi.fn()

const rRef = (db: number, over: Partial<TableRef> = {}): TableRef => ({
  dsId: 'rd', dsName: 'Cache', database: `db${db}`, schema: '', table: `db${db}`, kind: 'redis', engine: 'redis', db, ...over
})
const pgRef = (table: string): TableRef => ({ dsId: 'pg', dsName: 'Pg', database: 'app', schema: 'public', table, kind: 'table' })
const srcs = (): DataSource[] => [
  { id: 'rd', name: 'Cache', kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false, redis: { host: 'localhost', port: 6379, db: 0, tls: false } },
  { id: 'pg', name: 'Pg', host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false }
]
const tabs = (): HTMLElement[] => Array.from(document.querySelectorAll('.tab'))
// (key icons are text glyphs inside .ticon: leave them out of the title)
const titles = (): string[] =>
  tabs().map((t) => t.querySelector('.tabtitle')!.textContent!.slice(t.querySelector('.ticon')!.textContent!.length))
const flush = (): void => void act(() => void vi.advanceTimersByTime(400))

beforeEach(() => {
  vi.useFakeTimers()
  h.explorer = null
  h.keyTabs = {}
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

describe('App: Redis tabs', () => {
  it('a database opens the key browser with the Redis icon and a "source / dbN" tooltip', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3)))
    expect(screen.getByTestId('redis-db3').dataset).toMatchObject({ active: 'true', db: '3' })
    expect(screen.queryByTestId('pg-db3')).toBeNull()
    expect(tabs()[0].dataset.tip).toBe('Cache / db3')
    expect(titles()).toEqual(['db3'])
    act(() => h.explorer!.onOpen(pgRef('orders')))
    expect(tabs()).toHaveLength(2)
    expect(tabs()[0].querySelector('.ticon svg')!.outerHTML).not.toBe(tabs()[1].querySelector('.ticon svg')!.outerHTML)
  })

  it('the Explorer is told the Redis tree id of the active tab', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3)))
    expect(screen.getByTestId('explorer').dataset.target).toBe('rd/db3')
  })

  it('each database is its own tab; re-opening the same one reloads it', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3)))
    act(() => h.explorer!.onOpen(rRef(4)))
    expect(titles()).toEqual(['db3', 'db4'])
    act(() => h.explorer!.onOpen(rRef(3)))
    expect(tabs()).toHaveLength(2)
    expect(screen.getByTestId('redis-db3').dataset.token).toBe('1')
    expect(screen.getByTestId('redis-db4').dataset.token).toBe('0')
    expect(screen.getByTestId('redis-db3').dataset.active).toBe('true')
  })

  it('only the active tab is marked active (inactive key browsers do not load or react to keys)', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3)))
    act(() => h.explorer!.onOpen(rRef(4)))
    expect(screen.getByTestId('redis-db3').dataset.active).toBe('false')
    expect(screen.getByTestId('redis-db4').dataset.active).toBe('true')
  })

  it('refreshing a database or the whole source in the tree reloads its open tab', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3)))
    act(() => h.explorer!.onRefreshed('rd/db3'))
    expect(screen.getByTestId('redis-db3').dataset.token).toBe('1')
    act(() => h.explorer!.onRefreshed('rd'))
    expect(screen.getByTestId('redis-db3').dataset.token).toBe('2')
    act(() => h.explorer!.onRefreshed('rd/db4'))
    act(() => h.explorer!.onRefreshed('pg'))
    expect(screen.getByTestId('redis-db3').dataset.token).toBe('2')
  })

  it('a Redis console opens on its database with the right title and tooltip', async () => {
    await mount()
    act(() => h.explorer!.onConsole({ dsId: 'rd', dsName: 'Cache', database: 'db3', engine: 'redis', db: 3 }))
    const c = document.querySelector('[data-testid^="console-"]') as HTMLElement
    expect(c.dataset).toMatchObject({ engine: 'redis', db: '3' })
    expect(titles()).toEqual(['Cache db3 console'])
    expect(tabs()[0].dataset.tip).toBe('Cache / db3')
    expect(screen.getByTestId('explorer').dataset.target).toBe('rd/db3') // the console's database is revealed in the tree
    act(() => h.explorer!.onConsole({ dsId: 'rd', dsName: 'Cache', database: 'db0', engine: 'redis', db: 0 }))
    expect(titles()[1]).toBe('Cache db0 console 2')
    expect(tabs()[1].dataset.tip).toBe('Cache / db0')
  })

  it('removing the data source closes its Redis tabs and consoles only', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3)))
    act(() => h.explorer!.onConsole({ dsId: 'rd', dsName: 'Cache', database: 'db3', engine: 'redis', db: 3 }))
    act(() => h.explorer!.onOpen(pgRef('t')))
    act(() => h.explorer!.onObjectGone({ dsId: 'rd' }))
    flush()
    expect(titles()).toEqual(['t'])
  })

  it('the session saves engine and db; restoring brings the tabs back (unknown sources dropped, invalid db already filtered)', async () => {
    h.session.tabs = [
      { type: 'table', t: rRef(3, { dsName: 'old name' }) },
      { type: 'table', t: rRef(5, { dsId: 'deleted' }) },
      { type: 'console', c: { id: 'c1', title: 'Cache db3 console', dsId: 'rd', dsName: 'x', database: 'db3', engine: 'redis', db: 3 } }
    ]
    h.session.consoleSql = { c1: 'GET a' }
    h.session.active = 't|redis|rd|3'
    await mount()
    expect(titles()).toEqual(['db3', 'Cache db3 console'])
    expect(screen.getByTestId('redis-db3').dataset.active).toBe('true')
    expect(tabs()[0].dataset.tip).toBe('Cache / db3') // the data source's current name
    expect((document.querySelector('[data-testid="console-c1"]') as HTMLElement).dataset.sql).toBe('GET a')
    const [saved] = h.saveTabs.at(-1) as [{ type: string; t?: TableRef; c?: any }[]]
    expect(saved[0].t).toMatchObject({ engine: 'redis', db: 3, table: 'db3' })
    expect(saved[1].c).toMatchObject({ engine: 'redis', db: 3 })
  })

  it('closing a Redis tab removes it', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3)))
    fireEvent.click(tabs()[0].querySelector('.x')!)
    flush()
    expect(tabs()).toHaveLength(0)
    expect(screen.queryByTestId('redis-db3')).toBeNull()
  })
})

const kRef = (key: string, db = 3, over: Partial<TableRef> = {}): TableRef => ({ ...rRef(db), table: key, redisKey: key, ...over })
const icons = (): string[] => tabs().map((t) => t.querySelector('.ticon')!.getAttribute('data-tip')!)

describe('App: Redis key tabs', () => {
  it('a key opens in its own tab: title, tooltip, pane, and the tree reveals its database', async () => {
    await mount()
    act(() => h.explorer!.onOpen(kRef('user:42:name')))
    expect(titles()).toEqual(['user:42:name'])
    expect(tabs()[0].dataset.tip).toBe('Cache / db3 / user:42:name')
    expect(screen.getByTestId('rkey-user:42:name').dataset).toMatchObject({ active: 'true', db: '3' })
    expect(screen.queryByTestId('redis-user:42:name')).toBeNull() // not the key browser
    expect(screen.getByTestId('explorer').dataset.target).toBe('rd/db3')
  })

  it('long key names are shortened to their tail; the tooltip keeps the whole key', async () => {
    await mount()
    const long = 'tenant:1234567890:session:abcdefghijklmnop'
    act(() => h.explorer!.onOpen(kRef(long)))
    expect(titles()[0]).toBe('…' + long.slice(-27))
    expect(tabs()[0].dataset.tip).toBe('Cache / db3 / ' + long)
  })

  it('binary key names show their escaped form in the title and tooltip', async () => {
    await mount()
    const enc = '\u0000b64:' + btoa('\xff\x41')
    act(() => h.explorer!.onOpen(kRef(enc)))
    expect(titles()[0]).toBe('\\xffA')
    expect(tabs()[0].dataset.tip).toBe('Cache / db3 / \\xffA')
  })

  it('the icon follows the key type once the tab reports it', async () => {
    await mount()
    act(() => h.explorer!.onOpen(kRef('a')))
    expect(icons()).toEqual(['Key'])
    const before = tabs()[0].querySelector('.ticon svg')!.outerHTML
    act(() => h.keyTabs.a.onType('hash'))
    expect(icons()).toEqual(['Hash key'])
    expect(tabs()[0].querySelector('.ticon svg')!.outerHTML).not.toBe(before)
    act(() => h.keyTabs.a.onType('zset'))
    expect(icons()).toEqual(['Sorted set key'])
    act(() => h.keyTabs.a.onType('ReJSON-RL'))
    expect(icons()).toEqual(['Key'])
  })

  it('opening the same key again only focuses its tab (no second tab, no reload)', async () => {
    await mount()
    act(() => h.explorer!.onOpen(kRef('a')))
    act(() => h.explorer!.onOpen(kRef('b')))
    expect(screen.getByTestId('rkey-a').dataset.active).toBe('false')
    act(() => h.explorer!.onOpen(kRef('a')))
    expect(titles()).toEqual(['a', 'b'])
    expect(screen.getByTestId('rkey-a').dataset).toMatchObject({ active: 'true', token: '0' })
  })

  it('the same key name in another database or source is a different tab; the key browser is separate too', async () => {
    await mount()
    act(() => h.explorer!.onOpen(kRef('a', 3)))
    act(() => h.explorer!.onOpen(kRef('a', 4)))
    act(() => h.explorer!.onOpen(rRef(3)))
    expect(tabs()).toHaveLength(3)
    expect(titles()).toEqual(['a', 'a', 'db3'])
  })

  it('"Browse in Key Browser" opens the browser prefilled; asking again from another folder updates the SAME tab', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3, { redisFilter: { pattern: 'user:*', type: 'string', n: 1 } })))
    expect(JSON.parse(screen.getByTestId('redis-db3').dataset.filter!)).toEqual({ pattern: 'user:*', type: 'string', n: 1 })
    act(() => h.explorer!.onOpen(rRef(3, { redisFilter: { pattern: 'queue:*', type: '', n: 2 } })))
    expect(tabs()).toHaveLength(1)
    expect(JSON.parse(screen.getByTestId('redis-db3').dataset.filter!)).toEqual({ pattern: 'queue:*', type: '', n: 2 })
    expect(screen.getByTestId('redis-db3').dataset.token).toBe('0') // not a reload: the prefill drives the scan
  })

  it('a plain database open still reloads its browser and keeps the previous prefill', async () => {
    await mount()
    act(() => h.explorer!.onOpen(rRef(3, { redisFilter: { pattern: 'a*', type: '', n: 1 } })))
    act(() => h.explorer!.onOpen(rRef(3)))
    expect(screen.getByTestId('redis-db3').dataset.token).toBe('1')
    expect(JSON.parse(screen.getByTestId('redis-db3').dataset.filter!).pattern).toBe('a*')
  })

  describe('delete', () => {
    it('Delete in the tab closes it, activates a neighbour and asks the tree to re-scan the database', async () => {
      await mount()
      act(() => h.explorer!.onOpen(kRef('a')))
      act(() => h.explorer!.onOpen(kRef('b')))
      act(() => h.keyTabs.b.onDeleted())
      flush()
      expect(titles()).toEqual(['a'])
      expect(screen.getByTestId('rkey-a').dataset.active).toBe('true')
      expect(h.explorer!.treeRefresh).toEqual({ id: 'rd/db3', n: 1 })
      act(() => h.keyTabs.a.onDeleted())
      expect(tabs()).toHaveLength(0)
      expect(h.explorer!.treeRefresh).toEqual({ id: 'rd/db3', n: 2 })
    })

    it('deleting keys in the tree closes exactly their tabs (other keys, other databases, the browser stay)', async () => {
      await mount()
      act(() => h.explorer!.onOpen(kRef('a')))
      act(() => h.explorer!.onOpen(kRef('b')))
      act(() => h.explorer!.onOpen(kRef('c')))
      act(() => h.explorer!.onOpen(kRef('a', 4)))
      act(() => h.explorer!.onOpen(rRef(3)))
      act(() => h.explorer!.onKeysGone('rd', 3, ['a', 'c', 'never-open']))
      flush()
      expect(titles()).toEqual(['b', 'a', 'db3'])
      act(() => h.explorer!.onKeysGone('pg', 3, ['b']))
      expect(titles()).toEqual(['b', 'a', 'db3'])
    })

    it('when the active tab is deleted from the tree the last remaining tab is activated', async () => {
      await mount()
      act(() => h.explorer!.onOpen(kRef('a')))
      act(() => h.explorer!.onOpen(kRef('b')))
      act(() => h.explorer!.onKeysGone('rd', 3, ['b']))
      flush()
      expect(screen.getByTestId('rkey-a').dataset.active).toBe('true')
    })
  })

  describe('rename', () => {
    it('Rename in the tab re-keys and retitles it in place (same position, still active) and refreshes the tree', async () => {
      await mount()
      act(() => h.explorer!.onOpen(kRef('x')))
      act(() => h.explorer!.onOpen(kRef('old')))
      act(() => h.explorer!.onOpen(kRef('z')))
      act(() => h.explorer!.onOpen(kRef('old')))
      act(() => h.keyTabs.old.onType('hash'))
      act(() => h.keyTabs.old.onRenamed('new:name'))
      flush()
      expect(titles()).toEqual(['x', 'new:name', 'z'])
      expect(tabs()[1].dataset.tip).toBe('Cache / db3 / new:name')
      expect(screen.getByTestId('rkey-new:name').dataset.active).toBe('true')
      expect(screen.queryByTestId('rkey-old')).toBeNull()
      expect(icons()[1]).toBe('Hash key') // the known type moves along with the key
      expect(h.explorer!.treeRefresh).toEqual({ id: 'rd/db3', n: 1 })
    })

    it('Rename in the tree retitles the open tab (the tree already re-scans itself)', async () => {
      await mount()
      act(() => h.explorer!.onOpen(kRef('a')))
      act(() => h.explorer!.onKeyRenamed('rd', 3, 'a', 'b'))
      flush()
      expect(titles()).toEqual(['b'])
      expect(h.explorer!.treeRefresh).toBeNull()
    })

    it('renaming a key that has no tab, or one in another database, changes nothing', async () => {
      await mount()
      act(() => h.explorer!.onOpen(kRef('a', 4)))
      act(() => h.explorer!.onKeyRenamed('rd', 3, 'a', 'b'))
      act(() => h.explorer!.onKeyRenamed('rd', 4, 'nope', 'b'))
      flush()
      expect(titles()).toEqual(['a'])
    })

    it('renaming onto a name that already has a tab keeps one tab for it', async () => {
      await mount()
      act(() => h.explorer!.onOpen(kRef('a')))
      act(() => h.explorer!.onOpen(kRef('b')))
      act(() => h.explorer!.onKeyRenamed('rd', 3, 'a', 'b'))
      flush()
      expect(titles()).toEqual(['b'])
    })

    it('the renamed tab is saved in the session under its new name', async () => {
      await mount()
      act(() => h.explorer!.onOpen(kRef('a')))
      act(() => h.explorer!.onKeyRenamed('rd', 3, 'a', 'b'))
      flush()
      const [saved, active] = h.saveTabs.at(-1) as [{ t: TableRef }[], string]
      expect(saved.map((x) => x.t.redisKey)).toEqual(['b'])
      expect(active).toBe('t|rkey|rd|3|b')
    })
  })

  it('refreshing the database in the tree reloads open key tabs of it, not those of other databases', async () => {
    await mount()
    act(() => h.explorer!.onOpen(kRef('a', 3)))
    act(() => h.explorer!.onOpen(kRef('b', 4)))
    act(() => h.explorer!.onRefreshed('rd/db3'))
    expect(screen.getByTestId('rkey-a').dataset.token).toBe('1')
    expect(screen.getByTestId('rkey-b').dataset.token).toBe('0')
  })

  it('only the active key tab is marked active (restored tabs load lazily)', async () => {
    await mount()
    act(() => h.explorer!.onOpen(kRef('a')))
    act(() => h.explorer!.onOpen(kRef('b')))
    expect(screen.getByTestId('rkey-a').dataset.active).toBe('false')
    expect(screen.getByTestId('rkey-b').dataset.active).toBe('true')
  })

  it('closing a key tab removes it', async () => {
    await mount()
    act(() => h.explorer!.onOpen(kRef('a')))
    fireEvent.click(tabs()[0].querySelector('.x')!)
    flush()
    expect(tabs()).toHaveLength(0)
    expect(screen.queryByTestId('rkey-a')).toBeNull()
  })

  it('removing the data source closes its key tabs too', async () => {
    await mount()
    act(() => h.explorer!.onOpen(kRef('a')))
    act(() => h.explorer!.onOpen(pgRef('t')))
    act(() => h.explorer!.onObjectGone({ dsId: 'rd' }))
    flush()
    expect(titles()).toEqual(['t'])
  })

  describe('session', () => {
    it('key tabs are saved with their key and restored (unknown sources dropped, source name refreshed)', async () => {
      h.session.tabs = [
        { type: 'table', t: kRef('user:1', 3, { dsName: 'old name' }) },
        { type: 'table', t: kRef('gone', 3, { dsId: 'deleted' }) },
        { type: 'table', t: rRef(3) }
      ]
      h.session.active = 't|rkey|rd|3|user:1'
      await mount()
      expect(titles()).toEqual(['user:1', 'db3'])
      expect(screen.getByTestId('rkey-user:1').dataset.active).toBe('true')
      expect(tabs()[0].dataset.tip).toBe('Cache / db3 / user:1')
      const [saved] = h.saveTabs.at(-1) as [{ t: TableRef }[]]
      expect(saved[0].t).toMatchObject({ engine: 'redis', db: 3, redisKey: 'user:1' })
    })

    it('a restored key tab is lazy: inactive until shown', async () => {
      h.session.tabs = [{ type: 'table', t: kRef('a') }, { type: 'table', t: kRef('b') }]
      h.session.active = 't|rkey|rd|3|b'
      await mount()
      expect(screen.getByTestId('rkey-a').dataset.active).toBe('false')
      expect(screen.getByTestId('rkey-b').dataset.active).toBe('true')
    })
  })
})
