import { describe, expect, it } from 'vitest'
import {
  BackupError, buildBackup, countsOf, decryptBackup, deviceSecretsOf, encryptBackup, hasSecret, parseBackupFile, planImport, sanitizeLayout,
  sanitizeSession, sanitizeSettings, serializeBackup, stripSecrets, summarize, suggestFileName, validateBackup, validatePassphrase, validId
} from '../../src/main/backup'
import type { Backup, Envelope } from '../../src/main/backup'
import { BACKUP_MAX_ITEMS, isBackupLayoutKey } from '../../src/shared'
import type { DataSource, Folder } from '../../src/shared'

const seq = (): (() => string) => {
  let n = 0
  return () => `gen-${++n}`
}
const KDF = { N: 1 << 15, r: 8, p: 1 }

const pg = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, host: 'db.local', port: 5432, user: 'u', password: '', database: 'app', ssl: false, ...over
})
const ddb = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  dynamo: { region: 'eu-west-1', authMode: 'keys', accessKeyId: 'AKIA1', secretAccessKey: 'SECRET-KEY', sessionToken: 'TOKEN' }, ...over
})
const rds = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  redis: { host: 'cache.local', port: 6380, db: 2, tls: true, username: 'bob', password: 'RDS-PASS', keyDelimiter: ':' }, ...over
})
const folders: Folder[] = [
  { id: 'f1', name: 'Prod', parentId: null },
  { id: 'f2', name: 'EU', parentId: 'f1' }
]
const build = (over: Partial<Parameters<typeof buildBackup>[0]> = {}): Backup =>
  buildBackup({
    sources: [pg('p1', { password: 'pg-pass', folderId: 'f2', dbSort: 'size-desc', visibleDbs: ['a', 'b'], schemaFilter: { app: ['public'] }, tableFilter: { 'app/public': { list: ['t'] } } }), ddb('d1'), rds('r1')],
    folders, includeSecrets: false, appVersion: '1.2.3', platform: 'darwin', now: Date.UTC(2026, 10, 5, 10, 0, 0), ...over
  })
const rawOf = (b: Backup): Record<string, unknown> => JSON.parse(JSON.stringify(b))

