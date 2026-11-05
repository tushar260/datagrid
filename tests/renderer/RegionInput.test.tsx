// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import RegionInput from '../../src/renderer/src/RegionInput'
import { AWS_REGIONS } from '../../src/shared'

Element.prototype.scrollIntoView = vi.fn()
afterEach(cleanup)

function Host({ initial = '', onChange }: { initial?: string; onChange?: (v: string) => void }): React.JSX.Element {
  const [v, setV] = useState(initial)
  return <RegionInput value={v} onChange={(x) => { setV(x); onChange?.(x) }} placeholder="region" />
}
const input = (): HTMLInputElement => screen.getByRole('combobox') as HTMLInputElement
const options = (): string[] => screen.queryAllByRole('option').map((o) => o.querySelector('.sg-name')!.textContent!)
const selected = (): string => document.querySelector('[aria-selected="true"] .sg-name')!.textContent!
const type = (v: string): void => void fireEvent.change(input(), { target: { value: v } })

describe('RegionInput', () => {
  it('shows every region on focus', () => {
    render(<Host />)
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.focus(input())
    expect(options()).toEqual([...AWS_REGIONS])
  })

  it('fuzzy-filters while typing and ranks the best match first', () => {
    render(<Host />)
    type('ue1')
    expect(options()[0]).toBe('us-east-1')
    type('useast')
    expect(options()).toEqual(['us-east-1', 'us-east-2', 'us-gov-east-1'])
    type('frankfurt')
    expect(options()).toEqual(['eu-central-1'])
    expect(screen.getByRole('option').textContent).toContain('Europe (Frankfurt)')
  })

  it('highlights the matched letters', () => {
    render(<Host />)
    type('ue1')
    const hits = Array.from(document.querySelectorAll('[aria-selected="true"] .sg-hit')).map((b) => b.textContent)
    expect(hits).toEqual(['u', 'e', '1'])
  })

  it('shows no list when nothing matches, and keeps free text (e.g. "local")', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    type('local')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input().value).toBe('local')
    expect(onChange).toHaveBeenLastCalledWith('local')
  })

  it('closes when the typed text is exactly the only candidate', () => {
    render(<Host />)
    type('sa-east-1')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('arrow keys move the highlight (wrapping); Enter picks it and does not bubble as a submit', () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault())
    render(<form onSubmit={onSubmit as never}><Host /></form>)
    type('useast')
    expect(selected()).toBe('us-east-1')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selected()).toBe('us-east-2')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selected()).toBe('us-east-1') // wrapped around
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(selected()).toBe('us-gov-east-1')
    const ev = fireEvent.keyDown(input(), { key: 'Enter' })
    expect(ev).toBe(false) // default prevented: the form is not submitted
    expect(input().value).toBe('us-gov-east-1')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Enter with no open list is left alone (submits the form)', () => {
    render(<Host initial="us-east-1" />)
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(true)
  })

  it('Tab picks the highlighted match (Shift+Tab does not)', () => {
    render(<Host />)
    type('euw2')
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })
    expect(input().value).toBe('euw2')
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(input().value).toBe('eu-west-2')
  })

  it('Escape closes the list only (and stops propagating); without a list it propagates', () => {
    const outer = vi.fn()
    render(<div onKeyDown={outer}><Host /></div>)
    type('eu')
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(outer).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('ArrowDown reopens a closed list; clicking an option picks it; blur closes', () => {
    render(<Host />)
    type('eu')
    fireEvent.keyDown(input(), { key: 'Escape' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(options().length).toBeGreaterThan(1)
    fireEvent.mouseDown(screen.getAllByRole('option')[2])
    expect(AWS_REGIONS).toContain(input().value)
    type('eu')
    fireEvent.blur(input())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('hovering moves the highlight', () => {
    render(<Host />)
    type('eu')
    fireEvent.mouseEnter(screen.getAllByRole('option')[1])
    expect(selected()).toBe(options()[1])
  })

  it('exposes combobox ARIA state', () => {
    render(<Host />)
    expect(input().getAttribute('aria-expanded')).toBe('false')
    type('eu')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBeTruthy()
  })
})
