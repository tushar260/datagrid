import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createBackupService, nodeIo } from '../../src/main/backupService'
import type { BackupIo, BackupService, BackupServiceDeps } from '../../src/main/backupService'
import { buildBackup, decryptBackup, encryptBackup, parseBackupFile, serializeBackup, suggestFileName } from '../../src/main/backup'
import type { Envelope } from '../../src/main/backup'
import type { BackupApplyOutcome, BackupApplyResult, DataSource, Folder, StateItem } from '../../src/shared'

const pg = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, host: 'db.local', port: 5432, user: 'u', password: '', database: 'app', ssl: false, ...over
})
const rds = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  redis: { host: 'cache.local', port: 6380, db: 2, tls: true, password: 'RDS-PASS' }, ...over
})

interface Fake {
  svc: BackupService
  files: Map<string, string>
  state: { sources: DataSource[]; folders: Folder[] }
  deps: BackupServiceDeps
  save: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  closeSource: ReturnType<typeof vi.fn>
  dropCache: ReturnType<typeof vi.fn>
  showItem: ReturnType<typeof vi.fn>
  beforeKeychain: ReturnType<typeof vi.fn>
  clock: { t: number }
  fail: { write?: (path: string) => boolean; list?: boolean; stat?: { size: number; isFile: boolean } }
  encAvailable: { v: boolean }
}

function setup(over: Partial<BackupServiceDeps> = {}): Fake {
  const files = new Map<string, string>()
  const clock = { t: Date.UTC(2026, 10, 5, 10, 0, 0) }
  const state = { sources: [pg('p1', { name: 'Main', password: 'enc:QUJD' }), rds('r1', { name: 'Cache', redis: { host: 'c', port: 1, db: 0, tls: false, password: 'enc:REVG' } })] as DataSource[], folders: [{ id: 'f1', name: 'Prod', parentId: null }] as Folder[] }
  const fail: Fake['fail'] = {}
  const encAvailable = { v: true }
  const io: BackupIo = {
    stat: async (p) => {
      if (fail.stat) return fail.stat
      const c = files.get(p)
      if (c === undefined) throw new Error('ENOENT')
      return { size: Buffer.byteLength(c), isFile: true }
    },
    readFile: async (p) => {
      const c = files.get(p)
      if (c === undefined) throw new Error('ENOENT')
      return c
    },
    writeFileAtomic: async (p, text) => {
      if (fail.write?.(p)) throw new Error('ENOSPC: no space left on device')
      files.set(p, text)
    },
    mkdirp: async () => {},
    list: async (dir) => {
      if (fail.list) throw new Error('EACCES')
      return [...files.keys()].filter((k) => k.startsWith(dir + '/')).map((k) => k.slice(dir.length + 1))
    },
    remove: async (p) => void files.delete(p)
  }
  const save = vi.fn(async () => ({ canceled: false, filePath: '/dest/my-backup.datagrid-backup.json' }))
  const open = vi.fn(async () => ({ canceled: false, filePaths: ['/src/in.datagrid-backup.json'] }))
  const closeSource = vi.fn(async () => undefined)
  const dropCache = vi.fn()
  const showItem = vi.fn()
  const beforeKeychain = vi.fn(async () => undefined)
  const commit = vi.fn((items: StateItem[], folders: Folder[]) => {
    const by = new Map(state.sources.map((d) => [d.id, d]))
    state.sources = items.map((it) => ('keep' in it ? by.get(it.keep)! : { ...it.add, password: it.add.password ? 'enc:NEW' : it.deviceSecrets?.password ?? by.get(it.inheritFrom ?? '')?.password ?? '' }))
    state.folders = folders
  })
  let n = 0
  const deps: BackupServiceDeps = {
    dialog: { save, open },
    shell: { showItemInFolder: showItem },
    io,
    store: {
      loadSources: () => state.sources.map((d) => ({ ...d, password: d.password ? 'clear-' + d.id : '', ...(d.redis ? { redis: { ...d.redis, password: d.redis.password ? 'clear-redis' : undefined } } : {}) })),
      loadSourcesRaw: () => structuredClone(state.sources),
      loadFolders: () => structuredClone(state.folders),
      commit: commit as never,
      encryptionAvailable: () => encAvailable.v,
      secretBlobs: (d) => (d.redis ? { password: d.redis.password } : { password: d.password || undefined })
    },
    userDataDir: () => '/ud',
    defaultDir: () => '/docs',
    appVersion: '1.0.0',
    platform: 'darwin',
    closeSource,
    dropCache,
    beforeKeychain,
    now: () => clock.t,
    newId: () => `id-${++n}`,
    ttlMs: 60_000,
    ...over
  }
  return { svc: createBackupService(deps), files, state, deps, save, open, commit, closeSource, dropCache, showItem, beforeKeychain, clock, fail, encAvailable }
}

