import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DataSource } from '../../src/shared'

const fake = vi.hoisted(() => ({
  dir: '',
  available: true,
  decryptThrows: false,
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  isEncryptionAvailable: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  dialog: { showMessageBox: vi.fn() },
  safeStorage: fake
}))

import {
  createFolder, deleteFolder, deleteSource, duplicateSource, hasStoredPasswords, loadFolders, loadSource, loadSources,
  moveFolder, mutateSource, patchSource, renameFolder, saveFolders, updateSourceFolders, upsertSource
} from '../../src/main/store'

const dsFile = (): string => join(fake.dir, 'datasources.json')
const rawList = (): DataSource[] => JSON.parse(readFileSync(dsFile(), 'utf8'))
const mk = (id: string, over: Partial<DataSource> = {}): DataSource => ({
  id, name: id, host: 'localhost', port: 5432, user: 'u', password: '', database: 'postgres', ssl: false, ...over
})

beforeEach(() => {
  fake.dir = mkdtempSync(join(tmpdir(), 'dgl-store-'))
  fake.available = true
  fake.decryptThrows = false
  fake.isEncryptionAvailable.mockImplementation(() => fake.available)
  fake.encryptString.mockImplementation((s: string) => Buffer.from('ENC<' + s + '>'))
  fake.decryptString.mockImplementation((b: Buffer) => {
    if (fake.decryptThrows) throw new Error('keychain denied')
    return b.toString().replace(/^ENC</, '').replace(/>$/, '')
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => rmSync(fake.dir, { recursive: true, force: true }))

describe('data sources: persistence & password encryption', () => {
  it('loadSources is empty when nothing is saved', () => {
    expect(loadSources()).toEqual([])
    expect(loadSource('x')).toBeUndefined()
  })

  it('round-trips a password through encryption and stores only ciphertext on disk', () => {
    upsertSource(mk('a', { password: 's3cret' }))
    const onDisk = rawList()[0].password
    expect(onDisk.startsWith('enc:')).toBe(true)
    expect(readFileSync(dsFile(), 'utf8')).not.toContain('s3cret')
    expect(Buffer.from(onDisk.slice(4), 'base64').toString()).toBe('ENC<s3cret>')
    expect(loadSource('a')).toMatchObject({ password: 's3cret', passwordUnavailable: false })
  })

  it('falls back to a raw: prefix when OS encryption is unavailable, and still round-trips', () => {
    fake.available = false
    upsertSource(mk('a', { password: 'pw' }))
    expect(rawList()[0].password).toBe('raw:pw')
    expect(fake.encryptString).not.toHaveBeenCalled()
    expect(loadSource('a')!.password).toBe('pw')
    expect(fake.decryptString).not.toHaveBeenCalled()
  })

  it('an empty password stays empty and never touches safeStorage', () => {
    upsertSource(mk('a'))
    expect(rawList()[0].password).toBe('')
    expect(loadSource('a')).toMatchObject({ password: '', passwordUnavailable: false })
    expect(fake.encryptString).not.toHaveBeenCalled()
    expect(fake.decryptString).not.toHaveBeenCalled()
  })

  it('upsert inserts new and replaces existing ones in place without touching the others', () => {
    upsertSource(mk('a', { password: 'pa' }))
    upsertSource(mk('b', { password: 'pb' }))
    const blobB = rawList()[1].password
    fake.encryptString.mockClear()
    upsertSource(mk('a', { name: 'renamed', password: 'pa2' }))
    const list = rawList()
    expect(list.map((d) => d.id)).toEqual(['a', 'b'])
    expect(list[0].name).toBe('renamed')
    expect(list[1].password).toBe(blobB)
    expect(fake.encryptString).toHaveBeenCalledTimes(1)
    expect(loadSources().map((d) => d.password)).toEqual(['pa2', 'pb'])
  })

  it('passwordUnavailable is runtime-only and never written to disk', () => {
    upsertSource({ ...mk('a', { password: 'x' }), passwordUnavailable: true })
    expect(rawList()[0]).not.toHaveProperty('passwordUnavailable')
  })

  it('deleteSource removes only that source', () => {
    upsertSource(mk('a'))
    upsertSource(mk('b'))
    deleteSource('a')
    expect(loadSources().map((d) => d.id)).toEqual(['b'])
  })

  it('loadSource decrypts only the requested source', () => {
    upsertSource(mk('a', { password: 'pa' }))
    upsertSource(mk('b', { password: 'pb' }))
    fake.decryptString.mockClear()
    expect(loadSource('b')!.password).toBe('pb')
    expect(fake.decryptString).toHaveBeenCalledTimes(1)
  })

  it('wraps an encryption failure with the keychain help text', () => {
    fake.encryptString.mockImplementation(() => {
      throw new Error('nope')
    })
    expect(() => upsertSource(mk('a', { password: 'x' }))).toThrow(/Could not save the password.*Keychain.*nope/s)
    expect(existsSync(dsFile())).toBe(false)
  })

  it('hasStoredPasswords only reports encrypted blobs', () => {
    expect(hasStoredPasswords()).toBe(false)
    upsertSource(mk('a'))
    expect(hasStoredPasswords()).toBe(false)
    upsertSource(mk('b', { password: 'x' }))
    expect(hasStoredPasswords()).toBe(true)
  })
})

describe('data sources: decrypt failure (keychain denied)', () => {
  beforeEach(() => {
    upsertSource(mk('a', { password: 'pa', name: 'A' }))
    upsertSource(mk('b', { name: 'B' }))
    fake.decryptThrows = true
  })

  it('flags passwordUnavailable and blanks the password, but still lists the source', () => {
    const [a, b] = loadSources()
    expect(a).toMatchObject({ id: 'a', password: '', passwordUnavailable: true })
    expect(b).toMatchObject({ id: 'b', password: '', passwordUnavailable: false })
  })

  it('re-saving with an empty password + passwordUnavailable preserves the unreadable blob', () => {
    const before = rawList()[0].password
    const a = loadSource('a')!
    upsertSource({ ...a, name: 'A renamed' })
    expect(rawList()[0]).toMatchObject({ name: 'A renamed', password: before })
    fake.decryptThrows = false
    expect(loadSource('a')!.password).toBe('pa')
  })

  it('typing a new password replaces the blob', () => {
    const a = loadSource('a')!
    fake.decryptThrows = false
    upsertSource({ ...a, password: 'new' })
    expect(loadSource('a')).toMatchObject({ password: 'new', passwordUnavailable: false })
  })

  it('an empty password WITHOUT the unavailable flag clears the saved password (intentional)', () => {
    upsertSource(mk('a', { password: '' }))
    expect(rawList()[0].password).toBe('')
  })

  it('a brand new source flagged unavailable gets an empty password (nothing to preserve)', () => {
    upsertSource({ ...mk('zz'), passwordUnavailable: true })
    expect(rawList().find((d) => d.id === 'zz')!.password).toBe('')
  })
})

describe('raw edits never touch the keychain', () => {
  beforeEach(() => {
    upsertSource(mk('a', { password: 'pa', name: 'A' }))
    upsertSource(mk('b', { password: 'pb', name: 'B' }))
    fake.encryptString.mockClear()
    fake.decryptString.mockClear()
    fake.isEncryptionAvailable.mockClear()
  })
  const untouched = (): void => {
    expect(fake.decryptString).not.toHaveBeenCalled()
    expect(fake.encryptString).not.toHaveBeenCalled()
  }

  it('patchSource changes only the target, keeps blobs byte-identical', () => {
    const before = rawList()
    patchSource('a', { name: 'New', dbSort: 'size-desc', visibleDbs: ['x'] })
    const after = rawList()
    expect(after[0]).toMatchObject({ name: 'New', dbSort: 'size-desc', visibleDbs: ['x'], password: before[0].password })
    expect(after[1]).toEqual(before[1])
    untouched()
  })

  it('mutateSource applies a computed patch (schemaFilter / tableFilter)', () => {
    mutateSource('a', (d) => ({ schemaFilter: { ...(d.schemaFilter ?? {}), db1: ['public'] } }))
    mutateSource('a', (d) => ({ schemaFilter: { ...d.schemaFilter, db2: ['x'] } }))
    mutateSource('a', () => ({ tableFilter: { 'db1/public': { rule: { mode: 'starts', pattern: 't_' } } } }))
    expect(rawList()[0].schemaFilter).toEqual({ db1: ['public'], db2: ['x'] })
    expect(rawList()[0].tableFilter).toEqual({ 'db1/public': { rule: { mode: 'starts', pattern: 't_' } } })
    untouched()
  })

  it('patch/mutate of an unknown id or a missing file is a no-op', () => {
    const before = readFileSync(dsFile(), 'utf8')
    patchSource('nope', { name: 'x' })
    mutateSource('nope', () => ({ name: 'x' }))
    expect(readFileSync(dsFile(), 'utf8')).toBe(before)
    rmSync(dsFile())
    patchSource('a', { name: 'x' })
    mutateSource('a', () => ({ name: 'x' }))
    duplicateSource('a', 'z')
    updateSourceFolders(() => 'f')
    expect(existsSync(dsFile())).toBe(false)
    untouched()
  })

  it('duplicateSource copies the encrypted blob as-is, with a new id and "copy" suffix', () => {
    const before = rawList()[0]
    duplicateSource('a', 'a2')
    const list = rawList()
    expect(list).toHaveLength(3)
    expect(list[2]).toEqual({ ...before, id: 'a2', name: 'A copy' })
    untouched()
    expect(loadSource('a2')!.password).toBe('pa') // and it is decryptable
  })

  it('duplicateSource of an unknown id does nothing', () => {
    duplicateSource('zzz', 'new')
    expect(rawList()).toHaveLength(2)
  })

  it('updateSourceFolders: undefined = leave alone, null/string = set', () => {
    updateSourceFolders((d) => (d.id === 'a' ? 'f1' : undefined))
    expect(rawList().map((d) => d.folderId)).toEqual(['f1', undefined])
    updateSourceFolders((d) => (d.id === 'a' ? null : undefined))
    expect(rawList().map((d) => d.folderId)).toEqual([null, undefined])
    untouched()
  })
})

describe('folders', () => {
  it('loadFolders: empty when missing, empty when corrupt', () => {
    expect(loadFolders()).toEqual([])
    writeFileSync(join(fake.dir, 'folders.json'), '{not json')
    expect(loadFolders()).toEqual([])
  })

  it('createFolder trims the name, defaults empty names, and persists', () => {
    const a = createFolder('  Prod  ', null, 'f1')
    const b = createFolder('   ', 'f1', 'f2')
    expect(a).toEqual({ id: 'f1', name: 'Prod', parentId: null })
    expect(b).toEqual({ id: 'f2', name: 'New Folder', parentId: 'f1' })
    expect(loadFolders()).toEqual([a, b])
  })

  it('createFolder generates unique ids by default', () => {
    expect(createFolder('a', null).id).not.toBe(createFolder('b', null).id)
  })

  it('renameFolder trims; blank names are ignored; unknown ids are a no-op', () => {
    createFolder('x', null, 'f1')
    renameFolder('f1', '  y ')
    expect(loadFolders()[0].name).toBe('y')
    renameFolder('f1', '   ')
    expect(loadFolders()[0].name).toBe('y')
    renameFolder('nope', 'z')
    expect(loadFolders()).toHaveLength(1)
  })

  describe('moveFolder', () => {
    beforeEach(() => {
      saveFolders([
        { id: 'a', name: 'a', parentId: null },
        { id: 'b', name: 'b', parentId: 'a' },
        { id: 'c', name: 'c', parentId: 'b' },
        { id: 'd', name: 'd', parentId: null }
      ])
    })
    const parents = (): Record<string, string | null> => Object.fromEntries(loadFolders().map((f) => [f.id, f.parentId]))

    it('re-parents, and to root with null', () => {
      moveFolder('c', 'd')
      expect(parents().c).toBe('d')
      moveFolder('c', null)
      expect(parents().c).toBeNull()
    })

    it('moving a folder keeps its subtree attached', () => {
      moveFolder('a', 'd')
      expect(parents()).toEqual({ a: 'd', b: 'a', c: 'b', d: null })
    })

    it.each([
      ['itself', 'a', 'a'],
      ['a direct child', 'a', 'b'],
      ['a deep descendant', 'a', 'c']
    ])('refuses to move a folder into %s', (_n, id, target) => {
      const before = parents()
      expect(() => moveFolder(id, target)).toThrow('Cannot move a folder into itself')
      expect(parents()).toEqual(before)
    })

    describe('pre-existing parent cycle (corrupt folders.json)', () => {
      const writeCyclic = (): void =>
        writeFileSync(
          join(fake.dir, 'folders.json'),
          JSON.stringify([
            { id: 'a', name: 'a', parentId: 'b' },
            { id: 'b', name: 'b', parentId: 'a' },
            { id: 'c', name: 'c', parentId: null },
            { id: 'd', name: 'd', parentId: 'a' } // hangs off the cycle, not part of it
          ])
        )

      it('moving a folder under a cycle that does not include it does not hang', { timeout: 2000 }, () => {
        writeCyclic()
        expect(() => moveFolder('c', 'a')).not.toThrow()
        const ps = parents()
        expect(Object.keys(ps).sort()).toEqual(['a', 'b', 'c', 'd'])
        expect(ps.c).toBe('a')
        // every folder now reaches the root (no cycle left)
        for (const id of Object.keys(ps)) {
          const seen = new Set<string>()
          for (let cur: string | null = id; cur; cur = ps[cur] ?? null) {
            expect(seen.has(cur)).toBe(false)
            seen.add(cur)
          }
        }
      })

      it('loadFolders breaks the cycle without losing folders', { timeout: 2000 }, () => {
        writeCyclic()
        const list = loadFolders()
        expect(list.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd'])
        expect(list.find((f) => f.id === 'a')!.parentId).toBeNull()
        expect(list.find((f) => f.id === 'b')!.parentId).toBeNull()
        expect(list.find((f) => f.id === 'd')!.parentId).toBe('a') // non-cycle parent links preserved
      })

      it('a self-parent is reset to root', { timeout: 2000 }, () => {
        writeFileSync(join(fake.dir, 'folders.json'), JSON.stringify([{ id: 'a', name: 'a', parentId: 'a' }]))
        expect(loadFolders()).toEqual([{ id: 'a', name: 'a', parentId: null }])
      })

      it('deleteFolder / renameFolder do not hang either', { timeout: 2000 }, () => {
        writeCyclic()
        renameFolder('a', 'z')
        deleteFolder('b')
        expect(loadFolders().map((f) => f.id)).toEqual(['a', 'c', 'd'])
      })

      it('moving a folder into its own descendant is still rejected alongside a cycle elsewhere', { timeout: 2000 }, () => {
        saveFolders([
          { id: 'x', name: 'x', parentId: null },
          { id: 'y', name: 'y', parentId: 'x' },
          { id: 'a', name: 'a', parentId: 'b' },
          { id: 'b', name: 'b', parentId: 'a' }
        ])
        expect(() => moveFolder('x', 'y')).toThrow('Cannot move a folder into itself')
      })
    })
  })

  describe('deleteFolder', () => {
    beforeEach(() => {
      saveFolders([
        { id: 'a', name: 'a', parentId: null },
        { id: 'b', name: 'b', parentId: 'a' },
        { id: 'c', name: 'c', parentId: 'b' }
      ])
      upsertSource(mk('s1', { folderId: 'b' }))
      upsertSource(mk('s2', { folderId: 'a' }))
      upsertSource(mk('s3', { folderId: null, password: 'pw' }))
      fake.decryptString.mockClear()
      fake.encryptString.mockClear()
    })

    it('children and data sources move up to the deleted folder’s parent', () => {
      deleteFolder('b')
      expect(loadFolders()).toEqual([
        { id: 'a', name: 'a', parentId: null },
        { id: 'c', name: 'c', parentId: 'a' }
      ])
      expect(rawList().map((d) => [d.id, d.folderId ?? null])).toEqual([['s1', 'a'], ['s2', 'a'], ['s3', null]])
    })

    it('deleting a top-level folder moves contents to the root (null)', () => {
      deleteFolder('a')
      expect(loadFolders().map((f) => [f.id, f.parentId])).toEqual([['b', null], ['c', 'b']])
      expect(rawList().find((d) => d.id === 's2')!.folderId).toBeNull()
    })

    it('does not decrypt or re-encrypt passwords', () => {
      deleteFolder('b')
      expect(fake.decryptString).not.toHaveBeenCalled()
      expect(fake.encryptString).not.toHaveBeenCalled()
      expect(loadSource('s3')!.password).toBe('pw')
    })

    it('unknown id leaves everything alone', () => {
      const before = loadFolders()
      deleteFolder('nope')
      expect(loadFolders()).toEqual(before)
    })
  })
})
