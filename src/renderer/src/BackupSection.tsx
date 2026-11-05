import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { BACKUP_MIN_PASSPHRASE } from '../../shared'
import type { BackupApplyResult, BackupMode, BackupSummary } from '../../shared'
import { applyRestore, collectCurrent, collectLayout, describeCounts, describeRestore, formatBytes, passphraseStrength } from './lib/backup'
import { isMac } from './lib/platform'
import { getSettings } from './lib/settings'
import { exportSession } from './session'

type Panel =
  | { kind: 'none' }
  | { kind: 'export' }
  | { kind: 'passphrase'; importId: string; fileName: string }
  | { kind: 'preview'; importId: string; summary: BackupSummary }

interface Status {
  tone: 'info' | 'ok' | 'error'
  text: string
  /** where the last export went */
  path?: string
  /** Undo / Redo the last restore */
  undo?: 'undo' | 'redo'
  /** layout / tabs were written: a reload shows them */
  reload?: boolean
}

export interface BackupSectionProps {
  /** Esc handoff: the dialog calls this first; it returns true when it closed a sub-panel (so the dialog stays open) */
  escapeRef?: React.RefObject<(() => boolean) | null>
  /** data sources / folders changed: the explorer must reload them */
  onRestored?: () => void
  /** reload the window (layout / open tabs only show after it); default `window.location.reload()` */
  onReload?: () => void
  /** show the "Backup & restore" heading (the Settings dialog shows it as the pane title instead); default true */
  heading?: boolean
}

