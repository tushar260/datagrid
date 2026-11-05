/**
 * Backup / restore of the app's configuration (folders, data sources, settings, layout, optionally the open-tabs session
 * and the saved secrets). Pure: no electron imports, so every rule is unit-tested (tests/main/backup.test.ts).
 *
 * File format (`*.datagrid-backup.json`):
 *  - plain:     `{ format: 'datagrid-backup', version: 1, appVersion, createdAt, platform, folders, sources, settings?, layout?, session? }`
 *               (no secrets: the saved passwords live encrypted with this Mac's Keychain key and cannot be copied)
 *  - encrypted: `{ format, version, encrypted: true, cipher: 'aes-256-gcm', kdf: { name: 'scrypt', N, r, p, salt }, iv, tag, data }`
 *               (base64; `data` is the whole plain payload above, secrets included). scrypt(passphrase, salt) -> 32-byte key;
 *               the header is authenticated as GCM additional data.
 * Everything read from a file is treated as hostile: every field is validated / sanitised before it gets anywhere near the stores.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'crypto'
import {
  BACKUP_EXT, BACKUP_FORMAT, BACKUP_MAX_ITEMS, BACKUP_MAX_PASSPHRASE, BACKUP_MIN_PASSPHRASE, BACKUP_VERSION,
  breakFolderCycles, dsKind, isBackupLayoutKey, isHostileKey, parseEndpoint, validateDynamoConfig, validateRedisConfig
} from '../shared'
import type {
  BackupCounts, BackupMode, BackupSummary, DataSource, DbSort, DeviceSecrets, DynamoConfig, Folder, PatternRule, RedisConfig,
  RuleMode, StateItem, TableFilter
} from '../shared'

export type BackupErrorCode = 'format' | 'version' | 'corrupt' | 'passphrase' | 'invalid' | 'limits'

/** A problem with a backup file / passphrase. The message is meant for the user and never contains a secret. */
export class BackupError extends Error {
  code: BackupErrorCode
  constructor(code: BackupErrorCode, message: string) {
    super(message)
    this.name = 'BackupError'
    this.code = code
  }
}

export type SettingsValues = Record<string, string | number | boolean>

export interface Backup {
  format: typeof BACKUP_FORMAT
  version: number
  appVersion: string
  createdAt: string
  platform: string
  /** at least one source carries a clear-text secret (only ever true inside an encrypted file) */
  secrets: boolean
  folders: Folder[]
  sources: DataSource[]
  settings?: SettingsValues
  /** whitelisted localStorage layout entries (key -> raw string) */
  layout?: Record<string, string>
  /** open-tabs session (console SQL text removed) */
  session?: Record<string, unknown>
  /** this Mac's own automatic backups only: still-encrypted (`enc:`) secret blobs by data source id (see `undo`) */
  deviceSecrets?: Record<string, DeviceSecrets>
}

export interface KdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  /** base64, 16 random bytes per file */
  salt: string
}

export interface Envelope {
  format: typeof BACKUP_FORMAT
  version: number
  encrypted: true
  cipher: 'aes-256-gcm'
  kdf: KdfParams
  iv: string
  tag: string
  data: string
}

export type ParsedBackupFile = { encrypted: false; backup: Backup } | { encrypted: true; envelope: Envelope }

export interface ValidateOptions {
  /** keep the clear-text secrets (only for the payload of an encrypted file) */
  allowSecrets?: boolean
  /** keep `deviceSecrets` (only when reading one of this Mac's own automatic backups) */
  allowDeviceSecrets?: boolean
  /** repair odd Postgres host / port values instead of rejecting them (used when exporting what is stored) */
  lenient?: boolean
  /** fresh id generator (tests) */
  newId?: () => string
}

// ---------------------------------------------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------------------------------------------

const MAX_NAME = 200
const MAX_STR = 255
const MAX_SECRET = 8192
const MAX_LIST = 5000
const MAX_FILTER_KEYS = 2000
const MAX_SESSION_BYTES = 2_000_000
const MAX_DEPTH = 12

export const KDF_DEFAULT = { N: 1 << 15, r: 8, p: 1 } as const
const KDF_MAX_N = 1 << 18
const KDF_MEM_CAP = 256 * 1024 * 1024
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

// ---------------------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const CONTROL = /[\u0000-\u001f\u007f]/g
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** ASCII-safe, bounded ids (they become cache file names); anything else is replaced by a fresh id. */
export const validId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v) && !isHostileKey(v)

const bad = (message: string): never => {
  throw new BackupError('invalid', message)
}

