import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DataSource, Folder } from '../../src/shared'

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
  KEYCHAIN_HELP, breakFolderCycles, createFolder, deleteFolder, deleteSource, duplicateSource,
  hasStoredPasswords, loadFolders, loadSource, loadSources, moveFolder, mutateSource, patchSource, renameFolder,
  saveFolders, updateSourceFolders, upsertSource
} from '../../src/main/store'

const dsFile = (): string => join(fake.dir, 'datasources.json')
const rawList = (): DataSource[] => JSON.parse(readFileSync(dsFile(), 'utf8'))
const mk = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, host: 'localhost', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false, ...over
})
const F = (id: string, parentId: string | null = null): Folder => ({ id, name: id, parentId })

beforeEach(() => {
  fake.dir = mkdtempSync(join(tmpdir(), 'dgl-store-x-'))
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
  fake.showMessageBox.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => rmSync(fake.dir, { recursive: true, force: true }))

describe('encryption round trips', () => {
  it.each(['simple', 'with space', 'ünïcödé ☃', '"quotes" \'and\' \\ back', 'a'.repeat(5000), '0', ' ', 'enc:looks-like-prefix', 'raw:also'])(
    'password %#  round-trips',
    (pw) => {
      upsertSource(mk('a', { password: pw }))
      expect(loadSource('a')!.password).toBe(pw)
      fake.available = false
      upsertSource(mk('b', { password: pw }))
      expect(loadSource('b')!.password).toBe(pw)
    }
  )

  it('mixed enc:/raw: blobs on disk both load (OS encryption turned on/off between runs)', () => {
    upsertSource(mk('a', { password: 'one' }))
    fake.available = false
    upsertSource(mk('b', { password: 'two' }))
    fake.available = true
    expect(loadSources().map((d) => d.password)).toEqual(['one', 'two'])
  })

  it('encryption failure message contains the cause and keychain help; nothing is written', () => {
    fake.encryptThrows = true
    expect(() => upsertSource(mk('a', { password: 'pw' }))).toThrow(KEYCHAIN_HELP)
    expect(() => upsertSource(mk('a', { password: 'pw' }))).toThrow(/no keychain/)
    expect(existsSync(dsFile())).toBe(false)
  })

  it('decrypt of a garbage enc: blob is reported as unavailable, not thrown', () => {
    fake.decryptThrows = true
    writeFileSync(dsFile(), JSON.stringify([mk('a', { password: 'enc:@@@@' })]))
    expect(loadSources()[0]).toMatchObject({ password: '', passwordUnavailable: true })
  })

  it('a one-source decrypt failure does not hide the other sources', () => {
    upsertSource(mk('ok', { password: 'fine' }))
    writeFileSync(dsFile(), JSON.stringify([...rawList(), mk('bad', { password: 'enc:Zm9v' })]))
    fake.decryptString.mockImplementation((b: Buffer) => {
      if (b.toString() === 'foo') throw new Error('denied')
      return b.toString().replace(/^ENC</, '').replace(/>$/, '')
    })
    const l = loadSources()
    expect(l.map((d) => [d.id, d.passwordUnavailable])).toEqual([['ok', false], ['bad', true]])
    expect(l[0].password).toBe('fine')
  })
})

describe('corrupted / missing files', () => {
  it('datasources.json corrupt: loading throws (and upsert refuses to overwrite the file)', () => {
    writeFileSync(dsFile(), '{not json')
    expect(() => loadSources()).toThrow()
    expect(() => upsertSource(mk('a'))).toThrow()
    expect(readFileSync(dsFile(), 'utf8')).toBe('{not json')
  })

  it('missing datasources.json: every raw edit is a harmless no-op and creates nothing', () => {
    patchSource('a', { name: 'x' })
    mutateSource('a', () => ({ name: 'x' }))
    duplicateSource('a', 'b')
    updateSourceFolders(() => null)
    deleteFolder('nope')
    expect(existsSync(dsFile())).toBe(false)
  })

  it('deleteSource on a missing file writes an empty list', () => {
    deleteSource('a')
    expect(rawList()).toEqual([])
  })

  it('folders.json that is valid JSON but not an array -> []', () => {
    writeFileSync(join(fake.dir, 'folders.json'), '{"a":1}')
    expect(loadFolders()).toEqual([])
    writeFileSync(join(fake.dir, 'folders.json'), 'null')
    expect(loadFolders()).toEqual([])
  })

  it('hasStoredPasswords: false when no file; false for raw:-only; true with an enc: blob', () => {
    expect(hasStoredPasswords()).toBe(false)
    fake.available = false
    upsertSource(mk('a', { password: 'x' }))
    expect(hasStoredPasswords()).toBe(false)
    fake.available = true
    upsertSource(mk('b', { password: 'x' }))
    expect(hasStoredPasswords()).toBe(true)
  })
})

describe('upsert sequences (sync file IO is effectively serialized)', () => {
  it('many upserts in a row keep every source exactly once', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => upsertSource(mk('s' + (i % 10), { name: 'n' + i, password: 'p' + i })))))
    const l = rawList()
    expect(l).toHaveLength(10)
    expect(new Set(l.map((d) => d.id)).size).toBe(10)
    expect(loadSource('s0')!.name).toBe('n40')
    expect(loadSource('s0')!.password).toBe('p40')
  })
})

