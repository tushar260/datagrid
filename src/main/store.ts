import { app, dialog, safeStorage } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs'
import { breakFolderCycles, dsKind, validateDynamoConfig, validateRedisConfig, parseEndpoint, REDIS_DEFAULT_PORT } from '../shared'
import type { DataSource, DeviceSecrets, DynamoConfig, Folder, RedisConfig, StateItem } from '../shared'

const file = (): string => join(app.getPath('userData'), 'datasources.json')

export const KEYCHAIN_HELP =
  'macOS Keychain access was denied. Restart DataGrid and click "Always Allow" when macOS asks, ' +
  'or re-enter the password (or AWS secret access key) in Edit Data Source.'

function enc(s: string): string {
  try {
    return safeStorage.isEncryptionAvailable()
      ? 'enc:' + safeStorage.encryptString(s).toString('base64')
      : 'raw:' + s
  } catch (e) {
    throw new Error(`Could not save the password. ${KEYCHAIN_HELP} (${(e as Error).message})`)
  }
}

/** Returns null when the saved password exists but cannot be decrypted. */
function dec(s: string): string | null {
  try {
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'))
    return s.slice(4)
  } catch (e) {
    console.error('Could not decrypt a saved password:', (e as Error).message)
    return null
  }
}

const readRaw = (): DataSource[] => (existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as DataSource[]) : [])
const writeRaw = (list: DataSource[]): void => writeFileSync(file(), JSON.stringify(list, null, 2))

const SECRET_FIELDS = ['secretAccessKey', 'sessionToken'] as const

function openDynamo(d: DataSource): DataSource {
  const cfg: DynamoConfig = { region: '', authMode: 'default', ...(d.dynamo ?? {}) }
  let unavailable = false
  for (const f of SECRET_FIELDS) {
    const blob = cfg[f]
    if (!blob) continue
    const plain = dec(blob)
    if (plain === null) {
      unavailable = true
      delete cfg[f]
    } else cfg[f] = plain
  }
  return { ...d, kind: 'dynamodb', dynamo: cfg, passwordUnavailable: unavailable }
}

function openRedis(d: DataSource): DataSource {
  const cfg: RedisConfig = { host: 'localhost', port: REDIS_DEFAULT_PORT, db: 0, tls: false, ...(d.redis ?? {}) }
  let unavailable = false
  if (cfg.password) {
    const plain = dec(cfg.password)
    if (plain === null) {
      unavailable = true
      delete cfg.password
    } else cfg.password = plain
  }
  return { ...d, kind: 'redis', redis: cfg, passwordUnavailable: unavailable }
}

function open(d: DataSource): DataSource {
  if (dsKind(d) === 'dynamodb') return openDynamo(d)
  if (dsKind(d) === 'redis') return openRedis(d)
  // sources saved before DynamoDB support have no `kind`: they are PostgreSQL (migrated on load, the file is not rewritten)
  if (!d.password) return { ...d, kind: 'postgres', passwordUnavailable: false }
  const p = dec(d.password)
  return p === null
    ? { ...d, kind: 'postgres', password: '', passwordUnavailable: true }
    : { ...d, kind: 'postgres', password: p, passwordUnavailable: false }
}

/** Main-process view: DynamoDB / Redis secrets are decrypted (never send this to the renderer). */
export function loadSources(): DataSource[] {
  return readRaw().map(open)
}

/** Renderer view: like loadSources, but DynamoDB / Redis secrets are replaced by `hasSecret` / `hasSessionToken` / `hasPassword` flags. */
export function loadSourcesForRenderer(): DataSource[] {
  return readRaw().map((raw) => {
    const d = open(raw)
    if (dsKind(d) === 'redis') {
      const { password: _p, clearPassword: _c, ...cfg } = d.redis!
      return { ...d, redis: { ...cfg, hasPassword: !!raw.redis?.password } }
    }
    if (dsKind(d) !== 'dynamodb') return d
    const { secretAccessKey: _s, sessionToken: _t, ...cfg } = d.dynamo!
    return { ...d, dynamo: { ...cfg, hasSecret: !!raw.dynamo?.secretAccessKey, hasSessionToken: !!raw.dynamo?.sessionToken } }
  })
}