function text(v: unknown, max: number, what: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof v !== 'string') return bad(`${what} must be text`)
  const s = v.replace(CONTROL, '')
  if (s.length > max) return bad(`${what} is too long`)
  if (!s.trim() && !opts.allowEmpty) return bad(`${what} is empty`)
  return s
}

function strList(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) return bad(`${what} must be a list`)
  if (v.length > MAX_LIST) throw new BackupError('limits', `${what} has too many entries`)
  return v.map((x) => text(x, MAX_STR, what, { allowEmpty: true }))
}

const kindOf = (v: unknown): DataSource['kind'] => {
  if (v === undefined || v === null || v === 'postgres') return 'postgres'
  if (v === 'dynamodb' || v === 'redis') return v
  return bad(`Unknown data source type "${String(v).slice(0, 30)}"`)
}

// ---------------------------------------------------------------------------------------------------------------
// sections: settings, layout, session
// ---------------------------------------------------------------------------------------------------------------

/**
 * App settings as plain values only (the renderer normalises them with its own `normalizeSettings` when applying, so unknown or
 * out-of-range values fall back to defaults there). Here: plain object, safe keys, primitive values, bounded size.
 */
export function sanitizeSettings(raw: unknown): SettingsValues | undefined {
  if (!isObj(raw)) return undefined
  const out: SettingsValues = {}
  let n = 0
  for (const [k, v] of Object.entries(raw)) {
    if (isHostileKey(k) || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k)) continue
    if (typeof v === 'string' && v.length <= 100) out[k] = v.replace(CONTROL, '')
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else continue
    if (++n >= 64) break
  }
  return out
}

