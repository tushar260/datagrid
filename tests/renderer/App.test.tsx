// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { DataSource } from '../../src/shared'
import type { TableRef } from '../../src/renderer/src/Explorer'
import { installApi, type MockApi } from './helpers/mockApi'
import { getSettings, resetSettings, updateSettings } from '../../src/renderer/src/lib/settings'

// ---- light stand-ins for the heavy children: App's own logic is under test here ----
const h = vi.hoisted(() => ({
  explorer: null as null | Record<string, (...a: any[]) => void> & { reloadKey: number; activeTarget: string | null },
  mounts: { explorer: 0, tv: [] as string[], console: [] as string[] },
  tv: new Map<string, { active: boolean; reloadToken: number; reloadSoft: boolean }>(),
  session: {
    width: 300, sidebarHidden: false, consoleN: 0, tabs: [] as unknown[], consoleSql: {} as Record<string, string>, active: null as string | null
  },
  saveTabs: [] as unknown[][],
  patches: [] as Record<string, unknown>[]
}))

vi.mock('../../src/renderer/src/Explorer', async () => {
  const React = await import('react')
  return {
    default: (props: any) => {
      h.explorer = props
      React.useEffect(() => void h.mounts.explorer++, [])
      const root = React.useRef<HTMLDivElement>(null)
      // like the real Explorer: Shift+Esc (useSidebarFocus) fires this event and the tree takes the keyboard focus
      React.useEffect(() => {
        const on = (): void => root.current?.focus()
        window.addEventListener('explorer:focus', on)
        return () => window.removeEventListener('explorer:focus', on)
      }, [])
      return <div className="explorer" tabIndex={-1} ref={root} data-testid="explorer" data-reload={props.reloadKey} data-target={props.activeTarget ?? ''} />
    }
  }
})
vi.mock('../../src/renderer/src/TableView', async () => {
  const React = await import('react')
  return {
    default: ({ t, active, reloadToken, reloadSoft }: any) => {
      h.tv.set(t.table, { active, reloadToken, reloadSoft })
      React.useEffect(() => void h.mounts.tv.push(t.table), [t.table])
      return <div data-testid={'tv-' + t.table} data-active={String(active)} data-token={reloadToken} data-soft={String(reloadSoft)} />
    }
  }
})
vi.mock('../../src/renderer/src/Console', async () => {
  const React = await import('react')
  return {
    default: ({ c }: any) => {
      React.useEffect(() => void h.mounts.console.push(c.id), [c.id])
      return <div data-testid={'console-' + c.id} data-sql={c.sql ?? ''} />
    }
  }
})
vi.mock('../../src/renderer/src/session', () => ({
  get initialSession() { return h.session },
  patchSession: (p: Record<string, unknown>) => void h.patches.push(p),
  saveTabs: (tabs: unknown[], active: string | null) => void h.saveTabs.push([tabs, active])
}))

import App from '../../src/renderer/src/App'

let api: MockApi
Element.prototype.scrollIntoView = vi.fn()

const tref = (table: string, over: Partial<TableRef> = {}): TableRef => ({ dsId: 'ds1', dsName: 'Local', database: 'app', schema: 'public', table, kind: 'table', ...over })
const key = (t: TableRef): string => ['t', t.dsId, t.database, t.schema, t.table].join('|')
const src = (id: string, name = id): DataSource => ({ id, name, host: 'h', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false })

