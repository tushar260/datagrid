// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyLayout, applyRestore, collectCurrent, collectLayout, describeCounts, describeRestore, formatBytes, passphraseStrength
} from '../../src/renderer/src/lib/backup'
import { DEFAULT_SETTINGS, getSettings, resetSettings, updateSettings } from '../../src/renderer/src/lib/settings'
import { exportSession, replaceSession } from '../../src/renderer/src/session'
import type { BackupApplyResult } from '../../src/shared'

const result = (over: Partial<BackupApplyResult> = {}): BackupApplyResult => ({
  ok: true, mode: 'merge', foldersAdded: 0, sourcesAdded: 0, skipped: 0, renamed: 0, secrets: 'none', undoAvailable: true, ...over
})

beforeEach(() => {
  localStorage.clear()
  resetSettings()
})

describe('collectLayout / applyLayout', () => {
  it('collects only whitelisted layout keys (no session, no console text, no cache, no settings)', () => {
    for (const [k, v] of Object.entries({
      'datagrid:console-split': '0.4',
      'datagrid:filter-split': '0.6',
      'datagrid:redis-split': '0.5',
      'datagrid:picker-size:db': '{"w":1,"h":2}',
      'datagrid:session': '{"v":1}',
      'datagrid:settings': '{"v":1}',
      'datagrid:cache:x': '1',
      'other': '1'
    })) localStorage.setItem(k, v)
    expect(collectLayout()).toEqual({
      'datagrid:console-split': '0.4',
      'datagrid:filter-split': '0.6',
      'datagrid:redis-split': '0.5',
      'datagrid:picker-size:db': '{"w":1,"h":2}'
    })
  })

  it('applyLayout writes the whitelisted keys and ignores everything else', () => {
    applyLayout({ 'datagrid:console-split': '0.2', 'datagrid:session': 'x', 'evil': 'y', 'datagrid:picker-size:../x': '1' })
    expect(localStorage.getItem('datagrid:console-split')).toBe('0.2')
    expect(localStorage.getItem('datagrid:session')).toBeNull()
    expect(localStorage.getItem('evil')).toBeNull()
    expect(collectLayout()).toEqual({ 'datagrid:console-split': '0.2' })
    expect(localStorage.getItem('datagrid:picker-size:../x')).toBeNull()
  })

  it('collectCurrent has the settings and layout, and the session only when asked', () => {
    localStorage.setItem('datagrid:console-split', '0.3')
    localStorage.setItem('datagrid:session', JSON.stringify({ v: 1, tabs: [] }))
    expect(collectCurrent(false)).toEqual({ settings: getSettings(), layout: { 'datagrid:console-split': '0.3' } })
    expect(collectCurrent(true).session).toMatchObject({ v: 1 })
  })
})

describe('applyRestore', () => {
  it('Merge: the given settings go through the normalising function over the current ones', () => {
    updateSettings({ nullText: '∅', density: 'comfortable' })
    const r = applyRestore(result({ settings: { uiSize: 3, monoSize: 99, uiFont: 'wingdings', motion: 'off', restoreTabs: 'no', pageSize: 7, unknown: 1 } }))
    expect(r.reload).toBe(false)
    expect(getSettings()).toEqual({ ...DEFAULT_SETTINGS, nullText: '∅', density: 'comfortable', uiSize: 11, monoSize: 20, motion: 'off' })
    expect(JSON.parse(localStorage.getItem('datagrid:settings')!).settings).toEqual(getSettings())
    expect(document.documentElement.classList.contains('no-motion')).toBe(true)
  })

  it('Replace: settings start from the defaults', () => {
    updateSettings({ nullText: '∅', density: 'comfortable' })
    applyRestore(result({ mode: 'replace', settings: { uiSize: 15 } }))
    expect(getSettings()).toEqual({ ...DEFAULT_SETTINGS, uiSize: 15 })
  })

  it('without settings nothing changes; layout / session ask for a reload', () => {
    updateSettings({ density: 'compact' })
    expect(applyRestore(result())).toEqual({ reload: false })
    expect(getSettings().density).toBe('compact')
    expect(applyRestore(result({ layout: { 'datagrid:filter-split': '0.7' } }))).toEqual({ reload: true })
    expect(applyRestore(result({ session: { v: 1, tabs: [] } }))).toEqual({ reload: true })
  })
})

describe('session export / replace', () => {
  it('replaceSession writes the saved session (validated like any stored one) and exportSession reads it back', () => {
    expect(exportSession()).toBeUndefined()
    replaceSession({ v: 1, tabs: [], width: 9999, sidebarHidden: true, junk: 1 })
    const saved = exportSession() as Record<string, unknown>
    expect(saved).toMatchObject({ v: 1, sidebarHidden: true })
    localStorage.setItem('datagrid:session', '{broken')
    expect(exportSession()).toBeUndefined()
  })
})

describe('texts', () => {
  it('describeRestore: "Restored 3 folders, 12 data sources, settings"', () => {
    expect(describeRestore(result({ foldersAdded: 3, sourcesAdded: 12, settings: { a: 1 } }))).toBe('Restored 3 folders, 12 data sources, settings.')
    expect(describeRestore(result({ foldersAdded: 1, sourcesAdded: 1, layout: {}, session: {} }))).toBe('Restored 1 folder, 1 data source, layout, open tabs.')
    expect(describeRestore(result())).toBe('Nothing new to restore.')
    expect(describeRestore(result({ sourcesAdded: 2, renamed: 1, skipped: 2 }))).toBe('Restored 2 data sources (1 imported as "(imported)" copy, 2 already present).')
  })

  it('describeCounts / formatBytes / passphraseStrength', () => {
    expect(describeCounts({ folders: 0, sources: 1, byKind: { postgres: 1, dynamodb: 0, redis: 0 } })).toBe('0 folders · 1 data source (1 PostgreSQL)')
    expect(describeCounts({ folders: 1, sources: 0, byKind: { postgres: 0, dynamodb: 0, redis: 0 } })).toBe('1 folder · 0 data sources')
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(passphraseStrength('abcdefgh')).toBe('weak')
    expect(passphraseStrength('abcdefghij')).toBe('fair')
    expect(passphraseStrength('Abcdef1!')).toBe('fair')
    expect(passphraseStrength('Abcdefgh1234!')).toBe('strong')
    expect(passphraseStrength('correct horse battery')).toBe('strong')
  })
})
