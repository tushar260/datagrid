// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Console, { type ConsoleRef } from '../../src/renderer/src/Console'
import { initialSession } from '../../src/renderer/src/session'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

let api: MockApi
const ref: ConsoleRef = { id: 'c1', title: 'console', dsId: 'ds', dsName: 'Local', database: 'app', schema: 'public' }
const col = (name: string, type = 'text', isPk = false) => ({ name, type, nullable: !isPk, isPk })

beforeEach(() => {
  localStorage.clear()
  api = installApi({
    tableNames: { public: ['users', 'orders', 'user_roles'], audit: ['log'] },
    tables: [{ name: 'users', kind: 'table' }, { name: 'orders', kind: 'table' }, { name: 'user_roles', kind: 'view' }],
    schemasAll: ['public', 'audit', 'information_schema'],
    columns: [col('id', 'integer', true), col('email'), col('created_at', 'timestamptz')],
    query: { results: [{ command: 'SELECT', rowCount: 1, fields: ['a'], rows: [['1']], truncated: false }], durationMs: 3 }
  })
})
afterEach(cleanup)

const editor = (): HTMLTextAreaElement => document.querySelector('textarea.editor') as HTMLTextAreaElement
const names = (): string[] => screen.queryAllByRole('option').map((o) => o.querySelector('.cs-name')!.textContent!)
const popup = (): HTMLElement | null => screen.queryByRole('listbox')
const runBtn = (): HTMLButtonElement => screen.getByRole('button', { name: /Run|Running/ }) as HTMLButtonElement
const meta = async (): Promise<void> => {
  await waitFor(() => expect(api.tableNames).toHaveBeenCalled())
  await act(async () => {
    await Promise.resolve()
  })
}
async function typeSql(sql: string, c: ConsoleRef = ref): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  render(<Console c={c} />)
  await meta()
  await user.click(editor())
  await user.type(editor(), sql)
  return user
}