const openTable = (t: TableRef): void => void act(() => h.explorer!.onOpen(t))
const tabEls = (): HTMLElement[] => Array.from(document.querySelectorAll('.tab'))
const tabNames = (): string[] => tabEls().map((t) => t.querySelector('.tabtitle')!.textContent!)
const activeName = (): string | undefined => document.querySelector('.tab.on .tabtitle')?.textContent ?? undefined
const tabByName = (n: string): HTMLElement => tabEls().find((t) => t.querySelector('.tabtitle')!.textContent === n)!
const press = (init: KeyboardEventInit & { key: string }, target: EventTarget = document.body): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(ev))
  return ev
}
const flushAnim = (): void => void act(() => void vi.advanceTimersByTime(400))
const closeTab = (name: string): void => {
  fireEvent.click(tabByName(name).querySelector('.x')!)
  flushAnim()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-05T10:00:00Z'))
  h.explorer = null
  h.mounts.explorer = 0
  h.mounts.tv = []
  h.mounts.console = []
  h.tv.clear()
  h.saveTabs.length = 0
  h.patches.length = 0
  h.session = { width: 300, sidebarHidden: false, consoleN: 0, tabs: [], consoleSql: {}, active: null }
  api = installApi()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function mount(restoreWith: DataSource[] = [src('ds1', 'Local')]): Promise<void> {
  render(<App />)
  act(() => h.explorer!.onSources(restoreWith))
  flushAnim()
}

describe('App: tabs open / close', () => {
  it('starts with the placeholder and no tabs', async () => {
    await mount()
    expect(screen.getByText(/Double-click a table in the Database Explorer/)).toBeTruthy()
    expect(tabEls()).toHaveLength(0)
  })

  it('opening a table adds an active tab and mounts its view; the Explorer is told the active target', async () => {
    await mount()
    openTable(tref('users'))
    expect(tabNames()).toEqual(['users'])
    expect(activeName()).toBe('users')
    expect(screen.queryByText(/Double-click a table/)).toBeNull()
    expect(screen.getByTestId('tv-users').dataset.active).toBe('true')
    expect(screen.getByTestId('explorer').dataset.target).toBe('ds1/app/public/users')
    openTable(tref('orders'))
    expect(tabNames()).toEqual(['users', 'orders'])
    expect(activeName()).toBe('orders')
    expect(screen.getByTestId('tv-users').dataset.active).toBe('false') // stays mounted (keeps its state), just hidden
    expect(screen.getByTestId('tv-users').closest('.pane')!.getAttribute('style')).toContain('display: none')
  })

  it('same table in different schemas / databases / data sources are different tabs', async () => {
    await mount()
    openTable(tref('t'))
    openTable(tref('t', { schema: 'other' }))
    openTable(tref('t', { database: 'db2' }))
    openTable(tref('t', { dsId: 'ds2' }))
    expect(tabEls()).toHaveLength(4)
  })

  it('clicking a tab activates it', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b'))
    fireEvent.click(tabByName('a'))
    expect(activeName()).toBe('a')
    expect(screen.getByTestId('tv-a').dataset.active).toBe('true')
  })

  it('de-dups: opening an already open table only activates it, and bumps its reload token as a SOFT reload', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b'))
    expect(screen.getByTestId('tv-a').dataset.token).toBe('0')
    openTable(tref('a'))
    expect(tabNames()).toEqual(['a', 'b'])
    expect(activeName()).toBe('a')
    expect(screen.getByTestId('tv-a').dataset.token).toBe('1')
    expect(screen.getByTestId('tv-a').dataset.soft).toBe('true')
    expect(screen.getByTestId('tv-b').dataset.token).toBe('0') // others untouched
    openTable(tref('a'))
    expect(screen.getByTestId('tv-a').dataset.token).toBe('2')
    expect(h.mounts.tv.filter((x) => x === 'a')).toHaveLength(1) // never remounted
  })

  it('first open does NOT bump the token (a fresh tab loads by itself)', async () => {
    await mount()
    openTable(tref('a'))
    expect(screen.getByTestId('tv-a').dataset.token).toBe('0')
    expect(screen.getByTestId('tv-a').dataset.soft).toBe('true') // 0 === 0, harmless: tokens only matter once they change
  })

  it('a tree refresh bumps tokens HARD (not soft) for open tables under that node only', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b', { schema: 'other' })); openTable(tref('c', { dsId: 'ds2' }))
    openTable(tref('a')) // soft bump -> token 1
    act(() => h.explorer!.onRefreshed('ds1/app/public'))
    expect(screen.getByTestId('tv-a').dataset.token).toBe('2')
    expect(screen.getByTestId('tv-a').dataset.soft).toBe('false')
    expect(screen.getByTestId('tv-b').dataset.token).toBe('0')
    act(() => h.explorer!.onRefreshed('ds1'))
    expect(screen.getByTestId('tv-b').dataset.token).toBe('1')
    expect(screen.getByTestId('tv-c').dataset.token).toBe('0')
    act(() => h.explorer!.onRefreshed('ds1/app/pub')) // prefix of a name is not a path prefix
    expect(screen.getByTestId('tv-a').dataset.token).toBe('3') // unchanged by the previous? -> only exact path/prefix+/ match
  })

  it('closing with × animates (closing class) then removes; the right neighbour becomes active immediately', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b')); openTable(tref('c'))
    fireEvent.click(tabByName('b'))
    fireEvent.click(tabByName('b').querySelector('.x')!)
    expect(tabByName('b').classList.contains('closing')).toBe(true)
    expect(activeName()).toBe('c')
    flushAnim()
    expect(tabNames()).toEqual(['a', 'c'])
    expect(screen.queryByTestId('tv-b')).toBeNull()
  })

  it('closing the last tab activates the previous one; closing the only tab shows the placeholder', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b'))
    closeTab('b')
    expect(activeName()).toBe('a')
    closeTab('a')
    expect(tabEls()).toHaveLength(0)
    expect(screen.getByText(/Double-click a table/)).toBeTruthy()
  })

  it('closing an inactive tab keeps the active one', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b')); openTable(tref('c'))
    closeTab('a')
    expect(activeName()).toBe('c')
    expect(tabNames()).toEqual(['b', 'c'])
  })

  it('repeated clicks on × while animating are harmless', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b'))
    const x = tabByName('b').querySelector('.x')!
    fireEvent.click(x); fireEvent.click(x); fireEvent.click(x)
    flushAnim()
    expect(tabNames()).toEqual(['a'])
    expect(activeName()).toBe('a')
  })

  it('× does not also activate the tab (click does not bubble)', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b'))
    fireEvent.click(tabByName('a').querySelector('.x')!)
    expect(activeName()).toBe('b')
  })

  it('tab tooltips name the data source / database.schema', async () => {
    await mount()
    openTable(tref('a'))
    expect(tabByName('a').dataset.tip).toBe('Local / app.public')
  })
})

