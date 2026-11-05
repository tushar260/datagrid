// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ListPicker from '../../src/renderer/src/DbPicker'

afterEach(cleanup)

const ALL = ['scrut_a', 'scrut_b', 'my_scrut', 'postgres', 'Scrut_C']

async function setup(over: Partial<React.ComponentProps<typeof ListPicker>> = {}): Promise<{
  onChange: ReturnType<typeof vi.fn>
  user: ReturnType<typeof userEvent.setup>
  checked: () => string[]
}> {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <ListPicker
      x={10} y={10} icon="database" placeholder="Filter" load={async () => ALL} selected={null}
      defaultOf={(a) => a.filter((n) => n !== 'postgres')} onClose={() => {}} onChange={onChange} {...over}
    />
  )
  await screen.findByText('postgres')
  const checked = (): string[] =>
    screen.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked).map((c) => c.closest('label')!.textContent!)
  return { onChange, user, checked }
}

describe('ListPicker', () => {
  it('starts from the default selection and shows an "n of total" counter', async () => {
    const { checked } = await setup()
    expect(checked()).toEqual(['scrut_a', 'scrut_b', 'my_scrut', 'Scrut_C'])
    expect(screen.getByText(/4 of 5 shown/)).toBeTruthy()
  })

  it('starts from the saved selection when there is one', async () => {
    const { checked } = await setup({ selected: ['postgres'] })
    expect(checked()).toEqual(['postgres'])
  })

  it('All / None / Default buttons commit the expected lists', async () => {
    const { user, onChange, checked } = await setup()
    await user.click(screen.getByText('None'))
    expect(checked()).toEqual([])
    expect(onChange).toHaveBeenLastCalledWith([], null)

    await user.click(screen.getByText('All'))
    expect(checked()).toHaveLength(5)
    expect(onChange).toHaveBeenLastCalledWith(ALL, null)

    await user.click(screen.getByText('Default'))
    // equal to the default -> reported as `null` (= "use the default")
    expect(onChange).toHaveBeenLastCalledWith(null, null)
  })

  it('toggling a single item reports the new list', async () => {
    const { user, onChange } = await setup()
    await user.click(screen.getByText('my_scrut'))
    expect(onChange).toHaveBeenLastCalledWith(['scrut_a', 'scrut_b', 'Scrut_C'], null)
  })

  it('the search box filters the visible rows only (not the selection)', async () => {
    const { user, checked } = await setup()
    await user.type(screen.getByPlaceholderText('Filter'), 'POST')
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    await user.clear(screen.getByPlaceholderText('Filter'))
    await user.type(screen.getByPlaceholderText('Filter'), 'zzz')
    expect(screen.getByText('No matches')).toBeTruthy()
    await user.clear(screen.getByPlaceholderText('Filter'))
    expect(checked()).toHaveLength(4)
  })

  it('"Select matching" ticks exactly the items matching the pattern (starts with)', async () => {
    const { user, onChange, checked } = await setup()
    const btn = screen.getByRole('button', { name: 'Select matching' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true) // no pattern yet
    await user.type(screen.getByPlaceholderText('scrut_'), 'scrut_')
    await user.click(btn)
    expect(checked()).toEqual(['scrut_a', 'scrut_b', 'Scrut_C']) // case-insensitive, `my_scrut` excluded
    expect(onChange).toHaveBeenLastCalledWith(['scrut_a', 'scrut_b', 'Scrut_C'], null) // rule not persisted by default
  })

  it('supports contains / ends with / regex modes', async () => {
    const { user, checked } = await setup()
    const mode = screen.getByTitle('Pattern type')
    const pat = screen.getAllByRole('textbox')[1]
    const btn = screen.getByRole('button', { name: 'Select matching' })

    await user.selectOptions(mode, 'contains')
    await user.type(pat, 'scrut')
    await user.click(btn)
    expect(checked()).toEqual(['scrut_a', 'scrut_b', 'my_scrut', 'Scrut_C'])

    await user.selectOptions(mode, 'ends')
    await user.clear(pat)
    await user.type(pat, '_b')
    await user.click(btn)
    expect(checked()).toEqual(['scrut_b'])

    await user.selectOptions(mode, 'regex')
    await user.clear(pat)
    await user.type(pat, '^scrut_[[ab]$')
    await user.click(btn)
    expect(checked()).toEqual(['scrut_a', 'scrut_b'])
  })

  it('an invalid regex disables "Select matching" and flags the input', async () => {
    const { user } = await setup()
    await user.selectOptions(screen.getByTitle('Pattern type'), 'regex')
    const pat = screen.getAllByRole('textbox')[1]
    await user.type(pat, '(')
    expect((screen.getByRole('button', { name: 'Select matching' }) as HTMLButtonElement).disabled).toBe(true)
    expect(pat.className).toContain('bad')
  })

  it('Enter in the pattern box applies it', async () => {
    const { user, checked } = await setup()
    await user.type(screen.getAllByRole('textbox')[1], 'post{Enter}')
    expect(checked()).toEqual(['postgres'])
  })

  it('persistRule saves the rule itself so new matches follow it', async () => {
    const { user, onChange } = await setup({ persistRule: true })
    await user.type(screen.getAllByRole('textbox')[1], 'scrut_')
    await user.click(screen.getByRole('button', { name: 'Select matching' }))
    expect(onChange).toHaveBeenLastCalledWith(['scrut_a', 'scrut_b', 'Scrut_C'], { mode: 'starts', pattern: 'scrut_' })
    expect(screen.getByText(/Rule saved: starts with/)).toBeTruthy()
  })

  it('a saved rule wins over the saved list on open', async () => {
    const { checked } = await setup({ selected: ['postgres'], rule: { mode: 'ends', pattern: '_a' } })
    expect(checked()).toEqual(['scrut_a'])
  })

  it('shows the load error (with the IPC prefix stripped)', async () => {
    const load = async (): Promise<string[]> => {
      throw new Error("Error invoking remote method 'db:list': Error: connection refused")
    }
    render(<ListPicker x={0} y={0} icon="database" placeholder="Filter" load={load} selected={null} defaultOf={(a) => a} onClose={() => {}} onChange={() => {}} />)
    await waitFor(() => expect(screen.getByText('connection refused')).toBeTruthy())
  })

  it('Escape closes the picker', async () => {
    const onClose = vi.fn()
    const { user } = await setup({ onClose })
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})
