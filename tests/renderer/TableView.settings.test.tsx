// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import TableView from '../../src/renderer/src/TableView'
import type { TableRef } from '../../src/renderer/src/Explorer'
import type { RowsQuery } from '../../src/shared'
import { resetSettings, updateSettings } from '../../src/renderer/src/lib/settings'
import { installApi, type MockApi } from './helpers/mockApi'

Element.prototype.scrollIntoView = vi.fn()

let api: MockApi
let n = 0
const fresh = (): TableRef => ({ dsId: 'ds', dsName: 'Local', database: 'app', schema: 'public', table: 'ts' + ++n, kind: 'table' })
const COLS = [
  { name: 'id', type: 'integer', nullable: false, isPk: true },
  { name: 'note', type: 'text', nullable: true, isPk: false }
]

beforeEach(() => {
  localStorage.clear()
  resetSettings()
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  api = installApi({
    rows: async () => ({ columns: COLS, rows: [{ id: '1', note: null }], total: 1 }),
    indexes: []
  })
})
afterEach(() => {
  cleanup()
  resetSettings()
})

const mount = async (): Promise<void> => {
  render(<TableView t={fresh()} />)
  await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(1))
}
const nullCell = (): HTMLElement => document.querySelector('td.null') as HTMLElement

describe('TableView: settings', () => {
  it('shows NULL with the configured text (default "null")', async () => {
    await mount()
    expect(nullCell().textContent).toBe('null')
    cleanup()
    updateSettings({ nullText: '[null]' })
    await mount()
    expect(nullCell().textContent).toBe('[null]')
  })

  it('changing the NULL text re-renders an open grid', async () => {
    await mount()
    expect(nullCell().textContent).toBe('null')
    const { act } = await import('@testing-library/react')
    act(() => void updateSettings({ nullText: '∅' }))
    expect(nullCell().textContent).toBe('∅')
  })

  it('uses the default rows per page for a table without saved view state', async () => {
    updateSettings({ pageSize: 500 })
    await mount()
    expect((api.rows.mock.calls.at(-1)![0] as RowsQuery).limit).toBe(500)
  })

  it('rows per page defaults to 100', async () => {
    await mount()
    expect((api.rows.mock.calls.at(-1)![0] as RowsQuery).limit).toBe(100)
  })
})
