import { createHash } from 'crypto'
import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ExecuteStatementCommand,
  ListTablesCommand,
  ScanCommand,
  paginateListTables,
  type AttributeValue,
  type DescribeTableCommandOutput
} from '@aws-sdk/client-dynamodb'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { convertToAttr } from '@aws-sdk/util-dynamodb'
import { selectAllPartiql, validateDynamoConfig } from '../shared'
import type {
  DataSource, DdbJson, DynamoColumn, DynamoConfig, DynamoIndexInfo, DynamoKeyDef, DynamoPage, DynamoStatementResult,
  DynamoTableInfo
} from '../shared'

/**
 * DynamoDB support (AWS SDK for JavaScript v3: bare-bones client + commands, `@aws-sdk/credential-providers`).
 * Secrets reach this module decrypted inside `ds.dynamo` and are only ever handed to the SDK: never logged, never returned.
 */

type AttrMap = Record<string, AttributeValue>
type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date }
type CredsProvider = (...args: never[]) => Promise<Creds>

/** The most columns a grid shows (attributes beyond the cap stay in the item JSON). */
export const MAX_COLUMNS = 200
const KEY_CACHE_MS = 5 * 60_000
/** Console pages (ExecuteStatement `Limit`; PartiQL has no LIMIT clause) */
export const CONSOLE_PAGE = 100

// ---------------------------------------------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------------------------------------------

/** What credentials the SDK should use for these settings. */
export function credentialsFor(cfg: DynamoConfig): CredsProvider | Creds {
  if (cfg.authMode === 'keys') {
    return {
      accessKeyId: (cfg.accessKeyId ?? '').trim(),
      secretAccessKey: cfg.secretAccessKey ?? '',
      ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {})
    }
  }
  const chain = (
    cfg.authMode === 'profile' ? fromNodeProviderChain({ profile: (cfg.profile ?? '').trim() }) : fromNodeProviderChain()
  ) as unknown as (...a: unknown[]) => Promise<Creds>
  if (!cfg.endpoint) return chain as CredsProvider
  // DynamoDB Local / LocalStack accept any key: when nothing is configured (the chain fails) sign with dummy ones
  return (async (...args: unknown[]) => {
    try {
      return await chain(...args)
    } catch {
      return { accessKeyId: 'local', secretAccessKey: 'local' }
    }
  }) as unknown as CredsProvider
}

/** The region to pin, or undefined to let the SDK resolve it (AWS_REGION / the profile). Keys and custom endpoints need one. */
export function regionFor(cfg: DynamoConfig): string | undefined {
  const r = (cfg.region ?? '').trim()
  if (r) return r
  return cfg.authMode === 'keys' || cfg.endpoint ? 'us-east-1' : undefined
}

function clientConfig(cfg: DynamoConfig, credentials: CredsProvider | Creds, maxAttempts: number): Record<string, unknown> {
  const region = regionFor(cfg)
  return {
    ...(region ? { region } : {}),
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    // `profile` lets the SDK read the profile's region too; the credentials come from the same profile
    ...(cfg.authMode === 'profile' ? { profile: (cfg.profile ?? '').trim() } : {}),
    credentials,
    maxAttempts,
    requestHandler: { connectionTimeout: 6000, requestTimeout: 60_000 }
  }
}

function configOf(ds: DataSource): DynamoConfig {
  if (!ds.dynamo) throw new Error('Not a DynamoDB data source')
  return ds.dynamo
}

/** A new client for a DynamoDB data source (not cached; see `clientFor`). */
export function makeClient(ds: DataSource, opts: { maxAttempts?: number } = {}): DynamoDBClient {
  const cfg = configOf(ds)
  return new DynamoDBClient(clientConfig(cfg, credentialsFor(cfg), opts.maxAttempts ?? 3))
}

const clients = new Map<string, { sig: string; client: DynamoDBClient }>()
const keyCache = new Map<string, { at: number; keys: DynamoKeyDef[] }>()

/** Fingerprint of everything that shapes a client (hashed: secrets are not kept in a readable key). */
const signature = (cfg: DynamoConfig): string =>
  createHash('sha256').update(JSON.stringify([cfg.region, cfg.authMode, cfg.profile, cfg.accessKeyId, cfg.secretAccessKey, cfg.sessionToken, cfg.endpoint])).digest('hex')