describe('App: Cmd/Ctrl+W', () => {
  it('with no tabs it does nothing (no throw)', async () => {
    await mount()
    expect(() => press({ key: 'w', metaKey: true })).not.toThrow()
    expect(() => act(() => api._closeTab.forEach((f) => f()))).not.toThrow()
    expect(tabEls()).toHaveLength(0)
  })

  it('keydown Cmd+W / Ctrl+W closes the active tab and prevents default', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b'))
    const ev = press({ key: 'w', metaKey: true })
    expect(ev.defaultPrevented).toBe(true)
    flushAnim()
    expect(tabNames()).toEqual(['a'])
    act(() => void vi.advanceTimersByTime(200))
    press({ key: 'W', ctrlKey: true })
    flushAnim()
    expect(tabEls()).toHaveLength(0)
  })

  it('the menu accelerator (IPC) closes the active tab too; menu + keydown within 150ms count once', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b')); openTable(tref('c'))
    act(() => api._closeTab.forEach((f) => f()))
    press({ key: 'w', metaKey: true }) // the twin of the same keystroke
    flushAnim()
    expect(tabNames()).toEqual(['a', 'b'])
    act(() => void vi.advanceTimersByTime(200))
    act(() => api._closeTab.forEach((f) => f()))
    flushAnim()
    expect(tabNames()).toEqual(['a'])
  })

  it('Shift/Alt variants do not close', async () => {
    await mount()
    openTable(tref('a'))
    press({ key: 'w', metaKey: true, shiftKey: true })
    press({ key: 'w', metaKey: true, altKey: true })
    press({ key: 'w' })
    flushAnim()
    expect(tabEls()).toHaveLength(1)
  })

  it('unsubscribes the menu listener on unmount', async () => {
    await mount()
    expect(api._closeTab).toHaveLength(1)
    cleanup()
    expect(api._closeTab).toHaveLength(0)
  })
})

describe('App: console tabs', () => {
  it('opens numbered console tabs titled by schema (or database)', async () => {
    await mount()
    act(() => h.explorer!.onConsole({ dsId: 'ds1', dsName: 'Local', database: 'app', schema: 'public' }))
    act(() => h.explorer!.onConsole({ dsId: 'ds1', dsName: 'Local', database: 'app' }))
    act(() => h.explorer!.onConsole({ dsId: 'ds1', dsName: 'Local', database: 'app', schema: 'public' }))
    expect(tabNames()).toEqual(['public console', 'app console 2', 'public console 3'])
    expect(activeName()).toBe('public console 3')
    expect(h.patches.some((p) => p.consoleN === 3)).toBe(true)
  })

  it('console tabs close like table tabs and their Explorer target is ds/db/schema', async () => {
    await mount()
    act(() => h.explorer!.onConsole({ dsId: 'ds1', dsName: 'Local', database: 'app', schema: 'public' }))
    expect(screen.getByTestId('explorer').dataset.target).toBe('ds1/app/public')
    closeTab('public console')
    expect(tabEls()).toHaveLength(0)
  })

  it('console target omits a missing schema', async () => {
    await mount()
    act(() => h.explorer!.onConsole({ dsId: 'ds1', dsName: 'Local', database: 'app' }))
    expect(screen.getByTestId('explorer').dataset.target).toBe('ds1/app')
  })
})

describe('App: object renames / drops', () => {
  it('table rename updates the open tab title and the active key', async () => {
    await mount()
    openTable(tref('old')); openTable(tref('other'))
    fireEvent.click(tabByName('old'))
    act(() => h.explorer!.onTableRenamed('ds1', 'app', 'public', 'old', 'new'))
    expect(tabNames()).toEqual(['new', 'other'])
    expect(activeName()).toBe('new')
  })

  it('rename of a table that is not open (or in another schema) changes nothing', async () => {
    await mount()
    openTable(tref('x'))
    act(() => h.explorer!.onTableRenamed('ds1', 'app', 'other', 'x', 'y'))
    expect(tabNames()).toEqual(['x'])
  })

  it('onObjectGone closes matching tabs by table / schema / database / data source and selects the last remaining', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b')); openTable(tref('c', { schema: 's2' })); openTable(tref('d', { database: 'db2' })); openTable(tref('e', { dsId: 'ds2' }))
    act(() => h.explorer!.onObjectGone({ dsId: 'ds1', database: 'app', schema: 'public', table: 'a' }))
    expect(tabNames()).toEqual(['b', 'c', 'd', 'e'])
    act(() => h.explorer!.onObjectGone({ dsId: 'ds1', database: 'app', schema: 's2' }))
    expect(tabNames()).toEqual(['b', 'd', 'e'])
    act(() => h.explorer!.onObjectGone({ dsId: 'ds1', database: 'db2' }))
    expect(tabNames()).toEqual(['b', 'e'])
    expect(activeName()).toBe('e') // active was e: unaffected
    act(() => h.explorer!.onObjectGone({ dsId: 'ds2' }))
    expect(tabNames()).toEqual(['b'])
    expect(activeName()).toBe('b')
    act(() => h.explorer!.onObjectGone({ dsId: 'ds1' }))
    expect(tabEls()).toHaveLength(0)
  })

  it('dropping an object also closes console tabs of that scope', async () => {
    await mount()
    act(() => h.explorer!.onConsole({ dsId: 'ds1', dsName: 'Local', database: 'app', schema: 'public' }))
    openTable(tref('a'))
    act(() => h.explorer!.onObjectGone({ dsId: 'ds1', database: 'app', schema: 'public' }))
    expect(tabEls()).toHaveLength(0)
  })

  it('a table drop does not close console tabs', async () => {
    await mount()
    act(() => h.explorer!.onConsole({ dsId: 'ds1', dsName: 'Local', database: 'app', schema: 'public' }))
    openTable(tref('a'))
    act(() => h.explorer!.onObjectGone({ dsId: 'ds1', database: 'app', schema: 'public', table: 'a' }))
    expect(tabNames()).toEqual(['public console'])
  })
})

