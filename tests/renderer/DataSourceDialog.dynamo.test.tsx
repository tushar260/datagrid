// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DataSourceDialog from '../../src/renderer/src/DataSourceDialog'
import type { DataSource } from '../../src/shared'
import { installApi, type MockApi } from './helpers/mockApi'

let api: MockApi
beforeEach(() => {
  api = installApi({ dynamo: { profiles: ['default', 'dev', 'prod'] } })
})
afterEach(cleanup)

const field = (label: string | RegExp): HTMLInputElement =>
  screen.getByLabelText(typeof label === 'string' ? new RegExp('^' + label + (label === 'Name' ? '$' : '')) : label) as HTMLInputElement
const queryField = (label: string): HTMLElement | null => screen.queryByLabelText(new RegExp('^' + label))
const typeSelect = (): HTMLSelectElement => screen.getByLabelText('Type') as HTMLSelectElement
const pickType = (user: ReturnType<typeof userEvent.setup>, v: 'postgres' | 'dynamodb'): Promise<void> => user.selectOptions(typeSelect(), v)
const mode = (label: RegExp): HTMLInputElement => screen.getByRole('radio', { name: label }) as HTMLInputElement

const saved = (over: Partial<NonNullable<DataSource['dynamo']>> = {}, top: Partial<DataSource> = {}): DataSource => ({
  id: 'd1', kind: 'dynamodb', name: 'my ddb', host: '', port: 0, user: '', password: '', database: '', ssl: false, folderId: 'f1',
  dynamo: { region: 'eu-west-1', authMode: 'keys', accessKeyId: 'AKIAEXAMPLE', hasSecret: true, hasSessionToken: false, ...over },
  ...top
})

async function newDynamo(folderId?: string | null) {
  const user = userEvent.setup()
  const close = vi.fn()
  render(<DataSourceDialog initial={null} folderId={folderId} onClose={close} />)
  await pickType(user, 'dynamodb')
  return { user, close }
}

describe('type selector', () => {
  it('new sources start as PostgreSQL and can switch type; existing sources cannot', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<DataSourceDialog initial={null} onClose={vi.fn()} />)
    expect(screen.getByRole('heading').textContent).toBe('Data Source: PostgreSQL')
    expect(typeSelect().value).toBe('postgres')
    expect(Array.from(typeSelect().options).map((o) => o.textContent)).toEqual(['PostgreSQL', 'DynamoDB', 'Redis'])
    await pickType(user, 'dynamodb')
    expect(screen.getByRole('heading').textContent).toBe('Data Source: DynamoDB')
    expect(screen.queryByLabelText(/^Host/)).toBeNull()
    unmount()
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    expect(screen.queryByLabelText('Type')).toBeNull()
    expect(screen.getByRole('heading').textContent).toBe('Data Source: DynamoDB')
  })

  it('the default name follows the type until the user edits it', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={null} onClose={vi.fn()} />)
    expect(field('Name').value).toBe('postgres@localhost')
    await pickType(user, 'dynamodb')
    expect(field('Name').value).toBe('dynamodb')
    await pickType(user, 'postgres')
    expect(field('Name').value).toBe('postgres@localhost')
    expect(field('Host').value).toBe('localhost')
    await user.clear(field('Name'))
    await user.type(field('Name'), 'mine')
    await pickType(user, 'dynamodb')
    expect(field('Name').value).toBe('mine')
  })

  it('keeps the folder when switching and clicking the active type is a no-op', async () => {
    const { user } = await newDynamo('fld')
    await pickType(user, 'dynamodb')
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(api.saveSource).toHaveBeenCalled())
    expect(api.saveSource.mock.calls[0][0]).toMatchObject({ kind: 'dynamodb', folderId: 'fld' })
  })
})