describe('buildBackup / validateBackup', () => {
  it('round-trips folders, data sources of all three kinds and their options', () => {
    const b = build()
    const back = validateBackup(JSON.parse(serializeBackup(b)))
    expect(back).toEqual(b)
    expect(b).toMatchObject({ format: 'datagrid-backup', version: 1, appVersion: '1.2.3', platform: 'darwin', createdAt: '2026-11-05T10:00:00.000Z' })
    expect(b.folders).toEqual(folders)
    const p = b.sources.find((s) => s.id === 'p1')!
    expect(p).toMatchObject({ kind: 'postgres', host: 'db.local', port: 5432, user: 'u', database: 'app', ssl: false, folderId: 'f2', dbSort: 'size-desc', visibleDbs: ['a', 'b'], schemaFilter: { app: ['public'] }, tableFilter: { 'app/public': { list: ['t'] } } })
    expect(b.sources.find((s) => s.id === 'd1')!.dynamo).toEqual({ region: 'eu-west-1', authMode: 'keys', accessKeyId: 'AKIA1' })
    expect(b.sources.find((s) => s.id === 'r1')!.redis).toEqual({ host: 'cache.local', port: 6380, db: 2, tls: true, username: 'bob', keyDelimiter: ':' })
  })

  it('excludes every secret by default (nothing of them appears in the file text)', () => {
    const text = serializeBackup(build())
    for (const s of ['pg-pass', 'SECRET-KEY', 'TOKEN', 'RDS-PASS']) expect(text).not.toContain(s)
    expect(build().secrets).toBe(false)
    expect(build().sources.some(hasSecret)).toBe(false)
  })

  it('keeps clear-text secrets only when asked (they then live inside an encrypted payload)', () => {
    const b = build({ includeSecrets: true })
    expect(b.secrets).toBe(true)
    expect(b.sources.find((s) => s.id === 'p1')!.password).toBe('pg-pass')
    expect(b.sources.find((s) => s.id === 'd1')!.dynamo).toMatchObject({ secretAccessKey: 'SECRET-KEY', sessionToken: 'TOKEN' })
    expect(b.sources.find((s) => s.id === 'r1')!.redis!.password).toBe('RDS-PASS')
  })

  it('a plain (unencrypted) file never yields secrets, even if someone put them in', () => {
    const raw = rawOf(build({ includeSecrets: true }))
    const parsed = parseBackupFile(JSON.stringify(raw))
    expect(parsed.encrypted).toBe(false)
    if (!parsed.encrypted) {
      expect(parsed.backup.secrets).toBe(false)
      expect(JSON.stringify(parsed.backup)).not.toMatch(/pg-pass|SECRET-KEY|TOKEN|RDS-PASS/)
    }
  })

  it('migrates legacy sources without a kind to PostgreSQL', () => {
    const legacy = { id: 'old', name: 'Old', host: 'h', port: 5432, user: 'u', password: 'enc:xx', database: 'd', ssl: false }
    const b = buildBackup({ sources: [legacy], folders: [], includeSecrets: false, appVersion: '1', platform: 'darwin' })
    expect(b.sources[0].kind).toBe('postgres')
    expect(b.sources[0].password).toBe('')
  })

  it('exporting repairs odd stored Postgres values instead of failing, importing rejects them', () => {
    const weird = pg('w', { port: Number.NaN, host: undefined as unknown as string })
    const b = buildBackup({ sources: [weird], folders: [], includeSecrets: false, appVersion: '1', platform: 'darwin' })
    expect(b.sources[0]).toMatchObject({ host: '', port: 5432 })
    const raw = rawOf(b)
    ;(raw.sources as Record<string, unknown>[])[0].port = 70000
    expect(() => validateBackup(raw)).toThrow(/port/)
  })

  it('rejects an unknown format, a missing version and a future version with a clear message', () => {
    const raw = rawOf(build())
    expect(() => validateBackup({ ...raw, format: 'other' })).toThrow('not a DataGrid backup')
    expect(() => validateBackup({ ...raw, version: 'x' })).toThrow(/invalid version/)
    expect(() => validateBackup({ ...raw, version: 0 })).toThrow(/invalid version/)
    try {
      validateBackup({ ...raw, version: 2 })
      expect.unreachable()
    } catch (e) {
      expect((e as BackupError).code).toBe('version')
      expect((e as Error).message).toContain('created by a newer DataGrid')
    }
    expect(() => validateBackup({ ...raw, createdAt: 'yesterday-ish' })).toThrow(/creation date/)
    expect(() => validateBackup({ ...raw, folders: 'no' })).toThrow(/list/)
    expect(() => validateBackup(null)).toThrow(BackupError)
    expect(() => validateBackup([])).toThrow(BackupError)
  })

  it('rejects too many items', () => {
    const raw = rawOf(build())
    raw.folders = Array.from({ length: BACKUP_MAX_ITEMS + 1 }, (_, i) => ({ id: 'f' + i, name: 'x', parentId: null }))
    expect(() => validateBackup(raw)).toThrow(/more than/)
    const raw2 = rawOf(build())
    raw2.sources = Array.from({ length: BACKUP_MAX_ITEMS + 1 }, (_, i) => pg('s' + i))
    expect(() => validateBackup(raw2)).toThrow(/more than/)
  })

  it('accepts exactly the maximum number of items', () => {
    const raw = rawOf(build())
    raw.folders = []
    raw.sources = Array.from({ length: BACKUP_MAX_ITEMS }, (_, i) => pg('s' + i))
    expect(validateBackup(raw).sources).toHaveLength(BACKUP_MAX_ITEMS)
  })

  it('replaces hostile / invalid / duplicate ids with fresh ones and remaps references', () => {
    const raw = rawOf(build())
    raw.folders = [
      { id: '__proto__', name: 'A', parentId: null },
      { id: '../etc', name: 'B', parentId: '__proto__' },
      { id: 'x'.repeat(65), name: 'C', parentId: null },
      { id: 'ok', name: 'D', parentId: null },
      { id: 'ok', name: 'E', parentId: null }
    ]
    raw.sources = [
      pg('constructor', { folderId: '../etc' }),
      pg('prototype'),
      pg('dup'),
      pg('dup', { name: 'dup2' }),
      pg('a b'),
      pg('', { folderId: 'ok' })
    ]
    const b = validateBackup(raw, { newId: seq() })
    const fids = b.folders.map((f) => f.id)
    const sids = b.sources.map((s) => s.id)
    expect(new Set(fids).size).toBe(5)
    expect(new Set(sids).size).toBe(6)
    for (const id of [...fids, ...sids]) expect(validId(id)).toBe(true)
    expect(fids).toContain('ok')
    expect(b.folders[1].parentId).toBe(null) // its parent "__proto__" cannot be referenced by name
    expect(b.sources[0].folderId).toBe(b.folders[1].id) // "../etc" -> its fresh id
    expect(b.sources[5].folderId).toBe('ok')
    expect(sids.filter((s) => s === 'dup')).toHaveLength(1)
  })

  it('validId accepts UUIDs and the ids tests use, nothing else', () => {
    expect(validId('3f2b8c1e-6d1f-4c49-9b8a-1f2e3d4c5b6a')).toBe(true)
    expect(validId('a_b-C9')).toBe(true)
    for (const bad of ['', 'a.b', 'a/b', 'é', '__proto__', 'constructor', 'prototype', 'x'.repeat(65), 5, null]) expect(validId(bad)).toBe(false)
  })

  it('drops prototype-pollution keys everywhere without polluting anything', () => {
    const text = `{"format":"datagrid-backup","version":1,"createdAt":"2026-01-01T00:00:00Z","__proto__":{"polluted":true},
      "folders":[],"sources":[{"id":"s","name":"S","host":"h","port":1,"__proto__":{"polluted":true},"constructor":{"x":1},
        "schemaFilter":{"__proto__":["a"],"db":["t"]},"tableFilter":{"constructor":{"list":["a"]},"d/s":{"list":["t"],"__proto__":{"p":1}}}}],
      "settings":{"__proto__":{"polluted":true},"uiSize":14,"constructor":"x"},
      "layout":{"__proto__":"1","datagrip-lite:console-split":"0.5"},
      "session":{"__proto__":{"polluted":true},"tabs":[{"__proto__":{"p":1},"type":"table"}]}}`
    const parsed = parseBackupFile(text)
    if (parsed.encrypted) throw new Error('unexpected')
    const b = parsed.backup
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(b.sources[0].schemaFilter!)).toEqual(['db'])
    expect(Object.keys(b.sources[0].tableFilter!)).toEqual(['d/s'])
    expect(b.settings).toEqual({ uiSize: 14 })
    expect(b.layout).toEqual({ 'datagrip-lite:console-split': '0.5' })
    expect(JSON.stringify(b.session)).not.toContain('polluted')
    expect(Object.getPrototypeOf(b.sources[0].schemaFilter)).toBe(Object.prototype)
  })

  it('repairs folder cycles, self parents and orphans', () => {
    const raw = rawOf(build())
    raw.folders = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
      { id: 'c', name: 'C', parentId: 'c' },
      { id: 'd', name: 'D', parentId: 'ghost' },
      { id: 'e', name: 'E', parentId: 'd' }
    ]
    raw.sources = [pg('s1', { folderId: 'ghost' }), pg('s2', { folderId: 'e' })]
    const b = validateBackup(raw)
    expect(b.folders.find((f) => f.id === 'a')!.parentId).toBe(null)
    expect(b.folders.find((f) => f.id === 'b')!.parentId).toBe(null)
    expect(b.folders.find((f) => f.id === 'c')!.parentId).toBe(null)
    expect(b.folders.find((f) => f.id === 'd')!.parentId).toBe(null)
    expect(b.folders.find((f) => f.id === 'e')!.parentId).toBe('d')
    expect(b.sources[0].folderId).toBe(null)
    expect(b.sources[1].folderId).toBe('e')
  })

  it('validates the kind-specific config with the shared validators', () => {
    const base = (): Record<string, unknown> => rawOf(build({ sources: [] }))
    const withSrc = (s: unknown): Record<string, unknown> => ({ ...base(), sources: [s] })
    expect(() => validateBackup(withSrc({ ...ddb('d'), dynamo: { region: 'Bad Region!', authMode: 'default' } }))).toThrow(/Invalid region/)
    expect(() => validateBackup(withSrc({ ...ddb('d'), dynamo: { region: 'x', authMode: 'oauth' } }))).toThrow(/sign-in mode/)
    expect(() => validateBackup(withSrc({ ...ddb('d'), dynamo: { region: '', authMode: 'profile', profile: '../x' } }))).toThrow(/profile/)
    expect(() => validateBackup(withSrc({ ...ddb('d'), dynamo: { region: '', authMode: 'default', endpoint: 'ftp://x' } }))).toThrow(/Endpoint/)
    expect(() => validateBackup(withSrc({ ...ddb('d'), dynamo: { region: '', authMode: 'keys' } }))).toThrow(/Access key ID/)
    expect(() => validateBackup(withSrc({ ...ddb('d'), dynamo: undefined }))).toThrow(/DynamoDB settings are missing/)
    expect(() => validateBackup(withSrc({ ...rds('r'), redis: { host: 'h', port: 0, db: 0 } }))).toThrow(/Port/)
    expect(() => validateBackup(withSrc({ ...rds('r'), redis: { host: 'h', port: 1, db: 999 } }))).toThrow(/Database/)
    expect(() => validateBackup(withSrc({ ...rds('r'), redis: { host: '', port: 1, db: 0 } }))).toThrow(/Host/)
    expect(() => validateBackup(withSrc({ ...rds('r'), redis: { host: 'h', port: 1, db: 0, keyDelimiter: 5 } }))).toThrow(/delimiter/)
    expect(() => validateBackup(withSrc({ ...pg('p'), kind: 'mongo' }))).toThrow(/Unknown data source type/)
    expect(() => validateBackup(withSrc('str'))).toThrow(/not an object/)
    expect(() => validateBackup(withSrc({ ...pg('p'), host: 5 }))).toThrow(/host/)
    expect(() => validateBackup(withSrc({ ...pg('p'), name: 'x', schemaFilter: [] }))).toThrow(/schema filter/)
    expect(() => validateBackup(withSrc({ ...pg('p'), tableFilter: { 'a/b': { rule: { mode: 'weird', pattern: '' } } } }))).toThrow(/filter mode/)
  })

  it('only keeps fields that belong to the auth mode / kind (profile, keys, endpoint normalised)', () => {
    const d = ddb('d', { dynamo: { region: ' us-east-1 ', authMode: 'profile', profile: 'dev', accessKeyId: 'leftover', secretAccessKey: 's', endpoint: 'http://localhost:8000/' } })
    const b = buildBackup({ sources: [d], folders: [], includeSecrets: true, appVersion: '1', platform: 'darwin' })
    expect(b.sources[0].dynamo).toEqual({ region: 'us-east-1', authMode: 'profile', profile: 'dev', endpoint: 'http://localhost:8000' })
    expect(b.sources[0].host).toBe('')
    expect(b.secrets).toBe(false)
  })

  it('bounds strings and cleans control characters; names fall back to placeholders', () => {
    const raw = rawOf(build())
    raw.folders = [{ id: 'f', name: '  Pro\u0000d\n ', parentId: null }, { id: 'g', name: '   ', parentId: null }]
    raw.sources = [pg('a', { name: ' \u0007 ' }), pg('b', { name: 'n'.repeat(500) })]
    const b = validateBackup(raw)
    expect(b.folders.map((f) => f.name)).toEqual(['Prod', 'New Folder'])
    expect(b.sources[0].name).toBe('Untitled')
    expect(b.sources[1].name).toHaveLength(200)
    expect(() => validateBackup({ ...raw, sources: [pg('a', { host: 'h'.repeat(300) })] })).toThrow(/too long/)
    expect(() => validateBackup({ ...raw, sources: [pg('a', { visibleDbs: Array.from({ length: 5001 }, () => 'x') })] })).toThrow(/too many/)
  })

  it('ignores unknown dbSort values and keeps visibleDbs: null', () => {
    const raw = rawOf(build())
    raw.sources = [pg('a', { dbSort: 'weird' as never, visibleDbs: null })]
    const b = validateBackup(raw)
    expect(b.sources[0].dbSort).toBeUndefined()
    expect(b.sources[0].visibleDbs).toBeNull()
  })
})