describe('App: tab context menu', () => {
  const menuOpen = async (name: string): Promise<HTMLElement> => {
    fireEvent.contextMenu(tabByName(name), { clientX: 50, clientY: 20 })
    return document.querySelector('.ctxmenu') as HTMLElement
  }
  const item = (label: string): HTMLElement => within(document.querySelector('.ctxmenu') as HTMLElement).getByText(label).closest('.ctxitem') as HTMLElement

  beforeEach(async () => {
    await mount()
    for (const n of ['a', 'b', 'c', 'd']) openTable(tref(n))
  })

  it('lists the actions with first/last/only-tab items disabled appropriately', async () => {
    await menuOpen('a')
    expect(item('Close Others').classList.contains('disabled')).toBe(false)
    expect(item('Move Left').classList.contains('disabled')).toBe(true)
    expect(item('Move to Start').classList.contains('disabled')).toBe(true)
    expect(item('Move Right').classList.contains('disabled')).toBe(false)
    fireEvent.mouseDown(document.body)
    expect(document.querySelector('.ctxmenu')).toBeNull()
    await menuOpen('d')
    expect(item('Close Tabs to the Right').classList.contains('disabled')).toBe(true)
    expect(item('Move Right').classList.contains('disabled')).toBe(true)
    expect(item('Move to End').classList.contains('disabled')).toBe(true)
  })

  it('Close Others keeps only that tab and activates it', async () => {
    await menuOpen('b')
    fireEvent.click(item('Close Others'))
    flushAnim()
    expect(tabNames()).toEqual(['b'])
    expect(activeName()).toBe('b')
    expect(document.querySelector('.ctxmenu')).toBeNull()
  })

  it('Close Others is disabled with a single tab', async () => {
    await menuOpen('a'); fireEvent.click(item('Close Others')); flushAnim()
    await menuOpen('a')
    expect(item('Close Others').classList.contains('disabled')).toBe(true)
    fireEvent.click(item('Close Others'))
    expect(document.querySelector('.ctxmenu')).not.toBeNull() // disabled items do nothing (menu stays)
  })

  it('Close Tabs to the Right drops those after it; if the active tab was among them the clicked tab becomes active', async () => {
    expect(activeName()).toBe('d')
    await menuOpen('b')
    fireEvent.click(item('Close Tabs to the Right'))
    flushAnim()
    expect(tabNames()).toEqual(['a', 'b'])
    expect(activeName()).toBe('b')
  })

  it('Close Tabs to the Right keeps an active tab that stays', async () => {
    fireEvent.click(tabByName('a'))
    await menuOpen('b')
    fireEvent.click(item('Close Tabs to the Right'))
    expect(activeName()).toBe('a')
  })

  it('Close closes just that tab', async () => {
    await menuOpen('b')
    fireEvent.click(item('Close'))
    flushAnim()
    expect(tabNames()).toEqual(['a', 'c', 'd'])
  })

  it('Move Left / Right / Start / End reorder and the active tab follows its key', async () => {
    await menuOpen('c'); fireEvent.click(item('Move Left'))
    expect(tabNames()).toEqual(['a', 'c', 'b', 'd'])
    await menuOpen('c'); fireEvent.click(item('Move to Start'))
    expect(tabNames()).toEqual(['c', 'a', 'b', 'd'])
    await menuOpen('a'); fireEvent.click(item('Move to End'))
    expect(tabNames()).toEqual(['c', 'b', 'd', 'a'])
    await menuOpen('c'); fireEvent.click(item('Move Right'))
    expect(tabNames()).toEqual(['b', 'c', 'd', 'a'])
    expect(activeName()).toBe('d')
  })

  it('Escape and blur dismiss the menu', async () => {
    await menuOpen('a')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.ctxmenu')).toBeNull()
    await menuOpen('a')
    fireEvent.blur(window)
    expect(document.querySelector('.ctxmenu')).toBeNull()
  })

  it('clicks inside the menu do not dismiss it before the item runs', async () => {
    await menuOpen('a')
    fireEvent.mouseDown(document.querySelector('.ctxmenu')!)
    expect(document.querySelector('.ctxmenu')).not.toBeNull()
  })

  it('is positioned inside the window', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
    fireEvent.contextMenu(tabByName('a'), { clientX: 390, clientY: 10 })
    expect(parseInt((document.querySelector('.ctxmenu') as HTMLElement).style.left)).toBe(200)
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
  })
})