describe('authentication modes', () => {
  it('default: only the explanation, region and Advanced', async () => {
    await newDynamo()
    expect(mode(/^Default/).checked).toBe(true)
    expect(screen.getByText(/default credential chain/)).toBeTruthy()
    expect(queryField('Profile')).toBeNull()
    expect(queryField('Access key ID')).toBeNull()
    expect(queryField('Secret access key')).toBeNull()
    expect(field('Region')).toBeTruthy()
  })

  it('profile: a profile box offering the profiles found in ~/.aws', async () => {
    const { user } = await newDynamo()
    await user.click(mode(/Named profile/))
    await waitFor(() => expect(document.querySelectorAll('#ds-aws-profiles option')).toHaveLength(3))
    expect([...document.querySelectorAll('#ds-aws-profiles option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['default', 'dev', 'prod'])
    expect(queryField('Access key ID')).toBeNull()
    expect(screen.queryByText(/default credential chain/)).toBeNull()
    expect(field('Profile').getAttribute('list')).toBe('ds-aws-profiles')
    await user.type(field('Profile'), 'custom-one')
    expect(field('Profile').value).toBe('custom-one') // free text is allowed
  })

  it('profile list failing to load is harmless', async () => {
    api.dynamo.profiles.mockRejectedValue(new Error('x'))
    const { user } = await newDynamo()
    await user.click(mode(/Named profile/))
    expect(field('Profile').placeholder).toContain('type a profile name')
  })

  it('keys: key id, masked secret with Show / Hide, optional session token', async () => {
    const { user } = await newDynamo()
    await user.click(mode(/Access key/))
    expect(field('Access key ID')).toBeTruthy()
    const secret = field('Secret access key')
    expect(secret.type).toBe('password')
    await user.type(secret, 'abc')
    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(secret.type).toBe('text')
    expect(field(/^Session token/).type).toBe('text')
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(secret.type).toBe('password')
    expect(queryField('Profile')).toBeNull()
  })

  it('region offers the common regions and takes free text; Advanced holds the endpoint', async () => {
    const { user } = await newDynamo()
    await user.click(field('Region'))
    const opts = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.querySelector('.sg-name')!.textContent)
    expect(opts).toContain('us-east-1')
    expect(opts).toContain('eu-central-1')
    await user.type(field('Region'), 'my-region-9')
    expect(field('Region').value).toBe('my-region-9')
    expect(screen.queryByRole('listbox')).toBeNull()
    // fuzzy: "frankfurt" -> eu-central-1, picked with Enter (which does not submit the dialog)
    await user.clear(field('Region'))
    await user.type(field('Region'), 'frnkfrt{Enter}')
    expect(field('Region').value).toBe('eu-central-1')
    const details = document.querySelector('details.adv') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toBe('Advanced')
    await user.type(field('Endpoint URL'), 'http://localhost:8000')
    expect(field('Endpoint URL').value).toBe('http://localhost:8000')
  })

  it('Advanced is open when an endpoint is configured', () => {
    render(<DataSourceDialog initial={saved({ authMode: 'default', endpoint: 'http://localhost:8000' })} onClose={vi.fn()} />)
    expect((document.querySelector('details.adv') as HTMLDetailsElement).open).toBe(true)
  })
})

describe('saving and testing a new DynamoDB source', () => {
  it('default mode saves region + authMode only', async () => {
    const { user, close } = await newDynamo('fld')
    await user.type(field('Region'), 'eu-west-1')
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect(api.saveSource.mock.calls[0][0]).toMatchObject({
      id: '', kind: 'dynamodb', name: 'dynamodb', folderId: 'fld', dynamo: { region: 'eu-west-1', authMode: 'default' }
    })
  })

  it('keys mode sends the typed secret and token; Enter submits', async () => {
    const { user, close } = await newDynamo()
    await user.click(mode(/Access key/))
    await user.type(field('Access key ID'), 'AKIAXYZ')
    await user.type(field('Secret access key'), 's3cret')
    await user.type(field(/^Session token/), 'tok{Enter}')
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect(api.saveSource.mock.calls[0][0].dynamo).toMatchObject({
      authMode: 'keys', accessKeyId: 'AKIAXYZ', secretAccessKey: 's3cret', sessionToken: 'tok'
    })
  })

  it('validates before saving: shows the message and does not call the main process', async () => {
    const { user, close } = await newDynamo()
    await user.click(mode(/Access key/))
    await user.click(screen.getByRole('button', { name: 'OK' }))
    expect((await screen.findByText('Access key ID is required')).className).toContain('bad')
    await user.type(field('Access key ID'), 'AKIA')
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText('Secret access key is required')
    await user.click(mode(/Named profile/))
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText('Choose or type a profile name')
    await user.click(mode(/^Default/))
    await user.type(field('Region'), 'Not A Region')
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText(/Invalid region "Not A Region"/)
    await user.clear(field('Region'))
    await user.type(field('Region'), 'us-east-1')
    await user.click(screen.getByText('Advanced'))
    await user.type(field('Endpoint URL'), 'ftp://x')
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText(/Endpoint URL must be an http/)
    expect(api.saveSource).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('Test Connection validates, then reports success or the cleaned error', async () => {
    const { user } = await newDynamo()
    await user.click(mode(/Named profile/))
    await user.click(screen.getByRole('button', { name: 'Test Connection' }))
    await screen.findByText('Choose or type a profile name')
    expect(api.testSource).not.toHaveBeenCalled()

    await user.type(field('Profile'), 'dev')
    api.testSource.mockResolvedValueOnce('Connected. 3 tables visible.')
    await user.click(screen.getByRole('button', { name: 'Test Connection' }))
    expect((await screen.findByText('Succeeded. Connected. 3 tables visible.')).className).toContain('ok')
    expect(api.testSource.mock.calls[0][0]).toMatchObject({ kind: 'dynamodb', dynamo: { authMode: 'profile', profile: 'dev' } })

    api.testSource.mockRejectedValueOnce(new Error("Error invoking remote method 'ds:test': Error: Could not reach http://127.0.0.1:1 (ECONNREFUSED)."))
    await user.click(screen.getByRole('button', { name: 'Test Connection' }))
    expect((await screen.findByText('Could not reach http://127.0.0.1:1 (ECONNREFUSED).')).className).toContain('bad')
  })

  it('Test Connection shows a busy state', async () => {
    const { user } = await newDynamo()
    let done!: (v: string) => void
    api.testSource.mockReturnValueOnce(new Promise<string>((r) => (done = r)))
    await user.click(screen.getByRole('button', { name: 'Test Connection' }))
    expect((screen.getByRole('button', { name: 'Testing…' }) as HTMLButtonElement).disabled).toBe(true)
    done('Connected. 0 tables visible.')
    await screen.findByText(/Succeeded/)
  })

  it('a save error stays in the dialog', async () => {
    api.saveSource.mockRejectedValueOnce(new Error("Error invoking remote method 'ds:save': Error: Invalid region \"x\""))
    const { user, close } = await newDynamo()
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText('Could not save: Invalid region "x"')
    expect(close).not.toHaveBeenCalled()
  })

  it('Escape and the backdrop close without saving', async () => {
    const { user, close } = await newDynamo()
    await user.keyboard('{Escape}')
    expect(close).toHaveBeenCalledWith(false)
    close.mockClear()
    await user.pointer({ target: document.querySelector('.modal-bg')!, keys: '[MouseLeft]' })
    expect(close).toHaveBeenCalledWith(false)
    expect(api.saveSource).not.toHaveBeenCalled()
  })
})

describe('editing a saved DynamoDB source', () => {
  it('shows the saved values; secrets are never prefilled, only hinted', () => {
    render(<DataSourceDialog initial={saved({ hasSessionToken: true })} onClose={vi.fn()} />)
    expect(field('Name').value).toBe('my ddb')
    expect(field('Region').value).toBe('eu-west-1')
    expect(field('Access key ID').value).toBe('AKIAEXAMPLE')
    expect(field('Secret access key').value).toBe('')
    expect(field('Secret access key').placeholder).toBe('saved (leave blank to keep)')
    expect(field(/^Session token/).placeholder).toBe('saved (leave blank to keep)')
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
    expect(mode(/Access key/).checked).toBe(true)
  })

  it('a blank secret is accepted because one is saved, and is not sent', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    render(<DataSourceDialog initial={saved()} onClose={close} />)
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    const sent = api.saveSource.mock.calls[0][0].dynamo
    expect(sent.secretAccessKey ?? '').toBe('')
    expect(sent.sessionToken).toBeUndefined() // undefined = keep
  })

  it('no saved secret: it is required again', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved({ hasSecret: false })} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText('Secret access key is required')
    expect(field('Secret access key').placeholder).toBe('')
  })

  it('typing a new secret replaces it', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    await user.type(field('Secret access key'), 'new{Enter}')
    await waitFor(() => expect(api.saveSource).toHaveBeenCalled())
    expect(api.saveSource.mock.calls[0][0].dynamo.secretAccessKey).toBe('new')
  })

  it('"Clear saved" sends an empty session token (remove) and hides the hint', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved({ hasSessionToken: true })} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Clear saved' }))
    expect(screen.queryByRole('button', { name: 'Clear saved' })).toBeNull()
    expect(field(/^Session token/).placeholder).toBe('')
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(api.saveSource).toHaveBeenCalled())
    expect(api.saveSource.mock.calls[0][0].dynamo.sessionToken).toBe('')
  })

  it('a typed token replaces the saved one; erasing it again goes back to "keep"', async () => {
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved({ hasSessionToken: true })} onClose={vi.fn()} />)
    await user.type(field(/^Session token/), 'abc')
    await user.clear(field(/^Session token/))
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(api.saveSource).toHaveBeenCalled())
    expect(api.saveSource.mock.calls[0][0].dynamo.sessionToken).toBeUndefined()
  })

  it('Delete removes the source', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    render(<DataSourceDialog initial={saved()} onClose={close} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith(true))
    expect(api.deleteSource).toHaveBeenCalledWith('d1')
  })

  it('a failed delete is reported', async () => {
    api.deleteSource.mockRejectedValueOnce(new Error('nope'))
    const user = userEvent.setup()
    render(<DataSourceDialog initial={saved()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('Could not delete: nope')
  })

  it('keychain denied: the warning names the secret access key', () => {
    render(<DataSourceDialog initial={saved({ hasSecret: true }, { passwordUnavailable: true })} onClose={vi.fn()} />)
    const m = screen.getByText(/secret access key could not be read/)
    expect(m.className).toContain('warn')
    expect(m.textContent).toContain('Always Allow')
  })

  it('keychain denied on a Postgres source keeps the original password wording', () => {
    const pg: DataSource = { id: 'p', name: 'p', host: 'h', port: 1, user: 'u', password: '', database: 'd', ssl: false, passwordUnavailable: true }
    render(<DataSourceDialog initial={pg} onClose={vi.fn()} />)
    expect(screen.getByText(/saved password could not be read/)).toBeTruthy()
  })

  it('a profile source shows the profile and no key fields', () => {
    render(<DataSourceDialog initial={saved({ authMode: 'profile', profile: 'dev', hasSecret: false })} onClose={vi.fn()} />)
    expect(field('Profile').value).toBe('dev')
    expect(queryField('Access key ID')).toBeNull()
  })
})