/** Settings > Backup & restore: export the configuration to a file, import / restore one (merge or replace), undo. */
export default function BackupSection({ escapeRef, onRestored, onReload, heading = true }: BackupSectionProps): React.JSX.Element {
  const uid = useId()
  const [panel, setPanel] = useState<Panel>({ kind: 'none' })
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null) // inline error of the open panel

  // export panel
  const [withSecrets, setWithSecrets] = useState(false)
  const [withSession, setWithSession] = useState(false)
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  // passphrase (import) panel
  const [openPass, setOpenPass] = useState('')
  // preview panel
  const [mode, setMode] = useState<BackupMode>('merge')
  const [alsoSettings, setAlsoSettings] = useState(false)
  const [alsoLayout, setAlsoLayout] = useState(false)
  const [alsoSession, setAlsoSession] = useState(false)

  const exportBtn = useRef<HTMLButtonElement>(null)
  const importBtn = useRef<HTMLButtonElement>(null)
  const pendingImport = useRef<string | null>(null)
  const alive = useRef(true)
  const busyRef = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // closing Settings with a picked file open: the main process forgets it
      if (pendingImport.current) void window.api.backup.cancel(pendingImport.current)
    }
  }, [])

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return undefined
    busyRef.current = true
    setBusy(true)
    try {
      return await fn()
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }, [])

  const closePanel = useCallback((focus?: 'export' | 'import') => {
    if (pendingImport.current) {
      void window.api.backup.cancel(pendingImport.current)
      pendingImport.current = null
    }
    setPanel({ kind: 'none' })
    setError(null)
    setPass('')
    setConfirm('')
    setOpenPass('')
    const btn = focus === 'import' ? importBtn : exportBtn
    queueMicrotask(() => btn.current?.focus())
  }, [])

  // Esc closes an open sub-panel first (the dialog only closes when there is none)
  const panelRef = useRef(panel)
  panelRef.current = panel
  useEffect(() => {
    if (!escapeRef) return
    const ref = escapeRef
    ref.current = () => {
      const p = panelRef.current
      if (p.kind === 'none') return false
      closePanel(p.kind === 'export' ? 'export' : 'import')
      return true
    }
    return () => {
      ref.current = null
    }
  }, [escapeRef, closePanel])

  // ---- export ----
  const startExport = (): void => {
    setStatus(null)
    setError(null)
    setPanel({ kind: 'export' })
  }

  const doExport = async (): Promise<void> => {
    setError(null)
    if (withSecrets) {
      if (pass.length < BACKUP_MIN_PASSPHRASE) return setError(`The passphrase must have at least ${BACKUP_MIN_PASSPHRASE} characters.`)
      if (pass !== confirm) return setError('The passphrases do not match.')
    }
    const res = await run(() =>
      window.api.backup.export({
        includeSecrets: withSecrets,
        passphrase: withSecrets ? pass : undefined,
        settings: getSettings(),
        layout: collectLayout(),
        session: withSession ? exportSession() : undefined
      })
    )
    if (!res || !alive.current) return
    if (!res.ok) {
      if (!res.canceled) setError(res.error ?? 'Could not save the backup.')
      return
    }
    setPass('')
    setConfirm('')
    setWithSecrets(false)
    setPanel({ kind: 'none' })
    setStatus({
      tone: 'ok',
      path: res.path,
      text:
        `Saved ${res.path} (${formatBytes(res.bytes)})` +
        (res.encrypted ? ', encrypted with your passphrase' : ', without saved passwords') +
        (res.unreadable ? `. ${res.unreadable} saved password(s) could not be read from the Keychain and were left out` : '') +
        '.'
    })
    queueMicrotask(() => exportBtn.current?.focus())
  }

  // ---- import ----
  const startPreview = (importId: string, summary: BackupSummary): void => {
    pendingImport.current = importId
    setMode('merge')
    setAlsoSettings(false)
    setAlsoLayout(false)
    setAlsoSession(false)
    setError(null)
    setPanel({ kind: 'preview', importId, summary })
  }

  const doPick = async (): Promise<void> => {
    setStatus(null)
    if (pendingImport.current) {
      void window.api.backup.cancel(pendingImport.current)
      pendingImport.current = null
    }
    const res = await run(() => window.api.backup.pick())
    if (!res || !alive.current) return
    if (!res.ok) {
      if (res.canceled) return
      setPanel({ kind: 'none' })
      setStatus({ tone: 'error', text: res.error ?? 'Could not read the file.' })
      return
    }
    if (res.needsPassphrase) {
      pendingImport.current = res.importId
      setOpenPass('')
      setError(null)
      setPanel({ kind: 'passphrase', importId: res.importId, fileName: res.fileName })
    } else startPreview(res.importId, res.summary)
  }

  const doUnlock = async (importId: string): Promise<void> => {
    setError(null)
    if (!openPass) return setError('Enter the passphrase.')
    const res = await run(() => window.api.backup.unlock(importId, openPass))
    if (!res || !alive.current) return
    if (!res.ok) {
      if (res.expired) {
        pendingImport.current = null
        setPanel({ kind: 'none' })
        setOpenPass('')
        return setStatus({ tone: 'error', text: res.error })
      }
      return setError(res.error)
    }
    setOpenPass('')
    startPreview(importId, res.summary)
  }

  const finish = (res: BackupApplyResult, summary: BackupSummary | null, undone: boolean): void => {
    const { reload } = applyRestore(res)
    onRestored?.()
    let text = undone ? 'Undone: the previous state is back. ' + describeRestore(res) : describeRestore(res)
    if (!undone && res.sourcesAdded && !summary?.hasSecrets) text += ' Saved passwords were not in the backup: enter them when you connect.'
    if (res.secrets === 'unavailable') text += ' Saved passwords could not be restored because the macOS Keychain is not available.'
    setStatus({ tone: 'ok', text, undo: res.undoAvailable ? (undone ? 'redo' : 'undo') : undefined, reload })
  }

  const doRestore = async (importId: string, summary: BackupSummary): Promise<void> => {
    setError(null)
    const replace = mode === 'replace'
    const applySettings = replace ? summary.hasSettings : alsoSettings
    const applyLayoutKeys = replace ? summary.hasLayout : alsoLayout
    const applySession = alsoSession
    const res = await run(() =>
      window.api.backup.apply(importId, { mode, applySettings, applyLayout: applyLayoutKeys, applySession, current: collectCurrent(applySession) })
    )
    if (!res || !alive.current) return
    if (!res.ok) {
      if (res.expired) {
        pendingImport.current = null
        setPanel({ kind: 'none' })
        return setStatus({ tone: 'error', text: res.error })
      }
      return setError(res.error)
    }
    pendingImport.current = null // the main process dropped it
    setPanel({ kind: 'none' })
    finish(res, summary, false)
    queueMicrotask(() => importBtn.current?.focus())
  }

  const doUndo = async (): Promise<void> => {
    const res = await run(() => window.api.backup.undo(collectCurrent(true)))
    if (!res || !alive.current) return
    if (!res.ok) return setStatus({ tone: 'error', text: res.error })
    finish(res, null, status?.undo !== 'redo')
  }

  const showInFolder = isMac() ? 'Show in Finder' : 'Show in folder'

  return (
    <>
      {heading && <div className="set-section">Backup &amp; restore</div>}
      <div className="set-note">
        Save your folders, data sources and settings to a file, or restore them from one. Saved passwords are left out unless you protect the file with a passphrase.
      </div>
      <div className="set-row set-backup-actions">
        <button type="button" ref={exportBtn} disabled={busy} onClick={startExport}>Export backup…</button>
        <button type="button" ref={importBtn} disabled={busy} onClick={() => void doPick()}>Import backup…</button>
      </div>

      {panel.kind === 'export' && (
        <div className="set-panel" role="group" aria-label="Export backup">
          <label className="check set-check">
            <input type="checkbox" checked={withSession} onChange={(e) => setWithSession(e.target.checked)} />
            Include open tabs and layout
          </label>
          <label className="check set-check">
            <input type="checkbox" checked={withSecrets} onChange={(e) => { setWithSecrets(e.target.checked); setError(null) }} />
            Include saved passwords and secrets
          </label>
          {withSecrets ? (
            <>
              <div className="set-note">
                Passwords are encrypted by this Mac&apos;s Keychain, so they cannot be copied as they are. They go into the file only if you protect the whole file with a passphrase. You will need it to restore: it cannot be recovered.
              </div>
              <div className="set-field">
                <label htmlFor={uid + '-pass'}>Passphrase</label>
                <input id={uid + '-pass'} type="password" autoComplete="new-password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void doExport()} />
              </div>
              <div className="set-field">
                <label htmlFor={uid + '-confirm'}>Confirm passphrase</label>
                <input id={uid + '-confirm'} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void doExport()} />
              </div>
              <div className="set-note" aria-live="polite">
                {pass ? `Strength: ${passphraseStrength(pass)}. ` : ''}At least {BACKUP_MIN_PASSPHRASE} characters; a longer phrase is better.
              </div>
            </>
          ) : (
            <div className="set-note">The file will be readable text without any saved password; enter them again after restoring.</div>
          )}
          {error && <div className="set-error" role="alert">{error}</div>}
          <div className="set-panel-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void doExport()}>Choose location…</button>
            <button type="button" disabled={busy} onClick={() => closePanel('export')}>Cancel</button>
          </div>
        </div>
      )}

      {panel.kind === 'passphrase' && (
        <div className="set-panel" role="group" aria-label="Backup passphrase">
          <div className="set-note">
            <strong>{panel.fileName}</strong> is encrypted. Enter its passphrase to see what it contains.
          </div>
          <div className="set-field">
            <label htmlFor={uid + '-open'}>Passphrase</label>
            <input
              id={uid + '-open'} type="password" autoComplete="current-password" autoFocus value={openPass}
              onChange={(e) => setOpenPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void doUnlock(panel.importId)}
            />
          </div>
          {error && <div className="set-error" role="alert">{error}</div>}
          <div className="set-panel-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void doUnlock(panel.importId)}>Unlock</button>
            <button type="button" disabled={busy} onClick={() => closePanel('import')}>Cancel</button>
          </div>
        </div>
      )}

      {panel.kind === 'preview' && (
        <Preview
          key={panel.importId}
          uid={uid}
          summary={panel.summary}
          mode={mode}
          setMode={setMode}
          alsoSettings={alsoSettings} setAlsoSettings={setAlsoSettings}
          alsoLayout={alsoLayout} setAlsoLayout={setAlsoLayout}
          alsoSession={alsoSession} setAlsoSession={setAlsoSession}
          busy={busy}
          error={error}
          onRestore={() => void doRestore(panel.importId, panel.summary)}
          onCancel={() => closePanel('import')}
        />
      )}

      {status && (
        <div className={'set-status ' + status.tone} role={status.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
          <span className="set-status-text">{status.text}</span>
          {status.path && (
            <button type="button" className="set-link" onClick={() => void window.api.backup.showInFolder(status.path!)}>{showInFolder}</button>
          )}
          {status.undo && (
            <button type="button" className="set-link" disabled={busy} onClick={() => void doUndo()}>{status.undo === 'undo' ? 'Undo' : 'Redo'}</button>
          )}
          {status.reload && (
            <button type="button" className="set-link" onClick={() => (onReload ?? (() => window.location.reload()))()}>Reload to show layout and tabs</button>
          )}
        </div>
      )}
    </>
  )
}

