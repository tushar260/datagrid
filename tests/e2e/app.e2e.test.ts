/**
 * End-to-end smoke test of the INSTALLED app (/Applications/DataGrid.app). Run with `npm run test:e2e` (RUN_E2E=1).
 *
 * Safety: the app is started with a throw-away --user-data-dir (a fresh temp dir) and its own remote-debugging port, so the
 * real app data (data sources, session, window state) is never read or written, and a running real instance is unaffected.
 * It needs a local PostgreSQL (same defaults as the integration tests: current OS user, no password, localhost:5432, or
 * PG_TEST_URL). It creates its own scratch database `dgl_e2e_<random>` and ALWAYS drops it afterwards.
 * Nothing here builds or installs the app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { DataSource } from '../../src/shared'
import { closeAll, createDatabase, dropDatabase, runQuery } from '../../src/main/db'
import { Redis } from 'ioredis'
import { Cdp, freePort, sleep } from './cdp'
import { REDIS_SERVER_BIN, startRedis, type TestServer } from '../main/helpers/redisServer'

const APP = process.env.E2E_APP ?? '/Applications/DataGrid.app/Contents/MacOS/DataGrid'
const url = process.env.PG_TEST_URL ? new URL(process.env.PG_TEST_URL) : null
const base: DataSource = {
  id: 'e2e-base', name: 'e2e', host: url?.hostname || 'localhost', port: Number(url?.port) || 5432,
  user: decodeURIComponent(url?.username || '') || userInfo().username, password: decodeURIComponent(url?.password || ''),
  database: 'postgres', ssl: false
}
const DB = `dgl_e2e_${randomBytes(4).toString('hex')}`
const scratch: DataSource = { ...base, id: 'e2e-scratch', database: DB }

let userData = ''
let proc: ChildProcess | null = null
let cdp: Cdp
let dbCreated = false
const consoleErrors: string[] = []
const realErrors = (): string[] => consoleErrors

/** JS string literal for embedding in evaluated page code */
const js = (s: string): string => JSON.stringify(s)
/** DOM helpers evaluated in the page */
const rowOf = (suffix: string): string =>
  `Array.from(document.querySelectorAll('.explorer .tree-row[data-id]')).find(r => r.dataset.id.endsWith(${js(suffix)}))`
const tabs = (): Promise<string[]> =>
  cdp.eval(`Array.from(document.querySelectorAll('.tabbar [data-tabkey]')).map(t => t.querySelector('.tabtitle')?.textContent.trim())`)

async function launch(seed?: (dir: string) => void): Promise<void> {
  userData = mkdtempSync(join(tmpdir(), 'dgl-e2e-'))
  seed?.(userData)
  const port = await freePort(9355)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  proc = spawn(APP, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { stdio: 'ignore', env })
  let exited: number | null = null
  proc.once('exit', (c) => (exited = c ?? -1))
  cdp = await Cdp.connect(port, 40_000).catch((e) => {
    throw new Error(`${(e as Error).message}${exited !== null ? ` (app exited with code ${exited})` : ''}`)
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = (p as { exceptionDetails?: { text?: string; exception?: { description?: string } } }).exceptionDetails
    consoleErrors.push('exception: ' + (d?.exception?.description ?? d?.text))
  })
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const q = p as { type: string; args: { value?: unknown; description?: string }[] }
    if (q.type === 'error') consoleErrors.push('console.error: ' + q.args.map((a) => a.value ?? a.description).join(' '))
  })
  cdp.on('Log.entryAdded', (p) => {
    const e = (p as { entry: { level: string; text: string } }).entry
    if (e.level === 'error') consoleErrors.push('log: ' + e.text)
  })
  // reload so that errors during the page load are captured too
  await cdp.send('Page.reload')
  await cdp.waitFor(`!!document.querySelector('.app .explorer')`, 'the app window to render', 30_000)
}

