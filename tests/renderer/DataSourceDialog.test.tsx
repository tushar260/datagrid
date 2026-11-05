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

const existing: DataSource = { id: 'ds1', name: 'prod', host: 'db.example', port: 6432, user: 'me', password: 'pw', database: 'app', ssl: true, folderId: 'f1' }
const field = (label: string): HTMLInputElement => screen.getByLabelText(new RegExp('^' + label)) as HTMLInputElement

describe('DataSourceDialog', () => {
  it('new data source: defaults, no Delete button', () => {
    render(<DataSourceDialog initial={null} onClose={vi.fn()} />)
    expect(field('Name').value).toBe('postgres@localhost')
    expect(field('Host').value).toBe('localhost')
    expect(field('Port').value).toBe('5432')
    expect(field('User').value).toBe('postgres')
    expect(field('Password').value).toBe('')
    expect(field('Database').value).toBe('postgres')
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('edit: shows the stored values and a Delete button', () => {
    render(<DataSourceDialog initial={existing} onClose={vi.fn()} />)
    expect(field('Host').value).toBe('db.example')
    expect(field('Port').value).toBe('6432')
    expect((screen.getByLabelText(/Use SSL/) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('Enter in a field saves the edited source and closes with changed=true', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    render(<DataSourceDialog initial={null} folderId="fld" onClose={close} />)
    await user.clear(field('Name'))
    await user.type(field('Name'), 'local')
    await user.clear(field('Port'))
    await user.type(field('Port'), '5433')
    await user.type(field('Password'), 's3cret{Enter}')
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect(api.saveSource).toHaveBeenCalledWith(expect.objectContaining({ name: 'local', port: 5433, password: 's3cret', folderId: 'fld', ssl: false }))
    expect(typeof api.saveSource.mock.calls[0][0].port).toBe('number')
  })

  it('the OK button saves; SSL checkbox toggles', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    render(<DataSourceDialog initial={null} onClose={close} />)
    await user.click(screen.getByLabelText(/Use SSL/))
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect(api.saveSource.mock.calls[0][0].ssl).toBe(true)
  })

  it('save error: stays open and shows "Could not save: …" without the IPC prefix', async () => {
    api.saveSource.mockRejectedValueOnce(new Error("Error invoking remote method 'ds:save': Error: Could not save the password. Keychain"))
    const user = userEvent.setup()
    const close = vi.fn()
    render(<DataSourceDialog initial={null} onClose={close} />)
    await user.type(field('Password'), 'x{Enter}')
    await screen.findByText('Could not save: Could not save the password. Keychain')
    expect(close).not.toHaveBeenCalled()
  })

  it('Escape closes without saving; Cancel and backdrop mouse-down too; inside clicks do not', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    render(<DataSourceDialog initial={null} onClose={close} />)
    await user.keyboard('{Escape}')
    expect(close).toHaveBeenLastCalledWith(false)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.mouseDown(document.querySelector('.modal-bg')!)
    expect(close).toHaveBeenCalledTimes(3)
    expect(close.mock.calls.every((c) => c[0] === false)).toBe(true)
    fireEvent.mouseDown(document.querySelector('.modal')!)
    expect(close).toHaveBeenCalledTimes(3)
    expect(api.saveSource).not.toHaveBeenCalled()
  })

  it('Test Connection: success message with the server version; busy label while running', async () => {
    let resolve!: (v: string) => void
    api.testSource.mockImplementation(() => new Promise<string>((r) => (resolve = r)))
    const user = userEvent.setup()
    render(<DataSourceDialog initial={null} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Test Connection' }))
    const busy = screen.getByRole('button', { name: 'Testing…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    resolve('PostgreSQL 16.10')
    await screen.findByText('Succeeded. PostgreSQL 16.10')
    expect(document.querySelector('.msg.ok')).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Test Connection' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Test Connection failure shows the cleaned error; a new test clears the previous message', async () => {
    api.testSource.mockRejectedValueOnce(new Error("Error invoking remote method 'ds:test': Error: password authentication failed"))
    const user = userEvent.setup()
    render(<DataSourceDialog initial={null} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Test Connection' }))
    await screen.findByText('password authentication failed')
    expect(document.querySelector('.msg.bad')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Test Connection' }))
    await screen.findByText(/^Succeeded/)
    expect(screen.queryByText('password authentication failed')).toBeNull()
  })

  it('Test Connection sends the current form values, not the initial ones', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={existing} onClose={vi.fn()} />)
    await user.clear(field('Host'))
    await user.type(field('Host'), 'other')
    await user.click(screen.getByRole('button', { name: 'Test Connection' }))
    await waitFor(() => expect(api.testSource).toHaveBeenCalled())
    expect(api.testSource.mock.calls[0][0]).toMatchObject({ id: 'ds1', host: 'other', port: 6432 })
  })

  it('Delete calls deleteSource and closes with changed=true; failure shows an error', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    render(<DataSourceDialog initial={existing} onClose={close} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect(api.deleteSource).toHaveBeenCalledWith('ds1')
    cleanup()
    api.deleteSource.mockRejectedValueOnce(new Error('disk full'))
    const close2 = vi.fn()
    render(<DataSourceDialog initial={existing} onClose={close2} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('Could not delete: disk full')
    expect(close2).not.toHaveBeenCalled()
  })

  it('passwordUnavailable shows the Keychain warning up front', () => {
    render(<DataSourceDialog initial={{ ...existing, password: '', passwordUnavailable: true }} onClose={vi.fn()} />)
    expect(screen.getByText(/could not be read because macOS Keychain access was denied/)).toBeTruthy()
    expect(document.querySelector('.msg.warn')).not.toBeNull()
  })

  it('autofocuses the Name field', () => {
    render(<DataSourceDialog initial={null} onClose={vi.fn()} />)
    expect(document.activeElement).toBe(field('Name'))
  })
})