describe('App: drag-reorder of tabs', () => {
  const MIME = 'application/x-datagrip-lite-tab'
  const dt = (data: Record<string, string> = {}): DataTransfer => {
    const store = { ...data }
    return { get types() { return Object.keys(store) }, setData: (k: string, v: string) => void (store[k] = v), getData: (k: string) => store[k] ?? '', effectAllowed: '', dropEffect: '' } as unknown as DataTransfer
  }
  // jsdom has no DragEvent: build a MouseEvent (keeps clientX) and attach the dataTransfer ourselves
  const dnd = (el: Element, type: string, dataTransfer: DataTransfer | null, clientX = 0, extra: MouseEventInit = {}): MouseEvent => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, ...extra })
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer })
    act(() => void el.dispatchEvent(ev))
    return ev
  }
  const rect = (el: Element, left: number, width = 100): void =>
    void vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left, right: left + width, top: 0, bottom: 30, width, height: 30, x: left, y: 0, toJSON() {} })
  const bar = (): HTMLElement => document.querySelector('.tabbar') as HTMLElement

  beforeEach(async () => {
    await mount()
    for (const n of ['a', 'b', 'c']) openTable(tref(n))
  })

  it('dropping on the second half of another tab puts the dragged tab after it', () => {
    rect(tabByName('c'), 200)
    const data = dt()
    dnd(tabByName('a'), 'dragstart', data)
    expect(tabByName('a').classList.contains('dragging')).toBe(true)
    const over = dnd(tabByName('c'), 'dragover', data, 290)
    expect(over.defaultPrevented).toBe(true)
    expect(tabByName('c').classList.contains('drop-after')).toBe(true)
    dnd(tabByName('c'), 'drop', data, 290)
    expect(tabNames()).toEqual(['b', 'c', 'a'])
    expect(tabByName('a').classList.contains('dragging')).toBe(false)
    expect(document.querySelector('.drop-after, .drop-before')).toBeNull()
  })

  it('the first half puts it before', () => {
    rect(tabByName('a'), 0)
    const data = dt()
    dnd(tabByName('c'), 'dragstart', data)
    dnd(tabByName('a'), 'dragover', data, 10)
    expect(tabByName('a').classList.contains('drop-before')).toBe(true)
    dnd(tabByName('a'), 'drop', data, 10)
    expect(tabNames()).toEqual(['c', 'a', 'b'])
  })

  it('the active tab follows its key when reordered', () => {
    rect(tabByName('a'), 0)
    const data = dt()
    expect(activeName()).toBe('c')
    dnd(tabByName('c'), 'dragstart', data)
    dnd(tabByName('a'), 'drop', data, 5)
    expect(tabNames()).toEqual(['c', 'a', 'b'])
    expect(activeName()).toBe('c')
  })

  it('dropping on the empty strip area moves the tab to the end', () => {
    const data = dt()
    dnd(tabByName('a'), 'dragstart', data)
    dnd(bar(), 'drop', data)
    expect(tabNames()).toEqual(['b', 'c', 'a'])
  })

  it('hides the indicator for no-op positions (right where it already is), shows it for real moves', () => {
    const data = dt()
    rect(tabByName('b'), 100)
    dnd(tabByName('a'), 'dragstart', data)
    dnd(tabByName('b'), 'dragover', data, 120) // before b == a's current slot
    expect(tabByName('b').classList.contains('drop-before')).toBe(false)
    dnd(tabByName('b'), 'dragover', data, 190) // after b: a real move
    expect(tabByName('b').classList.contains('drop-after')).toBe(true)
  })

  it('dropping a tab on itself changes nothing', () => {
    const data = dt()
    rect(tabByName('b'), 100)
    dnd(tabByName('b'), 'dragstart', data)
    dnd(tabByName('b'), 'drop', data, 120)
    expect(tabNames()).toEqual(['a', 'b', 'c'])
  })

  it('drags that are not tab drags (e.g. from the Explorer) are ignored', () => {
    const foreign = dt({ 'text/plain': 'x' })
    const over = dnd(bar(), 'dragover', foreign)
    expect(over.defaultPrevented).toBe(false)
    dnd(bar(), 'drop', foreign)
    expect(tabNames()).toEqual(['a', 'b', 'c'])
  })

  it('dragend clears the drag state; leaving the strip clears the indicator', () => {
    rect(tabByName('c'), 200)
    const data = dt()
    dnd(tabByName('a'), 'dragstart', data)
    dnd(tabByName('c'), 'dragover', data, 290)
    expect(document.querySelector('.drop-after')).not.toBeNull()
    dnd(bar(), 'dragleave', null, 0, { relatedTarget: document.body })
    expect(document.querySelector('.drop-after')).toBeNull()
    dnd(tabByName('a'), 'dragend', null)
    expect(document.querySelector('.dragging')).toBeNull()
  })

  it('dragging near the strip edges auto-scrolls it', () => {
    vi.spyOn(bar(), 'getBoundingClientRect').mockReturnValue({ left: 0, right: 500, top: 0, bottom: 30, width: 500, height: 30, x: 0, y: 0, toJSON() {} })
    let left = 100
    Object.defineProperty(bar(), 'scrollLeft', { get: () => left, set: (v: number) => void (left = v), configurable: true })
    const data = dt({ [MIME]: 'x' })
    dnd(bar(), 'dragover', data, 10)
    expect(left).toBe(86)
    dnd(bar(), 'dragover', data, 495)
    expect(left).toBe(100)
    dnd(bar(), 'dragover', data, 250)
    expect(left).toBe(100)
  })
})