/** The cached client of a data source; rebuilt when its settings changed. */
export function clientFor(ds: DataSource): DynamoDBClient {
  const sig = signature(configOf(ds))
  const hit = clients.get(ds.id)
  if (hit && hit.sig === sig) return hit.client
  hit?.client.destroy()
  const client = makeClient(ds)
  clients.set(ds.id, { sig, client })
  return client
}

/** Destroys the cached client(s) (edit / delete / disconnect of one data source, or everything on quit). */
export async function closeAll(dsId?: string): Promise<void> {
  for (const [id, c] of clients) {
    if (dsId && id !== dsId) continue
    clients.delete(id)
    c.client.destroy()
  }
  for (const k of keyCache.keys()) if (!dsId || k.startsWith(dsId + '|')) keyCache.delete(k)
}

// ---------------------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------------------

interface AwsErr {
  name?: string
  message?: string
  code?: string
  cause?: unknown
  $metadata?: { httpStatusCode?: number }
}

const NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'])

function netCode(e: AwsErr): string | undefined {
  for (let x: AwsErr | undefined = e, n = 0; x && n < 4; x = x.cause as AwsErr | undefined, n++) {
    if (x.code && NET_CODES.has(x.code)) return x.code
    const m = /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/.exec(x.message ?? '')
    if (m) return m[1]
  }
  return undefined
}

/** A short, actionable message for an AWS SDK / network error (never contains credentials). */
export function cleanAwsError(e: unknown, ctx: { endpoint?: string; region?: string } = {}): string {
  const err = (e ?? {}) as AwsErr
  const name = err.name ?? ''
  const msg = (err.message ?? String(e)).trim()
  if (name === 'CredentialsProviderError' || /could not load credentials|credential is not defined|no credentials/i.test(msg)) {
    return 'No credentials found. Run `aws configure` / `aws sso login` or choose Access key.'
  }
  if (/region is missing/i.test(msg)) {
    return 'No AWS region configured. Enter a region, set AWS_REGION, or run `aws configure set region <region>`.'
  }
  if (/ExpiredToken|TokenRefreshRequired|RequestExpired/i.test(name) || /token (has )?expired|session has expired|sso session|token is expired|expired token/i.test(msg)) {
    return 'AWS credentials have expired. Run `aws sso login` (or refresh the access key / session token).'
  }
  if (/UnrecognizedClient|InvalidClientTokenId|InvalidSignature|SignatureDoesNotMatch|IncompleteSignature/i.test(name) ||
    /security token included in the request is invalid|signature we calculated does not match/i.test(msg)) {
    return 'The access key ID or secret access key is invalid. Check the credentials (and the session token for temporary keys).'
  }
  if (/AccessDenied|NotAuthorized|AuthorizationError/i.test(name)) {
    return `Access denied: ${msg}. The credentials lack the required DynamoDB permission.`
  }
  if (name === 'ResourceNotFoundException') return `Not found: ${msg}`
  if (/Throttl|ProvisionedThroughputExceeded|RequestLimitExceeded/i.test(name)) {
    return 'DynamoDB throttled the request. Wait a moment and try again.'
  }
  const code = netCode(err)
  if (code || name === 'TimeoutError' || name === 'AbortError') {
    const where = ctx.endpoint ?? (ctx.region ? `DynamoDB in ${ctx.region}` : 'DynamoDB')
    return `Could not reach ${where} (${code ?? 'timeout'}). Check the endpoint URL, the region and your network connection.`
  }
  if (name && name !== 'Error' && msg && !msg.startsWith(name)) return `${name}: ${msg}`
  return msg || name || 'Unknown AWS error'
}

