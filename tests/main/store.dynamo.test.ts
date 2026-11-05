import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DataSource, DynamoConfig } from '../../src/shared'

const fake = vi.hoisted(() => ({
  dir: '',
  available: true,
  decryptThrows: false,
  encryptThrows: false,
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  isEncryptionAvailable: vi.fn(),
  showMessageBox: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  dialog: { showMessageBox: fake.showMessageBox },
  safeStorage: fake
}))

import {
  duplicateSource, hasStoredPasswords, loadSource, loadSources, loadSourcesForRenderer, mergeStoredSecrets, mutateSource,
  patchSource, publicSource, updateSourceFolders, upsertSource
} from '../../src/main/store'

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const TOKEN = 'IQoJb3JpZ2luX2VjEXAMPLETOKEN'
const dsFile = (): string => join(fake.dir, 'datasources.json')
const fileText = (): string => readFileSync(dsFile(), 'utf8')
const rawList = (): DataSource[] => JSON.parse(fileText())

const ddb = (id: string, dynamo: Partial<DynamoConfig> = {}, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  dynamo: { region: 'us-east-1', authMode: 'keys', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: SECRET, ...dynamo }, ...over
})
const pg = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, host: 'localhost', port: 5432, user: 'u', password: 'pw', database: 'postgres', ssl: false, ...over
})