describe('App: keyboard tab switching & moving', () => {
  beforeEach(async () => {
    await mount()
    for (const n of ['a', 'b', 'c']) openTable(tref(n))
  })

  it('Ctrl+Tab cycles forward with wrap; Ctrl+Shift+Tab backward; the default focus move is prevented', () => {
    fireEvent.click(tabByName('a'))
    let ev = press({ key: 'Tab', ctrlKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(activeName()).toBe('b')
    act(() => void vi.advanceTimersByTime(200))
    press({ key: 'Tab', ctrlKey: true })
    expect(activeName()).toBe('c')
    act(() => void vi.advanceTimersByTime(200))
    press({ key: 'Tab', ctrlKey: true })
    expect(activeName()).toBe('a')
    act(() => void vi.advanceTimersByTime(200))
    ev = press({ key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(activeName()).toBe('c')
  })

  it('the Window-menu accelerators (IPC) switch tabs; a twin keystroke inside 150ms is dropped', () => {
    fireEvent.click(tabByName('a'))
    act(() => api._next.forEach((f) => f()))
    press({ key: 'Tab', ctrlKey: true })
    expect(activeName()).toBe('b')
    act(() => void vi.advanceTimersByTime(200))
    act(() => api._prev.forEach((f) => f()))
    expect(activeName()).toBe('a')
  })

  it('plain Tab, Cmd+Tab and Alt+Ctrl+Tab are left alone; modals / dialogs block cycling', () => {
    fireEvent.click(tabByName('a'))
    press({ key: 'Tab' })
    press({ key: 'Tab', metaKey: true })
    press({ key: 'Tab', ctrlKey: true, altKey: true })
    expect(activeName()).toBe('a')
    const m = document.createElement('div')
    m.className = 'cd-bg'
    document.body.appendChild(m)
    const ev = press({ key: 'Tab', ctrlKey: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(activeName()).toBe('a')
    m.remove()
  })

  it('skips tabs that are animating out', () => {
    fireEvent.click(tabByName('a'))
    fireEvent.click(tabByName('b').querySelector('.x')!) // b closing
    press({ key: 'Tab', ctrlKey: true })
    expect(activeName()).toBe('c')
  })

  it('focus moves into the new tab pane\'s grid/editor after cycling', () => {
    const pane = document.querySelector('[data-pane="' + key(tref('b')) + '"]')!
    const grid = document.createElement('div')
    grid.className = 'gridwrap'
    grid.tabIndex = 0
    pane.appendChild(grid)
    fireEvent.click(tabByName('a'))
    press({ key: 'Tab', ctrlKey: true })
    expect(document.activeElement).toBe(grid)
  })

  it('Ctrl+Shift+PageUp/PageDown moves the active tab', () => {
    fireEvent.click(tabByName('b'))
    press({ key: 'PageUp', ctrlKey: true, shiftKey: true })
    expect(tabNames()).toEqual(['b', 'a', 'c'])
    press({ key: 'PageDown', ctrlKey: true, shiftKey: true })
    press({ key: 'PageDown', ctrlKey: true, shiftKey: true })
    expect(tabNames()).toEqual(['a', 'c', 'b'])
    press({ key: 'PageDown', ctrlKey: true, shiftKey: true }) // at the edge: no change
    expect(tabNames()).toEqual(['a', 'c', 'b'])
    expect(activeName()).toBe('b')
  })

  it('Cmd/Ctrl+Shift+[ and ] switch to the previous / next tab', () => {
    fireEvent.click(tabByName('a'))
    press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })
    expect(activeName()).toBe('b')
    press({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true })
    press({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true })
    expect(activeName()).toBe('c') // wraps
  })

  it('those shortcuts are ignored while a modal is open', () => {
    fireEvent.click(tabByName('a'))
    const m = document.createElement('div')
    m.className = 'modal-bg'
    document.body.appendChild(m)
    press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })
    press({ key: 'PageDown', ctrlKey: true, shiftKey: true })
    expect(activeName()).toBe('a')
    expect(tabNames()).toEqual(['a', 'b', 'c'])
    m.remove()
  })
})

describe('App: sidebar', () => {
  it('Shift+Esc focuses the Explorer (sidebar stays visible); pressed again it hands the focus back to the editor pane', async () => {
    await mount()
    openTable(tref('users'))
    const grid = document.createElement('div')
    grid.className = 'gridwrap'
    grid.tabIndex = 0
    document.querySelector('.pane[data-pane="t|ds1|app|public|users"]')!.appendChild(grid)
    grid.focus()
    const side = document.querySelector('.side') as HTMLElement
    const ev = press({ key: 'Escape', shiftKey: true }, grid)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('explorer'))
    expect(side.style.display).toBe('')
    press({ key: 'Escape', shiftKey: true }, document.activeElement!)
    expect(document.activeElement).toBe(grid)
    expect(side.style.display).toBe('') // it was visible before: stays visible
  })

  it('Shift+Esc reveals a hidden sidebar (Explorer stays mounted), focuses it; the next one hides it again and returns the focus', async () => {
    h.session.sidebarHidden = true
    await mount()
    openTable(tref('users'))
    const grid = document.createElement('div')
    grid.className = 'gridwrap'
    grid.tabIndex = 0
    document.querySelector('.pane[data-pane="t|ds1|app|public|users"]')!.appendChild(grid)
    grid.focus()
    const side = document.querySelector('.side') as HTMLElement
    expect(side.style.display).toBe('none')
    press({ key: 'Escape', shiftKey: true }, grid)
    expect(side.style.display).toBe('')
    expect(document.querySelector('.splitter')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('explorer'))
    expect(h.patches.at(-1)).toMatchObject({ sidebarHidden: false })
    press({ key: 'Escape', shiftKey: true }, document.activeElement!)
    expect(side.style.display).toBe('none')
    expect(document.querySelector('.splitter')).toBeNull()
    expect(document.activeElement).toBe(grid)
    expect(h.mounts.explorer).toBe(1)
  })

  it('returning from the tree falls back to the active tab when the remembered element is gone or in a hidden tab', async () => {
    await mount()
    openTable(tref('users'))
    const mk = (tab: string): HTMLElement => {
      const g = document.createElement('div')
      g.className = 'gridwrap'
      g.tabIndex = 0
      document.querySelector(`.pane[data-pane="t|ds1|app|public|${tab}"]`)!.appendChild(g)
      return g
    }
    const g1 = mk('users')
    g1.focus()
    press({ key: 'Escape', shiftKey: true }, g1)
    openTable(tref('orders')) // e.g. Enter in the tree: another tab is now active, users' pane is hidden
    const g2 = mk('orders')
    press({ key: 'Escape', shiftKey: true }, document.activeElement!)
    expect(document.activeElement).toBe(g2)
  })

  it('Shift+Esc is ignored while a tree name is being edited (the blur would commit it)', async () => {
    await mount()
    const input = document.createElement('input')
    input.className = 'tree-input'
    document.querySelector('.explorer')!.appendChild(input)
    input.focus()
    const ev = press({ key: 'Escape', shiftKey: true }, input)
    expect(ev.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  it('plain Escape, Ctrl/Cmd/Alt+Shift+Esc do nothing', async () => {
    await mount()
    press({ key: 'Escape' })
    press({ key: 'Escape', shiftKey: true, ctrlKey: true })
    press({ key: 'Escape', shiftKey: true, metaKey: true })
    press({ key: 'Escape', shiftKey: true, altKey: true })
    expect((document.querySelector('.side') as HTMLElement).style.display).toBe('')
  })

  it('is ignored while a modal dialog is open', async () => {
    await mount()
    const m = document.createElement('div')
    m.className = 'modal-bg'
    document.body.appendChild(m)
    press({ key: 'Escape', shiftKey: true })
    expect((document.querySelector('.side') as HTMLElement).style.display).toBe('')
    m.remove()
  })

  it('stops the event in the capture phase so other Escape handlers do not react', async () => {
    await mount()
    const other = vi.fn()
    const el = document.createElement('input')
    document.body.appendChild(el)
    el.addEventListener('keydown', other)
    press({ key: 'Escape', shiftKey: true }, el)
    expect(other).not.toHaveBeenCalled()
    el.remove()
  })

  it('width starts from the session and the splitter drag clamps to 180..700 and persists', async () => {
    h.session.width = 350
    await mount()
    const side = document.querySelector('.side') as HTMLElement
    expect(side.style.width).toBe('350px')
    fireEvent.mouseDown(document.querySelector('.splitter')!)
    fireEvent.mouseMove(window, { clientX: 500 })
    expect(side.style.width).toBe('500px')
    fireEvent.mouseMove(window, { clientX: 5000 })
    expect(side.style.width).toBe('700px')
    fireEvent.mouseMove(window, { clientX: 10 })
    expect(side.style.width).toBe('180px')
    fireEvent.mouseUp(window)
    fireEvent.mouseMove(window, { clientX: 400 })
    expect(side.style.width).toBe('180px') // listeners were removed
    expect(h.patches.some((p) => p.width === 180)).toBe(true)
  })

  it('starts hidden when the session says so, and persists the toggle', async () => {
    h.session.sidebarHidden = true
    await mount()
    expect((document.querySelector('.side') as HTMLElement).style.display).toBe('none')
    press({ key: 'Escape', shiftKey: true })
    expect(h.patches.at(-1)).toMatchObject({ sidebarHidden: false })
  })
})

describe('App: data source dialog & Explorer reload', () => {
  it('onEdit opens the dialog (new + edit); closing without changes keeps reloadKey; saving bumps it', async () => {
    await mount()
    expect(screen.getByTestId('explorer').dataset.reload).toBe('0')
    act(() => h.explorer!.onEdit(null, 'folder1'))
    expect(screen.getByText('Data Source: PostgreSQL')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Data Source: PostgreSQL')).toBeNull()
    expect(screen.getByTestId('explorer').dataset.reload).toBe('0')
    act(() => h.explorer!.onEdit(src('ds1', 'Local'), null))
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Local')
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'OK' })))
    await act(async () => void (await Promise.resolve()))
    expect(api.saveSource).toHaveBeenCalled()
    expect(screen.queryByText('Data Source: PostgreSQL')).toBeNull()
    expect(screen.getByTestId('explorer').dataset.reload).toBe('1')
  })

  it('a new data source dialog inherits the folder the Explorer passed', async () => {
    await mount()
    act(() => h.explorer!.onEdit(null, 'fld'))
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'OK' })))
    expect(api.saveSource.mock.calls[0][0]).toMatchObject({ folderId: 'fld' })
  })
})

