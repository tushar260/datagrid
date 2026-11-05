/**
 * The main-process side of Settings > Backup & restore, behind the `backup:*` IPC channels (wired in index.ts).
 * Everything that touches the outside world (native dialogs, the file system, the stores, live connections) is injected,
 * so the flows are unit-tested with fakes (tests/main/backupService.test.ts) and against the real store (backup.store.test.ts).
 *
 * The renderer never gets a path to write to: the user picks it in the native dialog and this module writes the file
 * (temp file + rename, mode 0600). A picked import file is parsed / decrypted here and kept in memory under a random import id
 * (expires after a few minutes or on cancel), so the renderer never sends a payload back.
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { BACKUP_EXT, BACKUP_MAX_BYTES } from '../shared'
import type {
  BackupApplyOptions, BackupApplyOutcome, BackupExportResult, BackupMode, BackupPickResult, BackupUnlockResult, DataSource, DeviceSecrets,
  Folder, StateItem
} from '../shared'
import {
  BackupError, buildBackup, countsOf, decryptBackup, deviceSecretsOf, encryptBackup, hasSecret, parseBackupFile, planImport, serializeBackup,
  summarize, suggestFileName, validatePassphrase
} from './backup'
import type { Backup, Envelope } from './backup'

export interface BackupIo {
  /** size / kind of a file (throws when it does not exist) */
  stat(path: string): Promise<{ size: number; isFile: boolean }>
  readFile(path: string): Promise<string>
  /** writes next to the final name, then renames over it; mode 0600 */
  writeFileAtomic(path: string, text: string): Promise<void>
  mkdirp(dir: string): Promise<void>
  list(dir: string): Promise<string[]>
  remove(path: string): Promise<void>
}