describe('raw patches do not touch the keychain', () => {
  beforeEach(() => {
    upsertSource(mk('a', { password: 'secret', visibleDbs: ['x'] }))
    upsertSource(mk('b', { password: 'other' }))
    fake.encryptString.mockClear()
    fake.decryptString.mockClear()
  })
  const untouched = (): void => {
    expect(fake.encryptString).not.toHaveBeenCalled()
    expect(fake.decryptString).not.toHaveBeenCalled()
  }

  it('visibleDbs / schemaFilter / tableFilter / dbSort patches', () => {
    const blob = rawList()[0].password
    patchSource('a', { visibleDbs: ['p', 'q'] })
    patchSource('a', { dbSort: 'size-desc' })
    mutateSource('a', (d) => ({ schemaFilter: { ...(d.schemaFilter ?? {}), db1: ['public'] } }))
    mutateSource('a', (d) => ({ tableFilter: { ...(d.tableFilter ?? {}), 'db1/public': { rule: { mode: 'starts', pattern: 'x' } } } }))
    mutateSource('a', (d) => ({ tableFilter: { ...(d.tableFilter ?? {}), 'db1/other': { list: ['t'] } } }))
    const a = rawList()[0]
    expect(a.password).toBe(blob)
    expect(a.visibleDbs).toEqual(['p', 'q'])
    expect(a.dbSort).toBe('size-desc')
    expect(a.schemaFilter).toEqual({ db1: ['public'] })
    expect(Object.keys(a.tableFilter!)).toEqual(['db1/public', 'db1/other'])
    expect(rawList()[1].visibleDbs).toBeUndefined()
    untouched()
  })

  it('patching visibleDbs to null means "all"', () => {
    patchSource('a', { visibleDbs: null })
    expect(rawList()[0].visibleDbs).toBeNull()
    untouched()
  })

  it('rename (patchSource name) / move (folderId) leave passwords alone', () => {
    patchSource('a', { name: 'renamed' })
    updateSourceFolders((d) => (d.id === 'a' ? 'f1' : undefined))
    expect(rawList()[0]).toMatchObject({ name: 'renamed', folderId: 'f1' })
    updateSourceFolders((d) => (d.id === 'a' ? null : undefined))
    expect(rawList()[0].folderId).toBeNull()
    untouched()
  })

  it('duplicate twice gives distinct ids and a copy suffix on top of the previous copy', () => {
    duplicateSource('a', 'a2')
    duplicateSource('a2', 'a3')
    expect(rawList().map((d) => [d.id, d.name])).toEqual([['a', 'a'], ['b', 'b'], ['a2', 'a copy'], ['a3', 'a copy copy']])
    expect(rawList()[2].password).toBe(rawList()[0].password)
    untouched()
  })

  it('sorting (dbSort) patch for a source in a folder keeps the folder', () => {
    updateSourceFolders((d) => (d.id === 'a' ? 'f' : undefined))
    patchSource('a', { dbSort: 'name-desc' })
    expect(rawList()[0]).toMatchObject({ folderId: 'f', dbSort: 'name-desc' })
  })
})