describe('App: session restore & persistence', () => {
  const savedTable = (table: string, dsId = 'ds1'): unknown => ({ type: 'table', t: tref(table, { dsId, dsName: 'old name' }) })
  const savedConsole = (id: string, dsId = 'ds1'): unknown => ({ type: 'console', c: { id, title: 'public console', dsId, dsName: 'old', database: 'app', schema: 'public' } })

  it('nothing is restored (or saved) before the data sources are known', () => {
    h.session.tabs = [savedTable('a')]
    render(<App />)
    expect(tabEls()).toHaveLength(0)
    expect(h.saveTabs).toHaveLength(0)
  })

  it('restores tabs in order once sources arrive, refreshes data source names, restores console SQL, and activates the saved tab', async () => {
    h.session.tabs = [savedTable('a'), savedConsole('c1'), savedTable('b')]
    h.session.consoleSql = { c1: 'select 42' }
    h.session.active = key(tref('a'))
    await mount([src('ds1', 'Renamed')])
    expect(tabNames()).toEqual(['a', 'public console', 'b'])
    expect(activeName()).toBe('a')
    expect(tabByName('a').dataset.tip).toBe('Renamed / app.public')
    expect(screen.getByTestId('console-c1').dataset.sql).toBe('select 42')
  })

  it('drops tabs of deleted data sources; falls back to the last tab when the saved active one is gone', async () => {
    h.session.tabs = [savedTable('a', 'gone'), savedTable('b'), savedTable('c'), savedConsole('c9', 'gone')]
    h.session.active = key(tref('a', { dsId: 'gone' }))
    await mount([src('ds1')])
    expect(tabNames()).toEqual(['b', 'c'])
    expect(activeName()).toBe('c')
  })

  it('no saved tabs at all -> placeholder, nothing active', async () => {
    await mount()
    expect(activeName()).toBeUndefined()
  })

  it('restoring happens only once (a later source reload does not re-add closed tabs)', async () => {
    h.session.tabs = [savedTable('a'), savedTable('b')]
    await mount([src('ds1')])
    closeTab('a')
    act(() => h.explorer!.onSources([src('ds1')]))
    flushAnim()
    expect(tabNames()).toEqual(['b'])
  })

  it('tabs opened before the restore callback are kept after the restored ones, without duplicates', async () => {
    h.session.tabs = [savedTable('a')]
    render(<App />)
    openTable(tref('a'))
    openTable(tref('z'))
    act(() => h.explorer!.onSources([src('ds1')]))
    flushAnim()
    expect(tabNames()).toEqual(['a', 'z'])
  })

  it('persists the tab strip, the active tab and layout through saveTabs/patchSession after every change', async () => {
    await mount()
    openTable(tref('a')); openTable(tref('b'))
    const [tabs, active] = h.saveTabs.at(-1) as [{ t: { table: string } }[], string]
    expect(tabs.map((t) => t.t.table)).toEqual(['a', 'b'])
    expect(active).toBe(key(tref('b')))
    closeTab('b')
    const [tabs2, active2] = h.saveTabs.at(-1) as [{ t: { table: string } }[], string]
    expect(tabs2.map((t) => t.t.table)).toEqual(['a'])
    expect(active2).toBe(key(tref('a')))
    expect(h.patches.at(-1)).toMatchObject({ width: 300, sidebarHidden: false, consoleN: 0 })
  })

  it('restored tabs do not animate in (no tab-new class); user-opened ones do', async () => {
    h.session.tabs = [savedTable('a')]
    await mount()
    expect(tabByName('a').classList.contains('tab-new')).toBe(false)
    openTable(tref('b'))
    expect(tabByName('b').classList.contains('tab-new')).toBe(true)
    act(() => void vi.advanceTimersByTime(400))
    expect(tabByName('b').classList.contains('tab-new')).toBe(false)
  })

  it('a restored non-active table tab mounts with active=false (lazy load)', async () => {
    h.session.tabs = [savedTable('a'), savedTable('b')]
    h.session.active = key(tref('a'))
    await mount()
    expect(screen.getByTestId('tv-b').dataset.active).toBe('false')
    expect(screen.getByTestId('tv-a').dataset.active).toBe('true')
  })
})

