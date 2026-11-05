// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettingsDialog from '../../src/renderer/src/SettingsDialog'
import SettingsButton from '../../src/renderer/src/SettingsButton'
import { DEFAULT_SETTINGS, getSettings, resetSettings, updateSettings } from '../../src/renderer/src/lib/settings'
import { resetLastSection } from '../../src/renderer/src/lib/settingsSections'
import { installApi } from './helpers/mockApi'

beforeEach(() => {
  localStorage.clear()
  resetSettings()
  resetLastSection()
  installApi()
})
afterEach(cleanup)

const sel = (label: string): HTMLSelectElement => screen.getByLabelText(label) as HTMLSelectElement
const root = (): HTMLElement => document.documentElement
/** Settings are split into sections: switch to the one that holds the setting under test. */
const open = (name: string): void => void fireEvent.click(screen.getByRole('tab', { name }))

describe('SettingsDialog', () => {
  it('shows the current settings', () => {
    render(<SettingsDialog onClose={() => {}} />)
    expect(sel('Animations').value).toBe('system')
    open('Fonts')
    expect(sel('Interface font').value).toBe('google')
    expect(sel('Editor & grid font').value).toBe('google')
    expect(sel('Interface font size').value).toBe('13')
    expect(sel('Editor and grid font size').value).toBe('12')
    open('Data grid')
    expect(sel('Row density').value).toBe('normal')
    expect(sel('Rows per page (new tables)').value).toBe('100')
    expect(sel('Show NULL as').value).toBe('null')
    open('General')
    expect((screen.getByLabelText('Reopen previous tabs on launch') as HTMLInputElement).checked).toBe(true)
  })

  it('offers Google Sans, macOS and Linux fonts for the interface and the editor', () => {
    render(<SettingsDialog onClose={() => {}} />)
    open('Fonts')
    const labels = (s: HTMLSelectElement): string[] => Array.from(s.options).map((o) => o.textContent ?? '')
    expect(labels(sel('Interface font'))).toEqual(['Google Sans', 'macOS (San Francisco)', 'Linux (system UI)'])
    expect(labels(sel('Editor & grid font'))).toEqual(['Google Sans Code', 'macOS (SF Mono / Menlo)', 'Linux (DejaVu / Ubuntu Mono)'])
  })

  it('applies a font change immediately and saves it', () => {
    render(<SettingsDialog onClose={() => {}} />)
    open('Fonts')
    fireEvent.change(sel('Interface font'), { target: { value: 'macos' } })
    expect(getSettings().uiFont).toBe('macos')
    expect(root().style.getPropertyValue('--ui-font')).toContain('-apple-system')
    fireEvent.change(sel('Interface font'), { target: { value: 'linux' } })
    expect(root().style.getPropertyValue('--ui-font')).toContain('Ubuntu')
    fireEvent.change(sel('Editor & grid font'), { target: { value: 'linux' } })
    expect(root().style.getPropertyValue('--mono')).toContain('DejaVu')
    expect(JSON.parse(localStorage.getItem('datagrip-lite:settings')!).settings).toMatchObject({ uiFont: 'linux', monoFont: 'linux' })
  })

  it('changes sizes, density, page size, NULL text, animations and tab restore', () => {
    render(<SettingsDialog onClose={() => {}} />)
    open('Fonts')
    fireEvent.change(sel('Interface font size'), { target: { value: '16' } })
    fireEvent.change(sel('Editor and grid font size'), { target: { value: '15' } })
    open('Data grid')
    fireEvent.change(sel('Row density'), { target: { value: 'compact' } })
    fireEvent.change(sel('Rows per page (new tables)'), { target: { value: '500' } })
    fireEvent.change(sel('Show NULL as'), { target: { value: '∅' } })
    open('Appearance')
    fireEvent.change(sel('Animations'), { target: { value: 'off' } })
    open('General')
    fireEvent.click(screen.getByLabelText('Reopen previous tabs on launch'))
    expect(getSettings()).toEqual({
      ...DEFAULT_SETTINGS, uiSize: 16, monoSize: 15, density: 'compact', pageSize: 500, nullText: '∅', motion: 'off', restoreTabs: false
    })
    expect(root().style.getPropertyValue('--ui-fs')).toBe('16px')
    expect(root().style.getPropertyValue('--grid-fs')).toBe('15px')
    expect(root().style.getPropertyValue('--row-h')).toBe('18px')
    expect(root().classList.contains('no-motion')).toBe(true)
  })

  it('Reset to defaults restores everything (from any section)', () => {
    render(<SettingsDialog onClose={() => {}} />)
    open('Fonts')
    fireEvent.change(sel('Interface font'), { target: { value: 'linux' } })
    fireEvent.change(sel('Interface font size'), { target: { value: '17' } })
    fireEvent.click(screen.getByText('Reset to defaults'))
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(sel('Interface font').value).toBe('google')
    expect(sel('Interface font size').value).toBe('13')
  })

  it('closes with Done, Escape and a click on the backdrop, but not on a click inside', () => {
    const onClose = vi.fn()
    render(<SettingsDialog onClose={onClose} />)
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Done'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(document.querySelector('.modal-bg')!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('stops listening for Escape after unmount', () => {
    const onClose = vi.fn()
    const { unmount } = render(<SettingsDialog onClose={onClose} />)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('SettingsDialog: display size and font size', () => {
  const setPlatform = (p: string): void => void Object.defineProperty(navigator, 'platform', { value: p, configurable: true })
  afterEach(() => void delete (navigator as unknown as Record<string, unknown>).platform)
  const btn = (name: string): HTMLButtonElement => screen.getByLabelText(name) as HTMLButtonElement
  const flush = (): Promise<void> => act(async () => {})

  it('display size shows the current zoom and steps / resets through api.zoomStep', async () => {
    const api = installApi({ zoomGet: 125 })
    render(<SettingsDialog onClose={() => {}} />)
    await flush()
    expect(screen.getByRole('group', { name: 'Display size' }).textContent).toContain('125%')
    fireEvent.click(btn('Zoom in'))
    expect(api.zoomStep).toHaveBeenLastCalledWith('in')
    fireEvent.click(btn('Zoom out'))
    expect(api.zoomStep).toHaveBeenLastCalledWith('out')
    fireEvent.click(btn('Reset display size'))
    expect(api.zoomStep).toHaveBeenLastCalledWith('reset')
  })

  it('display size follows zoom events (menu / keyboard) while the dialog is open and unsubscribes on close', async () => {
    const api = installApi({ zoomGet: 100 })
    const { unmount } = render(<SettingsDialog onClose={() => {}} />)
    await flush()
    expect(btn('Reset display size').disabled).toBe(true)
    act(() => api._zoom.forEach((f) => f(150)))
    expect(screen.getByRole('group', { name: 'Display size' }).textContent).toContain('150%')
    expect(btn('Reset display size').disabled).toBe(false)
    unmount()
    expect(api._zoom).toHaveLength(0)
  })

  it('zoom buttons are disabled at the limits', async () => {
    installApi({ zoomGet: 500 })
    const { unmount } = render(<SettingsDialog onClose={() => {}} />)
    await flush()
    expect(btn('Zoom in').disabled).toBe(true)
    unmount()
    installApi({ zoomGet: 25 })
    render(<SettingsDialog onClose={() => {}} />)
    await flush()
    expect(btn('Zoom out').disabled).toBe(true)
  })

  it('shows the shortcuts (macOS and others)', async () => {
    setPlatform('MacIntel')
    installApi()
    const { unmount } = render(<SettingsDialog onClose={() => {}} />)
    await flush()
    expect(screen.getByTestId('zoom-keys').textContent).toBe('⌘− ⌘+ ⌘0')
    expect(screen.getByTestId('font-keys').textContent).toBe('⌥⌘− ⌥⌘+ ⌥⌘0')
    unmount()
    setPlatform('Linux x86_64')
    render(<SettingsDialog onClose={() => {}} />)
    await flush()
    expect(screen.getByTestId('zoom-keys').textContent).toBe('Ctrl+− Ctrl++ Ctrl+0')
    expect(screen.getByTestId('font-keys').textContent).toBe('Ctrl+Alt+− Ctrl+Alt++ Ctrl+Alt+0')
  })

  it('font size buttons move both sizes together and reset to the defaults', async () => {
    installApi()
    render(<SettingsDialog onClose={() => {}} />)
    await flush()
    fireEvent.click(btn('Increase font size'))
    fireEvent.click(btn('Increase font size'))
    expect(getSettings()).toMatchObject({ uiSize: 15, monoSize: 14 })
    expect(screen.getByRole('group', { name: 'Font size' }).textContent).toContain('15 px')
    fireEvent.click(btn('Decrease font size'))
    expect(getSettings()).toMatchObject({ uiSize: 14, monoSize: 13 })
    open('Fonts')
    expect(sel('Interface font size').value).toBe('14')
    open('Appearance')
    fireEvent.click(btn('Reset font size'))
    expect(getSettings()).toMatchObject({ uiSize: 13, monoSize: 12 })
    expect(btn('Reset font size').disabled).toBe(true)
  })
})

describe('SettingsButton', () => {
  it('has a Settings tooltip with the shortcut and calls the handler', () => {
    const onClick = vi.fn()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    render(<SettingsButton onClick={onClick} />)
    const b = document.querySelector('.settings-btn') as HTMLButtonElement
    expect(b.getAttribute('data-tip')).toBe('Settings')
    expect(b.getAttribute('data-tip2')).toBe('⌘,')
    fireEvent.click(b)
    expect(onClick).toHaveBeenCalledTimes(1)
    delete (navigator as unknown as Record<string, unknown>).platform
  })
})

describe('SettingsDialog: cached database objects', () => {
  it('has a checkbox, on by default, that turns the cache off and on', () => {
    render(<SettingsDialog onClose={() => {}} />)
    open('Cache')
    const box = screen.getByLabelText('Cache database objects locally (faster start)') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(getSettings().cacheObjects).toBe(false)
    expect(box.checked).toBe(false)
    expect(JSON.parse(localStorage.getItem('datagrip-lite:settings')!).settings.cacheObjects).toBe(false)
    fireEvent.click(box)
    expect(getSettings().cacheObjects).toBe(true)
  })

  it('"Clear cached objects" clears the stored lists and says so', async () => {
    const api = installApi()
    render(<SettingsDialog onClose={() => {}} />)
    open('Cache')
    expect(screen.getByTestId('cache-status').textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Clear cached objects' }))
    await waitFor(() => expect(screen.getByTestId('cache-status').textContent).toBe('Cleared'))
    expect(api.cache.clear).toHaveBeenCalledTimes(1)
  })

  it('"Clear cached objects" does not touch the checkbox (it works with the cache off too)', async () => {
    installApi()
    updateSettings({ cacheObjects: false })
    render(<SettingsDialog onClose={() => {}} />)
    open('Cache')
    fireEvent.click(screen.getByRole('button', { name: 'Clear cached objects' }))
    await waitFor(() => expect(screen.getByTestId('cache-status').textContent).toBe('Cleared'))
    expect(getSettings().cacheObjects).toBe(false)
  })

  it('says when clearing failed', async () => {
    installApi({ cache: { clear: async () => { throw new Error('disk') } } })
    render(<SettingsDialog onClose={() => {}} />)
    open('Cache')
    fireEvent.click(screen.getByRole('button', { name: 'Clear cached objects' }))
    await waitFor(() => expect(screen.getByTestId('cache-status').textContent).toBe('Could not clear'))
  })

  it('shows how much is cached', async () => {
    installApi({ cache: { size: async () => 3 * 1048576 } })
    render(<SettingsDialog onClose={() => {}} />)
    open('Cache')
    await waitFor(() => expect(screen.getByTestId('cache-status').textContent).toBe('3.0 MB'))
  })

  it('shows small sizes in KB and nothing for an empty cache', async () => {
    installApi({ cache: { size: async () => 20_480 } })
    const r = render(<SettingsDialog onClose={() => {}} />)
    open('Cache')
    await waitFor(() => expect(screen.getByTestId('cache-status').textContent).toBe('20 KB'))
    r.unmount()
    installApi({ cache: { size: async () => 0 } })
    render(<SettingsDialog onClose={() => {}} />)
    open('Cache')
    await new Promise((r2) => setTimeout(r2, 10))
    expect(screen.getByTestId('cache-status').textContent).toBe('')
  })

  it('Reset to defaults switches the cache back on', () => {
    updateSettings({ cacheObjects: false })
    render(<SettingsDialog onClose={() => {}} />)
    fireEvent.click(screen.getByText('Reset to defaults'))
    expect(getSettings().cacheObjects).toBe(true)
  })
})

describe('SettingsDialog: About', () => {
  const panel = (): HTMLElement => screen.getByRole('group', { name: 'About DataGrid' })
  const flush = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 30)) })

  it('is the last section and shows the name, version, credit and copyright', async () => {
    const api = installApi({ appVersion: '4.5.6' })
    render(<SettingsDialog onClose={() => {}} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[tabs.length - 1].textContent).toBe('About')
    open('About')
    await flush()
    expect(api.appVersion).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tabpanel', { name: 'About' })).toBeTruthy()
    const text = panel().textContent ?? ''
    expect(text).toContain('DataGrid')
    expect(screen.getByTestId('about-version').textContent).toBe('Version 4.5.6')
    expect(text).toContain('Designed and developed by Tushar Arora')
    expect(text).toContain(`© ${new Date().getFullYear()} Tushar Arora`)
    expect(panel().querySelector('svg')).toBeTruthy()
  })

  it('is reachable from the keyboard (End, or Up from the first section)', async () => {
    render(<SettingsDialog onClose={() => {}} />)
    screen.getByRole('tab', { name: 'Appearance' }).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    await flush()
    expect(screen.getByRole('tab', { name: 'About' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'About' }))
    expect(panel()).toBeTruthy()
  })

  it('still shows the credit when the version is unavailable', async () => {
    installApi({ appVersion: async () => { throw new Error('no ipc') } })
    render(<SettingsDialog onClose={() => {}} />)
    open('About')
    await flush()
    expect(screen.getByTestId('about-version').textContent).toBe('')
    expect(panel().textContent).toContain('Tushar Arora')
  })

  it('has no settings or footer changes: Reset to defaults and Done stay available', () => {
    render(<SettingsDialog onClose={() => {}} />)
    open('About')
    expect(screen.getByText('Reset to defaults')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
  })
})

describe('SettingsDialog: sections', () => {
  const tabs = (): HTMLElement[] => screen.getAllByRole('tab')
  const selected = (): string => tabs().find((t) => t.getAttribute('aria-selected') === 'true')!.textContent ?? ''
  // every setting and the section that holds it
  const CONTENT: Record<string, string[]> = {
    Appearance: ['Display size', 'Font size', 'Animations'],
    Fonts: ['Interface font', 'Interface font size', 'Editor & grid font', 'Editor and grid font size'],
    'Data grid': ['Row density', 'Rows per page (new tables)', 'Show NULL as'],
    General: ['Reopen previous tabs on launch'],
    Cache: ['Cache database objects locally (faster start)', 'Clear cached objects'],
    'Backup & restore': ['Export backup…', 'Import backup…'],
    About: ['About DataGrid']
  }
  const present = (name: string): boolean =>
    !!(screen.queryByLabelText(name) || screen.queryByRole('button', { name }) || screen.queryByRole('group', { name }))

  it('is a tablist of sections in a left nav, with the first one selected and a labelled tabpanel', () => {
    render(<SettingsDialog onClose={() => {}} />)
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeTruthy()
    expect(tabs().map((t) => t.textContent)).toEqual(Object.keys(CONTENT))
    expect(selected()).toBe('Appearance')
    const panel = screen.getByRole('tabpanel', { name: 'Appearance' })
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(panel.getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: 'Appearance' }).id)
    expect(screen.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-controls')).toBe(panel.id)
    expect(document.querySelector('[role=dialog]')!.contains(panel)).toBe(true)
  })

  it('only the selected tab is in the tab order (roving tabindex)', () => {
    render(<SettingsDialog onClose={() => {}} />)
    open('Cache')
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, -1, -1, 0, -1, -1])
  })

  it('clicking a section shows only that section; every setting is reachable in its own section', () => {
    render(<SettingsDialog onClose={() => {}} />)
    for (const [section, labels] of Object.entries(CONTENT)) {
      open(section)
      expect(selected()).toBe(section)
      expect(screen.getByRole('tabpanel', { name: section })).toBeTruthy()
      for (const l of labels) expect(present(l), `${l} in ${section}`).toBe(true)
      // nothing of the other sections is rendered
      for (const [other, otherLabels] of Object.entries(CONTENT))
        if (other !== section) for (const l of otherLabels) expect(present(l), `${l} must not be in ${section}`).toBe(false)
    }
  })

  it('keeps the footer (Reset to defaults / Done) outside the sections, visible in all of them', () => {
    render(<SettingsDialog onClose={() => {}} />)
    for (const section of Object.keys(CONTENT)) {
      open(section)
      expect(screen.getByText('Reset to defaults')).toBeTruthy()
      expect(screen.getByText('Done')).toBeTruthy()
      expect(screen.getByRole('tabpanel').contains(screen.getByText('Done'))).toBe(false)
    }
  })

  it('arrow keys move between sections (Up / Down and Left / Right), wrapping, with focus following', () => {
    render(<SettingsDialog onClose={() => {}} />)
    const list = screen.getByRole('tablist')
    const press = (key: string): void => void fireEvent.keyDown(document.activeElement ?? list, { key })
    const flushFrames = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    return (async () => {
      screen.getByRole('tab', { name: 'Appearance' }).focus()
      press('ArrowDown')
      await flushFrames()
      expect(selected()).toBe('Fonts')
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Fonts' }))
      expect(sel('Interface font')).toBeTruthy()
      press('ArrowRight')
      await flushFrames()
      expect(selected()).toBe('Data grid')
      press('ArrowUp')
      await flushFrames()
      expect(selected()).toBe('Fonts')
      press('ArrowLeft')
      await flushFrames()
      press('ArrowUp') // wraps to the last
      await flushFrames()
      expect(selected()).toBe('About')
      press('ArrowUp')
      await flushFrames()
      expect(selected()).toBe('Backup & restore')
      press('ArrowDown')
      await flushFrames()
      expect(selected()).toBe('About')
      press('ArrowDown') // and back to the first
      await flushFrames()
      expect(selected()).toBe('Appearance')
      press('End')
      await flushFrames()
      expect(selected()).toBe('About')
      press('Home')
      await flushFrames()
      expect(selected()).toBe('Appearance')
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Appearance' }))
    })()
  })

  it('other keys and modified arrows do not change the section', () => {
    render(<SettingsDialog onClose={() => {}} />)
    const t = screen.getByRole('tab', { name: 'Appearance' })
    fireEvent.keyDown(t, { key: 'a' })
    fireEvent.keyDown(t, { key: 'ArrowDown', metaKey: true })
    fireEvent.keyDown(t, { key: 'ArrowDown', altKey: true })
    expect(selected()).toBe('Appearance')
  })

  it('remembers the last section while the app runs (a new dialog opens on it)', () => {
    const first = render(<SettingsDialog onClose={() => {}} />)
    open('Data grid')
    first.unmount()
    render(<SettingsDialog onClose={() => {}} />)
    expect(selected()).toBe('Data grid')
    expect(sel('Row density').value).toBe('normal')
  })

  it('does not touch the persisted settings key when switching sections', () => {
    render(<SettingsDialog onClose={() => {}} />)
    const before = localStorage.getItem('datagrip-lite:settings')
    for (const section of Object.keys(CONTENT)) open(section)
    expect(localStorage.getItem('datagrip-lite:settings')).toBe(before)
    expect(Object.keys(localStorage).filter((k) => k.includes('section'))).toEqual([])
  })

  it('a setting changed in one section is still there after visiting the others', () => {
    render(<SettingsDialog onClose={() => {}} />)
    open('Data grid')
    fireEvent.change(sel('Row density'), { target: { value: 'compact' } })
    open('Cache')
    open('Data grid')
    expect(sel('Row density').value).toBe('compact')
  })

  it('the cache size read when the dialog opened is still shown after leaving and re-entering Cache', async () => {
    installApi({ cache: { size: async () => 3 * 1048576 } })
    render(<SettingsDialog onClose={() => {}} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    open('Cache')
    expect(screen.getByTestId('cache-status').textContent).toBe('3.0 MB')
    open('Fonts')
    open('Cache')
    expect(screen.getByTestId('cache-status').textContent).toBe('3.0 MB')
  })

  it('Escape closes the dialog from a focused tab', () => {
    const onClose = vi.fn()
    render(<SettingsDialog onClose={onClose} />)
    screen.getByRole('tab', { name: 'Fonts' }).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Done keeps the initial focus', () => {
    render(<SettingsDialog onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByText('Done'))
  })

  it('the modal is a scroll-contained layout: header, nav + pane, footer', () => {
    render(<SettingsDialog onClose={() => {}} />)
    const modal = document.querySelector('.settings-modal')!
    expect(Array.from(modal.children).map((c) => c.className || c.tagName)).toEqual(['H3', 'set-layout', 'set-actions'])
    const layout = modal.querySelector('.set-layout')!
    expect(Array.from(layout.children).map((c) => c.className)).toEqual(['set-nav', 'set-pane'])
  })
})