/** A data source safe to send to the renderer (secrets removed, flags set from what is present). */
export function publicSource(d: DataSource): DataSource {
  if (dsKind(d) === 'redis' && d.redis) {
    const { password, clearPassword: _c, ...cfg } = d.redis
    return { ...d, redis: { ...cfg, hasPassword: !!password || !!d.redis.hasPassword } }
  }
  if (dsKind(d) !== 'dynamodb' || !d.dynamo) return d
  const { secretAccessKey, sessionToken, ...cfg } = d.dynamo
  return { ...d, dynamo: { ...cfg, hasSecret: !!secretAccessKey || !!d.dynamo.hasSecret, hasSessionToken: !!sessionToken || !!d.dynamo.hasSessionToken } }
}

/** Decrypts only the requested data source (avoids touching the keychain for the others). */
export function loadSource(id: string): DataSource | undefined {
  const d = readRaw().find((x) => x.id === id)
  return d ? open(d) : undefined
}

/** Ids of the saved data sources (no decryption: the keychain is not touched). */
export function sourceIds(): string[] {
  try {
    return readRaw().map((d) => d.id)
  } catch {
    return []
  }
}

/** The stored record as is (secrets still encrypted): enough to compare non-secret connection settings. */
export function loadSourceRaw(id: string): DataSource | undefined {
  try {
    return readRaw().find((d) => d.id === id)
  } catch {
    return undefined
  }
}

/** Insert/update one data source without disturbing the stored passwords of the others. */
export function upsertSource(ds: DataSource): void {
  const list = readRaw()
  const i = list.findIndex((x) => x.id === ds.id)
  if (dsKind(ds) === 'redis') {
    const next = buildRedisRecord(ds, i >= 0 ? list[i].redis : undefined)
    if (i >= 0) list[i] = next
    else list.push(next)
    writeRaw(list)
    return
  }
  if (dsKind(ds) === 'dynamodb') {
    const next = buildDynamoRecord(ds, i >= 0 ? list[i].dynamo : undefined)
    if (i >= 0) list[i] = next
    else list.push(next)
    writeRaw(list)
    return
  }
  const { passwordUnavailable, ...rest } = ds
  let password: string
  if (rest.password) password = enc(rest.password)
  else if (passwordUnavailable && i >= 0) password = list[i].password // keep the unreadable blob untouched
  else password = ''
  const next = { ...rest, password }
  if (i >= 0) list[i] = next
  else list.push(next)
  writeRaw(list)
}

/**
 * The on-disk record of a DynamoDB source. Secrets are encrypted like the Postgres password; a blank secret keeps the saved
 * blob (also an unreadable one), a non-keys auth mode drops them. The Postgres connection fields are stored empty.
 */
function buildDynamoRecord(ds: DataSource, old: DynamoConfig | undefined, lenient = false): DataSource {
  const { passwordUnavailable: _u, ...rest } = ds
  const c = rest.dynamo ?? { region: '', authMode: 'default' as const }
  const err = validateDynamoConfig(c, lenient || !!old?.secretAccessKey) // lenient: a restored backup may carry no secret
  if (err) throw new Error(err)
  const cfg: DynamoConfig = { region: (c.region ?? '').trim(), authMode: c.authMode }
  if (c.authMode === 'profile') cfg.profile = (c.profile ?? '').trim()
  const endpoint = parseEndpoint(c.endpoint ?? '')
  if (endpoint) cfg.endpoint = endpoint
  if (c.authMode === 'keys') {
    cfg.accessKeyId = (c.accessKeyId ?? '').trim()
    cfg.secretAccessKey = c.secretAccessKey ? enc(c.secretAccessKey) : old?.secretAccessKey
    const token = c.sessionToken === undefined ? old?.sessionToken : c.sessionToken ? enc(c.sessionToken) : undefined
    if (token) cfg.sessionToken = token
  }
  return { ...rest, kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false, dynamo: cfg }
}