describe('App: settings', () => {
  const savedTable = (table: string): unknown => ({ type: 'table', t: tref(table) })
  const dialog = (): HTMLElement | null => document.querySelector('.settings-modal')

  afterEach(() => void resetSettings())

  it('the gear button in the tab strip opens the settings dialog; Done closes it', async () => {
    await mount()
    expect(dialog()).toBeNull()
    fireEvent.click(document.querySelector('.settings-btn')!)
    expect(dialog()).not.toBeNull()
    fireEvent.click(screen.getByText('Done'))
    expect(dialog()).toBeNull()
  })

  it('the application menu (Cmd/Ctrl+,) opens the dialog, and the subscription is removed on unmount', async () => {
    await mount()
    expect(api._settings).toHaveLength(1)
    act(() => api._settings.forEach((f) => f()))
    expect(dialog()).not.toBeNull()
    cleanup()
    expect(api._settings).toHaveLength(0)
  })

  it('the gear is the only control at the right of the tab strip (zoom moved into Settings)', async () => {
    await mount()
    expect(document.querySelector('.tabtools .settings-btn')).not.toBeNull()
    expect(document.querySelector('.zoom-in, .zoom-out, .zoom-pct')).toBeNull()
  })

  it('View > Increase / Decrease / Reset Font Size change the font sizes; unsubscribed on unmount', async () => {
    await mount()
    expect(api._fontSize).toHaveLength(1)
    act(() => api._fontSize.forEach((f) => f('in')))
    expect(getSettings()).toMatchObject({ uiSize: 14, monoSize: 13 })
    act(() => api._fontSize.forEach((f) => f('out')))
    act(() => api._fontSize.forEach((f) => f('out')))
    expect(getSettings()).toMatchObject({ uiSize: 12, monoSize: 11 })
    act(() => api._fontSize.forEach((f) => f('reset')))
    expect(getSettings()).toMatchObject({ uiSize: 13, monoSize: 12 })
    cleanup()
    expect(api._fontSize).toHaveLength(0)
  })

  it('"Reopen previous tabs on launch" off: saved tabs are not restored', async () => {
    updateSettings({ restoreTabs: false })
    h.session.tabs = [savedTable('a'), savedTable('b')]
    await mount()
    expect(tabEls()).toHaveLength(0)
    openTable(tref('c'))
    expect(tabNames()).toEqual(['c'])
  })

  it('"Reopen previous tabs on launch" on (default): saved tabs are restored', async () => {
    h.session.tabs = [savedTable('a'), savedTable('b')]
    await mount()
    expect(tabNames()).toEqual(['a', 'b'])
  })
})