describe('folders – cycles, moves, deletes', () => {
  it('breakFolderCycles: acyclic input is returned as the same array instance', () => {
    const l = [F('a'), F('b', 'a'), F('c', 'b')]
    expect(breakFolderCycles(l)).toBe(l)
    expect(breakFolderCycles([])).toEqual([])
  })

  it('breakFolderCycles: only folders on the cycle are reset; descendants hanging off keep their parent', () => {
    const l = [F('a', 'b'), F('b', 'c'), F('c', 'a'), F('leaf', 'a'), F('ok', 'missing')]
    const out = breakFolderCycles(l)
    expect(out.find((f) => f.id === 'a')!.parentId).toBeNull()
    expect(out.find((f) => f.id === 'b')!.parentId).toBeNull()
    expect(out.find((f) => f.id === 'c')!.parentId).toBeNull()
    expect(out.find((f) => f.id === 'leaf')!.parentId).toBe('a')
    expect(out.find((f) => f.id === 'ok')!.parentId).toBe('missing')
    expect(out).toHaveLength(5)
  })

  it('breakFolderCycles: two disjoint cycles and a self loop', () => {
    const out = breakFolderCycles([F('a', 'b'), F('b', 'a'), F('c', 'd'), F('d', 'c'), F('e', 'e')])
    expect(out.every((f) => f.parentId === null)).toBe(true)
  })

  it('moveFolder to root, to a sibling, and refusing self / descendant', () => {
    saveFolders([F('a'), F('b', 'a'), F('c', 'b'), F('d')])
    moveFolder('c', null)
    expect(loadFolders().find((f) => f.id === 'c')!.parentId).toBeNull()
    expect(() => moveFolder('a', 'a')).toThrow(/into itself/)
    expect(() => moveFolder('a', 'b')).toThrow(/into itself/)
    moveFolder('d', 'b')
    expect(loadFolders().find((f) => f.id === 'd')!.parentId).toBe('b')
    expect(() => moveFolder('a', 'd')).toThrow(/into itself/)
  })

  it('moveFolder into a nonexistent parent just attaches (dangling parent is the renderer\'s problem)', () => {
    saveFolders([F('a')])
    moveFolder('a', 'ghost')
    expect(loadFolders()[0].parentId).toBe('ghost')
  })

  it('deleteFolder: sub-folders AND sources move up one level; nested chain collapses correctly', () => {
    saveFolders([F('top'), F('mid', 'top'), F('low', 'mid')])
    upsertSource(mk('s1', { folderId: 'mid' }))
    upsertSource(mk('s2', { folderId: 'low' }))
    upsertSource(mk('s3'))
    deleteFolder('mid')
    expect(loadFolders().map((f) => [f.id, f.parentId])).toEqual([['top', null], ['low', 'top']])
    expect(rawList().map((d) => [d.id, d.folderId])).toEqual([['s1', 'top'], ['s2', 'low'], ['s3', undefined]])
  })

  it('deleteFolder on a root folder moves sources to root (null)', () => {
    saveFolders([F('top')])
    upsertSource(mk('s1', { folderId: 'top' }))
    deleteFolder('top')
    expect(loadFolders()).toEqual([])
    expect(rawList()[0].folderId).toBeNull()
  })

  it('createFolder defaults: blank name, explicit id, nested parent', () => {
    expect(createFolder('   ', null, 'x')).toEqual({ id: 'x', name: 'New Folder', parentId: null })
    expect(createFolder(' n ', 'x', 'y')).toEqual({ id: 'y', name: 'n', parentId: 'x' })
    expect(loadFolders().map((f) => f.id)).toEqual(['x', 'y'])
  })

  it('renameFolder with blank / whitespace-only name leaves it', () => {
    saveFolders([F('a')])
    renameFolder('a', '  ')
    renameFolder('a', '')
    expect(loadFolders()[0].name).toBe('a')
  })

  it('duplicate-named folders are allowed (ids matter)', () => {
    createFolder('Same', null, '1')
    createFolder('Same', null, '2')
    expect(loadFolders()).toHaveLength(2)
  })
})

describe('explainKeychain / settings.json', () => {
  const orig = process.platform
  const setPlatform = (p: string): void => void Object.defineProperty(process, 'platform', { value: p })
  afterEach(() => setPlatform(orig))
  // the module caches "already explained this session": re-import a fresh copy for every test
  const fresh = async (): Promise<typeof import('../../src/main/store')> => {
    vi.resetModules()
    return import('../../src/main/store')
  }

  it('does nothing outside macOS', async () => {
    setPlatform('linux')
    const s = await fresh()
    await s.explainKeychain()
    expect(fake.showMessageBox).not.toHaveBeenCalled()
  })

  it('shows once per session; "don\'t show again" writes settings.json and suppresses future sessions', async () => {
    setPlatform('darwin')
    fake.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true })
    const s = await fresh()
    await s.explainKeychain()
    await s.explainKeychain()
    expect(fake.showMessageBox).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(join(fake.dir, 'settings.json'), 'utf8'))).toEqual({ hideKeychainExplainer: true })
    const s2 = await fresh()
    await s2.explainKeychain()
    expect(fake.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('unchecked box: no settings file written, shown again next session', async () => {
    setPlatform('darwin')
    fake.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await (await fresh()).explainKeychain()
    expect(existsSync(join(fake.dir, 'settings.json'))).toBe(false)
    await (await fresh()).explainKeychain()
    expect(fake.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('corrupt settings.json is treated as "no settings yet"', async () => {
    setPlatform('darwin')
    writeFileSync(join(fake.dir, 'settings.json'), '{{{')
    fake.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await (await fresh()).explainKeychain()
    expect(fake.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('settings.json with hideKeychainExplainer=false still shows the dialog', async () => {
    setPlatform('darwin')
    writeFileSync(join(fake.dir, 'settings.json'), JSON.stringify({ hideKeychainExplainer: false }))
    fake.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await (await fresh()).explainKeychain()
    expect(fake.showMessageBox).toHaveBeenCalledTimes(1)
  })
})
