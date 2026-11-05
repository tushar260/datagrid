// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Console, { type ConsoleRef } from '../../src/renderer/src/Console'
import type { RedisCommandEntry, RedisCommandResult, RedisReply } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

let api: MockApi
let clip: ReturnType<typeof vi.fn>
const ref: ConsoleRef = { id: 'rc1', title: 'Cache console', dsId: 'r1', dsName: 'Cache', database: 'db3', engine: 'redis', db: 3 }
const entry = (line: string, reply: RedisReply, durationMs = 1): RedisCommandEntry => ({ line, command: line.split(' ')[0].toUpperCase(), reply, durationMs })
const result = (...entries: RedisCommandEntry[]): RedisCommandResult => ({ results: entries, durationMs: 7 })

beforeEach(() => {
  localStorage.clear()
  clip = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
  api = installApi({ redis: { command: async () => result(entry('PING', { kind: 'status', value: 'PONG' })) } })
})
afterEach(cleanup)

const editor = (): HTMLTextAreaElement => document.querySelector('textarea.editor') as HTMLTextAreaElement
const runBtn = (): HTMLButtonElement => screen.getByRole('button', { name: /Run|Running/ }) as HTMLButtonElement
const names = (): string[] => screen.queryAllByRole('option').map((o) => o.querySelector('.cs-name')!.textContent!)
const calls = (): [string, number, string][] => api.redis.command.mock.calls as never

describe('Console (Redis): running', () => {
  it('shows "source / dbN" and the command placeholder, prefill kept; never touches the SQL or PartiQL API', async () => {
    render(<Console c={{ ...ref, sql: 'GET a' }} />)
    expect(screen.getByText('Cache / db3')).toBeTruthy()
    expect(editor().placeholder).toContain('Redis commands')
    expect(editor().value).toBe('GET a')
    expect(screen.queryByTitle(/Refresh table/)).toBeNull() // nothing to refresh: command names are built in
    await new Promise((r) => setTimeout(r, 20))
    for (const f of [api.tableNames, api.schemasAll, api.tables, api.columns, api.dynamo.tables]) expect(f).not.toHaveBeenCalled()
  })

  it('Run sends the whole text for this source and database', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'SET a 1\nGET a' }} />)
    await user.click(runBtn())
    await screen.findByText(/1 command ·/)
    expect(calls()).toEqual([['r1', 3, 'SET a 1\nGET a']])
    expect(api.query).not.toHaveBeenCalled()
    expect(api.dynamo.partiql).not.toHaveBeenCalled()
  })

  it('runs only the selection when there is one', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'GET a\nGET b' }} />)
    editor().setSelectionRange(0, 5)
    await user.click(runBtn())
    await waitFor(() => expect(api.redis.command).toHaveBeenCalled())
    expect(calls()[0][2]).toBe('GET a')
  })

  it('Cmd/Ctrl+Enter runs; an empty console never runs', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: '  ' }} />)
    await user.click(runBtn())
    await user.click(editor())
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(api.redis.command).not.toHaveBeenCalled()
    await user.type(editor(), 'PING')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() => expect(api.redis.command).toHaveBeenCalledTimes(1))
  })

  it('Run is disabled while running', async () => {
    let release!: (v: RedisCommandResult) => void
    api.redis.command.mockImplementation(() => new Promise((r) => { release = r }))
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'PING' }} />)
    await user.click(runBtn())
    await waitFor(() => expect(runBtn().textContent).toBe('Running…'))
    expect(runBtn().disabled).toBe(true)
    release(result(entry('PING', { kind: 'status', value: 'PONG' })))
    await waitFor(() => expect(runBtn().textContent).toContain('Run'))
  })

  it('a rejected command shows the error and drops old results', async () => {
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'PING' }} />)
    await user.click(runBtn())
    await screen.findByText(/1 command/)
    api.redis.command.mockRejectedValue(new Error("Error invoking remote method 'redis:command': Error: Connection refused (127.0.0.1:6380)"))
    await user.click(runBtn())
    await waitFor(() => expect(document.querySelector('.msg.bad')!.textContent).toBe('Connection refused (127.0.0.1:6380)'))
    expect(document.querySelector('.rr')).toBeNull()
  })
})

