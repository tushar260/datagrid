import { isBackupLayoutKey } from '../../../shared'
import type { BackupApplyOptions, BackupApplyResult, BackupCounts } from '../../../shared'
import { exportSession, replaceSession } from '../session'
import { DEFAULT_SETTINGS, getSettings, updateSettings } from './settings'
import type { Settings } from './settings'

/**
 * Renderer helpers of Settings > Backup & restore: what to collect from localStorage for a backup (layout only, optionally the
 * session) and how a restored backup is applied. The main process already validated everything; settings still go through
 * `updateSettings` (the normalising function), layout keys through the same whitelist.
 */

/** Whitelisted layout entries (split ratios, picker sizes) currently saved in localStorage. */
export function collectLayout(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!isBackupLayoutKey(k)) continue
      const v = localStorage.getItem(k)
      if (v !== null) out[k] = v
    }
  } catch {
    /* storage unavailable: no layout */
  }
  return out
}

/** The state the main process keeps in its automatic safety backup (so Undo can put it back). */
export function collectCurrent(includeSession: boolean): NonNullable<BackupApplyOptions['current']> {
  const cur: NonNullable<BackupApplyOptions['current']> = { settings: getSettings(), layout: collectLayout() }
  if (includeSession) cur.session = exportSession()
  return cur
}

/** Writes whitelisted layout entries; anything else is ignored. */
export function applyLayout(layout: Record<string, string>): void {
  try {
    for (const [k, v] of Object.entries(layout)) if (isBackupLayoutKey(k) && typeof v === 'string') localStorage.setItem(k, v)
  } catch {
    /* quota / unavailable: ignore */
  }
}

/**
 * Applies what a restore returned: settings immediately (bad or unknown values are normalised; a Replace starts from the defaults),
 * layout keys into localStorage, the session for the next start. Returns whether a reload is needed to see layout / tabs.
 */
export function applyRestore(r: BackupApplyResult): { reload: boolean } {
  if (r.settings) updateSettings(r.mode === 'replace' ? { ...DEFAULT_SETTINGS, ...(r.settings as Partial<Settings>) } : (r.settings as Partial<Settings>))
  if (r.layout) applyLayout(r.layout)
  if (r.session) replaceSession(r.session)
  return { reload: !!r.layout || !!r.session }
}

const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`

/** "Restored 3 folders, 12 data sources, settings" */
export function describeRestore(r: BackupApplyResult): string {
  const parts: string[] = []
  if (r.foldersAdded) parts.push(plural(r.foldersAdded, 'folder'))
  if (r.sourcesAdded) parts.push(plural(r.sourcesAdded, 'data source'))
  if (r.settings) parts.push('settings')
  if (r.layout) parts.push('layout')
  if (r.session) parts.push('open tabs')
  let text = parts.length ? `Restored ${parts.join(', ')}` : 'Nothing new to restore'
  const notes: string[] = []
  if (r.renamed) notes.push(`${r.renamed} imported as "(imported)" ${r.renamed === 1 ? 'copy' : 'copies'}`)
  if (r.skipped) notes.push(`${r.skipped} already present`)
  if (notes.length) text += ` (${notes.join(', ')})`
  return text + '.'
}

/** "2 folders · 5 data sources (3 PostgreSQL, 1 DynamoDB, 1 Redis)" */
export function describeCounts(c: BackupCounts): string {
  const kinds = [
    c.byKind.postgres ? `${c.byKind.postgres} PostgreSQL` : '',
    c.byKind.dynamodb ? `${c.byKind.dynamodb} DynamoDB` : '',
    c.byKind.redis ? `${c.byKind.redis} Redis` : ''
  ].filter(Boolean)
  return `${plural(c.folders, 'folder')} · ${plural(c.sources, 'data source')}${kinds.length ? ` (${kinds.join(', ')})` : ''}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** A rough hint, not a guarantee: length and variety of characters. */
export function passphraseStrength(p: string): 'weak' | 'fair' | 'strong' {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length
  if (p.length >= 16 || (p.length >= 12 && classes >= 3)) return 'strong'
  if (p.length >= 10 || (p.length >= 8 && classes >= 3)) return 'fair'
  return 'weak'
}