/**
 * The on-disk record of a Redis source. The password is encrypted like the Postgres one; a blank password keeps the saved
 * blob (also an unreadable one) unless `clearPassword` asks to remove it. The Postgres connection fields are stored empty.
 */
function buildRedisRecord(ds: DataSource, old: RedisConfig | undefined): DataSource {
  const { passwordUnavailable: _u, ...rest } = ds
  const c = rest.redis ?? { host: 'localhost', port: REDIS_DEFAULT_PORT, db: 0, tls: false }
  const err = validateRedisConfig(c)
  if (err) throw new Error(err)
  const cfg: RedisConfig = { host: c.host.trim(), port: c.port, db: c.db, tls: !!c.tls }
  if (c.username?.trim()) cfg.username = c.username.trim()
  if (typeof c.keyDelimiter === 'string') cfg.keyDelimiter = c.keyDelimiter // blank is a real choice (no grouping); absent = default
  const password = c.password ? enc(c.password) : c.clearPassword ? undefined : old?.password
  if (password) cfg.password = password
  return { ...rest, kind: 'redis', host: '', port: 0, user: '', password: '', database: '', ssl: false, redis: cfg }
}

/**
 * For "Test Connection" of an existing DynamoDB / Redis source: blank secret fields in the form mean "the saved ones", so fill them
 * from the keychain. Only touches the keychain when something is actually missing.
 */
export function mergeStoredSecrets(ds: DataSource): DataSource {
  if (dsKind(ds) === 'redis') {
    if (!ds.redis || !ds.id || ds.redis.password || ds.redis.clearPassword) return ds
    const saved = loadSource(ds.id)?.redis
    return saved?.password ? { ...ds, redis: { ...ds.redis, password: saved.password } } : ds
  }
  if (dsKind(ds) !== 'dynamodb' || !ds.dynamo || ds.dynamo.authMode !== 'keys' || !ds.id) return ds
  const needSecret = !ds.dynamo.secretAccessKey
  const needToken = ds.dynamo.sessionToken === undefined
  if (!needSecret && !needToken) return ds
  const saved = loadSource(ds.id)?.dynamo
  if (!saved) return ds
  return {
    ...ds,
    dynamo: {
      ...ds.dynamo,
      secretAccessKey: ds.dynamo.secretAccessKey || saved.secretAccessKey,
      sessionToken: needToken ? saved.sessionToken : ds.dynamo.sessionToken
    }
  }
}

export function deleteSource(id: string): void {
  writeRaw(readRaw().filter((d) => d.id !== id))
}

// ---- folders (plain JSON, no secrets) ----
const foldersFile = (): string => join(app.getPath('userData'), 'folders.json')

export function loadFolders(): Folder[] {
  if (!existsSync(foldersFile())) return []
  try {
    const parsed = JSON.parse(readFileSync(foldersFile(), 'utf8')) as Folder[]
    return Array.isArray(parsed) ? breakFolderCycles(parsed) : []
  } catch {
    return []
  }
}

// (moved to shared.ts so the pure backup module can use it too)
export { breakFolderCycles }

export function saveFolders(list: Folder[]): void {
  writeFileSync(foldersFile(), JSON.stringify(list, null, 2))
}

export function createFolder(name: string, parentId: string | null, id: string = randomUUID()): Folder {
  const f: Folder = { id, name: name.trim() || 'New Folder', parentId }
  saveFolders([...loadFolders(), f])
  return f
}

export function renameFolder(id: string, name: string): void {
  const n = name.trim()
  if (!n) return
  saveFolders(loadFolders().map((f) => (f.id === id ? { ...f, name: n } : f)))
}

export function moveFolder(id: string, parentId: string | null): void {
  const list = loadFolders()
  // refuse to move a folder into itself or one of its descendants
  // (cycle-safe: a pre-existing cycle that doesn't include `id` must not hang the walk)
  const seen = new Set<string>()
  for (let cur = parentId; cur; cur = list.find((f) => f.id === cur)?.parentId ?? null) {
    if (cur === id) throw new Error('Cannot move a folder into itself')
    if (seen.has(cur)) throw new Error('Folder hierarchy contains a cycle')
    seen.add(cur)
  }
  saveFolders(list.map((f) => (f.id === id ? { ...f, parentId } : f)))
}