export const nodeIo: BackupIo = {
  async stat(path) {
    const s = await stat(path)
    return { size: s.size, isFile: s.isFile() }
  },
  readFile: (path) => readFile(path, 'utf8'),
  async writeFileAtomic(path, text) {
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
    try {
      await writeFile(tmp, text, { mode: 0o600 })
      await rename(tmp, path)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
  },
  mkdirp: async (dir) => void (await mkdir(dir, { recursive: true, mode: 0o700 })),
  list: (dir) => readdir(dir),
  remove: (path) => unlink(path)
}

export interface DialogOptions {
  title: string
  defaultPath?: string
  buttonLabel?: string
  message?: string
  filters: { name: string; extensions: string[] }[]
  properties: string[]
  showsTagField?: boolean
}

export interface BackupServiceDeps {
  dialog: {
    save(o: DialogOptions): Promise<{ canceled: boolean; filePath?: string }>
    open(o: DialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>
  }
  shell: { showItemInFolder(path: string): void }
  io?: BackupIo
  store: {
    loadSources(): DataSource[]
    loadSourcesRaw(): DataSource[]
    loadFolders(): Folder[]
    commit(items: StateItem[], folders: Folder[], opts: { withSecrets: boolean }): void
    encryptionAvailable(): boolean
    secretBlobs(d: DataSource): DeviceSecrets
  }
  userDataDir: () => string
  /** where the save / open dialogs start (Documents or Downloads) */
  defaultDir: () => string
  appVersion: string
  platform: string
  /** closes every live connection of a data source */
  closeSource: (id: string) => Promise<unknown>
  /** drops the object cache of a data source (guarded: omit when there is no cache) */
  dropCache?: (id: string) => void
  /** runs before the Keychain is used (the "why macOS asks" explainer) */
  beforeKeychain?: () => Promise<void>
  log?: (msg: string) => void
  now?: () => number
  newId?: () => string
  /** how long a picked file stays in memory (default 5 minutes) */
  ttlMs?: number
  /** automatic backups kept (default 5) */
  autoKeep?: number
}

export interface BackupService {
  export(req: unknown): Promise<BackupExportResult>
  pick(): Promise<BackupPickResult>
  unlock(importId: unknown, passphrase: unknown): Promise<BackupUnlockResult>
  apply(importId: unknown, opts: unknown): Promise<BackupApplyOutcome>
  cancel(importId: unknown): boolean
  undo(current?: unknown): Promise<BackupApplyOutcome>
  showInFolder(path: unknown): boolean
  dispose(): void
}

interface Pending {
  fileName: string
  encrypted: boolean
  envelope?: Envelope
  backup?: Backup
  expires: number
  timer: ReturnType<typeof setTimeout>
}

const AUTO_RE = /^auto-[0-9A-Za-z-]+\.datagrid-backup\.json$/
const MAX_PENDING = 3
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const fail = (message: string): { ok: false; error: string } => ({ ok: false, error: message })

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const io = deps.io ?? nodeIo
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const ttl = deps.ttlMs ?? 5 * 60_000
  const keep = deps.autoKeep ?? 5
  const log = (m: string): void => deps.log?.(m)
  const pending = new Map<string, Pending>()
  const savedPaths = new Set<string>()
  let lastAuto: string | null = null
  let chain: Promise<unknown> = Promise.resolve()

  /** one backup operation at a time (an apply must never interleave with another apply / undo) */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }

  const why = (e: unknown, what: string): string => (e instanceof BackupError ? e.message : `${what}: ${(e as Error)?.message ?? 'unknown error'}`)
  const logFail = (what: string, e: unknown): void => log(`${what}: ${e instanceof BackupError ? e.code : (e as { code?: string })?.code ?? (e as Error)?.name ?? 'error'}`)

  function drop(id: string): void {
    const p = pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(id)
  }
  function remember(p: Omit<Pending, 'expires' | 'timer'>): string {
    while (pending.size >= MAX_PENDING) drop(pending.keys().next().value as string)
    const id = newId()
    const timer = setTimeout(() => drop(id), ttl)
    timer.unref?.()
    pending.set(id, { ...p, expires: now() + ttl, timer })
    return id
  }
  function entry(id: unknown): Pending | undefined {
    if (typeof id !== 'string') return undefined
    const p = pending.get(id)
    if (!p) return undefined
    if (now() > p.expires) {
      drop(id)
      return undefined
    }
    return p
  }
  const GONE = 'This import expired. Choose the backup file again.'

  // ---- export ----
  async function doExport(reqIn: unknown): Promise<BackupExportResult> {
    if (!isObj(reqIn) || typeof reqIn.includeSecrets !== 'boolean') return fail('Invalid export request')
    const includeSecrets = reqIn.includeSecrets
    if (includeSecrets) {
      const err = validatePassphrase(reqIn.passphrase)
      if (err) return fail(err)
    }
    try {
      const picked = await deps.dialog.save({
        title: 'Export DataGrid backup',
        defaultPath: join(deps.defaultDir(), suggestFileName(new Date(now()))),
        buttonLabel: 'Export',
        message: includeSecrets ? 'The backup file will be encrypted with your passphrase.' : 'The backup will not contain any saved passwords.',
        filters: [{ name: 'DataGrid backup', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
        showsTagField: false
      })
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
      let path = picked.filePath
      if (!/\.json$/i.test(path)) path += BACKUP_EXT

      if (includeSecrets) await deps.beforeKeychain?.()
      const sources = includeSecrets ? deps.store.loadSources() : deps.store.loadSourcesRaw()
      const unreadable = includeSecrets ? sources.filter((d) => d.passwordUnavailable).length : 0
      const backup = buildBackup({
        sources, folders: deps.store.loadFolders(), includeSecrets, appVersion: deps.appVersion, platform: deps.platform, now: now(),
        settings: reqIn.settings, layout: reqIn.layout, session: reqIn.session
      })
      const text = includeSecrets ? serializeBackup(await encryptBackup(backup, reqIn.passphrase as string)) : serializeBackup(backup)
      await io.writeFileAtomic(path, text)
      savedPaths.add(path)
      const out: BackupExportResult = {
        ok: true, path, bytes: Buffer.byteLength(text), encrypted: includeSecrets,
        counts: countsOf(backup.folders, backup.sources), secrets: includeSecrets && backup.secrets
      }
      if (unreadable) out.unreadable = unreadable
      return out
    } catch (e) {
      logFail('backup export failed', e)
      return fail(why(e, 'Could not save the backup'))
    }
  }

  // ---- import: pick / unlock / cancel ----
  async function doPick(): Promise<BackupPickResult> {
    try {
      const picked = await deps.dialog.open({
        title: 'Import DataGrid backup',
        defaultPath: deps.defaultDir(),
        buttonLabel: 'Import',
        filters: [{ name: 'DataGrid backup (*.json)', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
      const path = picked.filePaths[0]
      const fileName = basename(path)
      const st = await io.stat(path)
      if (!st.isFile) return fail('That is not a file')
      if (st.size > BACKUP_MAX_BYTES) return fail(`The file is larger than ${BACKUP_MAX_BYTES / 1024 / 1024} MB, so it is not a DataGrid backup`)
      const parsed = parseBackupFile(await io.readFile(path))
      if (parsed.encrypted) {
        const importId = remember({ fileName, encrypted: true, envelope: parsed.envelope })
        return { ok: true, importId, fileName, needsPassphrase: true }
      }
      const importId = remember({ fileName, encrypted: false, backup: parsed.backup })
      return { ok: true, importId, fileName, needsPassphrase: false, summary: summarize(parsed.backup, fileName, false) }
    } catch (e) {
      logFail('backup import (read) failed', e)
      return fail(why(e, 'Could not read the file'))
    }
  }

  async function doUnlock(importId: unknown, passphrase: unknown): Promise<BackupUnlockResult> {
    const p = entry(importId)
    if (!p) return { ok: false, error: GONE, expired: true }
    if (p.backup) return { ok: true, summary: summarize(p.backup, p.fileName, p.encrypted) }
    if (!p.envelope) return { ok: false, error: GONE, expired: true }
    if (typeof passphrase !== 'string' || !passphrase) return { ok: false, error: 'Enter the passphrase' }
    try {
      p.backup = await decryptBackup(p.envelope, passphrase)
      delete p.envelope
      return { ok: true, summary: summarize(p.backup, p.fileName, true) }
    } catch (e) {
      logFail('backup unlock failed', e)
      return { ok: false, error: why(e, 'Could not open the backup') }
    }
  }

  // ---- apply ----
  function parseApplyOptions(o: unknown): BackupApplyOptions | null {
    if (!isObj(o) || (o.mode !== 'merge' && o.mode !== 'replace')) return null
    return {
      mode: o.mode as BackupMode, applySettings: o.applySettings === true, applyLayout: o.applyLayout === true, applySession: o.applySession === true,
      current: isObj(o.current) ? (o.current as BackupApplyOptions['current']) : undefined
    }
  }

  /** The automatic backup of the current state (settings, layout and secret-free data sources; blobs for this Mac's Undo). */
  async function writeAutoBackup(raw: DataSource[], folders: Folder[], current: BackupApplyOptions['current']): Promise<string> {
    const dir = join(deps.userDataDir(), 'backups')
    await io.mkdirp(dir)
    const backup = buildBackup({
      sources: raw, folders, includeSecrets: false, appVersion: deps.appVersion, platform: deps.platform, now: now(),
      settings: current?.settings, layout: current?.layout, session: current?.session,
      deviceSecrets: deviceSecretsOf(raw, deps.store.secretBlobs)
    })
    const path = join(dir, `auto-${new Date(now()).toISOString().replace(/[:.]/g, '-')}${BACKUP_EXT}`)
    await io.writeFileAtomic(path, serializeBackup(backup))
    try {
      const old = (await io.list(dir)).filter((n) => AUTO_RE.test(n)).sort().reverse().slice(keep)
      for (const n of old) await io.remove(join(dir, n)).catch(() => {})
    } catch {
      /* rotation is best effort */
    }
    return path
  }

  async function runApply(backup: Backup, o: BackupApplyOptions): Promise<BackupApplyOutcome> {
    let raw: DataSource[]
    let folders: Folder[]
    try {
      raw = deps.store.loadSourcesRaw()
      folders = deps.store.loadFolders()
    } catch (e) {
      logFail('backup restore (read current state) failed', e)
      return fail(why(e, 'Could not read the current data sources'))
    }
    const plan = planImport({ folders, sources: raw }, backup, o.mode, { newId })
    let autoPath: string
    try {
      autoPath = await writeAutoBackup(raw, folders, o.current)
    } catch (e) {
      logFail('backup restore (safety backup) failed', e)
      return fail(why(e, 'Could not create the safety backup of your current data, so nothing was changed'))
    }
    const hasClear = backup.sources.some(hasSecret)
    let withSecrets = hasClear && deps.store.encryptionAvailable()
    let secrets: 'applied' | 'none' | 'unavailable' = !hasClear ? 'none' : withSecrets ? 'applied' : 'unavailable'
    try {
      if (withSecrets) await deps.beforeKeychain?.()
      try {
        deps.store.commit(plan.items, plan.folders, { withSecrets })
      } catch (e) {
        if (!withSecrets) throw e
        // Keychain refused: the commit is atomic (nothing was written), so restore again without the secrets
        logFail('backup restore with secrets failed, retrying without', e)
        withSecrets = false
        secrets = 'unavailable'
        deps.store.commit(plan.items, plan.folders, { withSecrets: false })
      }
    } catch (e) {
      logFail('backup restore failed', e)
      return fail(why(e, 'Could not restore the backup. Nothing was changed'))
    }
    lastAuto = autoPath
    for (const id of plan.touchedIds) {
      await Promise.resolve(deps.closeSource(id)).catch(() => {})
      try {
        deps.dropCache?.(id)
      } catch {
        /* the cache is only a convenience */
      }
    }
    const out: BackupApplyOutcome = {
      ok: true, mode: o.mode, foldersAdded: plan.foldersAdded, sourcesAdded: plan.sourcesAdded, skipped: plan.skipped, renamed: plan.renamed,
      secrets, undoAvailable: true
    }
    if (o.applySettings && backup.settings) out.settings = backup.settings
    if (o.applyLayout && backup.layout) out.layout = backup.layout
    if (o.applySession && backup.session) out.session = backup.session
    return out
  }

  async function doApply(importId: unknown, optsIn: unknown): Promise<BackupApplyOutcome> {
    const p = entry(importId)
    if (!p) return { ok: false, error: GONE, expired: true }
    if (!p.backup) return fail('Enter the passphrase of the backup first')
    const o = parseApplyOptions(optsIn)
    if (!o) return fail('Invalid restore request')
    const r = await runApply(p.backup, o)
    if (r.ok) drop(importId as string)
    return r
  }

  async function doUndo(current?: unknown): Promise<BackupApplyOutcome> {
    if (!lastAuto) return fail('There is nothing to undo')
    try {
      const parsed = parseBackupFile(await io.readFile(lastAuto), { allowDeviceSecrets: true })
      if (parsed.encrypted) return fail('The safety backup is not readable')
      const b = parsed.backup
      return await runApply(b, {
        mode: 'replace', applySettings: !!b.settings, applyLayout: !!b.layout, applySession: !!b.session,
        current: isObj(current) ? (current as BackupApplyOptions['current']) : undefined
      })
    } catch (e) {
      logFail('backup undo failed', e)
      return fail(why(e, 'Could not undo the restore'))
    }
  }

  return {
    export: (req) => serial(() => doExport(req)),
    pick: () => serial(doPick),
    unlock: (id, pass) => serial(() => doUnlock(id, pass)),
    apply: (id, o) => serial(() => doApply(id, o)),
    cancel(id) {
      if (typeof id !== 'string' || !pending.has(id)) return false
      drop(id)
      return true
    },
    undo: (current) => serial(() => doUndo(current)),
    showInFolder(path) {
      if (typeof path !== 'string' || !savedPaths.has(path)) return false
      deps.shell.showItemInFolder(path)
      return true
    },
    dispose() {
      for (const id of [...pending.keys()]) drop(id)
    }
  }
}