async function guarded<T>(ds: DataSource, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const cfg = ds.dynamo
    throw new Error(cleanAwsError(e, { endpoint: cfg?.endpoint, region: cfg ? regionFor(cfg) : undefined }))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// value conversion (AttributeValue -> JSON-safe value / grid cell)
// ---------------------------------------------------------------------------------------------------------------

/** Numbers that survive a JS double round trip stay numbers; anything else (beyond 2^53, long decimals) stays an exact string. */
export function numberToJson(s: string): number | string {
  const n = Number(s)
  return Number.isFinite(n) && String(n) === s ? n : s
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')

/** DynamoDB type letter(s) of a value: S N B BOOL NULL SS NS BS M L. */
export function attrTypeName(av: AttributeValue | undefined): string {
  if (!av) return 'NULL'
  if (av.S !== undefined) return 'S'
  if (av.N !== undefined) return 'N'
  if (av.B !== undefined) return 'B'
  if (av.BOOL !== undefined) return 'BOOL'
  if (av.NULL !== undefined) return 'NULL'
  if (av.SS !== undefined) return 'SS'
  if (av.NS !== undefined) return 'NS'
  if (av.BS !== undefined) return 'BS'
  if (av.M !== undefined) return 'M'
  if (av.L !== undefined) return 'L'
  return 'NULL'
}

/** JSON-safe form: sets become arrays, binary base64 strings, nested maps / lists are converted recursively. */
export function attrToJson(av: AttributeValue | undefined): DdbJson {
  switch (attrTypeName(av)) {
    case 'S': return av!.S as string
    case 'N': return numberToJson(av!.N as string)
    case 'B': return b64(av!.B as Uint8Array)
    case 'BOOL': return av!.BOOL as boolean
    case 'SS': return [...(av!.SS as string[])]
    case 'NS': return (av!.NS as string[]).map(numberToJson)
    case 'BS': return (av!.BS as Uint8Array[]).map(b64)
    case 'M': return itemToJson(av!.M as AttrMap)
    case 'L': return (av!.L as AttributeValue[]).map(attrToJson)
    default: return null
  }
}

export function itemToJson(item: AttrMap): Record<string, DdbJson> {
  const out: Record<string, DdbJson> = {}
  for (const [k, v] of Object.entries(item)) out[k] = attrToJson(v)
  return out
}

/** Grid text of a top-level attribute: scalars as text, binary as `Binary(n bytes)`, sets / maps / lists as compact JSON. */
export function attrToCell(av: AttributeValue | undefined): string | null {
  switch (attrTypeName(av)) {
    case 'S': return av!.S as string
    case 'N': return av!.N as string
    case 'B': return `Binary(${(av!.B as Uint8Array).byteLength} bytes)`
    case 'BOOL': return String(av!.BOOL)
    case 'SS': return 'SS ' + JSON.stringify(av!.SS)
    case 'NS': return 'NS ' + JSON.stringify((av!.NS as string[]).map(numberToJson))
    case 'BS': return 'BS ' + JSON.stringify((av!.BS as Uint8Array[]).map((b) => `Binary(${b.byteLength} bytes)`))
    case 'M':
    case 'L': return JSON.stringify(attrToJson(av))
    default: return null
  }
}

const byName = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)

/**
 * Grid shape of a page: columns = union of the top-level attribute names, partition key and sort key first (when `keys` is
 * given they are always present), then the others alphabetically; capped at MAX_COLUMNS.
 */
export function buildPage(items: AttrMap[], keys: Pick<DynamoKeyDef, 'name' | 'keyType'>[] = [], next: string | null = null): DynamoPage {
  const seen = new Map<string, Set<string>>()
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      let s = seen.get(k)
      if (!s) seen.set(k, (s = new Set()))
      s.add(attrTypeName(v))
    }
  }
  const keyOrder = [...keys].sort((a, b) => (a.keyType === b.keyType ? 0 : a.keyType === 'HASH' ? -1 : 1))
  const names: string[] = keyOrder.map((k) => k.name)
  for (const k of [...seen.keys()].filter((n) => !names.includes(n)).sort(byName)) names.push(k)
  const columnsCapped = names.length > MAX_COLUMNS
  const shown = names.slice(0, MAX_COLUMNS)
  const columns: DynamoColumn[] = shown.map((name) => {
    const key = keyOrder.find((k) => k.name === name)?.keyType
    return { name, types: [...(seen.get(name) ?? [])].sort(), ...(key ? { key } : {}) }
  })
  return {
    items: items.map(itemToJson),
    columns,
    rows: items.map((it) => shown.map((n) => attrToCell(it[n]))),
    next,
    columnsCapped
  }
}

// ---------------------------------------------------------------------------------------------------------------
// cursors (a scan's LastEvaluatedKey or a PartiQL NextToken, as one opaque string the renderer hands back)
// ---------------------------------------------------------------------------------------------------------------

type SafeKey = Record<string, { S: string } | { N: string } | { B: string }>
type Cursor = { k: SafeKey } | { t: string }

