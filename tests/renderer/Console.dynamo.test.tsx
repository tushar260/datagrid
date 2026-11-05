// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Console, { type ConsoleRef } from '../../src/renderer/src/Console'
import type { DynamoStatementResult } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

let api: MockApi
const ref: ConsoleRef = {
  id: 'c1', title: 'Ddb console', dsId: 'dd', dsName: 'Ddb', database: '', engine: 'dynamodb', region: 'eu-west-1', sql: 'SELECT * FROM "orders"'
}
const result = (over: Partial<DynamoStatementResult> = {}): DynamoStatementResult => ({
  items: [{ pk: 'a', n: 1 }],
  columns: [{ name: 'pk', types: ['S'], key: 'HASH' }, { name: 'n', types: ['N'] }],
  rows: [['a', '1']],
  next: null,
  columnsCapped: false,
  command: 'SELECT',
  durationMs: 4,
  ...over
})

beforeEach(() => {
  localStorage.clear()
  api = installApi({
    dynamo: {
      tables: ['orders', 'users', 'we"ird'],
      describe: { keySchema: [{ name: 'pk', keyType: 'HASH', attrType: 'S' }], indexes: [{ name: 'g', kind: 'GSI', keys: [{ name: 'gsi_key', keyType: 'HASH', attrType: 'S' }] }] },
      items: { items: [], columns: [{ name: 'pk', types: ['S'] }, { name: 'status', types: ['S'] }], rows: [], next: null, columnsCapped: false },
      partiql: async () => result()
    }
  })
})
afterEach(cleanup)

const editor = (): HTMLTextAreaElement => document.querySelector('textarea.editor') as HTMLTextAreaElement
const runBtn = (): HTMLButtonElement => screen.getByRole('button', { name: /Run|Running/ }) as HTMLButtonElement
const names = (): string[] => screen.queryAllByRole('option').map((o) => o.querySelector('.cs-name')!.textContent!)
const cellsOf = (row: number): string[] => Array.from(document.querySelectorAll('tbody tr')[row].querySelectorAll('td')).map((c) => c.textContent!)
const tabs = (): string[] => Array.from(document.querySelectorAll('.results .subtabs button')).map((b) => b.textContent!)
const calls = (): [string, string, { nextToken?: string }?][] => api.dynamo.partiql.mock.calls as never
const metaLoaded = async (): Promise<void> => {
  await waitFor(() => expect(api.dynamo.tables).toHaveBeenCalled())
  await act(async () => { await Promise.resolve() })
}