describe('settings, layout and session sections', () => {
  it('settings: plain values only, safe keys, bad types dropped (the renderer normalises the values themselves)', () => {
    expect(sanitizeSettings({ uiSize: 99, uiFont: 'comic', restoreTabs: 'yes', nested: { a: 1 }, list: [1], nul: null, 'bad key': 1, n: Number.NaN, long: 'x'.repeat(200), ok: true }))
      .toEqual({ uiSize: 99, uiFont: 'comic', restoreTabs: 'yes', ok: true })
    expect(sanitizeSettings('nope')).toBeUndefined()
    expect(sanitizeSettings([1])).toBeUndefined()
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['k' + i, i]))
    expect(Object.keys(sanitizeSettings(many)!).length).toBeLessThanOrEqual(64)
  })

  it('layout whitelist: split ratios and picker sizes only, never the session or other keys', () => {
    expect(
      sanitizeLayout({
        'datagrip-lite:console-split': '0.4',
        'datagrip-lite:filter-split': '0.6',
        'datagrip-lite:redis-split': '0.5',
        'datagrip-lite:picker-size:table': '{"w":300,"h":200}',
        'datagrip-lite:session': '{"v":1,"tabs":[]}',
        'datagrip-lite:settings': '{}',
        'datagrip-lite:picker-size:../x': '1',
        'datagrip-lite:picker-size:': '1',
        'other:key': '1',
        'datagrip-lite:console-split2': '1'
      })
    ).toEqual({
      'datagrip-lite:console-split': '0.4',
      'datagrip-lite:filter-split': '0.6',
      'datagrip-lite:redis-split': '0.5',
      'datagrip-lite:picker-size:table': '{"w":300,"h":200}'
    })
    expect(isBackupLayoutKey('datagrip-lite:session')).toBe(false)
    expect(isBackupLayoutKey('datagrip-lite:picker-size:db')).toBe(true)
    expect(isBackupLayoutKey(5)).toBe(false)
  })

  it('layout values must be small JSON numbers / number-only objects', () => {
    expect(sanitizeLayout({ 'datagrip-lite:console-split': 'not json', 'datagrip-lite:filter-split': '"str"', 'datagrip-lite:redis-split': 'x'.repeat(300) })).toEqual({})
    expect(sanitizeLayout({ 'datagrip-lite:picker-size:a': '{"w":"1"}', 'datagrip-lite:picker-size:b': '{"a":1,"b":2,"c":3,"d":4,"e":5}' })).toEqual({})
    expect(sanitizeLayout(5)).toBeUndefined()
  })

  it('the session is optional and never carries console SQL text', () => {
    expect(build().session).toBeUndefined()
    const sess = { v: 1, tabs: [{ type: 'console', c: { id: 'c1' } }], consoleSql: { c1: 'select secret from t' }, width: 300 }
    const b = build({ session: sess })
    expect(b.session).toMatchObject({ v: 1, width: 300, consoleSql: {} })
    expect(serializeBackup(b)).not.toContain('select secret')
    expect(sanitizeSession('x')).toBeUndefined()
    expect(() => sanitizeSession({ v: 1, big: 'x'.repeat(2_100_000) })).toThrow(/too large/)
  })

  it('a backup includes settings and layout only when given', () => {
    expect(build().settings).toBeUndefined()
    expect(build().layout).toBeUndefined()
    const b = build({ settings: { uiSize: 15, motion: 'off' }, layout: { 'datagrip-lite:console-split': '0.3', 'datagrip-lite:session': '{}' } })
    expect(b.settings).toEqual({ uiSize: 15, motion: 'off' })
    expect(b.layout).toEqual({ 'datagrip-lite:console-split': '0.3' })
  })
})