function keyToSafe(key: AttrMap): SafeKey {
  const out: SafeKey = {}
  for (const [k, v] of Object.entries(key)) {
    if (v.S !== undefined) out[k] = { S: v.S }
    else if (v.N !== undefined) out[k] = { N: v.N }
    else if (v.B !== undefined) out[k] = { B: b64(v.B) }
    else throw new Error('Unsupported key attribute type in the page cursor')
  }
  return out
}

function safeToKey(key: SafeKey): AttrMap {
  const out: AttrMap = {}
  for (const [k, v] of Object.entries(key)) {
    if ('S' in v && typeof v.S === 'string') out[k] = { S: v.S }
    else if ('N' in v && typeof v.N === 'string') out[k] = { N: v.N }
    else if ('B' in v && typeof v.B === 'string') out[k] = { B: new Uint8Array(Buffer.from(v.B, 'base64')) }
    else throw new Error('Invalid page cursor')
  }
  return out
}

export const encodeCursor = (c: Cursor): string => JSON.stringify(c)

export function decodeCursor(s: string): Cursor {
  let c: unknown
  try {
    c = JSON.parse(s)
  } catch {
    throw new Error('Invalid page cursor')
  }
  const o = c as { k?: unknown; t?: unknown }
  if (o && typeof o === 'object' && typeof o.t === 'string') return { t: o.t }
  if (o && typeof o === 'object' && o.k && typeof o.k === 'object') {
    safeToKey(o.k as SafeKey) // validates
    return { k: o.k as SafeKey }
  }
  throw new Error('Invalid page cursor')
}

// ---------------------------------------------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------------------------------------------

/** "Test Connection": ListTables, plus (real AWS only) who the credentials belong to. */
export async function testConnection(ds: DataSource): Promise<string> {
  const cfg = configOf(ds)
  const bad = validateDynamoConfig(cfg, !!cfg.secretAccessKey)
  if (bad) throw new Error(bad)
  return guarded(ds, async () => {
    const credentials = credentialsFor(cfg)
    const client = new DynamoDBClient(clientConfig(cfg, credentials, 1))
    try {
      const r = await client.send(new ListTablesCommand({ Limit: 100 }))
      const n = r.TableNames?.length ?? 0
      const more = r.LastEvaluatedTableName ? '+' : ''
      let who = ''
      if (!cfg.endpoint) {
        const sts = new STSClient({ ...clientConfig(cfg, credentials, 1), endpoint: undefined, requestHandler: { connectionTimeout: 3000, requestTimeout: 4000 } })
        try {
          const id = await sts.send(new GetCallerIdentityCommand({}))
          if (id.Arn) who = ` as ${id.Arn}${id.Account ? ` (account ${id.Account})` : ''}`
        } catch {
          /* identity is a nicety (STS may be denied / unreachable) */
        } finally {
          sts.destroy()
        }
      }
      return `Connected${who}. ${n}${more} table${n === 1 && !more ? '' : 's'} visible.`
    } finally {
      client.destroy()
    }
  })
}

export async function listTables(ds: DataSource): Promise<string[]> {
  return guarded(ds, async () => {
    const names: string[] = []
    for await (const page of paginateListTables({ client: clientFor(ds) }, {})) names.push(...(page.TableNames ?? []))
    return names.sort(byName)
  })
}

function keysOfDescription(t: NonNullable<DescribeTableCommandOutput['Table']>, schema = t.KeySchema): DynamoKeyDef[] {
  const types = new Map((t.AttributeDefinitions ?? []).map((a) => [a.AttributeName ?? '', a.AttributeType ?? '']))
  return (schema ?? []).map((k) => ({
    name: k.AttributeName ?? '',
    keyType: k.KeyType === 'RANGE' ? 'RANGE' : 'HASH',
    attrType: types.get(k.AttributeName ?? '') ?? ''
  }))
}