const plainBackup = (over: Partial<Parameters<typeof buildBackup>[0]> = {}): string =>
  serializeBackup(
    buildBackup({
      sources: [pg('n1', { name: 'Imported', password: 'secret' })],
      folders: [{ id: 'nf', name: 'NewFolder', parentId: null }],
      includeSecrets: false, appVersion: '0.9.0', platform: 'darwin', now: Date.UTC(2026, 0, 1), ...over
    })
  )
const IN = '/src/in.datagrid-backup.json'
const asOk = (r: BackupApplyOutcome): BackupApplyResult => {
  if (!r.ok) throw new Error('expected success: ' + r.error)
  return r
}

describe('export', () => {
  it('shows the save dialog (default name in Documents, overwrite confirmation, json filter) and writes a plain file without secrets', async () => {
    const f = setup()
    const r = await f.svc.export({ includeSecrets: false, settings: { uiSize: 14 }, layout: { 'datagrip-lite:console-split': '0.4', 'datagrip-lite:session': 'x' } })
    expect(f.save).toHaveBeenCalledTimes(1)
    const opts = (f.save.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(opts.defaultPath).toBe('/docs/' + suggestFileName(new Date(f.clock.t)))
    expect(String(opts.defaultPath)).toMatch(/^\/docs\/DataGrid-backup-\d{4}-\d{2}-\d{2}\.datagrid-backup\.json$/)
    expect(opts.filters).toEqual([{ name: 'DataGrid backup', extensions: ['json'] }])
    expect(opts.properties).toEqual(['createDirectory', 'showOverwriteConfirmation'])
    expect(opts.showsTagField).toBe(false)
    expect(r).toMatchObject({ ok: true, path: '/dest/my-backup.datagrid-backup.json', encrypted: false, secrets: false, counts: { folders: 1, sources: 2, byKind: { postgres: 1, dynamodb: 0, redis: 1 } } })
    const text = f.files.get('/dest/my-backup.datagrid-backup.json')!
    expect(r.ok && r.bytes).toBe(Buffer.byteLength(text))
    expect(text).not.toMatch(/clear-|enc:|RDS-PASS/)
    const p = parseBackupFile(text)
    expect(p.encrypted).toBe(false)
    if (!p.encrypted) {
      expect(p.backup.settings).toEqual({ uiSize: 14 })
      expect(p.backup.layout).toEqual({ 'datagrip-lite:console-split': '0.4' })
      expect(p.backup.session).toBeUndefined()
      expect(p.backup.sources.map((s) => s.name)).toEqual(['Main', 'Cache'])
    }
    expect(f.beforeKeychain).not.toHaveBeenCalled() // plain export never decrypts, so the Keychain is not touched
  })

  it('a cancelled dialog is a no-op', async () => {
    const f = setup()
    f.save.mockResolvedValueOnce({ canceled: true, filePath: undefined } as never)
    expect(await f.svc.export({ includeSecrets: false })).toEqual({ ok: false, canceled: true })
    expect(f.files.size).toBe(0)
    f.save.mockResolvedValueOnce({ canceled: false, filePath: '' } as never)
    expect(await f.svc.export({ includeSecrets: false })).toEqual({ ok: false, canceled: true })
  })

  it('adds the extension when the chosen name has no .json', async () => {
    const f = setup()
    f.save.mockResolvedValueOnce({ canceled: false, filePath: '/dest/mine' } as never)
    const r = await f.svc.export({ includeSecrets: false })
    expect(r).toMatchObject({ ok: true, path: '/dest/mine.datagrid-backup.json' })
    expect(f.files.has('/dest/mine.datagrid-backup.json')).toBe(true)
  })

  it('includes the session (without console SQL) only when the request carries one', async () => {
    const f = setup()
    await f.svc.export({ includeSecrets: false, session: { v: 1, tabs: [], consoleSql: { a: 'select 1' } } })
    const text = f.files.get('/dest/my-backup.datagrid-backup.json')!
    expect(text).not.toContain('select 1')
    expect(text).toContain('"session"')
  })

  it('with secrets: requires a valid passphrase BEFORE any dialog, encrypts the whole file and never leaves a secret in clear text', async () => {
    const f = setup()
    for (const passphrase of [undefined, '', 'short', 'x'.repeat(2000)]) {
      const r = await f.svc.export({ includeSecrets: true, passphrase })
      expect(r.ok).toBe(false)
    }
    expect(f.save).not.toHaveBeenCalled()
    const r = await f.svc.export({ includeSecrets: true, passphrase: 'a good passphrase' })
    expect(r).toMatchObject({ ok: true, encrypted: true, secrets: true })
    expect(f.beforeKeychain).toHaveBeenCalledTimes(1)
    const text = f.files.get('/dest/my-backup.datagrid-backup.json')!
    for (const s of ['clear-p1', 'clear-redis', 'db.local', 'Main']) expect(text).not.toContain(s)
    const parsed = parseBackupFile(text)
    expect(parsed.encrypted).toBe(true)
    if (parsed.encrypted) {
      const b = await decryptBackup(parsed.envelope, 'a good passphrase')
      expect(b.sources.find((s) => s.id === 'p1')!.password).toBe('clear-p1')
      expect(b.sources.find((s) => s.id === 'r1')!.redis!.password).toBe('clear-redis')
      await expect(decryptBackup(parsed.envelope, 'another passphrase')).rejects.toThrow('Wrong passphrase')
    }
  })

  it('reports saved passwords that could not be read from the Keychain', async () => {
    const f = setup()
    f.state.sources[0].passwordUnavailable = true
    const loadSources = f.deps.store.loadSources
    f.deps.store.loadSources = () => loadSources().map((d) => (d.id === 'p1' ? { ...d, password: '', passwordUnavailable: true } : d))
    const svc = createBackupService(f.deps)
    const r = await svc.export({ includeSecrets: true, passphrase: 'a good passphrase' })
    expect(r).toMatchObject({ ok: true, unreadable: 1 })
  })

  it('a write failure is reported with a clear message and nothing is left behind', async () => {
    const f = setup()
    f.fail.write = () => true
    const r = await f.svc.export({ includeSecrets: false })
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.error).toMatch(/Could not save the backup: ENOSPC/)
    expect(f.files.size).toBe(0)
    // the service stays usable
    f.fail.write = undefined
    expect(await f.svc.export({ includeSecrets: false })).toMatchObject({ ok: true })
  })

  it('rejects malformed requests', async () => {
    const f = setup()
    expect(await f.svc.export(null)).toMatchObject({ ok: false })
    expect(await f.svc.export({ includeSecrets: 'yes' })).toMatchObject({ ok: false })
    expect(f.save).not.toHaveBeenCalled()
  })

  it('Show in Finder only reveals files this service wrote', async () => {
    const f = setup()
    expect(f.svc.showInFolder('/etc/passwd')).toBe(false)
    expect(f.svc.showInFolder(5)).toBe(false)
    await f.svc.export({ includeSecrets: false })
    expect(f.svc.showInFolder('/dest/my-backup.datagrid-backup.json')).toBe(true)
    expect(f.showItem).toHaveBeenCalledWith('/dest/my-backup.datagrid-backup.json')
    expect(f.showItem).toHaveBeenCalledTimes(1)
  })
})

