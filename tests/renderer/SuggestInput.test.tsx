// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SuggestInput from '../../src/renderer/src/SuggestInput'
import type { Column } from '../../src/shared'

// jsdom has no layout: the component scrolls the active option into view
Element.prototype.scrollIntoView = vi.fn()
afterEach(cleanup)

const cols: Column[] = [
  { name: 'id', type: 'integer', nullable: false, isPk: true },
  { name: 'name', type: 'text', nullable: true, isPk: false },
  { name: 'nickname', type: 'text', nullable: true, isPk: false },
  { name: 'order', type: 'int4', nullable: true, isPk: false }
]

function Harness(props: { initial?: string; mode?: 'where' | 'order'; onKeyDown?: (e: React.KeyboardEvent) => void }): React.JSX.Element {
  const [v, setV] = useState(props.initial ?? '')
  return <SuggestInput value={v} onChange={setV} columns={cols} mode={props.mode ?? 'where'} onKeyDown={props.onKeyDown} />
}
const box = (): HTMLInputElement => screen.getByRole('combobox') as HTMLInputElement
const options = (): string[] => screen.queryAllByRole('option').map((o) => o.querySelector('.sg-name')!.textContent!)

describe('SuggestInput', () => {
  it('opens a list while typing, ranked prefix-first, and nothing for an empty box', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.click(box())
    await user.keyboard('n')
    expect(box().getAttribute('aria-expanded')).toBe('true')
    expect(options()).toEqual(['name', 'nickname', 'not']) // columns first, then keywords
  })

  it('shows the PK badge and type for each column', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'i')
    const first = screen.getAllByRole('option')[0]
    expect(first.textContent).toContain('id')
    expect(first.querySelector('.sg-pk')).not.toBeNull()
    expect(first.querySelector('.sg-type')!.textContent).toBe('integer')
  })

  it('ArrowDown moves the selection (wrapping) and Enter accepts it without leaking Enter to the parent', async () => {
    const user = userEvent.setup()
    const parentKey = vi.fn()
    render(<Harness onKeyDown={(e) => parentKey(e.key)} />)
    await user.type(box(), 'n')
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowUp}') // wraps backwards to the last item ('not')
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowDown}') // and forwards to the first
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')

    parentKey.mockClear()
    await user.keyboard('{Enter}')
    expect(box().value).toBe('nickname')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(parentKey).not.toHaveBeenCalledWith('Enter') // "Enter must not apply the filter" while open
  })

  it('Enter applies the filter (reaches the parent) once the list is closed', async () => {
    const user = userEvent.setup()
    const parentKey = vi.fn()
    render(<Harness initial="id = 1" onKeyDown={(e) => parentKey(e.key)} />)
    await user.click(box())
    await user.keyboard('{Enter}')
    expect(parentKey).toHaveBeenCalledWith('Enter')
  })

  it('Tab accepts too; Shift+Tab does not', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness />)
    await user.type(box(), 'na')
    await user.keyboard('{Tab}')
    expect(box().value).toBe('name')
    unmount()

    render(<Harness />)
    await user.type(box(), 'na')
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(box().value).toBe('na')
  })

  it('replaces only the word at the caret and keeps the rest of the expression', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'id = 1 and nic')
    expect(options()).toEqual(['nickname'])
    await user.keyboard('{Enter}')
    expect(box().value).toBe('id = 1 and nickname')
  })

  it('quotes reserved words on accept', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'ord')
    expect(options()).toContain('order')
    await user.keyboard('{Enter}')
    expect(box().value).toBe('"order"')
  })

  it('Escape closes the list but keeps the text', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'na')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box().value).toBe('na')
  })

  it('does not suggest inside a string literal', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), "name = 'ni")
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('clicking an option accepts it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'ni')
    await user.click(screen.getByRole('option'))
    expect(box().value).toBe('nickname')
  })

  it('Ctrl+Space opens all columns + keywords in ORDER BY mode', async () => {
    const user = userEvent.setup()
    render(<Harness mode="order" />)
    await user.click(box())
    await user.keyboard('{Control>} {/Control}')
    expect(options()).toEqual(['id', 'name', 'nickname', 'order', 'asc', 'desc', 'nulls first', 'nulls last'])
  })

  it('offers keywords after columns and inserts them with a trailing space', async () => {
    const user = userEvent.setup()
    render(<Harness mode="order" />)
    await user.type(box(), 'name nu')
    expect(options()).toEqual(['nulls first', 'nulls last'])
    await user.keyboard('{ArrowDown}{Enter}')
    expect(box().value).toBe('name nulls last ')
  })
})