/** Pure: the table description in the shape the Structure tab shows. */
export function mapDescribe(t: NonNullable<DescribeTableCommandOutput['Table']>, ttl: DynamoTableInfo['ttl'] = null): DynamoTableInfo {
  const indexes: DynamoIndexInfo[] = []
  for (const g of t.GlobalSecondaryIndexes ?? []) {
    indexes.push({
      name: g.IndexName ?? '',
      kind: 'GSI',
      status: g.IndexStatus,
      keys: keysOfDescription(t, g.KeySchema),
      projection: g.Projection?.ProjectionType ?? 'ALL',
      nonKeyAttributes: g.Projection?.NonKeyAttributes ?? [],
      itemCount: g.ItemCount,
      sizeBytes: g.IndexSizeBytes,
      rcu: g.ProvisionedThroughput?.ReadCapacityUnits,
      wcu: g.ProvisionedThroughput?.WriteCapacityUnits
    })
  }
  for (const l of t.LocalSecondaryIndexes ?? []) {
    indexes.push({
      name: l.IndexName ?? '',
      kind: 'LSI',
      keys: keysOfDescription(t, l.KeySchema),
      projection: l.Projection?.ProjectionType ?? 'ALL',
      nonKeyAttributes: l.Projection?.NonKeyAttributes ?? [],
      itemCount: l.ItemCount,
      sizeBytes: l.IndexSizeBytes
    })
  }
  const billing = t.BillingModeSummary?.BillingMode ?? 'PROVISIONED'
  const prov = t.ProvisionedThroughput
  return {
    name: t.TableName ?? '',
    arn: t.TableArn ?? '',
    status: t.TableStatus ?? '',
    billingMode: billing,
    ...(billing === 'PROVISIONED' && prov ? { rcu: prov.ReadCapacityUnits, wcu: prov.WriteCapacityUnits } : {}),
    itemCount: Number(t.ItemCount ?? 0),
    sizeBytes: Number(t.TableSizeBytes ?? 0),
    createdAt: t.CreationDateTime ? new Date(t.CreationDateTime).toISOString() : null,
    keySchema: keysOfDescription(t),
    attributes: (t.AttributeDefinitions ?? []).map((a) => ({ name: a.AttributeName ?? '', type: a.AttributeType ?? '' })),
    indexes,
    stream: {
      enabled: !!t.StreamSpecification?.StreamEnabled,
      ...(t.StreamSpecification?.StreamViewType ? { viewType: t.StreamSpecification.StreamViewType } : {}),
      ...(t.LatestStreamArn ? { arn: t.LatestStreamArn } : {})
    },
    ttl,
    ...(t.TableClassSummary?.TableClass ? { tableClass: t.TableClassSummary.TableClass } : {}),
    ...(t.DeletionProtectionEnabled !== undefined ? { deletionProtection: t.DeletionProtectionEnabled } : {})
  }
}

export async function describeTable(ds: DataSource, table: string): Promise<DynamoTableInfo> {
  return guarded(ds, async () => {
    const client = clientFor(ds)
    const [d, ttl] = await Promise.all([
      client.send(new DescribeTableCommand({ TableName: table })),
      client
        .send(new DescribeTimeToLiveCommand({ TableName: table }))
        .then((r) => ({
          status: r.TimeToLiveDescription?.TimeToLiveStatus ?? 'DISABLED',
          ...(r.TimeToLiveDescription?.AttributeName ? { attribute: r.TimeToLiveDescription.AttributeName } : {})
        }))
        .catch(() => null)
    ])
    if (!d.Table) throw new Error(`Table "${table}" not found`)
    keyCache.set(`${ds.id}|${table}`, { at: Date.now(), keys: keysOfDescription(d.Table) })
    return mapDescribe(d.Table, ttl)
  })
}

/** Key schema of a table for column ordering: cached for a few minutes, best effort ([] when it cannot be read). */
async function keysOf(ds: DataSource, client: DynamoDBClient, table: string): Promise<DynamoKeyDef[]> {
  const k = `${ds.id}|${table}`
  const hit = keyCache.get(k)
  if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.keys
  try {
    const d = await client.send(new DescribeTableCommand({ TableName: table }))
    const keys = d.Table ? keysOfDescription(d.Table) : []
    if (keys.length) keyCache.set(k, { at: Date.now(), keys })
    return keys
  } catch {
    return []
  }
}

/** Key schema of one secondary index (column ordering / key badges for an index view): cached like keysOf, [] when unknown. */
async function indexKeysOf(ds: DataSource, client: DynamoDBClient, table: string, index: string): Promise<DynamoKeyDef[]> {
  const k = `${ds.id}|${table}|${index}`
  const hit = keyCache.get(k)
  if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.keys
  try {
    const d = await client.send(new DescribeTableCommand({ TableName: table }))
    const keys = d.Table ? mapDescribe(d.Table).indexes.find((i) => i.name === index)?.keys ?? [] : []
    if (keys.length) keyCache.set(k, { at: Date.now(), keys })
    return keys
  } catch {
    return []
  }
}

