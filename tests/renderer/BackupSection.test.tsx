// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import BackupSection from '../../src/renderer/src/BackupSection'
import SettingsDialog from '../../src/renderer/src/SettingsDialog'
import { DEFAULT_SETTINGS, getSettings, resetSettings, updateSettings } from '../../src/renderer/src/lib/settings'
import { resetLastSection } from '../../src/renderer/src/lib/settingsSections'
import { installApi } from './helpers/mockApi'
import type { BackupApplyResult, BackupSummary } from '../../src/shared'

const flush = (): Promise<void> => act(async () => {})
const btn = (name: string | RegExp): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement
const click = async (name: string | RegExp): Promise<void> => {
  fireEvent.click(btn(name))
  await flush()
}
/** Settings dialog: the backup tools live in their own section. */
const openBackup = (): void => void fireEvent.click(screen.getByRole('tab', { name: 'Backup & restore' }))
const type = (label: string | RegExp, value: string): void => void fireEvent.change(screen.getByLabelText(label), { target: { value } })

const summary = (over: Partial<BackupSummary> = {}): BackupSummary => ({
  fileName: 'work.datagrid-backup.json', createdAt: '2026-11-05T10:00:00.000Z', appVersion: '1.0.0', platform: 'darwin',
  counts: { folders: 2, sources: 5, byKind: { postgres: 3, dynamodb: 1, redis: 1 } },
  hasSettings: false, hasLayout: false, hasSession: false, hasSecrets: false, encrypted: false, ...over
})
const applied = (over: Partial<BackupApplyResult> = {}): BackupApplyResult => ({
  ok: true, mode: 'merge', foldersAdded: 2, sourcesAdded: 5, skipped: 0, renamed: 0, secrets: 'none', undoAvailable: true, ...over
})
const pickedPlain = (s: Partial<BackupSummary> = {}) => ({ ok: true, importId: 'imp-1', fileName: 'work.datagrid-backup.json', needsPassphrase: false, summary: summary(s) })

beforeEach(() => {
  localStorage.clear()
  resetSettings()
  resetLastSection()
})
afterEach(cleanup)