/** Layout entries: only whitelisted keys (split ratios / picker sizes) with small JSON number / size values. */
export function sanitizeLayout(raw: unknown): Record<string, string> | undefined {
  if (!isObj(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    // unknown keys (including layout keys of other versions) are ignored
    if (!isBackupLayoutKey(k) || typeof v !== 'string' || v.length > 256) continue
    try {
      const j: unknown = JSON.parse(v)
      const ok =
        (typeof j === 'number' && Number.isFinite(j)) ||
        (isObj(j) && Object.keys(j).length <= 4 && Object.values(j).every((x) => typeof x === 'number' && Number.isFinite(x)))
      if (ok) out[k] = v
    } catch {
      /* not JSON: dropped */
    }
  }
  return out
}

function cleanJson(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (Array.isArray(v)) return v.map((x) => cleanJson(x, depth + 1)).filter((x) => x !== undefined)
  if (isObj(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (isHostileKey(k)) continue
      const c = cleanJson(x, depth + 1)
      if (c !== undefined) out[k] = c
    }
    return out
  }
  return undefined
}

/** The open-tabs session as plain JSON: hostile keys dropped, bounded, and without the console SQL text. */
export function sanitizeSession(raw: unknown): Record<string, unknown> | undefined {
  if (!isObj(raw)) return undefined
  const c = cleanJson(raw, 0) as Record<string, unknown>
  c.consoleSql = {}
  if (JSON.stringify(c).length > MAX_SESSION_BYTES) throw new BackupError('limits', 'The saved tabs are too large to back up')
  return c
}

// ---------------------------------------------------------------------------------------------------------------
// data sources
// ---------------------------------------------------------------------------------------------------------------

const DB_SORTS: DbSort[] = ['name-asc', 'name-desc', 'size-desc', 'size-asc']
const RULE_MODES: RuleMode[] = ['starts', 'contains', 'ends', 'regex']

function cleanRule(v: unknown, what: string): PatternRule | undefined {
  if (!isObj(v)) return undefined
  if (!RULE_MODES.includes(v.mode as RuleMode)) return bad(`${what}: unknown filter mode`)
  return { mode: v.mode as RuleMode, pattern: text(v.pattern ?? '', 500, `${what}: filter pattern`, { allowEmpty: true }) }
}

function cleanTableFilter(v: unknown, what: string): Record<string, TableFilter> {
  if (!isObj(v)) return bad(`${what} must be an object`)
  const entries = Object.entries(v).filter(([k]) => !isHostileKey(k))
  if (entries.length > MAX_FILTER_KEYS) throw new BackupError('limits', `${what} has too many entries`)
  const out: Record<string, TableFilter> = {}
  for (const [k, f] of entries) {
    if (!isObj(f)) continue
    const tf: TableFilter = {}
    if (f.list !== undefined) tf.list = strList(f.list, `${what} list`)
    const rule = f.rule !== undefined ? cleanRule(f.rule, what) : undefined
    if (rule) tf.rule = rule
    out[text(k, MAX_STR, what, { allowEmpty: true })] = tf
  }
  return out
}

function cleanSchemaFilter(v: unknown, what: string): Record<string, string[]> {
  if (!isObj(v)) return bad(`${what} must be an object`)
  const entries = Object.entries(v).filter(([k]) => !isHostileKey(k))
  if (entries.length > MAX_FILTER_KEYS) throw new BackupError('limits', `${what} has too many entries`)
  const out: Record<string, string[]> = {}
  for (const [k, list] of entries) out[text(k, MAX_STR, what, { allowEmpty: true })] = strList(list, what)
  return out
}

function cleanDynamo(v: unknown, label: string, allowSecrets: boolean): DynamoConfig {
  if (!isObj(v)) return bad(`${label}: DynamoDB settings are missing`)
  const authMode = v.authMode
  if (authMode !== 'default' && authMode !== 'profile' && authMode !== 'keys') return bad(`${label}: unknown DynamoDB sign-in mode`)
  const cfg: DynamoConfig = {
    region: text(v.region ?? '', 40, `${label}: region`, { allowEmpty: true }).trim(),
    authMode
  }
  if (authMode === 'profile') cfg.profile = text(v.profile ?? '', 128, `${label}: profile`, { allowEmpty: true }).trim()
  if (v.endpoint !== undefined && v.endpoint !== null && v.endpoint !== '') cfg.endpoint = text(v.endpoint, 2048, `${label}: endpoint`).trim()
  if (authMode === 'keys') cfg.accessKeyId = text(v.accessKeyId ?? '', 128, `${label}: access key ID`, { allowEmpty: true }).trim()
  const err = validateDynamoConfig(cfg, true)
  if (err) return bad(`${label}: ${err}`)
  if (cfg.endpoint) cfg.endpoint = parseEndpoint(cfg.endpoint) ?? undefined
  if (!cfg.endpoint) delete cfg.endpoint
  if (authMode === 'keys' && allowSecrets) {
    if (typeof v.secretAccessKey === 'string' && v.secretAccessKey) cfg.secretAccessKey = text(v.secretAccessKey, MAX_SECRET, `${label}: secret`)
    if (typeof v.sessionToken === 'string' && v.sessionToken) cfg.sessionToken = text(v.sessionToken, MAX_SECRET, `${label}: session token`)
  }
  return cfg
}

function cleanRedis(v: unknown, label: string, allowSecrets: boolean): RedisConfig {
  if (!isObj(v)) return bad(`${label}: Redis settings are missing`)
  const cfg: RedisConfig = {
    host: text(v.host ?? '', 255, `${label}: host`, { allowEmpty: true }).trim(),
    port: v.port as number,
    db: v.db as number,
    tls: v.tls === true
  }
  if (v.keyDelimiter !== undefined && typeof v.keyDelimiter !== 'string') return bad(`${label}: key delimiter must be text`)
  const err = validateRedisConfig({ ...cfg, ...(v.keyDelimiter !== undefined ? { keyDelimiter: v.keyDelimiter as string } : {}) })
  if (err) return bad(`${label}: ${err}`)
  if (typeof v.username === 'string' && v.username.trim()) cfg.username = text(v.username, MAX_STR, `${label}: user`).trim()
  if (typeof v.keyDelimiter === 'string') cfg.keyDelimiter = v.keyDelimiter
  if (allowSecrets && typeof v.password === 'string' && v.password) cfg.password = text(v.password, MAX_SECRET, `${label}: password`)
  return cfg
}

function cleanSource(raw: unknown, index: number, id: string, folderId: string | null, o: ValidateOptions): DataSource {
  if (!isObj(raw)) return bad(`Data source ${index + 1} is not an object`)
  const name = (typeof raw.name === 'string' ? raw.name.replace(CONTROL, '').trim().slice(0, MAX_NAME) : '') || 'Untitled'
  const label = `Data source "${name}"`
  const kind = kindOf(raw.kind)
  const allowSecrets = !!o.allowSecrets
  const base: DataSource = { id, name, kind, host: '', port: 0, user: '', password: '', database: '', ssl: false, folderId }
  if (kind === 'dynamodb') base.dynamo = cleanDynamo(raw.dynamo, label, allowSecrets)
  else if (kind === 'redis') base.redis = cleanRedis(raw.redis, label, allowSecrets)
  else {
    const lenient = !!o.lenient
    const host = typeof raw.host === 'string' ? raw.host.replace(CONTROL, '').trim() : lenient ? '' : bad(`${label}: host must be text`)
    if (host.length > MAX_STR) return bad(`${label}: host is too long`)
    const portOk = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65535
    if (!portOk && !lenient) return bad(`${label}: port must be a number between 0 and 65535`)
    base.host = host
    base.port = portOk ? (raw.port as number) : 5432
    base.user = raw.user === undefined || raw.user === null ? '' : text(raw.user, MAX_STR, `${label}: user`, { allowEmpty: true })
    base.database = raw.database === undefined || raw.database === null ? '' : text(raw.database, MAX_STR, `${label}: database`, { allowEmpty: true })
    base.ssl = raw.ssl === true
    if (allowSecrets && typeof raw.password === 'string' && raw.password) base.password = text(raw.password, MAX_SECRET, `${label}: password`)
  }
  if (DB_SORTS.includes(raw.dbSort as DbSort)) base.dbSort = raw.dbSort as DbSort
  if (raw.visibleDbs === null) base.visibleDbs = null
  else if (raw.visibleDbs !== undefined) base.visibleDbs = strList(raw.visibleDbs, `${label}: visible databases`)
  if (raw.schemaFilter !== undefined) base.schemaFilter = cleanSchemaFilter(raw.schemaFilter, `${label}: schema filter`)
  if (raw.tableFilter !== undefined) base.tableFilter = cleanTableFilter(raw.tableFilter, `${label}: table filter`)
  return base
}

/** Does this source carry a clear-text secret? */
export function hasSecret(d: DataSource): boolean {
  if (dsKind(d) === 'dynamodb') return !!d.dynamo?.secretAccessKey || !!d.dynamo?.sessionToken
  if (dsKind(d) === 'redis') return !!d.redis?.password
  return !!d.password
}

/** A copy of the source without any clear-text secret. */
export function stripSecrets(d: DataSource): DataSource {
  const { password: _p, ...rest } = d
  const out: DataSource = { ...rest, password: '' }
  if (out.dynamo) {
    const { secretAccessKey: _s, sessionToken: _t, hasSecret: _h, hasSessionToken: _ht, ...cfg } = out.dynamo
    out.dynamo = cfg
  }
  if (out.redis) {
    const { password: _rp, clearPassword: _c, hasPassword: _hp, ...cfg } = out.redis
    out.redis = cfg
  }
  delete out.passwordUnavailable
  return out
}

function cleanDeviceSecrets(raw: unknown): Record<string, DeviceSecrets> | undefined {
  if (!isObj(raw)) return undefined
  const out: Record<string, DeviceSecrets> = {}
  const blob = (v: unknown): v is string => typeof v === 'string' && /^enc:[A-Za-z0-9+/=]{1,8192}$/.test(v)
  for (const [id, v] of Object.entries(raw)) {
    if (!validId(id) || !isObj(v)) continue
    const s: DeviceSecrets = {}
    if (blob(v.password)) s.password = v.password
    if (blob(v.secretAccessKey)) s.secretAccessKey = v.secretAccessKey
    if (blob(v.sessionToken)) s.sessionToken = v.sessionToken
    out[id] = s
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// validate / build / parse
// ---------------------------------------------------------------------------------------------------------------

/** Maps the ids found in a list to valid unique ones: bad / duplicate ids get a fresh id; references use the first mapping. */
function mapIds(list: unknown[], newId: () => string): { ids: string[]; byOriginal: Map<string, string> } {
  const taken = new Set<string>()
  const byOriginal = new Map<string, string>()
  const ids = list.map((x) => {
    const orig = isObj(x) ? x.id : undefined
    let id: string
    if (validId(orig) && !taken.has(orig)) id = orig
    else {
      do id = newId()
      while (taken.has(id) || !validId(id))
    }
    taken.add(id)
    if (typeof orig === 'string' && !byOriginal.has(orig) && !isHostileKey(orig)) byOriginal.set(orig, id)
    return id
  })
  return { ids, byOriginal }
}

function checkHeader(o: Record<string, unknown>): void {
  if (o.format !== BACKUP_FORMAT) throw new BackupError('format', 'This is not a DataGrid backup file')
  if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) throw new BackupError('format', 'The backup file has an invalid version')
  if (o.version > BACKUP_VERSION) {
    throw new BackupError('version', `This backup was created by a newer DataGrid (backup format v${o.version}). Update DataGrid to restore it.`)
  }
}

/** Strict validation + sanitising of a (decrypted / plain) backup payload. Throws BackupError; never returns unvalidated data. */
export function validateBackup(obj: unknown, opts: ValidateOptions = {}): Backup {
  if (!isObj(obj)) throw new BackupError('corrupt', 'The backup file is damaged (not a JSON object)')
  checkHeader(obj)
  const newId = opts.newId ?? randomUUID
  const createdAt = typeof obj.createdAt === 'string' && obj.createdAt.length <= 40 && !Number.isNaN(Date.parse(obj.createdAt)) ? obj.createdAt : null
  if (!createdAt) throw new BackupError('invalid', 'The backup file has no valid creation date')
  if (!Array.isArray(obj.folders) || !Array.isArray(obj.sources)) throw new BackupError('invalid', 'The backup file has no folders / data sources list')
  if (obj.folders.length > BACKUP_MAX_ITEMS || obj.sources.length > BACKUP_MAX_ITEMS) {
    throw new BackupError('limits', `The backup has more than ${BACKUP_MAX_ITEMS} folders or data sources`)
  }

  // folders: valid unique ids, names, parents that exist, no cycles
  const f = mapIds(obj.folders, newId)
  let folders: Folder[] = obj.folders.map((x, i) => {
    if (!isObj(x)) return bad(`Folder ${i + 1} is not an object`)
    const name = (typeof x.name === 'string' ? x.name.replace(CONTROL, '').trim().slice(0, MAX_NAME) : '') || 'New Folder'
    const parent = typeof x.parentId === 'string' ? f.byOriginal.get(x.parentId) : undefined
    return { id: f.ids[i], name, parentId: parent && parent !== f.ids[i] ? parent : null }
  })
  folders = breakFolderCycles(folders)
  const folderIds = new Set(folders.map((x) => x.id))

  const s = mapIds(obj.sources, newId)
  const sources = obj.sources.map((x, i) => {
    const fid = isObj(x) && typeof x.folderId === 'string' ? f.byOriginal.get(x.folderId) : undefined
    return cleanSource(x, i, s.ids[i], fid && folderIds.has(fid) ? fid : null, opts)
  })

  const out: Backup = {
    format: BACKUP_FORMAT,
    version: obj.version as number,
    appVersion: typeof obj.appVersion === 'string' ? obj.appVersion.replace(CONTROL, '').slice(0, 50) : '',
    createdAt,
    platform: typeof obj.platform === 'string' ? obj.platform.replace(CONTROL, '').slice(0, 40) : '',
    secrets: sources.some(hasSecret),
    folders,
    sources
  }
  const settings = sanitizeSettings(obj.settings)
  if (settings) out.settings = settings
  const layout = sanitizeLayout(obj.layout)
  if (layout) out.layout = layout
  const session = sanitizeSession(obj.session)
  if (session) out.session = session
  if (opts.allowDeviceSecrets) {
    const ds = cleanDeviceSecrets(obj.deviceSecrets)
    if (ds) out.deviceSecrets = ds
  }
  return out
}

export interface BuildInput {
  /** stored records (secrets encrypted, they are dropped) or decrypted sources (secrets kept only when includeSecrets) */
  sources: DataSource[]
  folders: Folder[]
  includeSecrets: boolean
  appVersion: string
  platform: string
  now?: number
  settings?: unknown
  layout?: unknown
  session?: unknown
  deviceSecrets?: Record<string, DeviceSecrets>
}

/** The payload for a backup of the current state. It goes through the same validation as an import, so it always re-imports. */
export function buildBackup(i: BuildInput): Backup {
  const raw: Record<string, unknown> = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: i.appVersion,
    createdAt: new Date(i.now ?? Date.now()).toISOString(),
    platform: i.platform,
    folders: i.folders,
    sources: i.includeSecrets ? i.sources : i.sources.map(stripSecrets),
    settings: i.settings,
    layout: i.layout,
    session: i.session,
    deviceSecrets: i.deviceSecrets
  }
  return validateBackup(raw, { allowSecrets: i.includeSecrets, allowDeviceSecrets: !!i.deviceSecrets, lenient: true })
}

export const serializeBackup = (b: Backup | Envelope): string => JSON.stringify(b, null, 2)

/** Parses the text of a backup file: a plain backup (validated) or an encrypted envelope (shape-checked, still sealed). */
export function parseBackupFile(textIn: string, opts: ValidateOptions = {}): ParsedBackupFile {
  let j: unknown
  try {
    j = JSON.parse(textIn.charCodeAt(0) === 0xfeff ? textIn.slice(1) : textIn)
  } catch {
    throw new BackupError('corrupt', 'The file is not valid JSON: it is damaged, incomplete or not a DataGrid backup')
  }
  if (!isObj(j)) throw new BackupError('format', 'This is not a DataGrid backup file')
  checkHeader(j)
  if (j.encrypted === true) return { encrypted: true, envelope: parseEnvelope(j) }
  return { encrypted: false, backup: validateBackup(j, { ...opts, allowSecrets: false }) }
}

// ---------------------------------------------------------------------------------------------------------------
// encryption: scrypt -> AES-256-GCM
// ---------------------------------------------------------------------------------------------------------------

/** Returns an error message, or null when the passphrase is acceptable. */
export function validatePassphrase(p: unknown): string | null {
  if (typeof p !== 'string') return 'Enter a passphrase'
  if (p.length < BACKUP_MIN_PASSPHRASE) return `The passphrase must have at least ${BACKUP_MIN_PASSPHRASE} characters`
  if (p.length > BACKUP_MAX_PASSPHRASE) return 'The passphrase is too long'
  return null
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/
function b64(v: unknown, bytes: number | null, what: string): Buffer {
  if (typeof v !== 'string' || !B64.test(v) || v.length % 4 !== 0) throw new BackupError('corrupt', `The backup file is damaged (${what})`)
  const b = Buffer.from(v, 'base64')
  if ((bytes !== null && b.length !== bytes) || (bytes === null && b.length === 0)) throw new BackupError('corrupt', `The backup file is damaged (${what})`)
  return b
}

function kdfParams(k: unknown): KdfParams {
  if (!isObj(k) || k.name !== 'scrypt') throw new BackupError('format', 'The backup uses an unsupported key derivation')
  const { N, r, p } = k as { N: unknown; r: unknown; p: unknown }
  const pow2 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0
  if (!pow2(N) || N < 1 << 15 || N > KDF_MAX_N) throw new BackupError('format', 'The backup uses unsupported encryption settings')
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 8 || r > 16) throw new BackupError('format', 'The backup uses unsupported encryption settings')
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 4) throw new BackupError('format', 'The backup uses unsupported encryption settings')
  if (128 * N * r > KDF_MEM_CAP) throw new BackupError('format', 'The backup uses unsupported encryption settings')
  b64(k.salt, SALT_BYTES, 'salt')
  return { name: 'scrypt', N, r, p, salt: k.salt as string }
}