export interface ItemsOpts {
  limit: number
  /** read through this secondary index (GSI / LSI) instead of the table itself */
  index?: string
  /** from the previous page's `next`; omitted = first page */
  cursor?: string | null
  /** PartiQL condition appended to `SELECT * FROM "table" WHERE ...` (key conditions use Query, others a filtered scan) */
  where?: string
}

/** Scan of a table (cursor = LastEvaluatedKey), or - with `where` - a PartiQL SELECT (cursor = NextToken). */
export async function fetchItems(ds: DataSource, table: string, opts: ItemsOpts): Promise<DynamoPage> {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 100, 10_000))
  const index = typeof opts.index === 'string' && opts.index.trim() ? opts.index : undefined
  if (index !== undefined && (index.length < 3 || index.length > 255)) throw new Error('Invalid index name (3 to 255 characters)')
  return guarded(ds, async () => {
    const client = clientFor(ds)
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null
    const keysP = index ? indexKeysOf(ds, client, table, index) : keysOf(ds, client, table)
    if (opts.where?.trim()) {
      const [r, keys] = await Promise.all([
        runStatement(client, selectAllPartiql(table, opts.where, index), { limit, nextToken: cur && 't' in cur ? cur.t : undefined }),
        keysP
      ])
      return buildPage(r.items, keys, r.nextToken ? encodeCursor({ t: r.nextToken }) : null)
    }
    const [r, keys] = await Promise.all([
      client.send(new ScanCommand({ TableName: table, Limit: limit, ...(index ? { IndexName: index } : {}), ...(cur && 'k' in cur ? { ExclusiveStartKey: safeToKey(cur.k) } : {}) })),
      keysP
    ])
    return buildPage(r.Items ?? [], keys, r.LastEvaluatedKey ? encodeCursor({ k: keyToSafe(r.LastEvaluatedKey) }) : null)
  })
}

async function runStatement(
  client: DynamoDBClient, statement: string, o: { params?: unknown[]; nextToken?: string; limit?: number }
): Promise<{ items: AttrMap[]; nextToken?: string }> {
  const r = await client.send(
    new ExecuteStatementCommand({
      Statement: statement,
      ...(o.params?.length ? { Parameters: o.params.map((p) => convertToAttr(p)) } : {}),
      ...(o.nextToken ? { NextToken: o.nextToken } : {}),
      ...(o.limit ? { Limit: o.limit } : {})
    })
  )
  return { items: r.Items ?? [], nextToken: r.NextToken }
}

/** The table a statement targets (`FROM "t"`, `UPDATE "t"`, `INSERT INTO "t"`), for column ordering. */
export function tableOfStatement(sql: string): string | null {
  const m = /\b(?:from|update|into)\s+("(?:[^"]|"")+"|[\w.-]+)/i.exec(sql)
  if (!m) return null
  const t = m[1]
  return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t
}

export interface StatementOpts {
  params?: unknown[]
  nextToken?: string
  /** page size for SELECT (default CONSOLE_PAGE) */
  limit?: number
}

/** Runs one PartiQL statement (ExecuteStatement only: reads and, as in a SQL console, real writes). */
export async function executePartiQL(ds: DataSource, statement: string, opts: StatementOpts = {}): Promise<DynamoStatementResult> {
  const stmt = statement.trim().replace(/;+$/, '')
  if (!stmt) throw new Error('Statement is empty')
  const command = (/^[A-Za-z]+/.exec(stmt)?.[0] ?? '').toUpperCase()
  return guarded(ds, async () => {
    const client = clientFor(ds)
    const t0 = Date.now()
    const table = tableOfStatement(stmt)
    const [r, keys] = await Promise.all([
      runStatement(client, stmt, {
        params: opts.params,
        nextToken: opts.nextToken,
        limit: command === 'SELECT' ? Math.max(1, Math.min(opts.limit ?? CONSOLE_PAGE, 10_000)) : undefined
      }),
      table && command === 'SELECT' ? keysOf(ds, client, table) : Promise.resolve([] as DynamoKeyDef[])
    ])
    return { ...buildPage(r.items, keys, r.nextToken ?? null), command, durationMs: Date.now() - t0 }
  })
}