async function stop(): Promise<void> {
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  const p = proc
  proc = null
  if (p && p.exitCode === null && p.signalCode === null) {
    const done = new Promise<void>((r) => p.once('exit', () => r()))
    p.kill('SIGTERM')
    await Promise.race([done, sleep(5000)])
    if (p.exitCode === null && p.signalCode === null) {
      p.kill('SIGKILL')
      await Promise.race([done, sleep(3000)])
    }
  }
}

const canRun = existsSync(APP)
vi.setConfig({ testTimeout: 45_000 })

describe.skipIf(!canRun)('E2E smoke (installed app, throw-away user data dir)', () => {
  beforeAll(async () => {
    await createDatabase(base, DB)
    dbCreated = true
    await runQuery(scratch, DB, 'public', 'create table e2e_items (id int primary key, name text)')
    await runQuery(scratch, DB, 'public', "insert into e2e_items values (1,'alpha'),(2,'beta'),(3,'gamma')")
    await runQuery(scratch, DB, 'public', 'create table e2e_other (id int primary key, note text)')
    await runQuery(scratch, DB, 'public', "insert into e2e_other values (10,'hello')")
    await launch()
  }, 90_000)

  afterAll(async () => {
    await stop()
    if (userData) rmSync(userData, { recursive: true, force: true })
    if (dbCreated) {
      await closeAll(scratch.id)
      await closeAll(base.id)
      await dropDatabase(base, DB)
    }
    await closeAll(base.id)
  }, 60_000)

  it('the window loads, shows the empty explorer and logs no errors', async () => {
    expect(await cdp.eval(`document.title.length >= 0 && !!document.querySelector('.tabbar, .content')`)).toBe(true)
    expect(await cdp.eval(`document.querySelector('.explorer .tree')?.textContent`)).toContain('No data sources')
    expect(realErrors()).toEqual([])
  })

  it('creates a data source for the local Postgres through the UI dialog (Test Connection works)', async () => {
    await cdp.eval(`document.querySelector('.explorer-head [data-tip="New data source"]').click()`)
    await cdp.waitFor(`!!document.querySelector('.modal-bg .modal')`, 'the data source dialog')
    const fill = (label: string, value: string): Promise<unknown> =>
      cdp.eval(`(() => {
        const l = Array.from(document.querySelectorAll('.modal label')).find(x => x.firstChild && x.firstChild.textContent.trim() === ${js(label)})
        const i = l.querySelector('input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${js(value)})
        i.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
    await fill('Name', 'E2E PG')
    await fill('Host', base.host)
    await fill('Port', String(base.port))
    await fill('User', base.user)
    await fill('Password', base.password)
    await fill('Database', DB)
    await cdp.eval(`Array.from(document.querySelectorAll('.modal button')).find(b => b.textContent === 'Test Connection').click()`)
    await cdp.waitFor(`document.querySelector('.modal')?.textContent.includes('Succeeded.')`, 'Test Connection to succeed')
    await cdp.eval(`Array.from(document.querySelectorAll('.modal button')).find(b => b.textContent === 'OK').click()`)
    await cdp.waitFor(`!document.querySelector('.modal-bg')`, 'the dialog to close')
    await cdp.waitFor(`document.querySelector('.explorer .tree-row .tlabel')?.textContent === 'E2E PG'`, 'the new data source row')
  })

  it('the tree expands: data source → database → schema → tables', async () => {
    await cdp.eval(`${rowOf('')}.querySelector('.arrow').click()`) // first row = the data source
    await cdp.waitFor(`!!(${rowOf('/' + DB)})`, 'the scratch database in the tree')
    await cdp.waitFor(`!!(${rowOf('/' + DB)}).querySelector('.arrow')`, 'the database row to be expandable')
    await cdp.eval(`${rowOf('/' + DB)}.querySelector('.arrow').click()`)
    await cdp.waitFor(`!!(${rowOf('/public')})`, 'the public schema')
    await cdp.waitFor(`!!(${rowOf('/public')}).querySelector('.arrow')`, 'the schema row to be expandable')
    await cdp.eval(`${rowOf('/public')}.querySelector('.arrow').click()`)
    await cdp.waitFor(`!!(${rowOf('/public/e2e_items')}) && !!(${rowOf('/public/e2e_other')})`, 'both tables')
    // the schema count pill
    expect(await cdp.waitFor(`(${rowOf('/public')}).querySelector('.badge')?.textContent`, 'the schema count pill')).toBe('2')
  })

  it('opening a table shows its rows', async () => {
    await cdp.eval(`${rowOf('/public/e2e_items')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await cdp.waitFor(`document.querySelectorAll('.gridwrap tbody tr').length === 3`, 'three data rows')
    const text = await cdp.eval<string>(`document.querySelector('.gridwrap').textContent`)
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).toContain('gamma')
    expect(await tabs()).toEqual(['e2e_items'])
  })

  it('opening a second table adds a tab; tabs can be reordered by dragging', async () => {
    await cdp.eval(`${rowOf('/public/e2e_other')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await cdp.waitFor(`Array.from(document.querySelectorAll('.gridwrap')).some(g => g.textContent.includes('hello'))`, 'the second table rows')
    expect(await tabs()).toEqual(['e2e_items', 'e2e_other'])
    // synthetic HTML5 drag: first tab dropped on the right half of the second one
    await cdp.eval(`(() => {
      const [a, b] = document.querySelectorAll('.tabbar [data-tabkey]')
      const dt = new DataTransfer()
      const fire = (el, type, x) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x }))
      const r = b.getBoundingClientRect()
      fire(a, 'dragstart', 0)
      fire(b, 'dragover', r.right - 2)
      fire(b, 'drop', r.right - 2)
      fire(a, 'dragend', 0)
      return true
    })()`)
    await cdp.waitFor(`document.querySelector('.tabbar [data-tabkey] .tabtitle')?.textContent.trim() === 'e2e_other'`, 'the tabs to swap')
    expect(await tabs()).toEqual(['e2e_other', 'e2e_items'])
  })

  it('Cmd+W closes the active tab', async () => {
    const before = (await tabs()).length
    await cdp.press('w', 'KeyW', 87, 4)
    await cdp.waitFor(`document.querySelectorAll('.tabbar [data-tabkey]').length === ${before - 1}`, 'a tab to close')
    expect((await tabs()).length).toBe(before - 1)
  })

  it('Shift+Esc moves the keyboard focus from the grid to the Explorer tree (arrows move, Enter opens), and back', async () => {
    const grid = `Array.from(document.querySelectorAll('.content > .pane')).find(p => p.style.display !== 'none').querySelector('.gridwrap')`
    const selectedId = (): Promise<string | undefined> => cdp.eval(`document.querySelector('.explorer .tree-row.sel')?.dataset.id`)
    expect(await cdp.eval(`getComputedStyle(document.querySelector('.side')).display === 'none'`)).toBe(false)
    // (the earlier steps only fired synthetic dblclicks / arrow clicks, so "public" is still the selected row; a real
    // double-click also clicks the table's row first: select it the way the user does, then move to the grid)
    await cdp.eval(`${rowOf('/public/e2e_items')}.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await cdp.eval(`${grid}.focus()`)
    expect(await cdp.eval(`document.activeElement === ${grid}`)).toBe(true)
    await cdp.press('Escape', 'Escape', 27, 8)
    await cdp.waitFor(`document.activeElement === document.querySelector('.explorer')`, 'the tree to take the focus')
    // the open table's row (or its nearest visible ancestor) is the highlighted one
    const first = await cdp.waitFor<string>(`document.querySelector('.explorer .tree-row.sel')?.dataset.id`, 'a selected row')
    expect(first).toMatch(/public\/e2e_/)
    // arrows move between rows
    await cdp.press('ArrowUp', 'ArrowUp', 38)
    await cdp.waitFor(`document.querySelector('.explorer .tree-row.sel')?.dataset.id !== ${js(first)}`, 'the selection to move up')
    await cdp.press('ArrowDown', 'ArrowDown', 40)
    await cdp.waitFor(`document.querySelector('.explorer .tree-row.sel')?.dataset.id === ${js(first)}`, 'the selection to move back down')
    // Enter opens the focused table (the already open one stays a single tab)
    const before = (await tabs()).length
    await cdp.press('Enter', 'Enter', 13)
    await cdp.waitFor(`document.querySelectorAll('.tabbar [data-tabkey]').length >= ${before}`, 'the table tab')
    expect(await selectedId()).toBe(first)
    // Shift+Esc again: back to the grid of the active tab
    await cdp.press('Escape', 'Escape', 27, 8)
    await cdp.waitFor(`document.activeElement === ${grid}`, 'the focus to return to the grid')
  })

  it('the gear sits at the top right and opens Settings; display size and font size live there', async () => {
    const pct = `document.querySelector('.settings-modal [aria-label="Display size"] .set-value').textContent`
    const click = (label: string): Promise<unknown> => cdp.eval(`document.querySelector('.settings-modal [aria-label="${label}"]').click()`)
    // Settings is split into sections: switch to the one that holds the setting (the dialog remembers the last one)
    const section = (name: string): Promise<unknown> => cdp.eval(`[...document.querySelectorAll('.settings-modal [role=tab]')].find((t) => t.textContent === ${JSON.stringify(name)}).click()`)
    // pinned at the far right of the top bar, after the (scrolling) tab strip
    expect(await cdp.eval(`(() => { const z = document.querySelector('.tabtools').getBoundingClientRect(); const t = document.querySelector('.tabbar').getBoundingClientRect(); return z.left >= t.right - 1 && Math.abs(z.right - innerWidth) < 2 })()`)).toBe(true)
    expect(await cdp.eval(`document.querySelector('.settings-btn').dataset.tip`)).toBe('Settings')
    await cdp.eval(`document.querySelector('.settings-btn').click()`)
    await cdp.waitFor(`!!document.querySelector('.settings-modal')`, 'the settings dialog')
    try {
      await section('Appearance')
      expect(await cdp.eval(pct)).toBe('100%')
      await click('Zoom in')
      await cdp.waitFor(`${pct} === '110%'`, 'the display size to show 110%')
      expect(JSON.parse(readFileSync(join(userData, 'zoom.json'), 'utf8'))).toEqual({ percent: 110 }) // temp user-data-dir, not the real one
      await click('Reset display size')
      await cdp.waitFor(`${pct} === '100%'`, 'the display size to reset to 100%')
      // font size: both sizes move together and are applied to the page
      await click('Increase font size')
      await cdp.waitFor(`getComputedStyle(document.body).fontSize === '14px'`, 'the UI font size to grow')
      await click('Reset font size')
      await cdp.waitFor(`getComputedStyle(document.body).fontSize === '13px'`, 'the UI font size to reset')
      // interface font: macOS stack is applied (Fonts section)
      await section('Fonts')
      await cdp.eval(`(() => { const s = document.getElementById('set-ui-font'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'macos'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      await cdp.waitFor(`getComputedStyle(document.body).fontFamily.includes('-apple-system')`, 'the macOS font stack')
    } finally {
      // never leave the throw-away app zoomed / restyled (a failed assertion above must not leak into the next tests)
      await section('Appearance')
      if ((await cdp.eval(pct)) !== '100%') await click('Reset display size')
      await cdp.eval(`document.querySelector('.settings-modal .set-actions button').click()`) // Reset to defaults
      await cdp.eval(`[...document.querySelectorAll('.settings-modal .set-actions button')].pop().click()`) // Done
    }
    await cdp.waitFor(`!document.querySelector('.settings-modal')`, 'the settings dialog to close (exit animation)')
  })

  it('⌘O opens "Go to database or table" from anywhere and Esc closes it', async () => {
    await cdp.press('o', 'KeyO', 79, 4)
    await cdp.waitFor(`!!document.querySelector('.modal.goto')`, 'the Go to modal')
    expect(await cdp.eval(`document.activeElement === document.querySelector('.modal.goto input')`)).toBe(true)
    expect(await cdp.eval(`document.querySelector('.modal.goto input').placeholder`)).toBe('Search databases and tables')
    expect(await cdp.eval(`document.querySelector('.modal.goto .goto-tab').textContent`)).toBe('Database')
    await cdp.press('Escape', 'Escape', 27)
    await cdp.waitFor(`!document.querySelector('.modal.goto')`, 'the Go to modal to close')
  })

  it('the data source dialog switches to DynamoDB: auth-mode fields toggle and Test Connection to a dead endpoint fails cleanly', async () => {
    const modal = `document.querySelector('.modal')`
    const labels = (): Promise<string[]> =>
      cdp.eval(`Array.from(document.querySelectorAll('.modal label')).map(l => (l.firstChild?.textContent ?? '').trim()).filter(Boolean)`)
    const setInput = (label: string, value: string): Promise<unknown> =>
      cdp.eval(`(() => {
        const l = Array.from(document.querySelectorAll('.modal label')).find(x => x.firstChild && x.firstChild.textContent.trim() === ${js(label)})
        const i = l.querySelector('input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${js(value)})
        i.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
    const pickAuth = (text: string): Promise<unknown> =>
      cdp.eval(`Array.from(document.querySelectorAll('.modal .auth-modes label')).find(l => l.textContent.includes(${js(text)})).querySelector('input').click()`)
    const rowsBefore = await cdp.eval<number>(`document.querySelectorAll('.explorer .tree-row[data-id]').length`)

    await cdp.eval(`document.querySelector('.explorer-head [data-tip="New data source"]').click()`)
    await cdp.waitFor(`!!${modal}`, 'the data source dialog')
    expect(await labels()).toContain('Host') // PostgreSQL form first
    await cdp.eval(`(() => { const s = document.querySelector('.modal select.ds-type'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'dynamodb'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await cdp.waitFor(`!!document.querySelector('.modal .auth-modes')`, 'the DynamoDB form')
    let l = await labels()
    expect(l).not.toContain('Host')
    expect(l).toEqual(expect.arrayContaining(['Name', 'Region']))
    // default: no key or profile fields
    expect(l).not.toContain('Profile')
    expect(l).not.toContain('Secret access key')
    expect(await cdp.eval(`${modal}.textContent`)).toContain('AWS CLI')
    // named profile
    await pickAuth('Named profile')
    await cdp.waitFor(`Array.from(document.querySelectorAll('.modal label')).some(x => x.firstChild?.textContent.trim() === 'Profile')`, 'the Profile field')
    l = await labels()
    expect(l).not.toContain('Secret access key')
    // access key, with Show / Hide
    await pickAuth('Access key')
    await cdp.waitFor(`Array.from(document.querySelectorAll('.modal label')).some(x => x.firstChild?.textContent.trim() === 'Secret access key')`, 'the key fields')
    l = await labels()
    expect(l).toEqual(expect.arrayContaining(['Access key ID', 'Secret access key']))
    expect(l).not.toContain('Profile')
    const secretType = (): Promise<string> => cdp.eval(`Array.from(document.querySelectorAll('.modal label')).find(x => x.firstChild?.textContent.trim() === 'Secret access key').querySelector('input').type`)
    expect(await secretType()).toBe('password')
    await cdp.eval(`document.querySelector('.modal .secret-toggle').click()`)
    await cdp.waitFor(`document.querySelector('.modal .secret-toggle').textContent === 'Hide'`, 'Show to become Hide')
    expect(await secretType()).toBe('text')
    // back to default hides them again
    await pickAuth('Default')
    await cdp.waitFor(`!Array.from(document.querySelectorAll('.modal label')).some(x => x.firstChild?.textContent.trim() === 'Secret access key')`, 'the key fields to disappear')

    // a dead local endpoint with obviously fake keys: nothing leaves this machine
    await pickAuth('Access key')
    await cdp.waitFor(`Array.from(document.querySelectorAll('.modal label')).some(x => x.firstChild?.textContent.trim() === 'Secret access key')`, 'the key fields')
    await setInput('Access key ID', 'AKIAE2EFAKEFAKEFAKE0')
    await setInput('Secret access key', 'fake-secret-for-e2e-only')
    await setInput('Region', 'us-east-1')
    await cdp.eval(`(() => { const d = document.querySelector('.modal details.adv'); d.open = true; return true })()`)
    await setInput('Endpoint URL', 'http://127.0.0.1:1')
    await cdp.eval(`Array.from(document.querySelectorAll('.modal button')).find(b => b.textContent === 'Test Connection').click()`)
    await cdp.waitFor(`!!document.querySelector('.modal .msg.bad')`, 'Test Connection to report an error', 40_000)
    const err = await cdp.eval<string>(`document.querySelector('.modal .msg.bad').textContent`)
    expect(err.length).toBeGreaterThan(0)
    expect(err).not.toContain('fake-secret-for-e2e-only')
    expect(err).not.toMatch(/Error invoking remote method/)
    // the dialog (and the app) are still alive
    expect(await cdp.eval(`!!${modal}`)).toBe(true)
    await cdp.eval(`Array.from(document.querySelectorAll('.modal button')).find(b => b.textContent === 'Cancel').click()`)
    await cdp.waitFor(`!document.querySelector('.modal-bg')`, 'the dialog to close')
    // nothing was saved
    expect(await cdp.eval<number>(`document.querySelectorAll('.explorer .tree-row[data-id]').length`)).toBe(rowsBefore)
  })

  it('the installed app bundles the AWS SDK (no "Cannot find module" in the app log)', () => {
    const log = join(userData, 'datagrid.log')
    if (existsSync(log)) expect(readFileSync(log, 'utf8')).not.toMatch(/Cannot find module/)
  })

  it('the app logged no errors the whole time (console, uncaught exceptions, app log)', async () => {
    expect(realErrors()).toEqual([])
    const log = join(userData, 'datagrid.log')
    if (existsSync(log)) expect(readFileSync(log, 'utf8')).not.toMatch(/uncaughtException|unhandledRejection/)
  })

  it('the throw-away data dir was used (the real app data was not touched)', () => {
    expect(existsSync(join(userData, 'datasources.json'))).toBe(true)
    expect(userData.startsWith(tmpdir())).toBe(true)
  })
})

/**
 * Redis key tab + key browser in the REAL app against the test's OWN throw-away redis-server (random high port, never 6379,
 * nothing persisted), with a data source written into the throw-away profile: the Save / Revert / Format JSON buttons sit in
 * the header bar above the editor, and Cmd+R reloads the open key wherever the focus is.
 */
describe.skipIf(!canRun || !existsSync(REDIS_SERVER_BIN))('E2E Redis key view (installed app, own redis-server)', () => {
  let server: TestServer
  let admin: Redis
  const q = (id: string): string => `Array.from(document.querySelectorAll('.explorer .tree-row[data-id]')).find(r => r.dataset.id === ${js(id)})`
  const ta = (): Promise<string | null> => cdp.eval(`document.querySelector('.pane[style*="flex"] .rk-text')?.value ?? null`)
  const expand = async (id: string): Promise<void> => {
    await cdp.eval(`${q(id)}.querySelector('.arrow').click()`)
    await cdp.waitFor(`!!(${q(id)})?.querySelector('.arrow.open, .arrow')`, 'row ' + id)
    await sleep(900)
  }
  const click = async (expr: string, count = 1): Promise<void> => {
    const [x, y] = await cdp.eval<number[]>(`(() => { const b = (${expr}).getBoundingClientRect(); return [b.left + Math.min(40, b.width / 2), b.top + b.height / 2] })()`)
    for (let i = 1; i <= count; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i })
    }
  }
  const reloaded = (want: string, what: string): Promise<unknown> => cdp.waitFor(`document.querySelector('.pane[style*="flex"] .rk-text')?.value === ${js(want)}`, what, 6000)

  beforeAll(async () => {
    await stop()
    if (userData) rmSync(userData, { recursive: true, force: true })
    consoleErrors.length = 0
    server = await startRedis()
    expect(server.port).not.toBe(6379)
    admin = new Redis({ host: '127.0.0.1', port: server.port })
    await admin.set('json:big', JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'item ' + i })) }))
    await admin.set('plain', 'v0')
    await admin.hset('h:one', { a: '1', b: '2' })
    await admin.rpush('l:one', 'x', 'y')
    await launch((dir) =>
      writeFileSync(join(dir, 'datasources.json'), JSON.stringify([{
        id: 'r1', name: 'E2E Redis', kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false,
        redis: { host: '127.0.0.1', port: server.port, db: 0, tls: false }
      }]))
    )
  }, 90_000)

  afterAll(async () => {
    await stop()
    if (userData) rmSync(userData, { recursive: true, force: true })
    await admin?.quit().catch(() => undefined)
    await server?.stop()
  }, 60_000)

  it('opens a string key in its own tab: Save / Revert / Format JSON are in the header bar, above the editor', async () => {
    await cdp.waitFor(`!!(${q('r1')})`, 'the Redis data source')
    await expand('r1')
    await cdp.waitFor(`!!(${q('r1/db0')})`, 'db0')
    await expand('r1/db0')
    await cdp.waitFor(`!!(${q('r1/db0/strings')})`, 'the strings group')
    await expand('r1/db0/strings')
    await cdp.eval(`${q('r1/db0/strings/k:json:big')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await cdp.waitFor(`!!document.querySelector('.pane[style*="flex"] .rk-text')`, 'the value editor')
    const m = await cdp.eval<{ head: number[]; ta: number[]; btns: Record<string, { top: number; bottom: number; inHead: boolean }>; below: number }>(`(() => {
      const pane = document.querySelector('.pane[style*="flex"]')
      const head = pane.querySelector('.rk-head'), ta = pane.querySelector('.rk-text')
      const r = (e) => { const b = e.getBoundingClientRect(); return [b.top, b.bottom] }
      const btns = {}
      for (const b of pane.querySelectorAll('button')) if (['Save', 'Revert', 'Format JSON'].includes(b.textContent)) btns[b.textContent] = { top: r(b)[0], bottom: r(b)[1], inHead: head.contains(b) }
      const below = Array.from(pane.querySelectorAll('button')).filter(b => b.getBoundingClientRect().top >= r(ta)[1]).length
      return { head: r(head), ta: r(ta), btns, below }
    })()`)
    expect(Object.keys(m.btns).sort()).toEqual(['Format JSON', 'Revert', 'Save'])
    for (const b of Object.values(m.btns)) {
      expect(b.inHead).toBe(true)
      expect(b.bottom).toBeLessThanOrEqual(m.ta[0] + 1) // above the editor
    }
    expect(m.below).toBe(0) // no button under the editor any more
    expect(m.ta[1] - m.ta[0]).toBeGreaterThan(200) // the editor takes the freed height
  })

  it('the header (with the buttons) stays on top at a narrow width', async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 700, deviceScaleFactor: 1, mobile: false })
    try {
      await sleep(400)
      const ok = await cdp.eval<boolean>(`(() => {
        const pane = document.querySelector('.pane[style*="flex"]')
        const head = pane.querySelector('.rk-head'), ta = pane.querySelector('.rk-text')
        const hb = head.getBoundingClientRect(), tb = ta.getBoundingClientRect()
        return Array.from(head.querySelectorAll('button')).every(b => { const r = b.getBoundingClientRect(); return r.right <= hb.right + 1 && r.bottom <= tb.top + 1 }) && head.scrollWidth <= head.clientWidth + 1
      })()`)
      expect(ok).toBe(true)
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride')
    }
  })

  it('Cmd+R reloads the open key: body focus, inside the value textarea and the TTL box, and in the explorer filter box', async () => {
    await cdp.eval(`${q('r1/db0/strings/k:plain')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await reloaded('v0', 'the plain key')
    const press = (): Promise<void> => cdp.press('r', 'KeyR', 82, 4)
    const trial = async (value: string, focus: string): Promise<void> => {
      await admin.set('plain', value)
      await cdp.eval(focus)
      await press()
      await reloaded(value, `Cmd+R to show "${value}"`)
    }
    await trial('v1', `document.activeElement.blur()`)
    await trial('v2', `document.querySelector('.pane[style*="flex"] .rk-text').focus()`)
    await trial('v3', `document.querySelector('.pane[style*="flex"] .rk-ttl input').focus()`)
    await click(`document.querySelector('.explorer input')`) // the filter box
    await trial('v4', `document.querySelector('.explorer input').focus()`)
    await click(`document.querySelector('.pane[style*="flex"] .rk-head')`)
    await trial('v5', `document.activeElement.blur()`)
  })

  it('Cmd+R in the key browser re-scans and reloads the focused key (hash too)', async () => {
    await click(`${q('r1/db0')}`)
    await cdp.press('F4', 'F4', 115) // Open Key Browser
    await cdp.waitFor(`Array.from(document.querySelectorAll('.pane[style*="flex"] tbody tr')).length >= 4`, 'the key grid')
    const row = (name: string): string => `Array.from(document.querySelectorAll('.pane[style*="flex"] tbody tr')).find(t => t.textContent.includes(${js(name)}))`
    await admin.set('plain', 'b0')
    await click(row('plain'))
    await reloaded('b0', 'the focused key in the detail pane')
    await admin.set('plain', 'b1')
    await admin.set('zzz:new', 'x')
    await click(`document.querySelector('.pane[style*="flex"] .rk-text')`)
    await cdp.press('r', 'KeyR', 82, 4)
    await reloaded('b1', 'the detail pane to reload')
    await cdp.waitFor(`Array.from(document.querySelectorAll('.pane[style*="flex"] tbody tr')).some(t => t.textContent.includes('zzz:new'))`, 'the grid to re-scan')
    // hash -> list -> hash: switching the item editors must not crash the window
    await click(row('h:one'))
    await cdp.waitFor(`!!document.querySelector('.pane[style*="flex"] .rk-items[data-kind="hash"]')`, 'the hash items')
    await admin.hset('h:one', 'a', 'CHANGED')
    await click(`document.querySelector('.pane[style*="flex"] .rk-head')`)
    await cdp.press('r', 'KeyR', 82, 4)
    await cdp.waitFor(`document.querySelector('.pane[style*="flex"] .rk-items')?.textContent.includes('CHANGED')`, 'the hash to reload')
    await click(row('l:one'))
    await cdp.waitFor(`!!document.querySelector('.pane[style*="flex"] .rk-items[data-kind="list"]')`, 'the list items')
    await click(row('h:one'))
    await cdp.waitFor(`!!document.querySelector('.pane[style*="flex"] .rk-items[data-kind="hash"]')`, 'the hash items again')
    expect(await cdp.eval(`!!document.querySelector('.app .explorer')`)).toBe(true)
    expect(realErrors()).toEqual([])
  })
})