describe('Console (PartiQL): running', () => {
  it('shows "source / region", a PartiQL placeholder and the prefill; never touches the Postgres API', async () => {
    render(<Console c={{ ...ref, sql: undefined }} />)
    expect(screen.getByText('Ddb / eu-west-1')).toBeTruthy()
    expect(editor().placeholder).toContain('PartiQL')
    expect(editor().value).toBe('')
    cleanup()
    render(<Console c={ref} />)
    expect(editor().value).toBe('SELECT * FROM "orders"')
    await metaLoaded()
    expect(api.tableNames).not.toHaveBeenCalled()
    expect(api.schemasAll).not.toHaveBeenCalled()
    expect(api.tables).not.toHaveBeenCalled()
  })

  it('Run executes the statement through PartiQL and shows the items', async () => {
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await user.click(runBtn())
    await screen.findByText(/1 item ·/)
    expect(calls()).toEqual([['dd', 'SELECT * FROM "orders"']])
    expect(api.query).not.toHaveBeenCalled()
    expect(Array.from(document.querySelectorAll('thead th')).map((t) => t.textContent)).toEqual(['#', 'PKpk', 'n'])
    expect(cellsOf(0)).toEqual(['1', 'a', '1'])
    expect(screen.getByText(/4 ms/)).toBeTruthy()
  })

  it('Cmd/Ctrl+Enter runs; an empty console never runs', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: '  ' }} />)
    await user.click(runBtn())
    expect(api.dynamo.partiql).not.toHaveBeenCalled()
    await user.click(editor())
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(api.dynamo.partiql).not.toHaveBeenCalled()
    await user.type(editor(), 'SELECT 1')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() => expect(api.dynamo.partiql).toHaveBeenCalledTimes(1))
  })

  it('runs only the selection when there is one', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'SELECT * FROM "a"; SELECT * FROM "b"' }} />)
    editor().setSelectionRange(0, 'SELECT * FROM "a"'.length)
    await user.click(runBtn())
    await waitFor(() => expect(api.dynamo.partiql).toHaveBeenCalled())
    expect(calls()).toEqual([['dd', 'SELECT * FROM "a"']])
  })

  it('";" separates statements: they run in order and each gets a result tab', async () => {
    api.dynamo.partiql.mockImplementation(async (_d: string, stmt: string) =>
      result({ command: stmt.split(' ')[0].toUpperCase(), rows: [[stmt.includes('"b"') ? 'from-b' : 'from-a', '1']] }))
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'SELECT * FROM "a";\nselect * from "b"; ' }} />)
    await user.click(runBtn())
    await waitFor(() => expect(tabs()).toEqual(['1: SELECT', '2: SELECT']))
    expect(calls().map((c) => c[1])).toEqual(['SELECT * FROM "a"', 'select * from "b"'])
    expect(cellsOf(0)[1]).toBe('from-b') // the last result is shown
    await user.click(screen.getByRole('button', { name: '1: SELECT' }))
    expect(cellsOf(0)[1]).toBe('from-a')
  })

  it('statements run sequentially, not in parallel', async () => {
    const order: string[] = []
    let release!: () => void
    api.dynamo.partiql.mockImplementation(async (_d: string, stmt: string) => {
      order.push('start ' + stmt)
      if (stmt === 'S1') await new Promise<void>((r) => (release = r))
      order.push('end ' + stmt)
      return result()
    })
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'S1; S2' }} />)
    await user.click(runBtn())
    await waitFor(() => expect(order).toEqual(['start S1']))
    expect(runBtn().textContent).toBe('Running…')
    release()
    await waitFor(() => expect(order).toEqual(['start S1', 'end S1', 'start S2', 'end S2']))
    await waitFor(() => expect(runBtn().textContent).toContain('Run'))
  })

  it('an error stops the run: earlier results stay, the failing statement shows the message inline', async () => {
    api.dynamo.partiql.mockImplementation(async (_d: string, stmt: string) => {
      if (stmt === 'BAD') throw new Error("Error invoking remote method 'dynamo:partiql': Error: ValidationException: Statement wasn't well formed")
      return result()
    })
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'OK1; BAD; OK2' }} />)
    await user.click(runBtn())
    await waitFor(() => expect(tabs()).toEqual(['1: SELECT', '2: ERROR']))
    expect(calls().map((c) => c[1])).toEqual(['OK1', 'BAD']) // OK2 never ran
    expect(document.querySelector('.msg.bad')!.textContent).toBe("ValidationException: Statement wasn't well formed")
    await user.click(screen.getByRole('button', { name: '1: SELECT' }))
    expect(document.querySelector('.msg.bad')).toBeNull()
    expect(cellsOf(0)).toEqual(['1', 'a', '1'])
  })

  it('a single failing statement shows only the error', async () => {
    api.dynamo.partiql.mockRejectedValue(new Error('No credentials found.'))
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await user.click(runBtn())
    expect((await screen.findByText('No credentials found.')).className).toContain('bad')
    expect(tabs()).toEqual([])
    expect(document.querySelector('tbody')).toBeNull()
  })

  it('a statement without rows reports completion; a new run replaces the old results', async () => {
    api.dynamo.partiql.mockResolvedValueOnce(result({ command: 'INSERT', columns: [], rows: [], items: [] }))
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'INSERT INTO "t" VALUE {\'pk\': \'a\'}' }} />)
    await user.click(runBtn())
    expect(await screen.findByText(/INSERT completed/)).toBeTruthy()
    expect(document.querySelector('thead')).toBeNull()
    await user.click(runBtn())
    await screen.findByText(/1 item ·/)
    expect(screen.queryByText(/INSERT completed/)).toBeNull()
  })

  it('semicolons inside strings do not split', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: `INSERT INTO "t" VALUE {'pk': 'a;b'}` }} />)
    await user.click(runBtn())
    await waitFor(() => expect(api.dynamo.partiql).toHaveBeenCalledTimes(1))
    expect(calls()[0][1]).toBe(`INSERT INTO "t" VALUE {'pk': 'a;b'}`)
  })

  it('multiple items are counted in the plural', async () => {
    api.dynamo.partiql.mockResolvedValue(result({ rows: [['a', '1'], ['b', '2']] }))
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await user.click(runBtn())
    await screen.findByText(/2 items ·/)
  })
})

