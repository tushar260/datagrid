import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DataSource, RedisConfig } from '../../src/shared'

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
  duplicateSource, hasStoredPasswords, loadSource, loadSources, loadSourcesForRenderer, mergeStoredSecrets, publicSource, upsertSource
} from '../../src/main/store'

const PW = 'hunter2-s3cret'
const dsFile = (): string => join(fake.dir, 'datasources.json')
const fileText = (): string => readFileSync(dsFile(), 'utf8')
const rawList = (): DataSource[] => JSON.parse(fileText())

const rds = (id: string, redis: Partial<RedisConfig> = {}, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, kind: 'redis', host: 'junk', port: 1, user: 'junk', password: 'junk', database: 'junk', ssl: true,
  redis: { host: 'localhost', port: 6379, db: 0, tls: false, password: PW, ...redis }, ...over
})
const pg = (id: string): DataSource => ({ id, name: id, host: 'localhost', port: 5432, user: 'u', password: 'pw', database: 'postgres', ssl: false })

beforeEach(() => {
  fake.dir = mkdtempSync(join(tmpdir(), 'dgl-store-redis-'))
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

describe('saving a Redis source', () => {
  it('encrypts the password; the file never contains it', () => {
    upsertSource(rds('a'))
    expect(rawList()[0].redis!.password).toMatch(/^enc:/)
    expect(fileText()).not.toContain(PW)
    expect(hasStoredPasswords()).toBe(true)
  })

  it('keeps only the Redis fields (and stores the Postgres ones empty)', () => {
    upsertSource(rds('a', { username: ' app ', host: ' redis.local ', hasPassword: true, clearPassword: false }))
    const d = rawList()[0]
    expect(d).toMatchObject({ kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false })
    expect(Object.keys(d.redis!).sort()).toEqual(['db', 'host', 'password', 'port', 'tls', 'username'])
    expect(d.redis).toMatchObject({ host: 'redis.local', username: 'app', port: 6379, db: 0, tls: false })
  })

  it('without a usable keychain the password is stored with raw: (like Postgres)', () => {
    fake.available = false
    upsertSource(rds('a'))
    expect(rawList()[0].redis!.password).toBe('raw:' + PW)
    expect(loadSource('a')!.redis!.password).toBe(PW)
  })

  it('a keychain failure while encrypting is an error and nothing is written', () => {
    fake.encryptThrows = true
    expect(() => upsertSource(rds('a'))).toThrow(/Could not save the password/)
    expect(() => rawList()).toThrow()
  })

  it('a source without a password stores none', () => {
    upsertSource(rds('a', { password: undefined }))
    expect(rawList()[0].redis).not.toHaveProperty('password')
    expect(hasStoredPasswords()).toBe(false)
  })

  it('validates host / port / db before writing', () => {
    expect(() => upsertSource(rds('a', { host: ' ' }))).toThrow(/Host is required/)
    expect(() => upsertSource(rds('a', { port: 0 }))).toThrow(/Port/)
    expect(() => upsertSource(rds('a', { port: 70000 }))).toThrow(/Port/)
    expect(() => upsertSource(rds('a', { db: 256 }))).toThrow(/Database/)
    expect(() => upsertSource(rds('a', { db: -1 }))).toThrow(/Database/)
    expect(() => upsertSource(rds('a', { db: 1.5 }))).toThrow(/Database/)
    expect(() => rawList()).toThrow()
  })
})

describe('the write-only password protocol', () => {
  it('a blank password keeps the saved blob byte for byte; new text replaces it', () => {
    upsertSource(rds('a'))
    const before = rawList()[0].redis!.password
    upsertSource(rds('a', { password: '', db: 3 }))
    expect(rawList()[0].redis!.password).toBe(before)
    expect(rawList()[0].redis!.db).toBe(3)
    upsertSource(rds('a', { password: 'new-pw' }))
    expect(loadSource('a')!.redis!.password).toBe('new-pw')
  })

  it('clearPassword removes the saved password', () => {
    upsertSource(rds('a'))
    upsertSource(rds('a', { password: '', clearPassword: true }))
    expect(rawList()[0].redis).not.toHaveProperty('password')
    expect(loadSource('a')!.redis!.password).toBeUndefined()
    expect(fileText()).not.toContain('clearPassword')
  })

  it('typing a new password wins over clearPassword', () => {
    upsertSource(rds('a'))
    upsertSource(rds('a', { password: 'again', clearPassword: true }))
    expect(loadSource('a')!.redis!.password).toBe('again')
  })

  it('the renderer list has hasPassword and never the password', () => {
    upsertSource(rds('a'))
    upsertSource(rds('b', { password: undefined }))
    const [a, b] = loadSourcesForRenderer()
    expect(a.redis).toMatchObject({ hasPassword: true, host: 'localhost' })
    expect(a.redis).not.toHaveProperty('password')
    expect(b.redis!.hasPassword).toBe(false)
    expect(JSON.stringify(loadSourcesForRenderer())).not.toContain(PW)
    expect(JSON.stringify(loadSourcesForRenderer())).not.toContain('enc:')
  })

  it('publicSource (what saveSource returns) is stripped too', () => {
    const s = publicSource(rds('a'))
    expect(s.redis).not.toHaveProperty('password')
    expect(s.redis!.hasPassword).toBe(true)
  })

  it('the main process list decrypts the password', () => {
    upsertSource(rds('a'))
    expect(loadSources()[0].redis!.password).toBe(PW)
  })

  it('Test Connection of an existing source fills a blank password from the saved one', () => {
    upsertSource(rds('a'))
    const merged = mergeStoredSecrets(rds('a', { password: '', hasPassword: true }))
    expect(merged.redis!.password).toBe(PW)
    // a typed password is used as is, and so is an explicit "clear"
    expect(mergeStoredSecrets(rds('a', { password: 'typed' })).redis!.password).toBe('typed')
    expect(mergeStoredSecrets(rds('a', { password: '', clearPassword: true })).redis!.password).toBe('')
    // a new (unsaved) source has nothing to fill in
    expect(mergeStoredSecrets(rds('', { password: '' })).redis!.password).toBe('')
  })

  it('an unreadable keychain entry marks the source and drops the password', () => {
    upsertSource(rds('a'))
    fake.decryptThrows = true
    const d = loadSources()[0]
    expect(d.passwordUnavailable).toBe(true)
    expect(d.redis!.password).toBeUndefined()
  })
})

describe('compatibility and other kinds', () => {
  it('a legacy Postgres / DynamoDB-free file still loads unchanged', () => {
    writeFileSync(dsFile(), JSON.stringify([{ id: 'p', name: 'p', host: 'h', port: 5432, user: 'u', password: 'raw:pw', database: 'd', ssl: false }]))
    const [p] = loadSources()
    expect(p).toMatchObject({ id: 'p', host: 'h', password: 'pw' })
    expect(p.redis).toBeUndefined()
  })

  it('Redis and Postgres sources live side by side', () => {
    upsertSource(pg('p'))
    upsertSource(rds('r'))
    expect(loadSources().map((d) => d.id)).toEqual(['p', 'r'])
    expect(loadSources()[0].password).toBe('pw')
  })

  it('duplicating keeps the password (re-encrypted) and the settings', () => {
    upsertSource(rds('a', { db: 5, tls: true, username: 'u1' }))
    duplicateSource('a', 'b')
    const list = loadSources()
    expect(list).toHaveLength(2)
    expect(list[1].redis).toMatchObject({ db: 5, tls: true, username: 'u1', password: PW })
    expect(list[1].id).toBe('b')
  })
})

describe('key delimiter setting', () => {
  it('is persisted as typed, including a blank one (no grouping)', () => {
    upsertSource(rds('a', { keyDelimiter: '/' }))
    upsertSource(rds('b', { keyDelimiter: '' }))
    upsertSource(rds('c', { keyDelimiter: '::' }))
    const list = loadSources()
    expect(list.map((d) => d.redis!.keyDelimiter)).toEqual(['/', '', '::'])
    expect(rawList().map((d) => d.redis!.keyDelimiter)).toEqual(['/', '', '::'])
  })

  it('a source saved without it stays without it (legacy: the app then uses ":")', () => {
    upsertSource(rds('a'))
    expect(loadSources()[0].redis).not.toHaveProperty('keyDelimiter')
    expect(rawList()[0].redis).not.toHaveProperty('keyDelimiter')
  })

  it('the renderer list carries it (it is not a secret) next to hasPassword', () => {
    upsertSource(rds('a', { keyDelimiter: '|' }))
    const r = loadSourcesForRenderer()[0].redis!
    expect(r.keyDelimiter).toBe('|')
    expect(r.hasPassword).toBe(true)
    expect(r.password).toBeUndefined()
  })

  it('editing the delimiter keeps the saved password byte for byte', () => {
    upsertSource(rds('a', { keyDelimiter: ':' }))
    const before = rawList()[0].redis!.password
    upsertSource(rds('a', { keyDelimiter: '/', password: '' }))
    expect(rawList()[0].redis!.password).toBe(before)
    expect(rawList()[0].redis!.keyDelimiter).toBe('/')
  })

  it('an invalid delimiter is refused before anything is written', () => {
    expect(() => upsertSource(rds('a', { keyDelimiter: '123456789' }))).toThrow(/at most 8/)
    expect(() => upsertSource(rds('a', { keyDelimiter: 'a\nb' }))).toThrow(/line breaks/)
    expect(loadSources()).toEqual([])
  })

  it('a non-text value in the payload is refused (never written)', () => {
    expect(() => upsertSource(rds('a', { keyDelimiter: 5 as never }))).toThrow(/must be text/)
    expect(loadSources()).toEqual([])
  })

  it('duplicating keeps it', () => {
    upsertSource(rds('a', { keyDelimiter: '/' }))
    duplicateSource('a', 'b')
    expect(loadSources()[1].redis!.keyDelimiter).toBe('/')
  })
})