describe('BackupSection: layout', () => {
  it('shows the section with both buttons and a status area that starts empty', () => {
    installApi()
    render(<BackupSection />)
    expect(screen.getByText('Backup & restore')).toBeTruthy()
    expect(btn('Export backup…').disabled).toBe(false)
    expect(btn('Import backup…').disabled).toBe(false)
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('is the section before About in the Settings dialog; the pane title replaces the section heading', () => {
    installApi()
    render(<SettingsDialog onClose={() => {}} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[tabs.length - 2].textContent).toBe('Backup & restore')
    expect(screen.queryByRole('button', { name: 'Export backup…' })).toBeNull() // only the active section is rendered
    openBackup()
    expect(screen.getByRole('tabpanel', { name: 'Backup & restore' })).toBeTruthy()
    expect(document.querySelectorAll('.set-section')).toHaveLength(0)
    expect(document.querySelector('.set-pane-title')!.textContent).toBe('Backup & restore')
    expect(btn('Export backup…')).toBeTruthy()
    expect(document.querySelector('.set-actions')!.textContent).toContain('Done')
  })
})

describe('BackupSection: export', () => {
  it('exports without secrets: the options panel, then the native dialog flow in the main process; shows path, size and Show in Finder', async () => {
    const api = installApi({ backup: { export: { ok: true, path: '/Users/me/Documents/b.datagrid-backup.json', bytes: 2048, encrypted: false, counts: { folders: 1, sources: 1, byKind: { postgres: 1, dynamodb: 0, redis: 0 } }, secrets: false } } })
    render(<BackupSection />)
    await click('Export backup…')
    const panel = screen.getByRole('group', { name: 'Export backup' })
    expect((within(panel).getByLabelText('Include saved passwords and secrets') as HTMLInputElement).checked).toBe(false)
    expect((within(panel).getByLabelText('Include open tabs and layout') as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByLabelText('Passphrase')).toBeNull()
    await click('Choose location…')
    expect(api.backup.export).toHaveBeenCalledWith({ includeSecrets: false, passphrase: undefined, settings: getSettings(), layout: {}, session: undefined })
    expect(screen.queryByRole('group')).toBeNull()
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Saved /Users/me/Documents/b.datagrid-backup.json (2.0 KB), without saved passwords.')
    fireEvent.click(within(status).getByRole('button', { name: /Show in/ }))
    expect(api.backup.showInFolder).toHaveBeenCalledWith('/Users/me/Documents/b.datagrid-backup.json')
  })

  it('sends only the whitelisted layout keys, and the session only when "Include open tabs and layout" is ticked', async () => {
    localStorage.setItem('datagrip-lite:console-split', '0.4')
    localStorage.setItem('datagrip-lite:picker-size:table', '{"w":300,"h":200}')
    localStorage.setItem('datagrip-lite:session', JSON.stringify({ v: 1, tabs: [], consoleSql: { c1: 'select 1' } }))
    localStorage.setItem('datagrip-lite:cache', 'x')
    localStorage.setItem('unrelated', 'y')
    const api = installApi({ backup: { export: { ok: false, canceled: true } } })
    render(<BackupSection />)
    await click('Export backup…')
    await click('Choose location…')
    const first = api.backup.export.mock.calls[0][0]
    expect(first.layout).toEqual({ 'datagrip-lite:console-split': '0.4', 'datagrip-lite:picker-size:table': '{"w":300,"h":200}' })
    expect(first.session).toBeUndefined()
    fireEvent.click(screen.getByLabelText('Include open tabs and layout'))
    await click('Choose location…')
    expect(api.backup.export.mock.calls[1][0].session).toMatchObject({ v: 1, tabs: [] })
  })

  it('a cancelled save dialog changes nothing: the panel stays open, no status, no error', async () => {
    const api = installApi({ backup: { export: { ok: false, canceled: true } } })
    render(<BackupSection />)
    await click('Export backup…')
    await click('Choose location…')
    expect(api.backup.export).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('group', { name: 'Export backup' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a failed export shows the error inside the panel', async () => {
    installApi({ backup: { export: { ok: false, error: 'Could not save the backup: ENOSPC: no space left on device' } } })
    render(<BackupSection />)
    await click('Export backup…')
    await click('Choose location…')
    expect(screen.getByRole('alert').textContent).toContain('ENOSPC')
    expect(screen.getByRole('group', { name: 'Export backup' })).toBeTruthy()
  })

  it('with secrets: asks for a passphrase (min 8) and its confirmation before anything is sent', async () => {
    const api = installApi({ backup: { export: { ok: true, path: '/x/b.json', bytes: 100, encrypted: true, counts: { folders: 0, sources: 0, byKind: { postgres: 0, dynamodb: 0, redis: 0 } }, secrets: true } } })
    render(<BackupSection />)
    await click('Export backup…')
    fireEvent.click(screen.getByLabelText('Include saved passwords and secrets'))
    expect(screen.getByText(/encrypted by this Mac/)).toBeTruthy()
    const pass = screen.getByLabelText('Passphrase') as HTMLInputElement
    expect(pass.type).toBe('password')
    expect((screen.getByLabelText('Confirm passphrase') as HTMLInputElement).type).toBe('password')

    await click('Choose location…')
    expect(screen.getByRole('alert').textContent).toMatch(/at least 8 characters/)
    type('Passphrase', 'short')
    type('Confirm passphrase', 'short')
    await click('Choose location…')
    expect(screen.getByRole('alert').textContent).toMatch(/at least 8 characters/)

    type('Passphrase', 'a long enough one')
    type('Confirm passphrase', 'a long enough ONE')
    await click('Choose location…')
    expect(screen.getByRole('alert').textContent).toMatch(/do not match/)
    expect(api.backup.export).not.toHaveBeenCalled()

    type('Confirm passphrase', 'a long enough one')
    await click('Choose location…')
    expect(api.backup.export).toHaveBeenCalledTimes(1)
    expect(api.backup.export.mock.calls[0][0]).toMatchObject({ includeSecrets: true, passphrase: 'a long enough one' })
    expect(screen.getByRole('status').textContent).toContain('encrypted with your passphrase')

    // the passphrase is not kept anywhere: the next export panel starts empty and unticked
    await click('Export backup…')
    expect((screen.getByLabelText('Include saved passwords and secrets') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByLabelText('Include saved passwords and secrets'))
    expect((screen.getByLabelText('Passphrase') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Confirm passphrase') as HTMLInputElement).value).toBe('')
  })

  it('shows a strength hint while typing and Enter submits', async () => {
    const api = installApi({ backup: { export: { ok: false, canceled: true } } })
    render(<BackupSection />)
    await click('Export backup…')
    fireEvent.click(screen.getByLabelText('Include saved passwords and secrets'))
    type('Passphrase', 'abc')
    expect(screen.getByText(/Strength: weak/)).toBeTruthy()
    type('Passphrase', 'Correct-Horse-Battery-9')
    expect(screen.getByText(/Strength: strong/)).toBeTruthy()
    type('Confirm passphrase', 'Correct-Horse-Battery-9')
    fireEvent.keyDown(screen.getByLabelText('Confirm passphrase'), { key: 'Enter' })
    await flush()
    expect(api.backup.export).toHaveBeenCalledTimes(1)
  })

  it('notes saved passwords the Keychain refused to give', async () => {
    installApi({ backup: { export: { ok: true, path: '/x/b.json', bytes: 5, encrypted: true, counts: { folders: 0, sources: 1, byKind: { postgres: 1, dynamodb: 0, redis: 0 } }, secrets: true, unreadable: 2 } } })
    render(<BackupSection />)
    await click('Export backup…')
    fireEvent.click(screen.getByLabelText('Include saved passwords and secrets'))
    type('Passphrase', 'abcdefgh1')
    type('Confirm passphrase', 'abcdefgh1')
    await click('Choose location…')
    expect(screen.getByRole('status').textContent).toContain('2 saved password(s) could not be read')
  })

  it('Cancel closes the panel, discards the passphrase and returns focus to the button', async () => {
    installApi()
    render(<BackupSection />)
    await click('Export backup…')
    fireEvent.click(screen.getByLabelText('Include saved passwords and secrets'))
    type('Passphrase', 'abcdefgh1')
    await click('Cancel')
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(btn('Export backup…'))
    await click('Export backup…')
    // the options stay as chosen, the passphrase never does
    expect((screen.getByLabelText('Include saved passwords and secrets') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Passphrase') as HTMLInputElement).value).toBe('')
  })

  it('the buttons are disabled while the native dialog is open', async () => {
    let finish: (v: unknown) => void = () => {}
    const api = installApi({ backup: { export: () => new Promise((r) => (finish = r)) } })
    render(<BackupSection />)
    await click('Export backup…')
    fireEvent.click(btn('Choose location…'))
    await flush()
    expect(btn('Choose location…').disabled).toBe(true)
    expect(btn('Import backup…').disabled).toBe(true)
    fireEvent.click(btn('Choose location…'))
    expect(api.backup.export).toHaveBeenCalledTimes(1)
    await act(async () => finish({ ok: false, canceled: true }))
    expect(btn('Import backup…').disabled).toBe(false)
  })
})

describe('BackupSection: import and restore', () => {
  it('a cancelled open dialog is a no-op', async () => {
    const api = installApi()
    render(<BackupSection />)
    await click('Import backup…')
    expect(api.backup.pick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an unreadable / invalid file shows the message from the main process', async () => {
    installApi({ backup: { pick: { ok: false, error: 'This backup was created by a newer DataGrid (backup format v2). Update DataGrid to restore it.' } } })
    render(<BackupSection />)
    await click('Import backup…')
    expect(screen.getByRole('alert').textContent).toContain('created by a newer DataGrid')
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('previews the file (name, date, version, counts, what it holds) with Merge as the default and no settings overwrite', async () => {
    const api = installApi({ backup: { pick: pickedPlain({ hasSettings: true, hasLayout: true, hasSession: true }) } })
    render(<BackupSection />)
    await click('Import backup…')
    const panel = screen.getByRole('group', { name: 'Restore backup' })
    expect(panel.textContent).toContain('work.datagrid-backup.json')
    expect(panel.textContent).toContain('DataGrid 1.0.0')
    expect(panel.textContent).toContain('2 folders · 5 data sources (3 PostgreSQL, 1 DynamoDB, 1 Redis)')
    expect(panel.textContent).toContain('settings, layout, open tabs, no saved passwords')
    expect((screen.getByLabelText(/Merge/) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Replace everything') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Also apply settings from the backup') as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByText(/Replace removes/)).toBeNull()
    await click('Restore')
    expect(api.backup.apply).toHaveBeenCalledWith('imp-1', expect.objectContaining({ mode: 'merge', applySettings: false, applyLayout: false, applySession: false }))
  })

  it('only offers the options the backup contains, and mentions encrypted files hold passwords', async () => {
    installApi({ backup: { pick: pickedPlain({ hasSecrets: true, encrypted: true }) } })
    render(<BackupSection />)
    await click('Import backup…')
    expect(screen.queryByLabelText('Also apply settings from the backup')).toBeNull()
    expect(screen.queryByLabelText(/layout/)).toBeNull()
    expect(screen.queryByLabelText('Also restore open tabs')).toBeNull()
    expect(screen.getByRole('group', { name: 'Restore backup' }).textContent).toContain('saved passwords')
    expect(screen.getByRole('group', { name: 'Restore backup' }).textContent).not.toContain('no saved passwords')
  })

  it('Merge: restores, applies the settings only when ticked (bad values normalised), tells the explorer to reload and shows the summary', async () => {
    const onRestored = vi.fn()
    const api = installApi({
      backup: {
        pick: pickedPlain({ hasSettings: true }),
        apply: applied({ settings: { uiSize: 99, uiFont: 'comic', density: 'compact', nonsense: 5 } })
      }
    })
    updateSettings({ nullText: '∅', pageSize: 500 })
    render(<BackupSection onRestored={onRestored} />)
    await click('Import backup…')
    fireEvent.click(screen.getByLabelText('Also apply settings from the backup'))
    await click('Restore')
    expect(api.backup.apply).toHaveBeenCalledWith('imp-1', {
      mode: 'merge', applySettings: true, applyLayout: false, applySession: false,
      current: { settings: expect.objectContaining({ nullText: '∅', pageSize: 500 }), layout: {} }
    })
    // merged over the current settings; junk values fixed by the normaliser
    expect(getSettings()).toMatchObject({ uiSize: 18, uiFont: DEFAULT_SETTINGS.uiFont, density: 'compact', nullText: '∅', pageSize: 500 })
    expect(onRestored).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Restored 2 folders, 5 data sources, settings.')
    expect(screen.getByRole('status').textContent).toContain('Saved passwords were not in the backup')
    expect(document.activeElement).toBe(btn('Import backup…'))
  })

  it('Merge without ticking settings does not touch them (nothing is returned for them)', async () => {
    installApi({ backup: { pick: pickedPlain({ hasSettings: true }), apply: applied() } })
    updateSettings({ density: 'comfortable' })
    render(<BackupSection />)
    await click('Import backup…')
    await click('Restore')
    expect(getSettings().density).toBe('comfortable')
    expect(screen.getByRole('status').textContent).toContain('Restored 2 folders, 5 data sources.')
  })

  it('Replace: shows a clear warning, forces settings and layout from the backup, starts settings from the defaults', async () => {
    const api = installApi({
      backup: { pick: pickedPlain({ hasSettings: true, hasLayout: true }), apply: applied({ mode: 'replace', settings: { density: 'compact' }, layout: { 'datagrip-lite:console-split': '0.3', 'datagrip-lite:session': '{}' } }) }
    })
    updateSettings({ nullText: '∅', pageSize: 500 })
    render(<BackupSection />)
    await click('Import backup…')
    fireEvent.click(screen.getByLabelText('Replace everything'))
    const warn = screen.getByRole('note')
    expect(warn.textContent).toMatch(/Replace removes all current folders and data sources and replaces your settings/)
    expect(warn.textContent).toMatch(/automatic backup/)
    const cb = screen.getByLabelText('Also apply settings from the backup') as HTMLInputElement
    expect(cb.checked).toBe(true)
    expect(cb.disabled).toBe(true)
    expect(btn('Restore').className).toContain('danger')
    await click('Restore')
    expect(api.backup.apply).toHaveBeenCalledWith('imp-1', expect.objectContaining({ mode: 'replace', applySettings: true, applyLayout: true }))
    expect(getSettings()).toEqual({ ...DEFAULT_SETTINGS, density: 'compact' })
    // only whitelisted layout keys reach localStorage
    expect(localStorage.getItem('datagrip-lite:console-split')).toBe('0.3')
    expect(localStorage.getItem('datagrip-lite:session')).toBeNull()
  })

  it('layout and tabs need a reload to show: the status offers it (and restoring the session replaces the saved one)', async () => {
    const onReload = vi.fn()
    installApi({
      backup: {
        pick: pickedPlain({ hasSession: true, hasLayout: true }),
        apply: applied({ layout: { 'datagrip-lite:filter-split': '0.45' }, session: { v: 1, tabs: [], width: 333 } })
      }
    })
    render(<BackupSection onReload={onReload} />)
    await click('Import backup…')
    fireEvent.click(screen.getByLabelText('Also apply layout (panel sizes)'))
    fireEvent.click(screen.getByLabelText('Also restore open tabs'))
    await click('Restore')
    expect(localStorage.getItem('datagrip-lite:filter-split')).toBe('0.45')
    expect(JSON.parse(localStorage.getItem('datagrip-lite:session')!)).toMatchObject({ v: 1, width: 333 })
    expect(screen.getByRole('status').textContent).toContain('layout, open tabs')
    await click('Reload to show layout and tabs')
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('reports copies / skipped items and a Keychain that was not available', async () => {
    installApi({ backup: { pick: pickedPlain(), apply: applied({ renamed: 2, skipped: 1, secrets: 'unavailable' }) } })
    render(<BackupSection />)
    await click('Import backup…')
    await click('Restore')
    const t = screen.getByRole('status').textContent!
    expect(t).toContain('(2 imported as "(imported)" copies, 1 already present)')
    expect(t).toContain('Keychain is not available')
  })

  it('says so when there was nothing new', async () => {
    installApi({ backup: { pick: pickedPlain(), apply: applied({ foldersAdded: 0, sourcesAdded: 0, skipped: 3 }) } })
    render(<BackupSection />)
    await click('Import backup…')
    await click('Restore')
    expect(screen.getByRole('status').textContent).toContain('Nothing new to restore (3 already present).')
  })

  it('an apply error stays in the panel so it can be retried; an expired import closes the panel', async () => {
    const api = installApi({ backup: { pick: pickedPlain(), apply: { ok: false, error: 'Could not restore the backup. Nothing was changed: disk is full' } } })
    const onRestored = vi.fn()
    render(<BackupSection onRestored={onRestored} />)
    await click('Import backup…')
    await click('Restore')
    expect(screen.getByRole('alert').textContent).toContain('Nothing was changed')
    expect(screen.getByRole('group', { name: 'Restore backup' })).toBeTruthy()
    expect(onRestored).not.toHaveBeenCalled()
    api.backup.apply.mockResolvedValueOnce({ ok: false, error: 'This import expired. Choose the backup file again.', expired: true })
    await click('Restore')
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('expired')
    expect(api.backup.cancel).not.toHaveBeenCalled()
  })

  it('Cancel in the preview tells the main process to forget the file', async () => {
    const api = installApi({ backup: { pick: pickedPlain() } })
    render(<BackupSection />)
    await click('Import backup…')
    await click('Cancel')
    expect(api.backup.cancel).toHaveBeenCalledWith('imp-1')
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(btn('Import backup…'))
  })

  it('picking another file forgets the previous one; closing Settings with a file open forgets it too', async () => {
    const api = installApi({ backup: { pick: pickedPlain() } })
    const { unmount } = render(<BackupSection />)
    await click('Import backup…')
    api.backup.pick.mockResolvedValueOnce({ ...pickedPlain(), importId: 'imp-2' })
    await click('Import backup…')
    expect(api.backup.cancel).toHaveBeenCalledWith('imp-1')
    unmount()
    expect(api.backup.cancel).toHaveBeenCalledWith('imp-2')
  })

  it('does not cancel anything after a successful restore when closing', async () => {
    const api = installApi({ backup: { pick: pickedPlain(), apply: applied() } })
    const { unmount } = render(<BackupSection />)
    await click('Import backup…')
    await click('Restore')
    unmount()
    expect(api.backup.cancel).not.toHaveBeenCalled()
  })
})

describe('BackupSection: encrypted backups', () => {
  const encrypted = { ok: true, importId: 'imp-e', fileName: 'secure.datagrid-backup.json', needsPassphrase: true }

  it('asks for the passphrase first; a wrong one shows the message and keeps the prompt; the right one shows the preview', async () => {
    const unlock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Wrong passphrase or the file was modified' })
      .mockResolvedValueOnce({ ok: true, summary: summary({ hasSecrets: true, encrypted: true }) })
    const api = installApi({ backup: { pick: encrypted, unlock } })
    render(<BackupSection />)
    await click('Import backup…')
    const panel = screen.getByRole('group', { name: 'Backup passphrase' })
    expect(panel.textContent).toContain('secure.datagrid-backup.json')
    expect(screen.queryByRole('group', { name: 'Restore backup' })).toBeNull()
    const input = screen.getByLabelText('Passphrase') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(document.activeElement).toBe(input)

    await click('Unlock') // empty
    expect(screen.getByRole('alert').textContent).toMatch(/Enter the passphrase/)
    expect(unlock).not.toHaveBeenCalled()

    type('Passphrase', 'not it')
    await click('Unlock')
    expect(unlock).toHaveBeenCalledWith('imp-e', 'not it')
    expect(screen.getByRole('alert').textContent).toBe('Wrong passphrase or the file was modified')
    expect(screen.getByRole('group', { name: 'Backup passphrase' })).toBeTruthy()

    type('Passphrase', 'the right one')
    fireEvent.keyDown(screen.getByLabelText('Passphrase'), { key: 'Enter' })
    await flush()
    expect(unlock).toHaveBeenLastCalledWith('imp-e', 'the right one')
    expect(screen.queryByLabelText('Passphrase')).toBeNull() // the passphrase prompt is gone, no field keeps it
    expect(screen.getByRole('group', { name: 'Restore backup' }).textContent).toContain('saved passwords')
    await click('Restore')
    expect(api.backup.apply).toHaveBeenCalledWith('imp-e', expect.objectContaining({ mode: 'merge' }))
  })

  it('an expired import while unlocking closes the prompt with the message', async () => {
    installApi({ backup: { pick: encrypted, unlock: { ok: false, error: 'This import expired. Choose the backup file again.', expired: true } } })
    render(<BackupSection />)
    await click('Import backup…')
    type('Passphrase', 'something')
    await click('Unlock')
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('expired')
  })

  it('Cancel at the passphrase prompt forgets the file', async () => {
    const api = installApi({ backup: { pick: encrypted } })
    render(<BackupSection />)
    await click('Import backup…')
    await click('Cancel')
    expect(api.backup.cancel).toHaveBeenCalledWith('imp-e')
    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('BackupSection: undo', () => {
  it('Undo restores the previous state through backup:undo (with the current settings so Redo works), reloads the explorer and offers Redo', async () => {
    const onRestored = vi.fn()
    const undone = applied({ mode: 'replace', foldersAdded: 1, sourcesAdded: 3, settings: { density: 'comfortable' } })
    const api = installApi({ backup: { pick: pickedPlain(), apply: applied({ mode: 'replace' }), undo: undone } })
    updateSettings({ density: 'compact' })
    render(<BackupSection onRestored={onRestored} />)
    await click('Import backup…')
    fireEvent.click(screen.getByLabelText('Replace everything'))
    await click('Restore')
    expect(onRestored).toHaveBeenCalledTimes(1)
    await click('Undo')
    expect(api.backup.undo).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ density: 'compact' }) }))
    expect(onRestored).toHaveBeenCalledTimes(2)
    expect(getSettings().density).toBe('comfortable')
    expect(screen.getByRole('status').textContent).toContain('Undone: the previous state is back. Restored 1 folder, 3 data sources, settings.')
    // and back again
    await click('Redo')
    expect(api.backup.undo).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).not.toContain('Undone')
    expect(btn('Undo')).toBeTruthy()
  })

  it('an undo that fails shows the error', async () => {
    installApi({ backup: { pick: pickedPlain(), apply: applied(), undo: { ok: false, error: 'The safety backup is not readable' } } })
    render(<BackupSection />)
    await click('Import backup…')
    await click('Restore')
    await click('Undo')
    expect(screen.getByRole('alert').textContent).toContain('safety backup')
  })
})

describe('Settings dialog: Esc and backdrop with a sub-panel open', () => {
  const subPanel = (): HTMLElement | null => screen.queryByRole('group', { name: /^(Export backup|Restore backup|Backup passphrase)$/ })

  it('Esc closes the sub-panel first (and forgets the picked file); only a second Esc closes the dialog', async () => {
    const onClose = vi.fn()
    const api = installApi({ backup: { pick: pickedPlain() } })
    render(<SettingsDialog onClose={onClose} />)
    openBackup()
    await click('Import backup…')
    expect(screen.getByRole('group', { name: 'Restore backup' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(subPanel()).toBeNull()
    expect(api.backup.cancel).toHaveBeenCalledWith('imp-1')
    expect(document.activeElement).toBe(btn('Import backup…'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('works for the export panel and the passphrase prompt as well', async () => {
    const onClose = vi.fn()
    installApi({ backup: { pick: { ok: true, importId: 'e1', fileName: 'x.json', needsPassphrase: true } } })
    render(<SettingsDialog onClose={onClose} />)
    openBackup()
    await click('Export backup…')
    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    expect(subPanel()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await click('Import backup…')
    expect(screen.getByRole('group', { name: 'Backup passphrase' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    expect(subPanel()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a click on the backdrop also closes the sub-panel first', async () => {
    const onClose = vi.fn()
    installApi()
    render(<SettingsDialog onClose={onClose} />)
    openBackup()
    await click('Export backup…')
    fireEvent.mouseDown(document.querySelector('.modal-bg')!)
    await flush()
    expect(subPanel()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.querySelector('.modal-bg')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Done forgets a picked file and the explorer reload callback of the dialog fires after a restore', async () => {
    const onSourcesChanged = vi.fn()
    const api = installApi({ backup: { pick: pickedPlain(), apply: applied() } })
    const { unmount } = render(<SettingsDialog onClose={() => {}} onSourcesChanged={onSourcesChanged} />)
    openBackup()
    await click('Import backup…')
    await click('Restore')
    expect(onSourcesChanged).toHaveBeenCalledTimes(1)
    await click('Import backup…')
    unmount()
    expect(api.backup.cancel).toHaveBeenCalledWith('imp-1')
  })

  it('keyboard: the panel controls are reachable native controls and Restore can be pressed with the keyboard focus', async () => {
    installApi({ backup: { pick: pickedPlain() } })
    render(<SettingsDialog onClose={() => {}} />)
    openBackup()
    await click('Import backup…')
    const mode = screen.getByRole('radiogroup', { name: 'Restore mode' })
    expect(within(mode).getAllByRole('radio')).toHaveLength(2)
    expect(document.activeElement).toBe(within(mode).getAllByRole('radio')[0]) // focus moves into the panel
  })
})

describe('Settings dialog: leaving the Backup & restore section', () => {
  it('switching to another section closes an open sub-panel and forgets the picked file; coming back starts clean', async () => {
    const onClose = vi.fn()
    const api = installApi({ backup: { pick: pickedPlain() } })
    render(<SettingsDialog onClose={onClose} />)
    openBackup()
    await click('Import backup…')
    expect(screen.getByRole('group', { name: 'Restore backup' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Cache' }))
    await flush()
    expect(api.backup.cancel).toHaveBeenCalledWith('imp-1')
    expect(screen.queryByRole('group', { name: 'Restore backup' })).toBeNull()
    // no sub-panel any more: Esc closes the dialog straight away
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
