// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Explorer from '../../src/renderer/src/Explorer'
import type { DataSource, Folder } from '../../src/shared'
import { installApi } from './helpers/mockApi'

afterEach(cleanup)
beforeEach(() => localStorage.clear())

const ds = (id: string, name: string, folderId: string | null = null): DataSource => ({
  id, name, host: 'h', port: 5432, user: 'u', password: '', database: 'app', ssl: false, folderId
})
const folders: Folder[] = [
  { id: 'f1', name: 'work', parentId: null },
  { id: 'f2', name: 'sub', parentId: 'f1' }
]

/** renders the Explorer; `reload()` bumps reloadKey so it re-reads the sources/folders */
const mount = (): { reload: () => void } => {
  const el = (key: number): React.JSX.Element => (
    <Explorer onOpen={vi.fn()} onEdit={vi.fn()} onConsole={vi.fn()} onTableRenamed={vi.fn()} onObjectGone={vi.fn()} onRefreshed={vi.fn()} reloadKey={key} />
  )
  let key = 0
  const r = render(el(key))
  return { reload: () => r.rerender(el(++key)) }
}

/** data-ids of all rows, in DOM order */
const order = (): string[] => [...document.querySelectorAll('.tree-row')].map((r) => (r as HTMLElement).dataset.id as string)
const openFolder = async (id: string): Promise<void> => {
  fireEvent.click(document.querySelector(`.tree-row[data-id="${id}"] .arrow`) as HTMLElement)
  await waitFor(() => expect(document.querySelector(`.tree-row[data-id="${id}"] .chevron.open`)).toBeTruthy())
}

describe('Explorer: data sources inside folders are alphabetical', () => {
  it('sorts case-insensitively and numerically, subfolders stay before sources, root keeps stored order', async () => {
    installApi({
      listSources: [
        ds('r2', 'zroot'), ds('a', 'pg10', 'f1'), ds('b', 'Beta', 'f1'), ds('c', 'pg2', 'f1'), ds('d', 'alpha', 'f1'), ds('e', 'inner', 'f2'),
        ds('r1', 'Aroot')
      ],
      listFolders: folders
    })
    mount()
    await screen.findByText('work')
    await openFolder('folder:f1')
    await openFolder('folder:f2')
    expect(order()).toEqual(['folder:f1', 'folder:f2', 'e', 'd', 'b', 'c', 'a', 'r2', 'r1'])
  })

  it('a renamed source re-sorts and a new source lands in the right place', async () => {
    const list = [ds('a', 'apple', 'f1'), ds('b', 'cherry', 'f1'), ds('c', 'db2', 'f1')]
    const api = installApi({ listSources: list, listFolders: [folders[0]] })
    const r = mount()
    await screen.findByText('work')
    await openFolder('folder:f1')
    expect(order()).toEqual(['folder:f1', 'a', 'b', 'c'])

    // rename 'apple' -> 'zebra'
    api.listSources.mockImplementation(async () => [ds('a', 'zebra', 'f1'), list[1], list[2]])
    r.reload()
    await waitFor(() => expect(order()).toEqual(['folder:f1', 'b', 'c', 'a']))

    // new source 'Banana' and 'db10' (after db2, numerically)
    api.listSources.mockImplementation(async () => [ds('a', 'zebra', 'f1'), list[1], list[2], ds('n', 'Banana', 'f1'), ds('m', 'db10', 'f1')])
    r.reload()
    await waitFor(() => expect(order()).toEqual(['folder:f1', 'n', 'b', 'c', 'm', 'a']))

    // moved out of the folder: it leaves the folder and goes to the root
    api.listSources.mockImplementation(async () => [ds('a', 'zebra'), list[1], list[2]])
    r.reload()
    await waitFor(() => expect(order()).toEqual(['folder:f1', 'b', 'c', 'a']))
  })
})