function parseEnvelope(j: Record<string, unknown>): Envelope {
  if (j.cipher !== 'aes-256-gcm') throw new BackupError('format', 'The backup uses an unsupported cipher')
  const kdf = kdfParams(j.kdf)
  b64(j.iv, IV_BYTES, 'iv')
  b64(j.tag, TAG_BYTES, 'tag')
  b64(j.data, null, 'data')
  return { format: BACKUP_FORMAT, version: j.version as number, encrypted: true, cipher: 'aes-256-gcm', kdf, iv: j.iv as string, tag: j.tag as string, data: j.data as string }
}

/** The authenticated (not secret) header: a changed version / kdf / salt / iv fails the GCM check. */
const aadOf = (e: Pick<Envelope, 'format' | 'version' | 'cipher' | 'kdf' | 'iv'>): Buffer =>
  Buffer.from(JSON.stringify([e.format, e.version, e.cipher, e.kdf.name, e.kdf.N, e.kdf.r, e.kdf.p, e.kdf.salt, e.iv]), 'utf8')

function deriveKey(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(passphrase.normalize('NFC'), 'utf8'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: KDF_MEM_CAP * 2 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  })
}

/** Encrypts the whole payload: a fresh random salt and IV per call. `kdf` is only overridable for tests (N stays >= 2^15 for files). */
export async function encryptBackup(backup: Backup, passphrase: string, kdf: { N: number; r: number; p: number } = KDF_DEFAULT): Promise<Envelope> {
  const perr = validatePassphrase(passphrase)
  if (perr) throw new BackupError('passphrase', perr)
  const params: KdfParams = { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: randomBytes(SALT_BYTES).toString('base64') }
  const iv = randomBytes(IV_BYTES)
  const header = { format: BACKUP_FORMAT as typeof BACKUP_FORMAT, version: backup.version, cipher: 'aes-256-gcm' as const, kdf: params, iv: iv.toString('base64') }
  const key = await deriveKey(passphrase, params)
  const plain = Buffer.from(JSON.stringify(backup), 'utf8')
  try {
    const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    c.setAAD(aadOf(header))
    const data = Buffer.concat([c.update(plain), c.final()])
    return { ...header, encrypted: true, tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
  } finally {
    key.fill(0)
    plain.fill(0)
  }
}

/** Decrypts + validates. A wrong passphrase and a modified file are indistinguishable (GCM authentication fails). */
export async function decryptBackup(envelope: Envelope, passphrase: string, opts: ValidateOptions = {}): Promise<Backup> {
  const env = parseEnvelope(envelope as unknown as Record<string, unknown>)
  if (typeof passphrase !== 'string' || !passphrase) throw new BackupError('passphrase', 'Enter the passphrase')
  const key = await deriveKey(passphrase, env.kdf)
  let plain: Buffer | null = null
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'), { authTagLength: TAG_BYTES })
    d.setAAD(aadOf(env))
    d.setAuthTag(Buffer.from(env.tag, 'base64'))
    plain = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()])
  } catch {
    throw new BackupError('passphrase', 'Wrong passphrase or the file was modified')
  } finally {
    key.fill(0)
  }
  try {
    let j: unknown
    try {
      j = JSON.parse(plain.toString('utf8'))
    } catch {
      throw new BackupError('corrupt', 'The backup contents are damaged')
    }
    return validateBackup(j, { ...opts, allowSecrets: true })
  } finally {
    plain.fill(0)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// summary / file names
// ---------------------------------------------------------------------------------------------------------------

export function countsOf(folders: Folder[], sources: DataSource[]): BackupCounts {
  const byKind = { postgres: 0, dynamodb: 0, redis: 0 }
  for (const d of sources) byKind[dsKind(d)]++
  return { folders: folders.length, sources: sources.length, byKind }
}

export function summarize(b: Backup, fileName: string, encrypted: boolean): BackupSummary {
  return {
    fileName,
    createdAt: b.createdAt,
    appVersion: b.appVersion,
    platform: b.platform,
    counts: countsOf(b.folders, b.sources),
    hasSettings: !!b.settings && Object.keys(b.settings).length > 0,
    hasLayout: !!b.layout && Object.keys(b.layout).length > 0,
    hasSession: !!b.session,
    hasSecrets: b.secrets,
    encrypted
  }
}

/** `DataGrid-backup-YYYY-MM-DD.datagrid-backup.json` (local date). */
export function suggestFileName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `DataGrid-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${BACKUP_EXT}`
}