describe('Console: running', () => {
  it('shows the context and the placeholder; empty SQL never runs', async () => {
    const user = userEvent.setup()
    render(<Console c={ref} />)
    expect(screen.getByText(/Local \/ app \/ public/)).toBeTruthy()
    expect(editor().placeholder).toContain('write SQL')
    await user.click(runBtn())
    expect(api.query).not.toHaveBeenCalled()
    await user.type(editor(), '   ')
    await user.click(runBtn())
    expect(api.query).not.toHaveBeenCalled()
  })

  it('initial SQL comes from the ref; Run sends the whole text with ds/database/schema', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'select 1' }} />)
    expect(editor().value).toBe('select 1')
    await user.click(runBtn())
    expect(api.query).toHaveBeenCalledWith('ds', 'app', 'public', 'select 1')
    await screen.findByText(/1 row · 3 ms/)
  })

  it('Cmd+Enter and Ctrl+Enter run', async () => {
    render(<Console c={{ ...ref, sql: 'select 1' }} />)
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(2))
  })

  it('plain Enter does not run', () => {
    render(<Console c={{ ...ref, sql: 'select 1' }} />)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(api.query).not.toHaveBeenCalled()
  })

  it('runs only the selection when there is one', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'select 1; select 2; select 3' }} />)
    editor().setSelectionRange(10, 18)
    await user.click(runBtn())
    expect(api.query).toHaveBeenLastCalledWith('ds', 'app', 'public', 'select 2')
    editor().setSelectionRange(4, 4)
    await user.click(runBtn())
    expect(api.query).toHaveBeenLastCalledWith('ds', 'app', 'public', 'select 1; select 2; select 3')
  })

  it('a whitespace-only selection does nothing', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'a   b' }} />)
    editor().setSelectionRange(1, 4)
    await user.click(runBtn())
    expect(api.query).not.toHaveBeenCalled()
  })

  it('while running the button reads Running… and is disabled', async () => {
    let done!: (v: unknown) => void
    api.query.mockImplementation(() => new Promise((r) => (done = r)))
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'select 1' }} />)
    await user.click(runBtn())
    expect(runBtn().textContent).toBe('Running…')
    expect(runBtn().disabled).toBe(true)
    done({ results: [], durationMs: 1 })
    await waitFor(() => expect(runBtn().textContent).toBe('▶ Run'))
  })

  it('server errors show without the IPC prefix and clear on the next success', async () => {
    api.query.mockRejectedValueOnce(new Error(`Error invoking remote method 'db:query': Error: syntax error at or near "selec"`))
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'selec 1' }} />)
    await user.click(runBtn())
    await screen.findByText('syntax error at or near "selec"')
    await user.click(runBtn())
    await screen.findByText(/1 row/)
    expect(screen.queryByText(/syntax error/)).toBeNull()
  })

  it('renders the grid: row numbers, header names, NULL as muted "null"', async () => {
    api.query.mockResolvedValue({ results: [{ command: 'SELECT', rowCount: 2, fields: ['id', 'name'], rows: [['1', 'a'], ['2', null]], truncated: false }], durationMs: 5 })
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'x' }} />)
    await user.click(runBtn())
    await screen.findByText('2 rows · 5 ms')
    expect(Array.from(document.querySelectorAll('thead th')).map((t) => t.textContent)).toEqual(['#', 'id', 'name'])
    expect(Array.from(document.querySelectorAll('tbody td.rn')).map((t) => t.textContent)).toEqual(['1', '2'])
    const nullCell = document.querySelector('td.null')!
    expect(nullCell.textContent).toBe('null')
    expect(nullCell.getAttribute('title')).toBe('NULL')
  })

  it('statement without fields shows "COMMAND count"; no grid', async () => {
    api.query.mockResolvedValue({ results: [{ command: 'UPDATE', rowCount: 4, fields: [], rows: [], truncated: false }], durationMs: 1 })
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'update t set a=1' }} />)
    await user.click(runBtn())
    await screen.findByText('UPDATE 4 · 1 ms')
    expect(document.querySelector('table.grid')).toBeNull()
  })

  it('command without a rowCount is trimmed', async () => {
    api.query.mockResolvedValue({ results: [{ command: 'CREATE', rowCount: null, fields: [], rows: [], truncated: false }], durationMs: 1 })
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'create table t()' }} />)
    await user.click(runBtn())
    await screen.findByText('CREATE · 1 ms')
  })

  it('singular/plural row label and the truncation note', async () => {
    api.query.mockResolvedValue({ results: [{ command: 'SELECT', rowCount: 9999, fields: ['a'], rows: [['1']], truncated: true }], durationMs: 2 })
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'x' }} />)
    await user.click(runBtn())
    await screen.findByText('1+ row · 2 ms · showing first 5000 rows')
  })

  it('multi-statement: sub-tabs, last result active, switching shows the others', async () => {
    api.query.mockResolvedValue({
      results: [
        { command: 'SELECT', rowCount: 1, fields: ['a'], rows: [['one']], truncated: false },
        { command: 'UPDATE', rowCount: 7, fields: [], rows: [], truncated: false }
      ],
      durationMs: 9
    })
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'x' }} />)
    await user.click(runBtn())
    const tabs = await screen.findAllByRole('button', { name: /^\d: / })
    expect(tabs.map((t) => t.textContent)).toEqual(['1: SELECT', '2: UPDATE'])
    expect(tabs[1].className).toBe('on')
    expect(screen.getByText('UPDATE 7 · 9 ms')).toBeTruthy()
    await user.click(tabs[0])
    expect(screen.getByText('1 row · 9 ms')).toBeTruthy()
    expect(document.querySelector('tbody td:not(.rn)')!.textContent).toBe('one')
  })

  it('a single result has no sub-tabs', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'x' }} />)
    await user.click(runBtn())
    await screen.findByText(/1 row/)
    expect(document.querySelector('.subtabs')).toBeNull()
  })

  it('DDL refreshes the completion metadata; plain selects do not', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'select 1' }} />)
    await meta()
    const n0 = api.tableNames.mock.calls.length
    await user.click(runBtn())
    await screen.findByText(/1 row/)
    expect(api.tableNames).toHaveBeenCalledTimes(n0)
    await user.clear(editor())
    await user.type(editor(), 'create table t (a int)')
    await user.click(runBtn())
    await waitFor(() => expect(api.tableNames.mock.calls.length).toBe(n0 + 1))
  })

  it.each(['alter table t add a int', 'DROP table t', 'truncate t', 'rename x'])('refreshes for %j', async (sql) => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql }} />)
    await meta()
    const n0 = api.tableNames.mock.calls.length
    await user.click(runBtn())
    await waitFor(() => expect(api.tableNames.mock.calls.length).toBe(n0 + 1))
  })
})