describe('parseBackupFile', () => {
  it('reads a plain backup (also with a BOM)', () => {
    const text = serializeBackup(build())
    for (const t of [text, '\ufeff' + text]) {
      const p = parseBackupFile(t)
      expect(p.encrypted).toBe(false)
    }
  })

  it('reports corrupt / truncated JSON', () => {
    const text = serializeBackup(build())
    for (const t of [text.slice(0, text.length / 2), '', 'not json', '{"format":']) {
      try {
        parseBackupFile(t)
        expect.unreachable()
      } catch (e) {
        expect((e as BackupError).code).toBe('corrupt')
        expect((e as Error).message).toMatch(/not valid JSON/)
      }
    }
  })

  it('rejects non-objects and foreign JSON', () => {
    expect(() => parseBackupFile('[1,2]')).toThrow('not a DataGrid backup')
    expect(() => parseBackupFile('"str"')).toThrow('not a DataGrid backup')
    expect(() => parseBackupFile('{"format":"x","version":1}')).toThrow('not a DataGrid backup')
    expect(() => parseBackupFile(JSON.stringify({ ...rawOf(build()), version: 7 }))).toThrow('newer DataGrid')
  })
})

describe('encryption (scrypt + AES-256-GCM)', () => {
  it('validates the passphrase length', () => {
    expect(validatePassphrase('short')).toMatch(/at least 8/)
    expect(validatePassphrase('12345678')).toBeNull()
    expect(validatePassphrase(5)).toMatch(/Enter/)
    expect(validatePassphrase('x'.repeat(2000))).toMatch(/too long/)
  })

  it('round-trips the whole payload including secrets, with the documented envelope', async () => {
    const b = build({ includeSecrets: true })
    const env = await encryptBackup(b, 'correct horse battery')
    expect(env).toMatchObject({ format: 'datagrid-backup', version: 1, encrypted: true, cipher: 'aes-256-gcm', kdf: { name: 'scrypt', N: 32768, r: 8, p: 1 } })
    expect(Buffer.from(env.kdf.salt, 'base64')).toHaveLength(16)
    expect(Buffer.from(env.iv, 'base64')).toHaveLength(12)
    expect(Buffer.from(env.tag, 'base64')).toHaveLength(16)
    const text = serializeBackup(env)
    for (const s of ['pg-pass', 'SECRET-KEY', 'RDS-PASS', 'db.local', 'Prod']) expect(text).not.toContain(s) // the WHOLE payload is encrypted
    const parsed = parseBackupFile(text)
    expect(parsed.encrypted).toBe(true)
    if (!parsed.encrypted) throw new Error('unexpected')
    expect(await decryptBackup(parsed.envelope, 'correct horse battery')).toEqual(b)
  })

  it('uses a fresh salt and IV for every file', async () => {
    const b = build()
    const [a, c] = await Promise.all([encryptBackup(b, 'passphrase-1'), encryptBackup(b, 'passphrase-1')])
    expect(a.kdf.salt).not.toBe(c.kdf.salt)
    expect(a.iv).not.toBe(c.iv)
    expect(a.data).not.toBe(c.data)
  })

  it('refuses a short passphrase when encrypting', async () => {
    await expect(encryptBackup(build(), 'short')).rejects.toThrow(/at least 8/)
  })

  it('a wrong passphrase gives the clear GCM message', async () => {
    const env = await encryptBackup(build(), 'right-passphrase')
    await expect(decryptBackup(env, 'wrong-passphrase')).rejects.toMatchObject({ code: 'passphrase', message: 'Wrong passphrase or the file was modified' })
    await expect(decryptBackup(env, '')).rejects.toMatchObject({ code: 'passphrase' })
  })

  it('a modified ciphertext, tag, iv, salt, version or kdf parameter fails authentication', async () => {
    const env = await encryptBackup(build(), 'right-passphrase')
    const flip = (b64: string): string => {
      const buf = Buffer.from(b64, 'base64')
      buf[0] ^= 1
      return buf.toString('base64')
    }
    const variants: Record<string, Envelope> = {
      data: { ...env, data: flip(env.data) },
      tag: { ...env, tag: flip(env.tag) },
      iv: { ...env, iv: flip(env.iv) },
      salt: { ...env, kdf: { ...env.kdf, salt: flip(env.kdf.salt) } },
      p: { ...env, kdf: { ...env.kdf, p: 2 } },
      r: { ...env, kdf: { ...env.kdf, r: 9 } }
    }
    for (const [name, v] of Object.entries(variants)) {
      await expect(decryptBackup(v, 'right-passphrase'), name).rejects.toMatchObject({ message: 'Wrong passphrase or the file was modified' })
    }
    // truncated data
    await expect(decryptBackup({ ...env, data: env.data.slice(0, 8) }, 'right-passphrase')).rejects.toMatchObject({ code: 'passphrase' })
  })

  it('rejects malformed envelopes and unsupported / dangerous KDF parameters before deriving a key', async () => {
    const env = await encryptBackup(build(), 'right-passphrase')
    const bad = (e: unknown): Promise<unknown> => decryptBackup(e as Envelope, 'right-passphrase').catch((x: unknown) => x)
    expect(await bad({ ...env, cipher: 'aes-128-cbc' })).toBeInstanceOf(BackupError)
    expect(await bad({ ...env, kdf: { ...env.kdf, name: 'pbkdf2' } })).toBeInstanceOf(BackupError)
    expect(await bad({ ...env, kdf: { ...env.kdf, N: 1 << 30 } })).toMatchObject({ code: 'format' }) // would need gigabytes
    expect(await bad({ ...env, kdf: { ...env.kdf, N: 1 << 10 } })).toMatchObject({ code: 'format' }) // too weak
    expect(await bad({ ...env, kdf: { ...env.kdf, N: 30000 } })).toMatchObject({ code: 'format' })
    expect(await bad({ ...env, kdf: { ...env.kdf, r: 64 } })).toMatchObject({ code: 'format' })
    expect(await bad({ ...env, kdf: { ...env.kdf, p: 100 } })).toMatchObject({ code: 'format' })
    expect(await bad({ ...env, iv: 'AAAA' })).toMatchObject({ code: 'corrupt' })
    expect(await bad({ ...env, tag: '***' })).toMatchObject({ code: 'corrupt' })
    expect(await bad({ ...env, data: '' })).toMatchObject({ code: 'corrupt' })
    expect(await bad({ ...env, kdf: { ...env.kdf, salt: 'AAAA' } })).toMatchObject({ code: 'corrupt' })
    expect(() => parseBackupFile(JSON.stringify({ ...env, version: 3 }))).toThrow('newer DataGrid')
  })

  it('a decrypted payload is validated like any other (a hostile payload cannot sneak in)', async () => {
    const hostile = { ...rawOf(build()), sources: [{ ...pg('p'), port: 'x' }] } as unknown as Backup
    const env = await encryptBackup(hostile, 'right-passphrase')
    await expect(decryptBackup(env, 'right-passphrase')).rejects.toThrow(/port/)
  })

  it('normalises the passphrase (NFC) so the same text typed differently still opens the file', async () => {
    const env = await encryptBackup(build(), 'caf\u00e9-passphrase')
    await expect(decryptBackup(env, 'cafe\u0301-passphrase')).resolves.toBeTruthy()
  })

  it('supports a custom KDF only within the accepted range (tests / future)', async () => {
    const env = await encryptBackup(build(), 'right-passphrase', { ...KDF, p: 2 })
    expect(env.kdf.p).toBe(2)
    await expect(decryptBackup(env, 'right-passphrase')).resolves.toBeTruthy()
  })
})