// ---------------------------------------------------------------------------------------------------------------
// planning an import
// ---------------------------------------------------------------------------------------------------------------

export interface CurrentState {
  folders: Folder[]
  /** stored records are fine: only names / connection fields are read */
  sources: DataSource[]
}

export interface ImportPlan {
  mode: BackupMode
  folders: Folder[]
  /** the final data source list, in order */
  items: StateItem[]
  /** existing data source ids that disappear */
  removedIds: string[]
  /** existing data source ids whose record is replaced or removed: close their connections, drop their cache */
  touchedIds: string[]
  foldersAdded: number
  sourcesAdded: number
  skipped: number
  renamed: number
  /** the sources that are added, by kind (for the success message) */
  addedByKind: Record<'postgres' | 'dynamodb' | 'redis', number>
}

const IMPORTED = ' (imported)'
const norm = (s: string): string => s.trim().toLowerCase()

/** The non-secret connection settings that make two sources "the same" (name is compared separately). */
function identity(d: DataSource): string {
  const k = dsKind(d)
  if (k === 'dynamodb') {
    const c = d.dynamo
    return JSON.stringify([k, c?.region ?? '', c?.authMode ?? 'default', c?.profile ?? '', c?.accessKeyId ?? '', c?.endpoint ?? ''])
  }
  if (k === 'redis') {
    const c = d.redis
    return JSON.stringify([k, c?.host ?? '', c?.port ?? 0, c?.username ?? '', c?.db ?? 0, !!c?.tls])
  }
  return JSON.stringify([k, d.host, d.port, d.user, d.database, !!d.ssl])
}

