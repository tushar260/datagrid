// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DataSourceDialog from '../../src/renderer/src/DataSourceDialog'
import type { DataSource } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

let api: MockApi
beforeEach(() => {
  api = installApi()
})
afterEach(cleanup)

const field = (label: string | RegExp): HTMLInputElement =>
  screen.getByLabelText(typeof label === 'string' ? new RegExp('^' + label) : label) as HTMLInputElement
const ok = (): HTMLElement => screen.getByRole('button', { name: 'OK' })

const saved = (over: Partial<NonNullable<DataSource['redis']>> = {}): DataSource => ({
  id: 'r1', kind: 'redis', name: 'my redis', host: '', port: 0, user: '', password: '', database: '', ssl: false, folderId: 'f1',
  redis: { host: 'cache.local', port: 6380, db: 2, tls: true, username: 'app', hasPassword: true, ...over }
})

async function newRedis(folderId?: string | null) {
  const user = userEvent.setup()
  const close = vi.fn()
  render(<DataSourceDialog initial={null} folderId={folderId} onClose={close} />)
  await user.selectOptions(screen.getByLabelText('Type'), 'redis')
  return { user, close }
}

describe('Redis data source form', () => {
  it('is offered as a third type and shows host, port, username, password, database and TLS only', async () => {
    await newRedis()
    expect(screen.getByRole('heading').textContent).toBe('Data Source: Redis')
    expect(field('Name').value).toBe('redis@localhost')
    expect(field('Host').value).toBe('localhost')
    expect(field('Port').value).toBe('6379')
    expect(field('Database').value).toBe('0')
    expect((screen.getByLabelText(/Use TLS/) as HTMLInputElement).checked).toBe(false)
    expect(field('Username').placeholder).toBe('default user')
    expect(field('Password').type).toBe('password')
    expect(screen.queryByLabelText(/^User$/)).toBeNull()
    expect(screen.queryByLabelText(/Use SSL/)).toBeNull()
    expect(screen.queryByLabelText(/Region/)).toBeNull()
  })

  it('the default name follows the type until edited', async () => {
    const { user } = await newRedis()
    await user.selectOptions(screen.getByLabelText('Type'), 'postgres')
    expect(field('Name').value).toBe('postgres@localhost')
    await user.clear(field('Name'))
    await user.type(field('Name'), 'mine')
    await user.selectOptions(screen.getByLabelText('Type'), 'redis')
    expect(field('Name').value).toBe('mine')
  })

  it('saves the typed configuration with the folder', async () => {
    const { user, close } = await newRedis('fld')
    await user.clear(field('Host'))
    await user.type(field('Host'), 'redis.example.com')
    await user.clear(field('Port'))
    await user.type(field('Port'), '6400')
    await user.type(field('Username'), 'alice')
    await user.type(field('Password'), 's3cret')
    await user.clear(field('Database'))
    await user.type(field('Database'), '5')
    await user.click(screen.getByLabelText(/Use TLS/))
    await user.click(ok())
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect(api.saveSource.mock.calls[0][0]).toMatchObject({
      kind: 'redis', folderId: 'fld',
      redis: { host: 'redis.example.com', port: 6400, username: 'alice', password: 's3cret', db: 5, tls: true }
    })
  })

  it('Show / Hide toggles the password', async () => {
    const { user } = await newRedis()
    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(field('Password').type).toBe('text')
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(field('Password').type).toBe('password')
  })

  it.each([
    ['Host', '', /host/i],
    ['Port', '70000', /port/i],
    ['Database', '256', /database/i]
  ])('an invalid %s is reported and nothing is saved or tested', async (label, value, msg) => {
    const { user } = await newRedis()
    const f = field(label)
    await user.clear(f)
    if (value) await user.type(f, value)
    await user.click(ok())
    expect(document.body.textContent).toMatch(msg)
    expect(api.saveSource).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Test Connection/ }))
    expect(api.testSource).not.toHaveBeenCalled()
  })
})