describe('Console: editor behaviour', () => {
  it('Tab inserts two spaces instead of moving focus', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'ab' }} />)
    editor().focus()
    editor().setSelectionRange(1, 1)
    await user.keyboard('{Tab}')
    expect(editor().value).toBe('a  b')
  })

  it('persists drafts into the session (debounced) and the refresh button reloads metadata', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<Console c={{ ...ref, sql: '' }} />)
      fireEvent.change(editor(), { target: { value: 'select now()' } })
      vi.advanceTimersByTime(400)
      expect(JSON.parse(localStorage.getItem('datagrid:session')!).consoleSql.c1).toBe('select now()')
      expect(initialSession).toBeTruthy()
      const n0 = api.tableNames.mock.calls.length
      fireEvent.click(screen.getByTitle(/Refresh table and column suggestions/))
      expect(api.tableNames.mock.calls.length).toBe(n0 + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('editor height follows the stored split; the splitter resets on double-click', () => {
    localStorage.setItem('datagrid:console-split', '0.6')
    render(<Console c={ref} />)
    expect(editor().style.height).toBe('60%')
    fireEvent.doubleClick(document.querySelector('.split-h')!)
    expect(editor().style.height).toBe('38%')
    expect(localStorage.getItem('datagrid:console-split')).toBeNull()
  })

  it('an out-of-range stored split falls back to the default', () => {
    localStorage.setItem('datagrid:console-split', '7')
    render(<Console c={ref} />)
    expect(editor().style.height).toBe('38%')
  })
})