/** Contents (sub-folders and data sources) move up to the deleted folder's parent. */
export function deleteFolder(id: string): void {
  const list = loadFolders()
  const parent = list.find((f) => f.id === id)?.parentId ?? null
  saveFolders(list.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId: parent } : f)))
  updateSourceFolders((d) => (d.folderId === id ? parent : undefined))
}

/** Update folderId on data sources without decrypting/re-encrypting passwords (no keychain access). */
export function updateSourceFolders(fn: (d: DataSource) => string | null | undefined): void {
  if (!existsSync(file())) return
  const raw = JSON.parse(readFileSync(file(), 'utf8')) as DataSource[]
  const next = raw.map((d) => {
    const r = fn(d)
    return r === undefined ? d : { ...d, folderId: r }
  })
  writeFileSync(file(), JSON.stringify(next, null, 2))
}

/** Raw (no decrypt) edits on one data source, e.g. rename. */
export function patchSource(id: string, patch: Partial<DataSource>): void {
  if (!existsSync(file())) return
  const raw = JSON.parse(readFileSync(file(), 'utf8')) as DataSource[]
  writeFileSync(file(), JSON.stringify(raw.map((d) => (d.id === id ? { ...d, ...patch } : d)), null, 2))
}

/** Copy a data source (including its encrypted password blob as-is). */
export function duplicateSource(id: string, newId: string): void {
  if (!existsSync(file())) return
  const raw = JSON.parse(readFileSync(file(), 'utf8')) as DataSource[]
  const src = raw.find((d) => d.id === id)
  if (!src) return
  writeFileSync(file(), JSON.stringify([...raw, { ...src, id: newId, name: src.name + ' copy' }], null, 2))
}

// ---- keychain explainer ----
// macOS shows its own (non-customisable) "wants to use your confidential information" dialog the first
// time we touch safeStorage. We show a short explanation of why right before that happens.
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
let explainedThisSession = false

export function hasStoredPasswords(): boolean {
  return existsSync(file()) && readFileSync(file(), 'utf8').includes('"enc:')
}

export async function explainKeychain(): Promise<void> {
  if (explainedThisSession || process.platform !== 'darwin') return
  explainedThisSession = true
  let suppressed = false
  try {
    suppressed = JSON.parse(readFileSync(settingsFile(), 'utf8')).hideKeychainExplainer === true
  } catch {
    /* no settings yet */
  }
  if (suppressed) return
  const r = await dialog.showMessageBox({
    type: 'info',
    title: 'Keychain access',
    message: 'Why macOS is about to ask for your Keychain password',
    detail:
      'DataGrid saves your database passwords encrypted on this Mac. The encryption key is kept in your ' +
      'macOS Keychain, so macOS will now ask for your Mac login password.\n\n' +
      'Choose "Always Allow" so you are not asked again. Choosing "Deny" means saved passwords cannot be ' +
      'read and you will need to re-enter them.\n\nNothing is sent anywhere; this stays on your Mac.',
    buttons: ['Continue'],
    checkboxLabel: "Don't show this again",
    checkboxChecked: false
  })
  if (r.checkboxChecked) {
    writeFileSync(settingsFile(), JSON.stringify({ hideKeychainExplainer: true }, null, 2))
  }
}

/** Raw (no decrypt) computed patch for one data source. */
export function mutateSource(id: string, fn: (d: DataSource) => Partial<DataSource>): void {
  if (!existsSync(file())) return
  const raw = JSON.parse(readFileSync(file(), 'utf8')) as DataSource[]
  writeFileSync(file(), JSON.stringify(raw.map((d) => (d.id === id ? { ...d, ...fn(d) } : d)), null, 2))
}

// ---- backup / restore support (see backup.ts / backupService.ts) ----

