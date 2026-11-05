import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DataSource } from '../../src/shared'

// Real store + real backup service on a temp userData with a mocked safeStorage (like store.test.ts). Never touches the real app data.
const fake = vi.hoisted(() => ({
  dir: '',
  available: true,
  /** which "Mac" encrypts: the blob prefix changes when a backup travels to another machine */
  mac: 'A',
  encryptThrows: false,
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  isEncryptionAvailable: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  dialog: { showMessageBox: vi.fn() },
  safeStorage: fake
}))

import * as store from '../../src/main/store'
import { createBackupService, nodeIo } from '../../src/main/backupService'
import type { BackupService } from '../../src/main/backupService'
import { decryptBackup, parseBackupFile } from '../../src/main/backup'
import type { BackupApplyResult, BackupApplyOutcome } from '../../src/shared'

const dsFile = (): string => join(fake.dir, 'datasources.json')
const rawList = (): DataSource[] => JSON.parse(readFileSync(dsFile(), 'utf8'))
const pg = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, host: 'localhost', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false, ...over
})
const ddb = (id: string, over: Partial<DataSource['dynamo']> = {}): DataSource => ({
  id, name: id, kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  dynamo: { region: 'us-east-1', authMode: 'keys', accessKeyId: 'AKIA', secretAccessKey: 'ddb-secret', sessionToken: 'ddb-token', ...over }
})
const rds = (id: string, password?: string): DataSource => ({
  id, name: id, kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  redis: { host: 'localhost', port: 6380, db: 1, tls: false, ...(password ? { password } : {}) }
})
const ok = (r: BackupApplyOutcome): BackupApplyResult => {
  if (!r.ok) throw new Error('expected success: ' + r.error)
  return r
}

let svc: BackupService
let exportPath = ''
let closed: string[] = []

function makeService(): BackupService {
  return createBackupService({
    dialog: {
      save: async () => ({ canceled: false, filePath: exportPath }),
      open: async () => ({ canceled: false, filePaths: [exportPath] })
    },
    shell: { showItemInFolder: () => {} },
    store: {
      loadSources: store.loadSources, loadSourcesRaw: store.loadSourcesRaw, loadFolders: store.loadFolders, commit: store.commitState,
      encryptionAvailable: store.encryptionAvailable, secretBlobs: store.secretBlobs
    },
    userDataDir: () => fake.dir,
    defaultDir: () => fake.dir,
    appVersion: '1.0.0',
    platform: 'darwin',
    closeSource: async (id) => void closed.push(id),
    io: nodeIo
  })
}

async function exportTo(opts: { includeSecrets: boolean; passphrase?: string }): Promise<string> {
  const r = await svc.export(opts)
  if (!r.ok) throw new Error('export failed: ' + r.error)
  return r.path
}
async function importFile(): Promise<string> {
  const r = await svc.pick()
  if (!r.ok) throw new Error('pick failed')
  return r.importId
}
const apply = async (mode: 'merge' | 'replace'): Promise<BackupApplyResult> =>
  ok(await svc.apply(await importFile(), { mode, applySettings: false, applyLayout: false, applySession: false }))