describe('Console (Redis): replies', () => {
  const show = async (r: RedisCommandResult): Promise<void> => {
    api.redis.command.mockResolvedValue(r)
    const user = userEvent.setup()
    render(<Console c={{ ...ref, sql: 'x' }} />)
    await user.click(runBtn())
    await waitFor(() => expect(document.querySelector('.rr')).toBeTruthy())
  }
  const text = (sel: string): string[] => Array.from(document.querySelectorAll(sel)).map((e) => e.textContent!)

  it('renders each reply type like redis-cli, with command, timing and summary', async () => {
    await show({
      durationMs: 9,
      results: [
        entry('SET a 1', { kind: 'status', value: 'OK' }, 2),
        entry('GET a', { kind: 'bulk', value: '1' }),
        entry('GET nope', { kind: 'nil' }),
        entry('INCR a', { kind: 'integer', value: 2 }),
        entry('LRANGE q 0 -1', { kind: 'array', items: [] }),
        entry('BOOM', { kind: 'error', message: "ERR unknown command 'BOOM'" })
      ]
    })
    expect(document.querySelector('.msg.ok')!.textContent).toBe('6 commands · 9 ms')
    expect(text('.rr-line')).toEqual(['SET a 1', 'GET a', 'GET nope', 'INCR a', 'LRANGE q 0 -1', 'BOOM'])
    expect(text('.rr-ms')[0]).toBe('2 ms')
    expect(text('.rr-reply')).toEqual(['OK', '"1"', '(nil)', '(integer) 2', '(empty array)', "(error) ERR unknown command 'BOOM'"])
    expect(document.querySelector('.rr-err')).toBeTruthy()
    expect(document.querySelector('.rr-status')).toBeTruthy()
    expect(document.querySelector('.rr-nil')).toBeTruthy()
  })

  it('nested arrays are numbered; multi-line bulk strings are shown raw', async () => {
    await show({
      durationMs: 1,
      results: [
        entry('HGETALL h', { kind: 'array', items: [{ kind: 'bulk', value: 'f' }, { kind: 'array', items: [{ kind: 'integer', value: 1 }, { kind: 'nil' }] }] }),
        entry('INFO', { kind: 'bulk', value: '# Server\nredis_version:7\n' })
      ]
    })
    expect(text('.rr-idx')).toEqual(['1)', '2)', '1)', '2)'])
    expect(document.querySelector('.rr-block')!.textContent).toBe('# Server\nredis_version:7\n')
    expect(document.querySelectorAll('.rr-reply')[0].querySelector('.rr-list .rr-list')).toBeTruthy()
  })

  it('a single command is summarised in the singular and Copy copies its reply as text', async () => {
    await show(result(entry('LRANGE q 0 -1', { kind: 'array', items: [{ kind: 'bulk', value: 'a' }, { kind: 'bulk', value: 'b' }] })))
    expect(document.querySelector('.msg.ok')!.textContent).toBe('1 command · 7 ms')
    // userEvent.setup() installed its own clipboard stub: put ours back
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true })
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(clip).toHaveBeenCalledWith('1) a\n2) b')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('a new run replaces the previous replies', async () => {
    await show(result(entry('GET a', { kind: 'bulk', value: 'first' })))
    api.redis.command.mockResolvedValue(result(entry('GET b', { kind: 'bulk', value: 'second' })))
    fireEvent.click(runBtn())
    await waitFor(() => expect(text('.rr-line')).toEqual(['GET b']))
  })
})

describe('Console (Redis): command-name completion', () => {
  const type = async (t: string): Promise<ReturnType<typeof userEvent.setup>> => {
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await user.click(editor())
    await user.type(editor(), t)
    return user
  }

  it('suggests commands for the first word, exact match first, and Enter inserts it with a space', async () => {
    const user = await type('hget')
    expect(names().slice(0, 2)).toEqual(['hget', 'hgetall'])
    await user.keyboard('{Enter}')
    expect(editor().value).toBe('hget ')
    expect(api.redis.command).not.toHaveBeenCalled() // Enter accepted the suggestion, nothing ran
  })

  it('keeps the case it was typed in', async () => {
    const user = await type('HGETA')
    expect(names()).toEqual(['HGETALL'])
    await user.keyboard('{Tab}')
    expect(editor().value).toBe('HGETALL ')
  })

  it('completes the first word of every line but not arguments', async () => {
    const user = await type('GET key\nin')
    expect(names()).toEqual(expect.arrayContaining(['incr', 'info']))
    await user.keyboard('{Escape}')
    await user.type(editor(), 'fo k')
    expect(names()).toEqual([])
  })

  it('two-word commands complete after the first word (CLIENT LIST)', async () => {
    await type('client l')
    expect(names()).toContain('client list')
  })

  it('Ctrl+Space lists commands on an empty line; Escape closes', async () => {
    const user = userEvent.setup()
    render(<Console c={ref} />)
    await user.click(editor())
    await user.keyboard('{Control>} {/Control}')
    expect(names().length).toBeGreaterThan(20)
    await user.keyboard('{Escape}')
    expect(names()).toEqual([])
  })

  it('never offers dangerous commands', async () => {
    await type('flush')
    expect(names()).toEqual([])
    cleanup()
    await type('shut')
    expect(names()).toEqual([])
  })
})