describe('pick / unlock / cancel', () => {
  it('a cancelled open dialog is a no-op', async () => {
    const f = setup()
    f.open.mockResolvedValueOnce({ canceled: true, filePaths: [] } as never)
    expect(await f.svc.pick()).toEqual({ ok: false, canceled: true })
    f.open.mockResolvedValueOnce({ canceled: false, filePaths: [] } as never)
    expect(await f.svc.pick()).toEqual({ ok: false, canceled: true })
  })

  it('opens the dialog for .json files and returns a preview of a plain backup (no secrets, no payload)', async () => {
    const f = setup()
    f.files.set(IN, plainBackup({ settings: { uiSize: 14 } }))
    const r = await f.svc.pick()
    const opts = (f.open.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(opts.filters).toEqual([{ name: 'DataGrid backup (*.json)', extensions: ['json'] }])
    expect(opts.properties).toEqual(['openFile'])
    expect(r).toMatchObject({
      ok: true, needsPassphrase: false, fileName: 'in.datagrid-backup.json',
      summary: { appVersion: '0.9.0', hasSettings: true, hasSecrets: false, encrypted: false, counts: { folders: 1, sources: 1 } }
    })
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('checks the size before reading', async () => {
    const f = setup()
    f.files.set(IN, '{}')
    f.fail.stat = { size: 50 * 1024 * 1024 + 1, isFile: true }
    const read = vi.spyOn(f.deps.io!, 'readFile')
    const r = await f.svc.pick()
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.error).toMatch(/larger than 50 MB/)
    expect(read).not.toHaveBeenCalled()
    f.fail.stat = { size: 10, isFile: false }
    expect(await f.svc.pick()).toMatchObject({ ok: false, error: 'That is not a file' })
  })

  it('reports damaged, foreign and newer files with clear messages', async () => {
    const f = setup()
    const text = plainBackup()
    const cases: [string, RegExp][] = [
      [text.slice(0, 40), /not valid JSON/],
      ['{"hello":1}', /not a DataGrid backup/],
      [JSON.stringify({ ...JSON.parse(text), version: 2 }), /created by a newer DataGrid/],
      [JSON.stringify({ ...JSON.parse(text), sources: [{ id: 'x', name: 'x', host: 'h', port: 'no' }] }), /port/]
    ]
    for (const [content, re] of cases) {
      f.files.set(IN, content)
      const r = await f.svc.pick()
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(re)
    }
    f.files.delete(IN)
    expect(await f.svc.pick()).toMatchObject({ ok: false, error: expect.stringContaining('Could not read the file') })
  })

  it('an encrypted file asks for the passphrase; a wrong one keeps the import open; the right one shows the preview', async () => {
    const f = setup()
    const env = await encryptBackup(buildBackup({ sources: [pg('n1', { password: 'secret' })], folders: [], includeSecrets: true, appVersion: '0.9.0', platform: 'darwin' }), 'the passphrase')
    f.files.set(IN, serializeBackup(env))
    const r = await f.svc.pick()
    expect(r).toMatchObject({ ok: true, needsPassphrase: true })
    if (!r.ok || !r.needsPassphrase) throw new Error('unexpected')
    expect(await f.svc.apply(r.importId, { mode: 'merge' })).toMatchObject({ ok: false, error: expect.stringContaining('passphrase') })
    expect(await f.svc.unlock(r.importId, '')).toMatchObject({ ok: false })
    expect(await f.svc.unlock(r.importId, 'wrong one!')).toEqual({ ok: false, error: 'Wrong passphrase or the file was modified' })
    const u = await f.svc.unlock(r.importId, 'the passphrase')
    expect(u).toMatchObject({ ok: true, summary: { hasSecrets: true, encrypted: true, counts: { sources: 1 } } })
    expect(await f.svc.unlock(r.importId, 'anything')).toMatchObject({ ok: true }) // already open: idempotent
  })

  it('a tampered encrypted file is reported like a wrong passphrase', async () => {
    const f = setup()
    const env = await encryptBackup(buildBackup({ sources: [], folders: [], includeSecrets: false, appVersion: '1', platform: 'darwin' }), 'the passphrase')
    const buf = Buffer.from(env.data, 'base64')
    buf[3] ^= 0xff
    f.files.set(IN, serializeBackup({ ...env, data: buf.toString('base64') } as Envelope))
    const r = await f.svc.pick()
    if (!r.ok || !r.needsPassphrase) throw new Error('unexpected')
    expect(await f.svc.unlock(r.importId, 'the passphrase')).toMatchObject({ ok: false, error: 'Wrong passphrase or the file was modified' })
  })

  it('cancel forgets the import; unknown ids are harmless', async () => {
    const f = setup()
    f.files.set(IN, plainBackup())
    const r = await f.svc.pick()
    if (!r.ok || r.needsPassphrase) throw new Error('unexpected')
    expect(f.svc.cancel(r.importId)).toBe(true)
    expect(f.svc.cancel(r.importId)).toBe(false)
    expect(f.svc.cancel(5)).toBe(false)
    expect(await f.svc.apply(r.importId, { mode: 'merge' })).toMatchObject({ ok: false, expired: true })
    expect(await f.svc.unlock(r.importId, 'x')).toMatchObject({ ok: false, expired: true })
    expect(f.commit).not.toHaveBeenCalled()
  })

  it('an import expires after the ttl (checked on use) and is also dropped by its timer', async () => {
    const f = setup()
    f.files.set(IN, plainBackup())
    const r = await f.svc.pick()
    if (!r.ok || r.needsPassphrase) throw new Error('unexpected')
    f.clock.t += 59_000
    expect(await f.svc.unlock(r.importId, '')).toMatchObject({ ok: true }) // still there
    f.clock.t += 2_000
    expect(await f.svc.apply(r.importId, { mode: 'merge' })).toMatchObject({ ok: false, expired: true, error: expect.stringContaining('expired') })
    expect(f.commit).not.toHaveBeenCalled()

    vi.useFakeTimers()
    try {
      const g = setup({ ttlMs: 1000 })
      g.files.set(IN, plainBackup())
      const p = await g.svc.pick()
      if (!p.ok || p.needsPassphrase) throw new Error('unexpected')
      vi.advanceTimersByTime(1500)
      expect(g.svc.cancel(p.importId)).toBe(false) // the timer already dropped it
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps at most three picked files in memory', async () => {
    const f = setup()
    f.files.set(IN, plainBackup())
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = await f.svc.pick()
      if (!r.ok) throw new Error('unexpected')
      ids.push(r.importId)
    }
    expect(f.svc.cancel(ids[0])).toBe(false)
    expect(f.svc.cancel(ids[3])).toBe(true)
  })

  it('dispose drops everything', async () => {
    const f = setup()
    f.files.set(IN, plainBackup())
    const r = await f.svc.pick()
    if (!r.ok) throw new Error('unexpected')
    f.svc.dispose()
    expect(f.svc.cancel(r.importId)).toBe(false)
  })
})

describe('apply', () => {
  const pick = async (f: Fake, text = plainBackup()): Promise<string> => {
    f.files.set(IN, text)
    const r = await f.svc.pick()
    if (!r.ok || r.needsPassphrase) throw new Error('pick failed')
    return r.importId
  }
  const opts = { mode: 'merge' as const, applySettings: false, applyLayout: false, applySession: false }

  it('merge: writes a safety backup first, commits the plan, leaves live connections alone, returns what to apply', async () => {
    const f = setup()
    const id = await pick(f, plainBackup({ settings: { uiSize: 15 }, layout: { 'datagrip-lite:console-split': '0.3' }, session: { v: 1, tabs: [] } }))
    const r = asOk(await f.svc.apply(id, { ...opts, applySettings: true, applyLayout: true, applySession: false, current: { settings: { uiSize: 13 }, layout: { 'datagrip-lite:filter-split': '0.5' } } }))
    expect(r).toMatchObject({ mode: 'merge', foldersAdded: 1, sourcesAdded: 1, skipped: 0, renamed: 0, secrets: 'none', undoAvailable: true })
    expect(r.settings).toEqual({ uiSize: 15 })
    expect(r.layout).toEqual({ 'datagrip-lite:console-split': '0.3' })
    expect(r.session).toBeUndefined() // not asked for
    expect(f.state.sources.map((s) => s.id)).toEqual(['p1', 'r1', 'n1'])
    expect(f.state.folders.map((x) => x.id)).toEqual(['f1', 'nf'])
    expect(f.closeSource).not.toHaveBeenCalled()
    expect(f.dropCache).not.toHaveBeenCalled()
    // safety backup: plain, secrets excluded, with the current settings / layout we passed
    const autos = [...f.files.keys()].filter((k) => k.startsWith('/ud/backups/auto-'))
    expect(autos).toHaveLength(1)
    expect(autos[0]).toMatch(/^\/ud\/backups\/auto-2026-11-05T10-00-00-000Z\.datagrid-backup\.json$/)
    const auto = f.files.get(autos[0])!
    expect(auto).not.toMatch(/RDS-PASS|clear-/)
    const p = parseBackupFile(auto, { allowDeviceSecrets: true })
    if (p.encrypted) throw new Error('unexpected')
    expect(p.backup.sources.map((s) => s.id)).toEqual(['p1', 'r1'])
    expect(p.backup.settings).toEqual({ uiSize: 13 })
    expect(p.backup.layout).toEqual({ 'datagrip-lite:filter-split': '0.5' })
    expect(p.backup.deviceSecrets).toEqual({ p1: { password: 'enc:QUJD' }, r1: { password: 'enc:REVG' } })
    // the safety backup was written before the commit
    expect(f.commit.mock.invocationCallOrder[0]).toBeGreaterThan(0)
  })

  it('settings, layout and tabs are returned only when asked for (and present)', async () => {
    const f = setup()
    const id = await pick(f, plainBackup({ settings: { uiSize: 15 }, layout: { 'datagrip-lite:console-split': '0.3' }, session: { v: 1, tabs: [] } }))
    const r = asOk(await f.svc.apply(id, { ...opts, applySession: true }))
    expect(r.settings).toBeUndefined()
    expect(r.layout).toBeUndefined()
    expect(r.session).toMatchObject({ v: 1 })
    const g = setup()
    const id2 = await pick(g)
    const r2 = asOk(await g.svc.apply(id2, { ...opts, applySettings: true, applyLayout: true, applySession: true }))
    expect(r2.settings).toBeUndefined() // the backup has none
  })

  it('merge: collisions are imported as copies', async () => {
    const f = setup()
    const id = await pick(f, plainBackup({ sources: [pg('p1', { name: 'Main', host: 'elsewhere' })], folders: [] }))
    const r = asOk(await f.svc.apply(id, opts))
    expect(r).toMatchObject({ sourcesAdded: 1, renamed: 1 })
    expect(f.state.sources.map((s) => s.name)).toEqual(['Main', 'Cache', 'Main (imported)'])
    expect(f.state.sources[2].id).not.toBe('p1')
  })

  it('replace: closes every live connection and clears the cache of the current sources, applies settings of the backup when asked', async () => {
    const f = setup()
    const id = await pick(f, plainBackup({ settings: { uiSize: 15 } }))
    const r = asOk(await f.svc.apply(id, { ...opts, mode: 'replace', applySettings: true }))
    expect(r).toMatchObject({ mode: 'replace', sourcesAdded: 1, foldersAdded: 1 })
    expect(f.state.sources.map((s) => s.id)).toEqual(['n1'])
    expect(f.state.folders).toEqual([{ id: 'nf', name: 'NewFolder', parentId: null }])
    expect(f.closeSource.mock.calls.map((c) => c[0]).sort()).toEqual(['p1', 'r1'])
    expect(f.dropCache.mock.calls.map((c) => c[0]).sort()).toEqual(['p1', 'r1'])
    expect(r.settings).toEqual({ uiSize: 15 })
  })

  it('a failing cache / connection cleanup does not fail the restore', async () => {
    const f = setup()
    f.closeSource.mockRejectedValue(new Error('boom'))
    f.dropCache.mockImplementation(() => {
      throw new Error('boom')
    })
    const id = await pick(f)
    expect(await f.svc.apply(id, { ...opts, mode: 'replace' })).toMatchObject({ ok: true })
  })

  it('the import is single-use: a second apply of the same id says it expired', async () => {
    const f = setup()
    const id = await pick(f)
    asOk(await f.svc.apply(id, opts))
    expect(await f.svc.apply(id, opts)).toMatchObject({ ok: false, expired: true })
  })

  it('invalid options are rejected without touching anything', async () => {
    const f = setup()
    const id = await pick(f)
    for (const bad of [null, {}, { mode: 'overwrite' }, 'merge']) {
      expect(await f.svc.apply(id, bad)).toMatchObject({ ok: false, error: 'Invalid restore request' })
    }
    expect(f.commit).not.toHaveBeenCalled()
    expect([...f.files.keys()].some((k) => k.includes('/backups/'))).toBe(false)
    // non-boolean flags count as off
    const r = asOk(await f.svc.apply(id, { mode: 'merge', applySettings: 'yes', applyLayout: 1, applySession: {} }))
    expect(r.settings).toBeUndefined()
  })

  it('a failing commit changes nothing: error shown, no cleanup, nothing to undo', async () => {
    const f = setup()
    f.commit.mockImplementationOnce(() => {
      throw new Error('disk is full')
    })
    const id = await pick(f)
    const r = await f.svc.apply(id, { ...opts, mode: 'replace' })
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.error).toMatch(/Nothing was changed.*|Could not restore the backup/)
    expect(!r.ok && r.error).toContain('disk is full')
    expect(f.state.sources.map((s) => s.id)).toEqual(['p1', 'r1'])
    expect(f.closeSource).not.toHaveBeenCalled()
    expect(await f.svc.undo()).toMatchObject({ ok: false, error: 'There is nothing to undo' })
    // the import stays available for another try
    expect(await f.svc.apply(id, { ...opts, mode: 'replace' })).toMatchObject({ ok: true })
  })

  it('without a safety backup nothing is changed', async () => {
    const f = setup()
    f.fail.write = (p) => p.includes('/backups/')
    const id = await pick(f)
    const r = await f.svc.apply(id, opts)
    expect(!r.ok && r.error).toMatch(/safety backup.*nothing was changed/)
    expect(f.commit).not.toHaveBeenCalled()
  })

  it('reading the current state failing is reported', async () => {
    const f = setup()
    f.deps.store.loadSourcesRaw = () => {
      throw new Error('Unexpected token in JSON')
    }
    const svc = createBackupService(f.deps)
    f.files.set(IN, plainBackup())
    const r = await svc.pick()
    if (!r.ok || r.needsPassphrase) throw new Error('unexpected')
    expect(await svc.apply(r.importId, opts)).toMatchObject({ ok: false, error: expect.stringContaining('Could not read the current data sources') })
  })

  it('keeps only the 5 most recent automatic backups', async () => {
    const f = setup()
    for (let i = 0; i < 7; i++) {
      f.clock.t += 1000
      const id = await pick(f, plainBackup({ sources: [pg('x' + i, { name: 'X' + i })], folders: [] }))
      asOk(await f.svc.apply(id, opts))
    }
    const autos = [...f.files.keys()].filter((k) => k.startsWith('/ud/backups/auto-')).sort()
    expect(autos).toHaveLength(5)
    expect(autos[0]).toContain('T10-00-03-000Z')
    expect(autos[4]).toContain('T10-00-07-000Z')
  })

  it('rotation never deletes other files and survives a list failure', async () => {
    const f = setup()
    f.files.set('/ud/backups/notes.txt', 'mine')
    f.fail.list = true
    const id = await pick(f)
    expect(await f.svc.apply(id, opts)).toMatchObject({ ok: true })
    expect(f.files.get('/ud/backups/notes.txt')).toBe('mine')
  })

  it('secrets from an encrypted backup are re-encrypted on this Mac (commit withSecrets), or skipped with a notice when the Keychain is unavailable', async () => {
    const f = setup()
    const env = await encryptBackup(buildBackup({ sources: [pg('n1', { name: 'N', password: 'secret' })], folders: [], includeSecrets: true, appVersion: '1', platform: 'darwin' }), 'the passphrase')
    f.files.set(IN, serializeBackup(env))
    const pickIt = async (): Promise<string> => {
      const r = await f.svc.pick()
      if (!r.ok || !r.needsPassphrase) throw new Error('unexpected')
      expect((await f.svc.unlock(r.importId, 'the passphrase')).ok).toBe(true)
      return r.importId
    }
    const r1 = asOk(await f.svc.apply(await pickIt(), opts))
    expect(r1.secrets).toBe('applied')
    expect(f.commit.mock.calls[0][2]).toEqual({ withSecrets: true })
    expect((f.commit.mock.calls[0][0] as StateItem[]).some((i) => 'add' in i && i.add.password === 'secret')).toBe(true)
    expect(f.beforeKeychain).toHaveBeenCalledTimes(1)

    f.encAvailable.v = false
    const r2 = asOk(await f.svc.apply(await pickIt(), { ...opts, mode: 'replace' }))
    expect(r2.secrets).toBe('unavailable')
    expect(f.commit.mock.calls[1][2]).toEqual({ withSecrets: false })

    f.encAvailable.v = true
    f.commit.mockImplementationOnce(() => {
      throw new Error('keychain denied')
    })
    const r3 = asOk(await f.svc.apply(await pickIt(), opts))
    expect(r3.secrets).toBe('unavailable')
    expect(f.commit.mock.calls[3][2]).toEqual({ withSecrets: false }) // retried without secrets (the failed commit wrote nothing)
  })

  it('operations run one at a time', async () => {
    const f = setup()
    const order: string[] = []
    f.commit.mockImplementation(((items: StateItem[]) => void order.push('commit' + items.length)) as never)
    const id1 = await pick(f)
    f.files.set(IN, plainBackup({ sources: [pg('q', { name: 'Q' })], folders: [] }))
    const r2 = await f.svc.pick()
    if (!r2.ok) throw new Error('unexpected')
    const [a, b] = await Promise.all([f.svc.apply(id1, opts), f.svc.apply(r2.importId, opts)])
    expect(a.ok && b.ok).toBe(true)
    expect(order).toHaveLength(2)
  })
})

describe('undo', () => {
  it('has nothing to undo before a restore', async () => {
    expect(await setup().svc.undo()).toEqual({ ok: false, error: 'There is nothing to undo' })
  })

  it('restores the automatic backup in Replace mode, including the saved password blobs and the previous settings', async () => {
    const f = setup()
    f.files.set(IN, plainBackup({ settings: { uiSize: 15 } }))
    const r = await f.svc.pick()
    if (!r.ok || r.needsPassphrase) throw new Error('unexpected')
    asOk(await f.svc.apply(r.importId, { mode: 'replace', applySettings: true, applyLayout: false, applySession: false, current: { settings: { uiSize: 13 }, layout: { 'datagrip-lite:console-split': '0.7' } } }))
    expect(f.state.sources.map((s) => s.id)).toEqual(['n1'])
    f.closeSource.mockClear()

    const u = asOk(await f.svc.undo({ settings: { uiSize: 15 } }))
    expect(u.mode).toBe('replace')
    expect(f.state.sources.map((s) => s.id)).toEqual(['p1', 'r1'])
    expect(f.state.sources.map((s) => s.name)).toEqual(['Main', 'Cache'])
    expect(f.state.folders).toEqual([{ id: 'f1', name: 'Prod', parentId: null }])
    // the saved passwords come back from the blobs of the automatic backup (this Mac's Keychain ciphertext)
    expect(f.state.sources[0].password).toBe('enc:QUJD')
    const items = f.commit.mock.calls.at(-1)![0] as StateItem[]
    expect(items.every((i) => 'add' in i && i.deviceSecrets !== undefined)).toBe(true)
    expect(u.settings).toEqual({ uiSize: 13 })
    expect(u.layout).toEqual({ 'datagrip-lite:console-split': '0.7' })
    expect(u.undoAvailable).toBe(true)
    expect(f.closeSource.mock.calls.map((c) => c[0])).toEqual(['n1'])
  })

  it('can be undone again (redo) because every restore writes its own safety backup', async () => {
    const f = setup()
    f.files.set(IN, plainBackup())
    const r = await f.svc.pick()
    if (!r.ok || r.needsPassphrase) throw new Error('unexpected')
    asOk(await f.svc.apply(r.importId, { mode: 'replace', applySettings: false, applyLayout: false, applySession: false }))
    asOk(await f.svc.undo())
    expect(f.state.sources.map((s) => s.id)).toEqual(['p1', 'r1'])
    asOk(await f.svc.undo())
    expect(f.state.sources.map((s) => s.id)).toEqual(['n1'])
  })

  it('reports a missing / damaged safety backup', async () => {
    const f = setup()
    f.files.set(IN, plainBackup())
    const r = await f.svc.pick()
    if (!r.ok || r.needsPassphrase) throw new Error('unexpected')
    asOk(await f.svc.apply(r.importId, { mode: 'merge', applySettings: false, applyLayout: false, applySession: false }))
    for (const k of [...f.files.keys()]) if (k.startsWith('/ud/backups/')) f.files.set(k, '{broken')
    expect(await f.svc.undo()).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') })
    for (const k of [...f.files.keys()]) if (k.startsWith('/ud/backups/')) f.files.delete(k)
    expect(await f.svc.undo()).toMatchObject({ ok: false, error: expect.stringContaining('Could not undo') })
  })
})

describe('nodeIo (real file system, temp dir)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-backup-io-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes through a temp file with mode 0600, overwrites atomically and leaves no temp file', async () => {
    const target = join(dir, 'b.datagrid-backup.json')
    await nodeIo.writeFileAtomic(target, '{"a":1}')
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}')
    expect(statSync(target).mode & 0o777).toBe(0o600)
    writeFileSync(target, 'old', { mode: 0o644 })
    await nodeIo.writeFileAtomic(target, 'new')
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['b.datagrid-backup.json'])
  })

  it('a failed write leaves the existing file untouched and no temp file behind', async () => {
    const target = join(dir, 'keep.json')
    writeFileSync(target, 'precious')
    await expect(nodeIo.writeFileAtomic(join(dir, 'missing-dir', 'x.json'), 'data')).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('precious')
    expect(readdirSync(dir)).toEqual(['keep.json'])
    // renaming over a directory fails: the temp file is cleaned up
    const asDir = join(dir, 'a-directory')
    await nodeIo.mkdirp(asDir)
    await expect(nodeIo.writeFileAtomic(asDir, 'data')).rejects.toThrow()
    expect(readdirSync(dir).sort()).toEqual(['a-directory', 'keep.json'])
  })

  it('stat / read / list / remove / mkdirp', async () => {
    const f = join(dir, 'x.json')
    writeFileSync(f, 'héllo')
    expect(await nodeIo.stat(f)).toEqual({ size: Buffer.byteLength('héllo'), isFile: true })
    expect((await nodeIo.stat(dir)).isFile).toBe(false)
    expect(await nodeIo.readFile(f)).toBe('héllo')
    expect(await nodeIo.list(dir)).toEqual(['x.json'])
    await nodeIo.mkdirp(join(dir, 'a', 'b'))
    expect(existsSync(join(dir, 'a', 'b'))).toBe(true)
    await nodeIo.remove(f)
    expect(existsSync(f)).toBe(false)
    await expect(nodeIo.stat(f)).rejects.toThrow()
  })
})
