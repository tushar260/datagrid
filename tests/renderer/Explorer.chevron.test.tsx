// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Explorer from '../../src/renderer/src/Explorer'
import { Chevron } from '../../src/renderer/src/icons'
import type { DataSource, Folder } from '../../src/shared'
import { installApi } from './helpers/mockApi'

afterEach(cleanup)

const ds: DataSource = { id: 'ds1', name: 'prod', host: 'h', port: 5432, user: 'u', password: '', database: 'app', ssl: false }

describe('Chevron', () => {
  it('is a 12px svg that only carries the open class when open', () => {
    const { container, rerender } = render(<Chevron open={false} />)
    const svg = (): SVGElement => container.querySelector('svg.chevron') as SVGElement
    expect(svg().getAttribute('width')).toBe('12')
    expect(svg().classList.contains('open')).toBe(false)
    rerender(<Chevron open />)
    expect(svg().classList.contains('open')).toBe(true)
  })
})

describe('Explorer disclosure arrows', () => {
  beforeEach(() => {
    installApi({
      listSources: [ds],
      listFolders: [{ id: 'f1', name: 'work', parentId: null } as Folder],
      databases: ['app']
    })
  })

  const renderExplorer = (): void => {
    render(
      <Explorer
        onOpen={vi.fn()} onEdit={vi.fn()} onConsole={vi.fn()} onTableRenamed={vi.fn()} onObjectGone={vi.fn()}
        onRefreshed={vi.fn()} reloadKey={0}
      />
    )
  }
  const chevronOf = (id: string): Element =>
    document.querySelector(`.tree-row[data-id="${id}"] .arrow .chevron`) as Element

  it('data source row: chevron renders closed (no text glyph), toggles open on click without double-click needed', async () => {
    renderExplorer()
    await screen.findByText('prod')
    const row = document.querySelector('.tree-row[data-id="ds1"]') as HTMLElement
    const arrow = row.querySelector('.arrow') as HTMLElement
    expect(arrow.textContent).toBe('')
    expect(chevronOf('ds1').classList.contains('open')).toBe(false)
    fireEvent.click(arrow)
    await waitFor(() => expect(chevronOf('ds1').classList.contains('open')).toBe(true))
    fireEvent.click(row.querySelector('.arrow') as HTMLElement)
    await waitFor(() => expect(chevronOf('ds1').classList.contains('open')).toBe(false))
  })

  it('folder row uses the same chevron and toggles it', async () => {
    renderExplorer()
    await screen.findByText('work')
    expect(chevronOf('folder:f1').classList.contains('open')).toBe(false)
    fireEvent.click(document.querySelector('.tree-row[data-id="folder:f1"] .arrow') as HTMLElement)
    await waitFor(() => expect(chevronOf('folder:f1').classList.contains('open')).toBe(true))
  })
})