describe('planImport', () => {
  const current = { folders: [{ id: 'f1', name: 'Prod', parentId: null }] as Folder[], sources: [pg('p1', { name: 'Main' }), rds('r9', { name: 'Cache' })] }
  const fromBackup = (over: Partial<Backup> = {}): Backup => ({ ...build({ sources: [], folders: [] }), ...over })

  it('replace: exactly the backup, current ones are touched / removed', () => {
    const b = fromBackup({ folders: [{ id: 'n1', name: 'New', parentId: null }], sources: [pg('p1', { name: 'Renamed', folderId: 'n1' }), pg('p2')] })
    const plan = planImport(current, b, 'replace', { newId: seq() })
    expect(plan.folders).toEqual(b.folders)
    expect(plan.items).toHaveLength(2)
    expect(plan.removedIds).toEqual(['r9'])
    expect(plan.touchedIds.sort()).toEqual(['p1', 'r9'])
    expect(plan.sourcesAdded).toBe(2)
    expect(plan.addedByKind).toEqual({ postgres: 2, dynamodb: 0, redis: 0 })
    // a plain backup keeps the saved secrets of a source with the same id; a new one has nothing to inherit
    expect(plan.items[0]).toMatchObject({ inheritFrom: 'p1' })
    expect(plan.items[1]).not.toHaveProperty('inheritFrom')
  })

  it('replace: a backup with secrets (or an automatic backup) is authoritative', () => {
    const withSecrets = fromBackup({ secrets: true, sources: [pg('p1', { password: 'x' })] })
    expect(planImport(current, withSecrets, 'replace').items[0]).not.toHaveProperty('inheritFrom')
    const auto = fromBackup({ sources: [pg('p1'), pg('p3')], deviceSecrets: { p1: { password: 'enc:AAAA' } } })
    const plan = planImport(current, auto, 'replace')
    expect(plan.items[0]).toMatchObject({ deviceSecrets: { password: 'enc:AAAA' } })
    expect(plan.items[1]).toMatchObject({ deviceSecrets: {} })
    expect(plan.items[0]).not.toHaveProperty('inheritFrom')
  })

  it('merge: keeps everything that exists and adds what is missing (folders keep their nesting)', () => {
    const b = fromBackup({
      folders: [{ id: 'g1', name: 'Staging', parentId: null }, { id: 'g2', name: 'EU', parentId: 'g1' }],
      sources: [pg('p5', { name: 'Reports', folderId: 'g2' }), ddb('d5', { name: 'Events' })]
    })
    const plan = planImport(current, b, 'merge', { newId: seq() })
    expect(plan.items.slice(0, 2)).toEqual([{ keep: 'p1' }, { keep: 'r9' }])
    expect(plan.folders).toEqual([...current.folders, { id: 'g1', name: 'Staging', parentId: null }, { id: 'g2', name: 'EU', parentId: 'g1' }])
    expect(plan.items[2]).toMatchObject({ add: { id: 'p5', name: 'Reports', folderId: 'g2' } })
    expect(plan.items[3]).toMatchObject({ add: { id: 'd5', name: 'Events', folderId: null } })
    expect(plan).toMatchObject({ foldersAdded: 2, sourcesAdded: 2, skipped: 0, renamed: 0, removedIds: [], touchedIds: [] })
    expect(plan.addedByKind).toEqual({ postgres: 1, dynamodb: 1, redis: 0 })
  })

  it('merge: an id collision with different content becomes an "(imported)" copy with a fresh id', () => {
    const b = fromBackup({ sources: [pg('p1', { name: 'Other name', host: 'other' })] })
    const plan = planImport(current, b, 'merge', { newId: seq() })
    expect(plan.items[2]).toMatchObject({ add: { id: 'gen-1', name: 'Other name (imported)', host: 'other' } })
    expect(plan.renamed).toBe(1)
    expect(plan.items[0]).toEqual({ keep: 'p1' })
  })

  it('merge: a name collision (case / spaces ignored) becomes a copy with a fresh id, numbered when needed', () => {
    const b = fromBackup({ sources: [pg('n1', { name: ' main ' }), pg('n2', { name: 'Main' })] })
    const cur = { folders: [], sources: [pg('p1', { name: 'Main' }), pg('x', { name: 'Main (imported)' })] }
    const plan = planImport(cur, b, 'merge', { newId: seq() })
    const added = plan.items.filter((i) => 'add' in i).map((i) => ('add' in i ? i.add : null)!)
    expect(added.map((a) => a.name)).toEqual(['main (imported 2)', 'Main (imported 3)'])
    expect(new Set(added.map((a) => a.id)).size).toBe(2)
    expect(added.every((a) => a.id.startsWith('gen-'))).toBe(true)
    expect(plan.renamed).toBe(2)
  })

  it('merge: an exact duplicate (same id, name and connection) is skipped, so importing twice does not double everything', () => {
    const b = fromBackup({ sources: [pg('p1', { name: 'Main' }), rds('r9', { name: 'Cache' })], folders: [{ id: 'f1', name: 'Prod', parentId: null }] })
    const plan = planImport(current, b, 'merge', { newId: seq() })
    expect(plan.items).toEqual([{ keep: 'p1' }, { keep: 'r9' }])
    expect(plan.skipped).toBe(2)
    expect(plan).toMatchObject({ sourcesAdded: 0, foldersAdded: 0, renamed: 0 })
    expect(plan.folders).toEqual(current.folders)
  })

  it('merge: folders collide by id with another name or by name under the same parent; children follow their (possibly renamed) parent', () => {
    const b = fromBackup({
      folders: [
        { id: 'f1', name: 'Different', parentId: null }, // same id, other name -> copy
        { id: 'k1', name: 'prod', parentId: null }, // same name (case-insens.) as f1 "Prod" -> copy
        { id: 'k2', name: 'Child', parentId: 'k1' },
        { id: 'k3', name: 'Fresh', parentId: null }
      ],
      sources: [pg('s9', { name: 'S9', folderId: 'k2' })]
    })
    const plan = planImport(current, b, 'merge', { newId: seq() })
    expect(plan.folders).toEqual([
      { id: 'f1', name: 'Prod', parentId: null },
      { id: 'gen-1', name: 'Different (imported)', parentId: null },
      { id: 'gen-2', name: 'prod (imported)', parentId: null },
      { id: 'k2', name: 'Child', parentId: 'gen-2' },
      { id: 'k3', name: 'Fresh', parentId: null }
    ])
    expect(plan.foldersAdded).toBe(4)
    expect(plan.renamed).toBe(2)
    expect(plan.items[2]).toMatchObject({ add: { folderId: 'k2' } })
  })

  it('merge: a folder with the same id and name is the same folder (its sources land in it)', () => {
    const b = fromBackup({ folders: [{ id: 'f1', name: 'Prod', parentId: null }], sources: [pg('s9', { name: 'S9', folderId: 'f1' })] })
    const plan = planImport(current, b, 'merge', { newId: seq() })
    expect(plan.folders).toEqual(current.folders)
    expect(plan.items[2]).toMatchObject({ add: { id: 's9', folderId: 'f1' } })
  })

  it('merge never reuses an id that is taken (even by another imported source) and ends up with unique ids', () => {
    const b = fromBackup({ sources: [pg('a', { name: 'A' }), pg('b', { name: 'B' })] })
    const ids = ['a', 'p1', 'gen-x']
    let i = 0
    const plan = planImport({ folders: [], sources: [pg('a', { name: 'Zed', host: 'diff' })] }, b, 'merge', { newId: () => ids[i++] ?? `n${i++}` })
    const all = plan.items.map((x) => ('keep' in x ? x.keep : x.add.id))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('helpers', () => {
  it('summarize counts folders and sources by kind and reports what is included', () => {
    const b = build({ includeSecrets: true, settings: { uiSize: 14 }, layout: { 'datagrip-lite:console-split': '0.5' }, session: { v: 1 } })
    const s = summarize(b, 'x.json', true)
    expect(s).toMatchObject({
      fileName: 'x.json', appVersion: '1.2.3', platform: 'darwin', hasSettings: true, hasLayout: true, hasSession: true, hasSecrets: true, encrypted: true,
      counts: { folders: 2, sources: 3, byKind: { postgres: 1, dynamodb: 1, redis: 1 } }
    })
    const plain = summarize(build(), 'p.json', false)
    expect(plain).toMatchObject({ hasSettings: false, hasLayout: false, hasSession: false, hasSecrets: false, encrypted: false })
    expect(countsOf([], [pg('a')]).byKind).toEqual({ postgres: 1, dynamodb: 0, redis: 0 })
  })

  it('stripSecrets removes every secret field and runtime flags', () => {
    const s = stripSecrets(rds('r', { passwordUnavailable: true }))
    expect(s.redis).not.toHaveProperty('password')
    expect(s).not.toHaveProperty('passwordUnavailable')
    const d = stripSecrets(ddb('d', { dynamo: { region: 'x', authMode: 'keys', accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't', hasSecret: true, hasSessionToken: true } }))
    expect(d.dynamo).toEqual({ region: 'x', authMode: 'keys', accessKeyId: 'a' })
    expect(stripSecrets(pg('p', { password: 'x' })).password).toBe('')
  })

  it('suggestFileName uses the local date', () => {
    expect(suggestFileName(new Date(2026, 10, 5, 23, 59))).toBe('DataGrid-backup-2026-11-05.datagrid-backup.json')
    expect(suggestFileName(new Date(2026, 0, 2))).toBe('DataGrid-backup-2026-01-02.datagrid-backup.json')
  })

  it('deviceSecretsOf copies only still-encrypted blobs ("raw:" readable text never)', () => {
    const raw = [pg('a', { password: 'enc:QUJD' }), pg('b', { password: 'raw:plain' }), pg('c'), pg('bad id', { password: 'enc:QUJD' })]
    const out = deviceSecretsOf(raw, (d) => ({ password: d.password || undefined }))
    expect(out).toEqual({ a: { password: 'enc:QUJD' } })
  })

  it('device secrets are only read when explicitly allowed, and only well-formed blobs', () => {
    const raw = { ...rawOf(build()), deviceSecrets: { p1: { password: 'enc:QUJD', secretAccessKey: 'raw:x', sessionToken: 5 }, '../x': { password: 'enc:QUJD' }, '__proto__': { password: 'enc:QUJD' } } }
    expect(validateBackup(raw).deviceSecrets).toBeUndefined()
    expect(parseBackupFile(JSON.stringify(raw)).encrypted).toBe(false)
    expect(validateBackup(raw, { allowDeviceSecrets: true }).deviceSecrets).toEqual({ p1: { password: 'enc:QUJD' } })
  })
})