describe('editing a saved Redis source', () => {
  it('has no type selector, shows the saved values and never the password', () => {
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    expect(screen.queryByLabelText('Type')).toBeNull()
    expect(screen.getByRole('heading').textContent).toBe('Data Source: Redis')
    expect(field('Host').value).toBe('cache.local')
    expect(field('Port').value).toBe('6380')
    expect(field('Username').value).toBe('app')
    expect(field('Database').value).toBe('2')
    expect((screen.getByLabelText(/Use TLS/) as HTMLInputElement).checked).toBe(true)
    expect(field('Password').value).toBe('')
    expect(field('Password').placeholder).toBe('saved (leave blank to keep)')
  })

  it('a blank password is sent as blank (the main process keeps the saved one) and Test uses the same payload', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Test Connection/ }))
    await waitFor(() => expect(screen.getByText(/Succeeded/)).toBeTruthy())
    const sent = api.testSource.mock.calls[0][0] as DataSource
    expect(sent.id).toBe('r1')
    expect(sent.redis).toMatchObject({ host: 'cache.local', hasPassword: true })
    expect(sent.redis!.password ?? '').toBe('')
    expect(sent.redis!.clearPassword).toBeFalsy()
  })

  it('typing a new password replaces the saved one', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    await user.type(field('Password'), 'new')
    await user.click(ok())
    await waitFor(() => expect(api.saveSource).toHaveBeenCalled())
    expect((api.saveSource.mock.calls[0][0] as DataSource).redis).toMatchObject({ password: 'new' })
  })

  it('Clear saved removes the password on OK and explains it; typing afterwards cancels the removal', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Clear saved' }))
    expect(screen.getByText(/saved password will be removed/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear saved' })).toBeNull()
    expect(field('Password').placeholder).toBe('')
    await user.type(field('Password'), 'x')
    expect(screen.queryByText(/saved password will be removed/)).toBeNull()
  })

  it('Clear saved + OK sends clearPassword with a blank password', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Clear saved' }))
    await user.click(ok())
    await waitFor(() => expect(api.saveSource).toHaveBeenCalled())
    expect((api.saveSource.mock.calls[0][0] as DataSource).redis).toMatchObject({ password: '', clearPassword: true })
  })

  it('a source without a saved password has no Clear button', () => {
    render(<DataSourceDialog initial={saved({ hasPassword: false })} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Clear saved' })).toBeNull()
    expect(field('Password').placeholder).toBe('')
  })

  it('a failing test / save is shown without the IPC prefix', async () => {
    const user = userEvent.setup()
    api.testSource.mockRejectedValue(new Error("Error invoking remote method 'ds:test': Error: Connection refused (localhost:6379)"))
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Test Connection/ }))
    await waitFor(() => expect(screen.getByText('Connection refused (localhost:6379)')).toBeTruthy())
    api.saveSource.mockRejectedValue(new Error("Error invoking remote method 'ds:save': Error: nope"))
    await user.click(ok())
    await waitFor(() => expect(screen.getByText('Could not save: nope')).toBeTruthy())
  })
})

describe('key delimiter field', () => {
  it('is a "Key delimiter" field, empty by default (a flat key list, like DataGrip), with a hint', async () => {
    await newRedis()
    expect(field('Key delimiter').value).toBe('')
    expect(field('Key delimiter').placeholder).toMatch(/flat list/)
    expect(field('Key delimiter').maxLength).toBe(8)
    expect(document.body.textContent).toContain('a flat list of keys under each type')
  })

  it('an untouched new source saves without a delimiter (so the default applies)', async () => {
    const { user, close } = await newRedis()
    await user.click(ok())
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect((api.saveSource.mock.calls[0][0] as DataSource).redis).not.toHaveProperty('keyDelimiter')
  })

  it('a typed delimiter is saved and tested with the rest of the configuration', async () => {
    const { user, close } = await newRedis()
    await user.clear(field('Key delimiter'))
    await user.type(field('Key delimiter'), '/')
    await user.click(screen.getByRole('button', { name: /Test Connection/ }))
    await waitFor(() => expect(api.testSource).toHaveBeenCalled())
    expect((api.testSource.mock.calls[0][0] as DataSource).redis).toMatchObject({ keyDelimiter: '/' })
    await user.click(ok())
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect((api.saveSource.mock.calls[0][0] as DataSource).redis).toMatchObject({ keyDelimiter: '/' })
  })

  it('a multi-character delimiter is accepted', async () => {
    const { user } = await newRedis()
    await user.clear(field('Key delimiter'))
    await user.type(field('Key delimiter'), '::')
    await user.click(ok())
    await waitFor(() => expect(api.saveSource).toHaveBeenCalled())
    expect((api.saveSource.mock.calls[0][0] as DataSource).redis).toMatchObject({ keyDelimiter: '::' })
  })

  it('clearing a typed delimiter means "no grouping" and is saved as blank', async () => {
    const { user } = await newRedis()
    await user.type(field('Key delimiter'), ':')
    await user.clear(field('Key delimiter'))
    await user.click(ok())
    await waitFor(() => expect(api.saveSource).toHaveBeenCalled())
    expect((api.saveSource.mock.calls[0][0] as DataSource).redis).toMatchObject({ keyDelimiter: '' })
  })

  it('a saved source shows its delimiter; a legacy one without it is empty (flat)', () => {
    const { unmount } = render(<DataSourceDialog initial={saved({ keyDelimiter: '|' })} onClose={vi.fn()} />)
    expect(field('Key delimiter').value).toBe('|')
    unmount()
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    expect(field('Key delimiter').value).toBe('')
  })

  it('a saved blank delimiter stays blank when editing', () => {
    render(<DataSourceDialog initial={saved({ keyDelimiter: '' })} onClose={vi.fn()} />)
    expect(field('Key delimiter').value).toBe('')
  })

  it('typing is limited to 8 characters, and an over-long value that gets in anyway is reported, not saved', async () => {
    const { user } = await newRedis()
    const f = field('Key delimiter')
    await user.clear(f)
    await user.type(f, '123456789')
    expect(f.value).toBe('12345678')
    fireEvent.change(f, { target: { value: '123456789' } }) // e.g. set by autofill: the validation still holds
    await user.click(ok())
    expect(document.body.textContent).toMatch(/Key delimiter can have at most 8/)
    expect(api.saveSource).not.toHaveBeenCalled()
  })

  it('the field is not shown for PostgreSQL', async () => {
    const { user } = await newRedis()
    await user.selectOptions(screen.getByLabelText('Type'), 'postgres')
    expect(screen.queryByLabelText(/Key delimiter/)).toBeNull()
  })
})