beforeEach(() => {
  fake.dir = mkdtempSync(join(tmpdir(), 'dgl-store-ddb-'))
  fake.available = true
  fake.decryptThrows = false
  fake.encryptThrows = false
  fake.isEncryptionAvailable.mockImplementation(() => fake.available)
  fake.encryptString.mockImplementation((s: string) => {
    if (fake.encryptThrows) throw new Error('no keychain')
    return Buffer.from('ENC<' + s + '>')
  })
  fake.decryptString.mockImplementation((b: Buffer) => {
    if (fake.decryptThrows) throw new Error('keychain denied')
    return b.toString().replace(/^ENC</, '').replace(/>$/, '')
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => rmSync(fake.dir, { recursive: true, force: true }))

describe('saving a DynamoDB source', () => {
  it('encrypts the secret access key and the session token; nothing secret is readable on disk', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    const raw = rawList()[0].dynamo!
    expect(raw.secretAccessKey).toMatch(/^enc:/)
    expect(raw.sessionToken).toMatch(/^enc:/)
    expect(fileText()).not.toContain(SECRET)
    expect(fileText()).not.toContain(TOKEN)
    expect(raw.accessKeyId).toBe('AKIAEXAMPLE') // the key id is not a secret
    expect(hasStoredPasswords()).toBe(true)
  })

  it('stores the Postgres connection fields empty and marks the kind', () => {
    upsertSource(ddb('a', {}, { host: 'h', port: 1, user: 'u', password: 'p', database: 'd', ssl: true }))
    expect(rawList()[0]).toMatchObject({ kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false })
  })

  it('without a usable keychain the secrets are stored with the raw: prefix (like the Postgres password)', () => {
    fake.available = false
    upsertSource(ddb('a'))
    expect(rawList()[0].dynamo!.secretAccessKey).toBe('raw:' + SECRET)
    expect(loadSource('a')!.dynamo!.secretAccessKey).toBe(SECRET)
  })

  it('a keychain failure while encrypting is an error, and nothing is written', () => {
    fake.encryptThrows = true
    expect(() => upsertSource(ddb('a'))).toThrow(/Could not save the password.*macOS Keychain access was denied/)
    expect(() => rawList()).toThrow() // no file
  })

  it('does not store runtime-only flags', () => {
    upsertSource(ddb('a', { hasSecret: true, hasSessionToken: true }, { passwordUnavailable: false }))
    const d = rawList()[0]
    expect(d.dynamo).not.toHaveProperty('hasSecret')
    expect(d.dynamo).not.toHaveProperty('hasSessionToken')
    expect(d).not.toHaveProperty('passwordUnavailable')
  })

  it('normalises region, profile and endpoint', () => {
    upsertSource(ddb('p', { authMode: 'profile', profile: ' dev ', region: ' eu-west-1 ', endpoint: 'http://localhost:8000///' }))
    expect(rawList()[0].dynamo).toEqual({ region: 'eu-west-1', authMode: 'profile', profile: 'dev', endpoint: 'http://localhost:8000' })
  })

  it('profile / default sources never keep keys or secrets, even if the form still carried them', () => {
    upsertSource(ddb('p', { authMode: 'profile', profile: 'dev', accessKeyId: 'AKIA', sessionToken: TOKEN }))
    expect(rawList()[0].dynamo).toEqual({ region: 'us-east-1', authMode: 'profile', profile: 'dev' })
    upsertSource(ddb('d', { authMode: 'default' }))
    expect(rawList()[1].dynamo).toEqual({ region: 'us-east-1', authMode: 'default' })
    expect(fileText()).not.toContain(SECRET)
  })

  it('validates: region, endpoint scheme, profile, missing key / secret', () => {
    expect(() => upsertSource(ddb('a', { region: 'bad region!' }))).toThrow(/Invalid region/)
    expect(() => upsertSource(ddb('a', { endpoint: 'file:///etc/passwd' }))).toThrow(/http:\/\/ or https:\/\//)
    expect(() => upsertSource(ddb('a', { endpoint: 'ftp://x' }))).toThrow(/http:\/\/ or https:\/\//)
    expect(() => upsertSource(ddb('a', { authMode: 'profile', profile: '../../etc/passwd' }))).toThrow(/Invalid profile/)
    expect(() => upsertSource(ddb('a', { authMode: 'profile', profile: '' }))).toThrow(/profile name/)
    expect(() => upsertSource(ddb('a', { accessKeyId: '' }))).toThrow(/Access key ID is required/)
    expect(() => upsertSource(ddb('a', { secretAccessKey: '' }))).toThrow(/Secret access key is required/)
    expect(() => rawList()).toThrow()
  })

  it('an invalid endpoint is rejected even in default mode', () => {
    expect(() => upsertSource(ddb('a', { authMode: 'default', endpoint: 'javascript:alert(1)' }))).toThrow(/http:\/\/ or https:\/\//)
  })
})

describe('editing: the write-only secret protocol', () => {
  it('blank secret keeps the saved blob byte for byte; new text replaces it', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    const before = rawList()[0].dynamo!
    upsertSource(ddb('a', { secretAccessKey: '', sessionToken: undefined, region: 'eu-west-1' }))
    const kept = rawList()[0].dynamo!
    expect(kept.secretAccessKey).toBe(before.secretAccessKey)
    expect(kept.sessionToken).toBe(before.sessionToken)
    expect(kept.region).toBe('eu-west-1')
    upsertSource(ddb('a', { secretAccessKey: 'new-secret', sessionToken: undefined }))
    expect(loadSource('a')!.dynamo!.secretAccessKey).toBe('new-secret')
    expect(loadSource('a')!.dynamo!.sessionToken).toBe(TOKEN)
  })

  it('session token: undefined keeps, empty string clears, text replaces', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    upsertSource(ddb('a', { secretAccessKey: '', sessionToken: '' }))
    expect(rawList()[0].dynamo).not.toHaveProperty('sessionToken')
    expect(loadSource('a')!.dynamo!.sessionToken).toBeUndefined()
    upsertSource(ddb('a', { secretAccessKey: '', sessionToken: 'fresh' }))
    expect(loadSource('a')!.dynamo!.sessionToken).toBe('fresh')
  })

  it('a saved secret satisfies the "secret required" rule', () => {
    upsertSource(ddb('a'))
    expect(() => upsertSource(ddb('a', { secretAccessKey: '' }))).not.toThrow()
    expect(loadSource('a')!.dynamo!.secretAccessKey).toBe(SECRET)
  })

  it('switching from keys to another mode drops the saved secrets', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    upsertSource(ddb('a', { authMode: 'default', secretAccessKey: '', sessionToken: undefined }))
    expect(rawList()[0].dynamo).toEqual({ region: 'us-east-1', authMode: 'default' })
  })

  it('upserting a DynamoDB source leaves the other sources untouched', () => {
    upsertSource(pg('pg1'))
    const pgBlob = rawList()[0].password
    upsertSource(ddb('a'))
    upsertSource(ddb('a', { region: 'eu-west-1', secretAccessKey: '' }))
    expect(rawList()[0].password).toBe(pgBlob)
    expect(rawList()).toHaveLength(2)
  })
})

describe('reading', () => {
  it('main-process loaders decrypt', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    expect(loadSource('a')!.dynamo).toMatchObject({ secretAccessKey: SECRET, sessionToken: TOKEN, accessKeyId: 'AKIAEXAMPLE' })
    expect(loadSources()[0]).toMatchObject({ kind: 'dynamodb', passwordUnavailable: false })
    expect(loadSource('missing')).toBeUndefined()
  })

  it('renderer loader never carries the secrets, only flags', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    upsertSource(ddb('b', { authMode: 'default' }))
    upsertSource(pg('c'))
    const list = loadSourcesForRenderer()
    const a = list[0].dynamo!
    expect(a).toMatchObject({ hasSecret: true, hasSessionToken: true, accessKeyId: 'AKIAEXAMPLE' })
    expect(a).not.toHaveProperty('secretAccessKey')
    expect(a).not.toHaveProperty('sessionToken')
    expect(list[1].dynamo).toMatchObject({ hasSecret: false, hasSessionToken: false })
    expect(list[2].password).toBe('pw') // Postgres behaviour unchanged
    const wire = JSON.stringify(list)
    expect(wire).not.toContain(SECRET)
    expect(wire).not.toContain(TOKEN)
    expect(wire).not.toContain('enc:')
  })

  it('the renderer still sees the flags when the keychain is denied', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    fake.decryptThrows = true
    const a = loadSourcesForRenderer()[0]
    expect(a.passwordUnavailable).toBe(true)
    expect(a.dynamo).toMatchObject({ hasSecret: true, hasSessionToken: true })
    expect(a.dynamo).not.toHaveProperty('secretAccessKey')
  })

  it('publicSource strips secrets from any DynamoDB source and leaves Postgres alone', () => {
    const s = publicSource(ddb('a', { sessionToken: TOKEN }))
    expect(s.dynamo).not.toHaveProperty('secretAccessKey')
    expect(s.dynamo).not.toHaveProperty('sessionToken')
    expect(s.dynamo).toMatchObject({ hasSecret: true, hasSessionToken: true })
    const p = pg('p')
    expect(publicSource(p)).toBe(p)
    expect(publicSource({ ...ddb('x'), dynamo: undefined }).dynamo).toBeUndefined()
  })

  it('a keychain that denies access marks the source and removes the secrets instead of failing', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    fake.decryptThrows = true
    const d = loadSource('a')!
    expect(d.passwordUnavailable).toBe(true)
    expect(d.dynamo).not.toHaveProperty('secretAccessKey')
    expect(d.dynamo).not.toHaveProperty('sessionToken')
    expect(d.dynamo!.accessKeyId).toBe('AKIAEXAMPLE')
  })

  it('saving with a blank secret while the keychain is denied keeps the unreadable blob', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    const blob = rawList()[0].dynamo!
    fake.decryptThrows = true
    const loaded = loadSource('a')!
    upsertSource({ ...loaded, dynamo: { ...loaded.dynamo!, region: 'eu-west-1' } })
    const after = rawList()[0].dynamo!
    expect(after.secretAccessKey).toBe(blob.secretAccessKey)
    expect(after.sessionToken).toBe(blob.sessionToken)
    expect(after.region).toBe('eu-west-1')
  })
})