describe('Console: completion popup', () => {
  it('opens for a table name after FROM, ranked, and closes when nothing matches', async () => {
    await typeSql('select * from us')
    await waitFor(() => expect(names()).toContain('users'))
    expect(names()[0]).toMatch(/^user/)
    expect(popup()).not.toBeNull()
    const user = userEvent.setup()
    await user.type(editor(), 'zzz')
    await waitFor(() => expect(popup()).toBeNull())
  })

  it('Enter accepts the highlighted suggestion (no newline, no run)', async () => {
    await typeSql('select * from us')
    await waitFor(() => expect(names().length).toBeGreaterThan(0))
    const first = names()[0]
    const user = userEvent.setup()
    await user.keyboard('{Enter}')
    expect(editor().value).toBe(`select * from ${first}`)
    expect(popup()).toBeNull()
    expect(api.query).not.toHaveBeenCalled()
  })

  it('Tab accepts as well (and does not insert spaces)', async () => {
    await typeSql('select * from ord')
    await waitFor(() => expect(names()).toContain('orders'))
    await userEvent.setup().keyboard('{Tab}')
    expect(editor().value).toBe('select * from orders')
  })

  it('Shift+Tab does not accept', async () => {
    await typeSql('select * from ord')
    await waitFor(() => expect(popup()).not.toBeNull())
    fireEvent.keyDown(editor(), { key: 'Tab', shiftKey: true })
    expect(editor().value).not.toContain('orders') // the suggestion was not accepted
  })

  it('arrow keys move (wrapping) and Enter accepts the moved-to item', async () => {
    await typeSql('select * from user')
    await waitFor(() => expect(names().length).toBeGreaterThan(1))
    const list = names()
    const user = userEvent.setup()
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(screen.getAllByRole('option')[list.length - 1].getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{Enter}')
    expect(editor().value).toBe(`select * from ${list[list.length - 1]}`)
  })

  it('Escape closes the popup, keeps the text and does not bubble', async () => {
    const outer = vi.fn()
    const user = userEvent.setup()
    render(<div onKeyDown={outer}><Console c={ref} /></div>)
    await meta()
    await user.click(editor())
    await user.type(editor(), 'select * from us')
    await waitFor(() => expect(popup()).not.toBeNull())
    outer.mockClear()
    await user.keyboard('{Escape}')
    expect(popup()).toBeNull()
    expect(editor().value).toBe('select * from us')
    expect(outer).not.toHaveBeenCalled()
  })

  it('Escape with no popup is left alone for the parent', async () => {
    const outer = vi.fn()
    render(<div onKeyDown={outer}><Console c={ref} /></div>)
    fireEvent.keyDown(editor(), { key: 'Escape' })
    expect(outer).toHaveBeenCalled()
  })

  it('Cmd+Enter with the popup open closes it and runs the query (bypass)', async () => {
    await typeSql('select * from us')
    await waitFor(() => expect(popup()).not.toBeNull())
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })
    expect(popup()).toBeNull()
    await waitFor(() => expect(api.query).toHaveBeenCalledWith('ds', 'app', 'public', 'select * from us'))
    expect(editor().value).toBe('select * from us')
  })

  it('no popup inside a string literal or a comment', async () => {
    await typeSql(`select 'us`)
    await new Promise((r) => setTimeout(r, 20))
    expect(popup()).toBeNull()
    cleanup()
    await typeSql('select 1 -- us')
    await new Promise((r) => setTimeout(r, 20))
    expect(popup()).toBeNull()
    cleanup()
    await typeSql('/* from us')
    await new Promise((r) => setTimeout(r, 20))
    expect(popup()).toBeNull()
  })

  it('column completion after "alias." loads the table columns lazily', async () => {
    await typeSql('select u. from users u')
    const el = editor()
    el.setSelectionRange(9, 9)
    fireEvent.change(el, { target: { value: el.value, selectionStart: 9, selectionEnd: 9 } })
    const user = userEvent.setup()
    await user.click(el)
    el.setSelectionRange(9, 9)
    fireEvent.keyDown(el, { key: ' ', ctrlKey: true })
    await waitFor(() => expect(api.columns).toHaveBeenCalledWith('ds', 'app', 'public', 'users'))
    await waitFor(() => expect(names()).toEqual(expect.arrayContaining(['id', 'email', 'created_at'])))
  })

  it('Ctrl+Space forces the popup open on an empty statement', async () => {
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await meta()
    await user.click(editor())
    fireEvent.keyDown(editor(), { key: ' ', ctrlKey: true })
    await waitFor(() => expect(popup()).not.toBeNull())
    expect(names()).toContain('select')
  })

  it('blur, click and wheel close the popup', async () => {
    for (const close of [() => fireEvent.blur(editor()), () => fireEvent.click(editor()), () => fireEvent.wheel(editor())]) {
      await typeSql('select * from us')
      await waitFor(() => expect(popup()).not.toBeNull())
      close()
      expect(popup()).toBeNull()
      cleanup()
    }
  })

  it('clicking (mouse-down on) an item accepts it', async () => {
    await typeSql('select * from ord')
    await waitFor(() => expect(names()).toContain('orders'))
    fireEvent.mouseDown(screen.getAllByRole('option')[names().indexOf('orders')])
    expect(editor().value).toBe('select * from orders')
  })

  it('schema-qualified: "audit." lists that schema\'s tables (fetching them on demand)', async () => {
    api.tables.mockImplementation(async (_d: string, _db: string, s: string) => (s === 'audit' ? [{ name: 'log', kind: 'table' }] : [{ name: 'users', kind: 'table' }]))
    await typeSql('select * from audit.')
    await waitFor(() => expect(names()).toContain('log'))
    expect(api.tables).toHaveBeenCalledWith('ds', 'app', 'audit')
  })

  it('metadata failures do not break the editor', async () => {
    api.tableNames.mockRejectedValue(new Error('x'))
    api.tables.mockRejectedValue(new Error('x'))
    api.schemasAll.mockRejectedValue(new Error('x'))
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await user.type(editor(), 'select 1')
    expect(editor().value).toBe('select 1')
  })

  it('keywords complete in lower case after typing in lower case', async () => {
    await typeSql('sel')
    await waitFor(() => expect(names()).toContain('select'))
  })

  it('backspacing alone does not open the popup', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'select * from userx' }} />)
    await meta()
    await user.click(editor())
    editor().setSelectionRange(19, 19)
    await user.keyboard('{Backspace}')
    await new Promise((r) => setTimeout(r, 20))
    expect(popup()).toBeNull()
  })
})