/** True when secrets can be encrypted with this Mac's Keychain key (else `enc` would store them as readable `raw:` text). */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** The stored records as they are on disk (secrets still encrypted): never decrypts, never touches the Keychain. */
export function loadSourcesRaw(): DataSource[] {
  return readRaw()
}

/** The still-encrypted (`enc:`) secret blobs of a stored record, by the fields its kind uses. */
export function secretBlobs(raw: DataSource): DeviceSecrets {
  const out: DeviceSecrets = {}
  if (dsKind(raw) === 'dynamodb') {
    if (raw.dynamo?.secretAccessKey) out.secretAccessKey = raw.dynamo.secretAccessKey
    if (raw.dynamo?.sessionToken) out.sessionToken = raw.dynamo.sessionToken
  } else if (dsKind(raw) === 'redis') {
    if (raw.redis?.password) out.password = raw.redis.password
  } else if (raw.password) out.password = raw.password
  return out
}

/**
 * The on-disk record for a data source coming from a backup. `ds` may carry clear-text secrets (encrypted here with this Mac's
 * key); blank ones fall back to `inherited` (already-encrypted blobs of the previous record / of an automatic backup).
 */
function recordForImport(ds: DataSource, inherited: DeviceSecrets | undefined, withSecrets: boolean): DataSource {
  const { passwordUnavailable: _u, ...rest } = ds
  const kind = dsKind(rest)
  const inh = inherited ?? {}
  if (kind === 'redis') {
    const redis = rest.redis ? { ...rest.redis, ...(withSecrets ? {} : { password: undefined }) } : rest.redis
    return buildRedisRecord({ ...rest, redis }, { host: '', port: 0, db: 0, tls: false, password: inh.password })
  }
  if (kind === 'dynamodb') {
    const dynamo = rest.dynamo
      ? { ...rest.dynamo, ...(withSecrets ? {} : { secretAccessKey: undefined, sessionToken: undefined }) }
      : rest.dynamo
    const old: DynamoConfig = { region: '', authMode: 'keys', secretAccessKey: inh.secretAccessKey, sessionToken: inh.sessionToken }
    return buildDynamoRecord({ ...rest, dynamo }, old, true)
  }
  const password = withSecrets && rest.password ? enc(rest.password) : inh.password ?? ''
  return { ...rest, kind: 'postgres', password }
}

/** Writes a file next to its final name and renames it over it (a crash never leaves a half-written file). */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* nothing to clean up */
    }
    throw e
  }
}

/**
 * Replaces the data sources and folders in one go. Every record is built (and encrypted) first; only then are the two files
 * written (tmp + rename each). If the second write fails the first file is put back, so a failure changes nothing.
 * `{ keep }` items keep their stored record untouched (blobs and all); `{ add }` items are built from a backup source.
 */
export function commitState(items: StateItem[], folders: Folder[], opts: { withSecrets?: boolean } = {}): void {
  const withSecrets = opts.withSecrets !== false
  const before = readRaw()
  const byId = new Map(before.map((d) => [d.id, d]))
  const next: DataSource[] = []
  for (const it of items) {
    if ('keep' in it) {
      const raw = byId.get(it.keep)
      if (raw) next.push(raw)
      continue
    }
    const old = it.inheritFrom ? byId.get(it.inheritFrom) : undefined
    const sameKind = old && dsKind(old) === dsKind(it.add)
    const inherited = it.deviceSecrets ?? (sameKind ? secretBlobs(old) : undefined)
    next.push(recordForImport(it.add, inherited, withSecrets))
  }
  const sourcesText = JSON.stringify(next, null, 2)
  const foldersText = JSON.stringify(folders, null, 2)
  const dsPath = file()
  const hadFile = existsSync(dsPath)
  const previous = hadFile ? readFileSync(dsPath, 'utf8') : null
  writeAtomic(dsPath, sourcesText)
  try {
    writeAtomic(foldersFile(), foldersText)
  } catch (e) {
    try {
      if (previous !== null) writeAtomic(dsPath, previous)
      else unlinkSync(dsPath)
    } catch {
      /* best effort: the original error is the one to report */
    }
    throw e
  }
}