describe('migration of sources saved before DynamoDB support', () => {
  it('a source without kind loads as postgres and the file is not rewritten', () => {
    upsertSource(pg('old'))
    const list = rawList()
    delete (list[0] as Partial<DataSource>).kind
    writeFileSync(dsFile(), JSON.stringify(list, null, 2))
    const before = fileText()
    expect(before).not.toContain('"kind"')
    const loaded = loadSource('old')!
    expect(loaded).toMatchObject({ kind: 'postgres', password: 'pw', host: 'localhost' })
    expect(loadSources()[0].kind).toBe('postgres')
    expect(loadSourcesForRenderer()[0].kind).toBe('postgres')
    expect(fileText()).toBe(before)
  })

  it('an old source with an empty password migrates too', () => {
    writeFileSync(dsFile(), JSON.stringify([{ id: 'x', name: 'x', host: 'h', port: 5432, user: 'u', password: '', database: 'd', ssl: false }]))
    expect(loadSource('x')).toMatchObject({ kind: 'postgres', password: '', passwordUnavailable: false })
  })

  it('Postgres and DynamoDB sources live side by side', () => {
    upsertSource(pg('p'))
    upsertSource(ddb('d'))
    expect(loadSources().map((s) => s.kind)).toEqual(['postgres', 'dynamodb'])
    expect(loadSource('p')!.password).toBe('pw')
  })
})