interface PreviewProps {
  uid: string
  summary: BackupSummary
  mode: BackupMode
  setMode: (m: BackupMode) => void
  alsoSettings: boolean
  setAlsoSettings: (v: boolean) => void
  alsoLayout: boolean
  setAlsoLayout: (v: boolean) => void
  alsoSession: boolean
  setAlsoSession: (v: boolean) => void
  busy: boolean
  error: string | null
  onRestore: () => void
  onCancel: () => void
}

function Preview(p: PreviewProps): React.JSX.Element {
  const s = p.summary
  const replace = p.mode === 'replace'
  const created = new Date(s.createdAt)
  const includes = [
    s.hasSettings && 'settings',
    s.hasLayout && 'layout',
    s.hasSession && 'open tabs',
    s.hasSecrets ? 'saved passwords' : 'no saved passwords'
  ].filter(Boolean)
  return (
    <div className="set-panel" role="group" aria-label="Restore backup">
      <dl className="set-facts">
        <dt>File</dt><dd>{s.fileName}</dd>
        <dt>Created</dt><dd>{Number.isNaN(created.getTime()) ? s.createdAt : created.toLocaleString()}{s.appVersion ? ` · DataGrid ${s.appVersion}` : ''}</dd>
        <dt>Contains</dt><dd>{describeCounts(s.counts)}</dd>
        <dt>Also</dt><dd>{includes.join(', ')}</dd>
      </dl>
      <div className="set-modes" role="radiogroup" aria-label="Restore mode">
        <label className="check set-check">
          <input type="radio" name={p.uid + '-mode'} autoFocus checked={!replace} onChange={() => p.setMode('merge')} />
          Merge: keep what I have, add what is missing
        </label>
        <label className="check set-check">
          <input type="radio" name={p.uid + '-mode'} checked={replace} onChange={() => p.setMode('replace')} />
          Replace everything
        </label>
      </div>
      {replace ? (
        <div className="set-warn" role="note">
          Replace removes all current folders and data sources{s.hasSettings ? ' and replaces your settings' : ''}. An automatic backup is saved first, so you can undo.
        </div>
      ) : (
        <div className="set-note">A data source or folder that already exists is kept; the one from the backup is added as a copy marked &quot;(imported)&quot;.</div>
      )}
      {s.hasSettings && (
        <label className="check set-check">
          <input type="checkbox" checked={replace || p.alsoSettings} disabled={replace} onChange={(e) => p.setAlsoSettings(e.target.checked)} />
          Also apply settings from the backup
        </label>
      )}
      {s.hasLayout && (
        <label className="check set-check">
          <input type="checkbox" checked={replace || p.alsoLayout} disabled={replace} onChange={(e) => p.setAlsoLayout(e.target.checked)} />
          Also apply layout (panel sizes)
        </label>
      )}
      {s.hasSession && (
        <label className="check set-check">
          <input type="checkbox" checked={p.alsoSession} onChange={(e) => p.setAlsoSession(e.target.checked)} />
          Also restore open tabs
        </label>
      )}
      {p.error && <div className="set-error" role="alert">{p.error}</div>}
      <div className="set-panel-actions">
        <button type="button" className={replace ? 'danger' : 'primary'} disabled={p.busy} onClick={p.onRestore}>Restore</button>
        <button type="button" disabled={p.busy} onClick={p.onCancel}>Cancel</button>
      </div>
    </div>
  )
}