describe('Console (PartiQL): load more', () => {
  it('pages through NextToken and appends rows, widening the columns when new attributes show up', async () => {
    api.dynamo.partiql
      .mockResolvedValueOnce(result({ next: 'tok1' }))
      .mockResolvedValueOnce(
        result({ columns: [{ name: 'pk', types: ['S'], key: 'HASH' }, { name: 'extra', types: ['BOOL'] }], rows: [['b', 'true']], items: [{ pk: 'b', extra: true }], next: null, durationMs: 3 })
      )
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await user.click(runBtn())
    const more = await screen.findByRole('button', { name: 'Load more' })
    await user.click(more)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull())
    expect(calls()[1]).toEqual(['dd', 'SELECT * FROM "orders"', { nextToken: 'tok1' }])
    expect(Array.from(document.querySelectorAll('thead th')).map((t) => t.textContent)).toEqual(['#', 'PKpk', 'n', 'extra'])
    expect(cellsOf(0)).toEqual(['1', 'a', '1', 'null'])
    expect(cellsOf(1)).toEqual(['2', 'b', 'null', 'true'])
    expect(screen.getByText(/2 items · 7 ms/)).toBeTruthy()
  })

  it('shows a busy state, ignores double clicks, and keeps the button when a page fails', async () => {
    let finish!: (r: DynamoStatementResult) => void
    api.dynamo.partiql
      .mockResolvedValueOnce(result({ next: 'tok1' }))
      .mockReturnValueOnce(new Promise<DynamoStatementResult>((r) => (finish = r)))
      .mockRejectedValueOnce(new Error("Error invoking remote method 'dynamo:partiql': Error: DynamoDB throttled the request."))
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await user.click(runBtn())
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    const busy = screen.getByRole('button', { name: 'Loading…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    fireEvent.click(busy)
    expect(api.dynamo.partiql).toHaveBeenCalledTimes(2)
    finish(result({ next: 'tok2', rows: [['c', '3']] }))
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByText('DynamoDB throttled the request.')
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy() // can be retried
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2)
  })

  it('only the shown result tab loads more', async () => {
    api.dynamo.partiql
      .mockResolvedValueOnce(result({ next: 't1', rows: [['first', '1']] }))
      .mockResolvedValueOnce(result({ next: null, rows: [['second', '2']] }))
      .mockResolvedValueOnce(result({ next: null, rows: [['first', '1'], ['more', '9']] }))
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'A; B' }} />)
    await user.click(runBtn())
    await waitFor(() => expect(tabs()).toHaveLength(2))
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull() // tab 2 has no more
    await user.click(screen.getByRole('button', { name: '1: SELECT' }))
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(calls()[2]).toEqual(['dd', 'A', { nextToken: 't1' }]))
  })
})