describe('raw helpers never touch the keychain', () => {
  beforeEach(() => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    fake.decryptString.mockClear()
    fake.encryptString.mockClear()
  })
  const untouched = (): void => {
    expect(fake.decryptString).not.toHaveBeenCalled()
    expect(fake.encryptString).not.toHaveBeenCalled()
  }

  it('patchSource / mutateSource / updateSourceFolders keep the encrypted blobs', () => {
    const blobs = JSON.stringify(rawList()[0].dynamo)
    patchSource('a', { name: 'renamed' })
    mutateSource('a', (d) => ({ name: d.name + '!' }))
    updateSourceFolders(() => 'folder-1')
    const d = rawList()[0]
    expect(d).toMatchObject({ name: 'renamed!', folderId: 'folder-1' })
    expect(JSON.stringify(d.dynamo)).toBe(blobs)
    untouched()
  })

  it('duplicate copies the encrypted blobs as they are', () => {
    duplicateSource('a', 'b')
    const [a, b] = rawList()
    expect(b).toMatchObject({ id: 'b', name: 'a copy', kind: 'dynamodb' })
    expect(b.dynamo).toEqual(a.dynamo)
    expect(b.dynamo!.secretAccessKey).toMatch(/^enc:/)
    untouched()
    // and the copy can be read
    expect(loadSource('b')!.dynamo!.secretAccessKey).toBe(SECRET)
  })
})

describe('mergeStoredSecrets (Test Connection of a saved source)', () => {
  it('fills a blank secret / token from the saved ones', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    const form = ddb('a', { secretAccessKey: '', sessionToken: undefined })
    const merged = mergeStoredSecrets(form)
    expect(merged.dynamo).toMatchObject({ secretAccessKey: SECRET, sessionToken: TOKEN })
  })

  it('typed values win; an explicit empty token stays cleared', () => {
    upsertSource(ddb('a', { sessionToken: TOKEN }))
    const merged = mergeStoredSecrets(ddb('a', { secretAccessKey: 'typed', sessionToken: '' }))
    expect(merged.dynamo).toMatchObject({ secretAccessKey: 'typed', sessionToken: '' })
  })

  it('does not touch the keychain when nothing is missing, for new sources or other modes', () => {
    upsertSource(ddb('a'))
    fake.decryptString.mockClear()
    const full = ddb('a', { secretAccessKey: 'x', sessionToken: 'y' })
    expect(mergeStoredSecrets(full)).toBe(full)
    const fresh = ddb('', { secretAccessKey: '' })
    expect(mergeStoredSecrets(fresh)).toBe(fresh)
    const profile = ddb('a', { authMode: 'profile', profile: 'p', secretAccessKey: undefined })
    expect(mergeStoredSecrets(profile)).toBe(profile)
    const p = pg('a')
    expect(mergeStoredSecrets(p)).toBe(p)
    expect(fake.decryptString).not.toHaveBeenCalled()
  })

  it('an unknown id or an unreadable keychain returns the form unchanged / without secrets', () => {
    const ghost = ddb('ghost', { secretAccessKey: '' })
    expect(mergeStoredSecrets(ghost)).toBe(ghost)
    upsertSource(ddb('a'))
    fake.decryptThrows = true
    expect(mergeStoredSecrets(ddb('a', { secretAccessKey: '' })).dynamo!.secretAccessKey).toBeUndefined()
  })
})
