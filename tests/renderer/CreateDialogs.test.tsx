// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CreateDialog, { type CreateReq } from '../../src/renderer/src/CreateDialogs'
import { installApi, type MockApi } from './helpers/mockApi'

let api: MockApi
beforeEach(() => {
  api = installApi({ roles: ['alice', 'bob'] })
})
afterEach(cleanup)

const open = (req: CreateReq, onClose = vi.fn()): ReturnType<typeof vi.fn> => {
  render(<CreateDialog req={req} onClose={onClose} />)
  return onClose
}
const nameInput = (): HTMLInputElement => screen.getByLabelText(/^Name/) as HTMLInputElement
const preview = (): string => (document.querySelector('textarea.ddl-preview') as HTMLTextAreaElement).value
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll('.cd-cols .cd-row:not(.cd-head)'))
const create = (): HTMLButtonElement => screen.getByRole('button', { name: /^(Create|Add|Creating…)$/ }) as HTMLButtonElement

describe('CreateDialog – database', () => {
  const req: CreateReq = { kind: 'database', dsId: 'd1' }

  it('renders into document.body (portal), titled, with roles loaded for the owner datalist', async () => {
    open(req)
    expect(screen.getByRole('heading').textContent).toBe('New Database')
    expect(document.body.querySelector('.cd-bg')!.parentElement).toBe(document.body)
    await waitFor(() => expect(document.querySelectorAll('#dgl-roles option')).toHaveLength(2))
    expect(api.roles).toHaveBeenCalledWith('d1')
  })

  it('empty name shows "Name is required" and does not call the API', async () => {
    const user = userEvent.setup()
    const close = open(req)
    await user.click(create())
    expect(screen.getByText('Name is required')).toBeTruthy()
    expect(api.createDatabase).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('Enter submits (trimmed name, blank owner -> undefined) and closes with created=true', async () => {
    const user = userEvent.setup()
    const close = open(req)
    await user.type(nameInput(), '  mydb  {Enter}')
    await waitFor(() => expect(close).toHaveBeenCalledWith(true, 'mydb'))
    expect(api.createDatabase).toHaveBeenCalledWith('d1', 'mydb', undefined)
  })

  it('passes a trimmed owner through', async () => {
    const user = userEvent.setup()
    const close = open(req)
    await user.type(nameInput(), 'x')
    await user.type(screen.getByLabelText(/^Owner/), ' alice ')
    await user.click(create())
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(api.createDatabase).toHaveBeenCalledWith('d1', 'x', 'alice')
  })

  it('server error stays open, strips the IPC prefix, and re-enables the button', async () => {
    api.createDatabase.mockRejectedValueOnce(new Error("Error invoking remote method 'db:createDatabase': Error: database \"x\" already exists"))
    const user = userEvent.setup()
    const close = open(req)
    await user.type(nameInput(), 'x{Enter}')
    await screen.findByText('database "x" already exists')
    expect(close).not.toHaveBeenCalled()
    expect(create().disabled).toBe(false)
    expect(create().textContent).toBe('Create')
    // retry succeeds and clears the error
    await user.click(create())
    await waitFor(() => expect(close).toHaveBeenCalledWith(true, 'x'))
  })

  it('disables the button and ignores double submits while busy', async () => {
    let resolve!: () => void
    api.createDatabase.mockImplementation(() => new Promise<void>((r) => (resolve = r)))
    const user = userEvent.setup()
    const close = open(req)
    await user.type(nameInput(), 'x{Enter}')
    await waitFor(() => expect(create().disabled).toBe(true))
    expect(create().textContent).toBe('Creating…')
    fireEvent.submit(document.querySelector('form')!)
    expect(api.createDatabase).toHaveBeenCalledTimes(1)
    resolve()
    await waitFor(() => expect(close).toHaveBeenCalledWith(true, 'x'))
  })

  it('Escape closes with created=false; Cancel and backdrop mouse-down too; clicks inside the modal do not', async () => {
    const user = userEvent.setup()
    const close = open(req)
    await user.keyboard('{Escape}')
    expect(close).toHaveBeenLastCalledWith(false)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(document.querySelector('.modal-bg')!)
    expect(close).toHaveBeenCalledTimes(3)
    fireEvent.mouseDown(document.querySelector('.modal')!)
    fireEvent.mouseDown(nameInput())
    expect(close).toHaveBeenCalledTimes(3)
  })

  it('a failing roles lookup is ignored', async () => {
    api.roles.mockRejectedValueOnce(new Error('no'))
    open(req)
    await waitFor(() => expect(api.roles).toHaveBeenCalled())
    expect(screen.getByRole('heading').textContent).toBe('New Database')
  })

  it('removes its Escape listener on unmount', () => {
    const close = vi.fn()
    const { unmount } = render(<CreateDialog req={req} onClose={close} />)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })
})

describe('CreateDialog – schema', () => {
  const req: CreateReq = { kind: 'schema', dsId: 'd1', database: 'mydb' }

  it('titled with the database, owner label is "Authorization"', () => {
    open(req)
    expect(screen.getByRole('heading').textContent).toBe('New Schema in mydb')
    expect(screen.getByLabelText(/^Authorization/)).toBeTruthy()
  })

  it('submits name + owner', async () => {
    const user = userEvent.setup()
    const close = open(req)
    await user.type(nameInput(), 'sch')
    await user.type(screen.getByLabelText(/^Authorization/), 'bob{Enter}')
    await waitFor(() => expect(close).toHaveBeenCalledWith(true, 'sch'))
    expect(api.createSchema).toHaveBeenCalledWith('d1', 'mydb', 'sch', 'bob')
  })

  it('requires a name', async () => {
    const user = userEvent.setup()
    open(req)
    await user.type(nameInput(), '   {Enter}')
    expect(screen.getByText('Name is required')).toBeTruthy()
    expect(api.createSchema).not.toHaveBeenCalled()
  })
})

describe('CreateDialog – table', () => {
  const req: CreateReq = { kind: 'table', dsId: 'd1', database: 'mydb', schema: 'public' }

  it('starts with an "id serial" primary key row and a live preview that asks for a name first', () => {
    open(req)
    expect(screen.getByRole('heading').textContent).toBe('New Table in public')
    expect(rows()).toHaveLength(1)
    expect((within(rows()[0]).getByPlaceholderText('name') as HTMLInputElement).value).toBe('id')
    expect(preview()).toBe('-- Table name is required')
  })

  it('DDL preview updates live as name / columns / flags / defaults change', async () => {
    const user = userEvent.setup()
    open(req)
    await user.type(nameInput(), 'people')
    expect(preview()).toBe('create table "public"."people" (\n  "id" serial not null,\n  primary key ("id")\n);')
    await user.click(screen.getByRole('button', { name: '+ Add Column' }))
    expect(preview()).toBe('-- Column 2: name is required')
    const r2 = rows()[1]
    await user.type(within(r2).getByPlaceholderText('name'), 'full name')
    const type = within(r2).getByPlaceholderText('type') as HTMLInputElement
    await user.clear(type)
    await user.type(type, 'varchar(10)')
    await user.type(within(r2).getByPlaceholderText('default (optional)'), "'x'")
    expect(preview()).toContain(`"full name" varchar(10) default 'x'`)
    await user.click(within(r2).getByTitle('Nullable'))
    expect(preview()).toContain(`"full name" varchar(10) default 'x' not null`)
  })

  it('PK checkbox forces not-null (nullable box checked-off and disabled) and unchecking restores editing', async () => {
    const user = userEvent.setup()
    open(req)
    await user.click(screen.getByRole('button', { name: '+ Add Column' }))
    const r2 = rows()[1]
    const nullable = within(r2).getByTitle('Nullable') as HTMLInputElement
    const pk = within(r2).getByTitle('Primary key') as HTMLInputElement
    expect(nullable.checked).toBe(true)
    await user.click(pk)
    expect(pk.checked).toBe(true)
    expect(nullable.checked).toBe(false)
    expect(nullable.disabled).toBe(true)
    await user.click(pk)
    expect(nullable.disabled).toBe(false)
    expect(nullable.checked).toBe(false) // stays not-null until the user opts back in
    await user.click(nullable)
    expect(nullable.checked).toBe(true)
  })

  it('add and remove column rows; removing every row asks for at least one column', async () => {
    const user = userEvent.setup()
    open(req)
    await user.type(nameInput(), 't')
    await user.click(screen.getByRole('button', { name: '+ Add Column' }))
    await user.click(screen.getByRole('button', { name: '+ Add Column' }))
    expect(rows()).toHaveLength(3)
    await user.click(within(rows()[1]).getByTitle('Remove column'))
    expect(rows()).toHaveLength(2)
    await user.click(within(rows()[0]).getByTitle('Remove column'))
    await user.click(within(rows()[0]).getByTitle('Remove column'))
    expect(rows()).toHaveLength(0)
    expect(preview()).toBe('-- Add at least one column')
  })

  it('invalid definition shows the validation error on submit and never calls the API', async () => {
    const user = userEvent.setup()
    open(req)
    await user.type(nameInput(), 't')
    await user.click(screen.getByRole('button', { name: '+ Add Column' })) // blank second column
    await user.click(create())
    expect(document.querySelector('.cd-error')!.textContent).toBe('Column 2: name is required')
    expect(api.createTable).not.toHaveBeenCalled()
  })

  it('rejects an injection-y type and default via validation', async () => {
    const user = userEvent.setup()
    open(req)
    await user.type(nameInput(), 't')
    const r1 = rows()[0]
    const type = within(r1).getByPlaceholderText('type')
    await user.clear(type)
    await user.type(type, 'int); drop table x; --')
    expect(preview()).toMatch(/^-- Column "id": invalid type/)
    await user.clear(type)
    await user.type(type, 'int')
    await user.type(within(r1).getByPlaceholderText('default (optional)'), '1; select 1')
    expect(preview()).toMatch(/default must not contain/)
  })

  it('Enter in the name field submits the columns and closes with the trimmed name', async () => {
    const user = userEvent.setup()
    const close = open(req)
    await user.type(nameInput(), ' people {Enter}')
    await waitFor(() => expect(close).toHaveBeenCalledWith(true, 'people'))
    expect(api.createTable).toHaveBeenCalledWith('d1', 'mydb', 'public', 'people', [
      { name: 'id', type: 'serial', nullable: false, isPk: true, default: '' }
    ])
  })

  it('a server error keeps the dialog open with the message (and the DDL preview intact)', async () => {
    api.createTable.mockRejectedValueOnce(new Error('relation "people" already exists'))
    const user = userEvent.setup()
    const close = open(req)
    await user.type(nameInput(), 'people{Enter}')
    await screen.findByText('relation "people" already exists')
    expect(close).not.toHaveBeenCalled()
    expect(preview()).toContain('create table "public"."people"')
  })

  it('has the wide layout class and a datalist of common types', () => {
    open(req)
    expect(document.querySelector('.cd-modal')!.classList.contains('cd-table')).toBe(true)
    const types = Array.from(document.querySelectorAll('#dgl-pg-types option')).map((o) => o.getAttribute('value'))
    expect(types).toEqual(expect.arrayContaining(['integer', 'text', 'uuid', 'jsonb', 'timestamptz']))
  })
})

describe('CreateDialog – column', () => {
  const req: CreateReq = { kind: 'column', dsId: 'd1', database: 'mydb', schema: 's', table: 'people' }

  it('titled schema.table; button says Add; no PK checkbox; preview starts with the name error', () => {
    open(req)
    expect(screen.getByRole('heading').textContent).toBe('New Column in s.people')
    expect(create().textContent).toBe('Add')
    expect(screen.queryByTitle('Primary key')).toBeNull()
    expect(preview()).toBe('-- Column 1: name is required')
  })

  it('preview follows edits and Enter submits through addColumn', async () => {
    const user = userEvent.setup()
    const close = open(req)
    await user.type(screen.getByPlaceholderText('name'), 'age{Enter}')
    await waitFor(() => expect(close).toHaveBeenCalledWith(true, ''))
    expect(api.addColumn).toHaveBeenCalledWith('d1', 'mydb', 's', 'people', { name: 'age', type: 'text', nullable: true, isPk: false, default: '' })
  })

  it('preview shows the ALTER with not null / default', async () => {
    const user = userEvent.setup()
    open(req)
    await user.type(screen.getByPlaceholderText('name'), 'age')
    await user.type(screen.getByPlaceholderText('default (optional)'), '0')
    await user.click(document.querySelector('input[title="Nullable"]')!)
    expect(preview()).toBe('alter table "s"."people" add column "age" text default 0 not null;')
  })

  it('errors from addColumn are shown', async () => {
    api.addColumn.mockRejectedValueOnce(new Error('column "age" of relation "people" already exists'))
    const user = userEvent.setup()
    open(req)
    await user.type(screen.getByPlaceholderText('name'), 'age{Enter}')
    await screen.findByText(/already exists/)
  })

  it('does not fetch roles for table/column dialogs', () => {
    open(req)
    expect(api.roles).not.toHaveBeenCalled()
  })
})