describe('Console (PartiQL): completion', () => {
  async function typeSql(text: string) {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: '' }} />)
    await metaLoaded()
    await user.click(editor())
    await user.type(editor(), text)
    return user
  }

  it('suggests table names after FROM and inserts them double-quoted', async () => {
    const user = await typeSql('SELECT * FROM o')
    expect(names()).toEqual(['orders'])
    await user.keyboard('{Enter}')
    expect(editor().value).toBe('SELECT * FROM "orders"')
    expect(api.dynamo.tables).toHaveBeenCalledWith('dd')
  })

  it('lists every table right after FROM and doubles embedded quotes', async () => {
    const user = await typeSql('SELECT * FROM ')
    expect(names()).toEqual(['orders', 'users', 'we"ird'])
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(editor().value).toBe('SELECT * FROM "we""ird"')
  })

  it('completes inside an already quoted name', async () => {
    const user = await typeSql('SELECT * FROM "us')
    expect(names()).toEqual(['users'])
    await user.keyboard('{Tab}')
    expect(editor().value).toBe('SELECT * FROM "users"')
  })

  it('attribute names of the referenced table: keys, index keys and attributes seen in a sample', async () => {
    await typeSql('SELECT * FROM "orders" WHERE ')
    const user = userEvent.setup()
    await user.keyboard('{Control>} {/Control}') // Ctrl+Space: open the list
    await waitFor(() => expect(api.dynamo.describe).toHaveBeenCalledWith('dd', 'orders'))
    expect(api.dynamo.items).toHaveBeenCalledWith('dd', 'orders', { limit: 25 })
    await waitFor(() => expect(names()).toEqual(expect.arrayContaining(['pk', 'gsi_key', 'status'])))
    await user.keyboard('{Escape}')
    await user.type(editor(), 'sta')
    await waitFor(() => expect(names()).toContain('status'))
    await user.keyboard('{Enter}')
    expect(editor().value).toBe('SELECT * FROM "orders" WHERE "status"') // reserved word: quoted
  })

  it('keywords and functions; no LIMIT', async () => {
    const user = await typeSql('SELECT * FROM "orders" WHERE begin')
    expect(names()).toContain('begins_with')
    await user.keyboard('{Enter}')
    expect(editor().value).toBe('SELECT * FROM "orders" WHERE begins_with(, )')
    expect(editor().selectionStart).toBe(editor().value.length - 3) // caret in the first argument
    await user.clear(editor())
    await user.type(editor(), 'SELECT * FROM "orders" WHERE a lim')
    expect(names()).toEqual([])
  })

  it('accepting a function suggests attributes for its first argument straight away', async () => {
    const user = await typeSql('SELECT * FROM "orders" WHERE begin')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(names()).toEqual(expect.arrayContaining(['pk'])))
    expect(names().every((n) => !['and', 'AND', 'begins_with'].includes(n))).toBe(true)
    await user.keyboard('{Enter}')
    expect(editor().value).toMatch(/^SELECT \* FROM "orders" WHERE begins_with\(pk, \)$/)
  })

  it('the refresh button reloads the table names; a failed refresh keeps the last list', async () => {
    render(<Console c={{ ...ref, sql: '' }} />)
    await metaLoaded()
    expect(api.dynamo.tables).toHaveBeenCalledTimes(1)
    const user = userEvent.setup()
    api.dynamo.tables.mockRejectedValueOnce(new Error('denied'))
    await user.click(screen.getByTitle(/Refresh table and attribute suggestions/))
    await waitFor(() => expect(api.dynamo.tables).toHaveBeenCalledTimes(2))
    await user.click(editor())
    await user.type(editor(), 'SELECT * FROM ')
    expect(names()).toEqual(['orders', 'users', 'we"ird']) // a failed refresh keeps the last known list
  })

  it('a failing describe / sample does not break completion', async () => {
    api.dynamo.describe.mockRejectedValue(new Error('x'))
    api.dynamo.items.mockRejectedValue(new Error('y'))
    await typeSql('SELECT * FROM "orders" WHERE ')
    await userEvent.setup().keyboard('{Control>} {/Control}')
    await waitFor(() => expect(names()).toContain('AND'))
  })
})