function uniqueName(baseIn: string, taken: Set<string>): string {
  const base = baseIn.trim()
  let name = base + IMPORTED
  for (let n = 2; taken.has(norm(name)); n++) name = `${base} (imported ${n})`
  return name.slice(0, MAX_NAME + 20)
}

/**
 * What the data sources / folders look like after importing `backup`.
 *  - replace: exactly the backup's folders and sources (a source with a known id inherits its saved secrets when the backup has none).
 *  - merge:   everything that exists stays. A backup item with the id (or, for data sources, the name) of an existing one is
 *             imported as a copy with a fresh id and an "(imported)" suffix, except an exact duplicate (same id, name and
 *             connection) which is skipped. Folders of the backup keep their nesting; assignments follow the folder mapping.
 */
export function planImport(current: CurrentState, backup: Backup, mode: BackupMode, opts: { newId?: () => string } = {}): ImportPlan {
  const newId = opts.newId ?? randomUUID
  const existingIds = new Set(current.sources.map((d) => d.id))
  const addedByKind = { postgres: 0, dynamodb: 0, redis: 0 }
  const authoritativeSecrets = backup.secrets || !!backup.deviceSecrets

  if (mode === 'replace') {
    const items: StateItem[] = backup.sources.map((s) => {
      addedByKind[dsKind(s)]++
      const it: StateItem = { add: s }
      if (backup.deviceSecrets) it.deviceSecrets = backup.deviceSecrets[s.id] ?? {}
      else if (!authoritativeSecrets && existingIds.has(s.id)) it.inheritFrom = s.id
      return it
    })
    return {
      mode, folders: backup.folders, items, removedIds: current.sources.filter((d) => !backup.sources.some((s) => s.id === d.id)).map((d) => d.id),
      touchedIds: [...existingIds], foldersAdded: backup.folders.length, sourcesAdded: backup.sources.length, skipped: 0, renamed: 0, addedByKind
    }
  }

  // ---- merge: folders first (parents before children) ----
  const folderIds = new Set(current.folders.map((x) => x.id))
  const byBackupId = new Map(backup.folders.map((x) => [x.id, x]))
  const finalOf = new Map<string, string>() // backup folder id -> id in the result
  const folders = [...current.folders]
  let foldersAdded = 0
  let skipped = 0
  let renamed = 0
  const resolve = (id: string): string => {
    const done = finalOf.get(id)
    if (done) return done
    const f = byBackupId.get(id)!
    finalOf.set(id, id) // (the folders are cycle-free; this only guards against a bug looping)
    const parent = f.parentId && byBackupId.has(f.parentId) ? resolve(f.parentId) : null
    const sameId = current.folders.find((x) => x.id === f.id)
    let out: string
    if (sameId && sameId.name.trim() === f.name.trim()) out = sameId.id // already there
    else {
      const nameTaken = current.folders.some((x) => (x.parentId ?? null) === parent && norm(x.name) === norm(f.name))
      const collides = !!sameId || nameTaken
      const nid = collides || folderIds.has(f.id) ? freshFolderId() : f.id
      const siblings = new Set(folders.filter((x) => (x.parentId ?? null) === parent).map((x) => norm(x.name)))
      folders.push({ id: nid, name: collides ? uniqueName(f.name, siblings) : f.name, parentId: parent })
      folderIds.add(nid)
      foldersAdded++
      if (collides) renamed++
      out = nid
    }
    finalOf.set(id, out)
    return out
  }
  const freshFolderId = (): string => {
    let id = newId()
    while (folderIds.has(id) || existingIds.has(id)) id = newId()
    return id
  }
  for (const f of backup.folders) resolve(f.id)

  // ---- merge: data sources ----
  const names = new Set(current.sources.map((d) => norm(d.name)))
  const items: StateItem[] = current.sources.map((d) => ({ keep: d.id }))
  const usedIds = new Set(existingIds)
  let sourcesAdded = 0
  for (const s of backup.sources) {
    const folderId = s.folderId ? finalOf.get(s.folderId) ?? null : null
    const sameId = current.sources.find((d) => d.id === s.id)
    if (sameId && norm(sameId.name) === norm(s.name) && identity(sameId) === identity(s)) {
      skipped++
      continue
    }
    const nameTaken = names.has(norm(s.name))
    const collides = !!sameId || nameTaken
    let id = s.id
    if (collides || usedIds.has(id)) {
      do id = newId()
      while (usedIds.has(id) || !validId(id))
    }
    const name = collides ? uniqueName(s.name, names) : s.name
    usedIds.add(id)
    names.add(norm(name))
    if (collides) renamed++
    items.push({ add: { ...s, id, name, folderId } })
    addedByKind[dsKind(s)]++
    sourcesAdded++
  }
  return { mode, folders, items, removedIds: [], touchedIds: [], foldersAdded, sourcesAdded, skipped, renamed, addedByKind }
}

/** Raw (still encrypted) secret blobs of the stored records, for this Mac's automatic backups only. */
export function deviceSecretsOf(raw: DataSource[], blobsOf: (d: DataSource) => DeviceSecrets): Record<string, DeviceSecrets> {
  const out: Record<string, DeviceSecrets> = {}
  for (const d of raw) {
    if (!validId(d.id)) continue
    const b = blobsOf(d)
    const only: DeviceSecrets = {}
    for (const k of ['password', 'secretAccessKey', 'sessionToken'] as const) {
      const v = b[k]
      if (typeof v === 'string' && v.startsWith('enc:')) only[k] = v // 'raw:' blobs are readable text: never copied
    }
    if (Object.keys(only).length) out[d.id] = only
  }
  return out
}