beforeEach(() => {
  fake.dir = mkdtempSync(join(tmpdir(), 'dgl-backup-store-'))
  exportPath = join(fake.dir, 'out.datagrid-backup.json')
  fake.available = true
  fake.mac = 'A'
  fake.encryptThrows = false
  fake.isEncryptionAvailable.mockImplementation(() => fake.available)
  fake.encryptString.mockImplementation((s: string) => {
    if (fake.encryptThrows) throw new Error('keychain denied')
    return Buffer.from(`ENC-${fake.mac}<${s}>`)
  })
  fake.decryptString.mockImplementation((b: Buffer) => {
    const t = b.toString()
    if (!t.startsWith(`ENC-${fake.mac}<`)) throw new Error('not encrypted by this Mac')
    return t.replace(/^ENC-[A-Z]</, '').replace(/>$/, '')
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  closed = []
  svc = makeService()
})
afterEach(() => rmSync(fake.dir, { recursive: true, force: true }))

const seed = (): void => {
  store.upsertSource(pg('p1', { name: 'Main', password: 'pg-pass', folderId: 'f1', dbSort: 'size-desc', visibleDbs: ['a'] }))
  store.upsertSource(ddb('d1'))
  store.upsertSource(rds('r1', 'redis-pass'))
  store.saveFolders([{ id: 'f1', name: 'Prod', parentId: null }, { id: 'f2', name: 'EU', parentId: 'f1' }])
}

describe('backup with the real store', () => {
  it('encrypted round trip to another Mac: secrets are re-encrypted with the local key, never written in clear text', async () => {
    seed()
    await exportTo({ includeSecrets: true, passphrase: 'a good passphrase' })
    const file = readFileSync(exportPath, 'utf8')
    for (const s of ['pg-pass', 'ddb-secret', 'ddb-token', 'redis-pass']) expect(file).not.toContain(s)

    // "another Mac": a different Keychain key and an empty app
    rmSync(dsFile())
    rmSync(join(fake.dir, 'folders.json'))
    fake.mac = 'B'
    const r = await svc.pick()
    if (!r.ok || !r.needsPassphrase) throw new Error('unexpected')
    expect((await svc.unlock(r.importId, 'a good passphrase')).ok).toBe(true)
    const res = ok(await svc.apply(r.importId, { mode: 'merge', applySettings: false, applyLayout: false, applySession: false }))
    expect(res).toMatchObject({ sourcesAdded: 3, foldersAdded: 2, secrets: 'applied' })

    const onDisk = readFileSync(dsFile(), 'utf8')
    for (const s of ['pg-pass', 'ddb-secret', 'ddb-token', 'redis-pass']) expect(onDisk).not.toContain(s)
    const raw = rawList()
    expect(raw.find((d) => d.id === 'p1')!.password.startsWith('enc:')).toBe(true)
    expect(Buffer.from(raw.find((d) => d.id === 'p1')!.password.slice(4), 'base64').toString()).toBe('ENC-B<pg-pass>')
    // readable by THIS Mac, with the options and structure intact
    const loaded = store.loadSources()
    expect(loaded.find((d) => d.id === 'p1')).toMatchObject({ password: 'pg-pass', passwordUnavailable: false, name: 'Main', folderId: 'f1', dbSort: 'size-desc', visibleDbs: ['a'], kind: 'postgres' })
    expect(loaded.find((d) => d.id === 'd1')!.dynamo).toMatchObject({ secretAccessKey: 'ddb-secret', sessionToken: 'ddb-token', accessKeyId: 'AKIA', region: 'us-east-1' })
    expect(loaded.find((d) => d.id === 'r1')!.redis).toMatchObject({ password: 'redis-pass', host: 'localhost', port: 6380, db: 1 })
    expect(store.loadFolders()).toEqual([{ id: 'f1', name: 'Prod', parentId: null }, { id: 'f2', name: 'EU', parentId: 'f1' }])
    // the renderer view only has flags for DynamoDB / Redis secrets
    const view = JSON.stringify(store.loadSourcesForRenderer())
    for (const s of ['ddb-secret', 'ddb-token', 'redis-pass']) expect(view).not.toContain(s)
  })

  it('a plain backup carries no secrets: imported sources show no saved password and keep-on-blank still works', async () => {
    seed()
    await exportTo({ includeSecrets: false })
    expect(readFileSync(exportPath, 'utf8')).not.toMatch(/pg-pass|ddb-secret|ddb-token|redis-pass|enc:/)
    rmSync(dsFile())
    const res = await apply('merge')
    expect(res.secrets).toBe('none')
    expect(rawList().map((d) => d.id)).toEqual(['p1', 'd1', 'r1'])
    expect(rawList().find((d) => d.id === 'p1')!.password).toBe('')
    const view = store.loadSourcesForRenderer()
    expect(view.find((d) => d.id === 'd1')!.dynamo).toMatchObject({ hasSecret: false, hasSessionToken: false, authMode: 'keys' })
    expect(view.find((d) => d.id === 'r1')!.redis).toMatchObject({ hasPassword: false })

    // the existing semantics are unaffected: a blank secret needs one while nothing is saved...
    expect(() => store.upsertSource({ ...ddb('d1'), dynamo: { region: 'us-east-1', authMode: 'keys', accessKeyId: 'AKIA' } })).toThrow('Secret access key is required')
    // ...and once a secret is typed it is saved, then a later blank keeps it
    store.upsertSource(ddb('d1', { secretAccessKey: 'typed-secret', sessionToken: undefined }))
    store.upsertSource({ ...ddb('d1'), dynamo: { region: 'us-east-1', authMode: 'keys', accessKeyId: 'AKIA2' } })
    expect(store.loadSource('d1')!.dynamo).toMatchObject({ secretAccessKey: 'typed-secret', accessKeyId: 'AKIA2' })
    store.upsertSource(rds('r1', 'typed-pw'))
    store.upsertSource(rds('r1'))
    expect(store.loadSource('r1')!.redis!.password).toBe('typed-pw')
    store.upsertSource(pg('p1', { password: 'typed' }))
    expect(store.loadSource('p1')!.password).toBe('typed')
  })

  it('a plain Replace keeps the saved secrets of sources that already exist (same id) and drops the rest', async () => {
    seed()
    await exportTo({ includeSecrets: false })
    store.upsertSource(pg('extra', { name: 'Extra', password: 'extra-pass' }))
    const before = rawList()
    const res = await apply('replace')
    expect(res).toMatchObject({ mode: 'replace', sourcesAdded: 3 })
    const after = rawList()
    expect(after.map((d) => d.id)).toEqual(['p1', 'd1', 'r1'])
    expect(after.find((d) => d.id === 'p1')!.password).toBe(before.find((d) => d.id === 'p1')!.password) // blob kept as is
    expect(store.loadSource('p1')!.password).toBe('pg-pass')
    expect(store.loadSource('d1')!.dynamo).toMatchObject({ secretAccessKey: 'ddb-secret', sessionToken: 'ddb-token' })
    expect(store.loadSource('r1')!.redis!.password).toBe('redis-pass')
    expect(closed.sort()).toEqual(['d1', 'extra', 'p1', 'r1'])
  })

  it('Merge keeps the stored records of existing sources byte for byte and imports collisions as copies', async () => {
    seed()
    await exportTo({ includeSecrets: false })
    const before = rawList()
    const res = await apply('merge')
    expect(res).toMatchObject({ skipped: 3, sourcesAdded: 0, foldersAdded: 0 })
    expect(rawList()).toEqual(before)
    // a changed copy of a source in the file is added next to it
    store.patchSource('p1', { host: 'changed-host' })
    const res2 = await apply('merge')
    expect(res2).toMatchObject({ sourcesAdded: 1, renamed: 1, skipped: 2 })
    expect(rawList().map((d) => d.name)).toEqual(['Main', 'd1', 'r1', 'Main (imported)'])
    expect(rawList()[0].host).toBe('changed-host')
  })

  it('Undo of a Replace brings back sources, folders AND their saved passwords (from the blobs of the automatic backup)', async () => {
    seed()
    const original = store.loadSources()
    const originalFolders = store.loadFolders()
    // the file to import has completely different content
    for (const id of ['p1', 'd1', 'r1']) store.deleteSource(id)
    store.saveFolders([])
    store.upsertSource(pg('other', { name: 'Other', password: 'other-pass' }))
    await exportTo({ includeSecrets: false })
    store.deleteSource('other')
    seed()

    const res = await apply('replace')
    expect(res.undoAvailable).toBe(true)
    expect(store.loadSources().map((d) => d.id)).toEqual(['other'])

    const u = ok(await svc.undo())
    expect(u.mode).toBe('replace')
    const plainFolder = (d: DataSource): DataSource => ({ ...d, folderId: d.folderId ?? null })
    expect(store.loadSources().map(plainFolder)).toEqual(original.map(plainFolder))
    expect(store.loadFolders()).toEqual(originalFolders)
    // the automatic backup itself holds no clear-text secret
    const autos = readdirSync(join(fake.dir, 'backups')).filter((n) => n.startsWith('auto-'))
    expect(autos.length).toBeGreaterThanOrEqual(1)
    for (const n of autos) expect(readFileSync(join(fake.dir, 'backups', n), 'utf8')).not.toMatch(/pg-pass|ddb-secret|ddb-token|redis-pass/)
  })

  it('Undo of a Merge removes what was added and leaves the existing sources untouched', async () => {
    seed()
    const before = rawList()
    store.upsertSource(pg('n1', { name: 'New one' }))
    await exportTo({ includeSecrets: false })
    store.deleteSource('n1')
    const merged = await apply('merge')
    expect(merged.sourcesAdded).toBe(1)
    expect(rawList().map((d) => d.id)).toContain('n1')
    ok(await svc.undo())
    expect(rawList().map((d) => d.id)).toEqual(['p1', 'd1', 'r1'])
    expect(rawList().find((d) => d.id === 'p1')!.password).toBe(before.find((d) => d.id === 'p1')!.password)
    expect(store.loadSource('p1')!.password).toBe('pg-pass')
  })

  it('Keychain unavailable: the import proceeds without secrets (nothing readable is written) and says so', async () => {
    seed()
    await exportTo({ includeSecrets: true, passphrase: 'a good passphrase' })
    rmSync(dsFile())
    fake.available = false
    const r = await svc.pick()
    if (!r.ok || !r.needsPassphrase) throw new Error('unexpected')
    await svc.unlock(r.importId, 'a good passphrase')
    const res = ok(await svc.apply(r.importId, { mode: 'merge', applySettings: false, applyLayout: false, applySession: false }))
    expect(res).toMatchObject({ secrets: 'unavailable', sourcesAdded: 3 })
    expect(readFileSync(dsFile(), 'utf8')).not.toMatch(/pg-pass|ddb-secret|redis-pass|raw:/)
    expect(rawList().find((d) => d.id === 'p1')!.password).toBe('')
  })

  it('Keychain refusing to encrypt: retried without secrets, nothing half-written', async () => {
    seed()
    await exportTo({ includeSecrets: true, passphrase: 'a good passphrase' })
    rmSync(dsFile())
    fake.encryptThrows = true
    const r = await svc.pick()
    if (!r.ok || !r.needsPassphrase) throw new Error('unexpected')
    await svc.unlock(r.importId, 'a good passphrase')
    const res = ok(await svc.apply(r.importId, { mode: 'merge', applySettings: false, applyLayout: false, applySession: false }))
    expect(res.secrets).toBe('unavailable')
    expect(rawList()).toHaveLength(3)
    expect(rawList().every((d) => !d.password.startsWith('enc:'))).toBe(true)
  })

  it('commitState is atomic: a failing second file restores the first, a failing encryption writes nothing', () => {
    seed()
    const before = readFileSync(dsFile(), 'utf8')
    // folders.json cannot be replaced (it is a directory now) -> rollback of datasources.json
    rmSync(join(fake.dir, 'folders.json'))
    mkdirSync(join(fake.dir, 'folders.json'))
    expect(() => store.commitState([{ add: pg('z', { name: 'Z' }) }], [{ id: 'q', name: 'Q', parentId: null }])).toThrow()
    expect(readFileSync(dsFile(), 'utf8')).toBe(before)
    expect(readdirSync(fake.dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    rmSync(join(fake.dir, 'folders.json'), { recursive: true })

    fake.encryptThrows = true
    expect(() => store.commitState([{ keep: 'p1' }, { add: pg('z', { name: 'Z', password: 'secret' }) }], [])).toThrow(/Could not save the password/)
    expect(readFileSync(dsFile(), 'utf8')).toBe(before)
    expect(existsSync(join(fake.dir, 'folders.json'))).toBe(false)
  })

  it('commitState writes with mode 0600 and creates the files when there are none yet', () => {
    store.commitState([{ add: pg('a', { name: 'A', password: 'pw' }) }], [{ id: 'f', name: 'F', parentId: null }])
    expect(rawList()).toHaveLength(1)
    expect(rawList()[0].password.startsWith('enc:')).toBe(true)
    expect(store.loadFolders()).toEqual([{ id: 'f', name: 'F', parentId: null }])
    expect(readdirSync(fake.dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    // `keep` of an id that vanished is ignored
    store.commitState([{ keep: 'a' }, { keep: 'ghost' }], [])
    expect(rawList().map((d) => d.id)).toEqual(['a'])
  })

  it('commitState without secrets drops clear-text secrets but keeps inherited blobs', () => {
    store.upsertSource(rds('r', 'old-pw'))
    store.commitState([{ add: { ...rds('r'), redis: { host: 'h', port: 1, db: 0, tls: false, password: 'new-pw' } }, inheritFrom: 'r' }], [], { withSecrets: false })
    expect(store.loadSource('r')!.redis!.password).toBe('old-pw')
    store.commitState([{ add: pg('p', { password: 'x' }) }], [], { withSecrets: false })
    expect(rawList()[0].password).toBe('')
  })

  it('secretBlobs reads the stored (still encrypted) blobs by kind', () => {
    seed()
    const raw = store.loadSourcesRaw()
    expect(store.secretBlobs(raw.find((d) => d.id === 'p1')!).password).toMatch(/^enc:/)
    expect(store.secretBlobs(raw.find((d) => d.id === 'd1')!)).toMatchObject({ secretAccessKey: expect.stringMatching(/^enc:/), sessionToken: expect.stringMatching(/^enc:/) })
    expect(store.secretBlobs(raw.find((d) => d.id === 'r1')!).password).toMatch(/^enc:/)
    expect(store.secretBlobs(pg('none'))).toEqual({})
    expect(store.encryptionAvailable()).toBe(true)
    fake.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('x')
    })
    expect(store.encryptionAvailable()).toBe(false)
  })

  it('the exported plain file parses back to what was exported', async () => {
    seed()
    await exportTo({ includeSecrets: false })
    const p = parseBackupFile(readFileSync(exportPath, 'utf8'))
    expect(p.encrypted).toBe(false)
    if (p.encrypted) return
    expect(p.backup.sources.map((s) => s.kind)).toEqual(['postgres', 'dynamodb', 'redis'])
    expect(p.backup.folders).toHaveLength(2)
    const enc = await exportTo({ includeSecrets: true, passphrase: 'a good passphrase' })
    const e = parseBackupFile(readFileSync(enc, 'utf8'))
    if (!e.encrypted) throw new Error('unexpected')
    expect((await decryptBackup(e.envelope, 'a good passphrase')).secrets).toBe(true)
  })
})
