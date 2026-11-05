import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, DynamoConfig } from '../../src/shared'

// ---- fakes for the AWS SDK: clients record their config and every command they were sent ----
const h = vi.hoisted(() => {
  interface Rec { cfg: Record<string, unknown>; destroyed: boolean; sent: { name: string; input: Record<string, any> }[] }
  return {
    clients: [] as Rec[],
    sts: [] as Rec[],
    handler: (_name: string, _input: Record<string, any>, _cfg: Record<string, unknown>): any => ({}),
    stsHandler: (_name: string, _input: Record<string, any>): any => ({}),
    chainCalls: [] as unknown[][],
    chainResult: (() => Promise.resolve({ accessKeyId: 'chain-key', secretAccessKey: 'chain-secret' })) as () => Promise<unknown>
  }
})

vi.mock('@aws-sdk/client-dynamodb', () => {
  class Cmd {
    input: Record<string, any>
    constructor(input: Record<string, any>) { this.input = input }
  }
  class ListTablesCommand extends Cmd {}
  class DescribeTableCommand extends Cmd {}
  class DescribeTimeToLiveCommand extends Cmd {}
  class ScanCommand extends Cmd {}
  class ExecuteStatementCommand extends Cmd {}
  class DynamoDBClient {
    rec: (typeof h.clients)[number]
    constructor(cfg: Record<string, unknown>) {
      this.rec = { cfg, destroyed: false, sent: [] }
      h.clients.push(this.rec)
    }
    async send(cmd: Cmd): Promise<unknown> {
      this.rec.sent.push({ name: cmd.constructor.name, input: cmd.input })
      return h.handler(cmd.constructor.name, cmd.input, this.rec.cfg)
    }
    destroy(): void { this.rec.destroyed = true }
  }
  async function* paginateListTables(conf: { client: DynamoDBClient }, input: Record<string, unknown>) {
    let start: string | undefined
    do {
      const r = (await conf.client.send(new ListTablesCommand({ ...input, ...(start ? { ExclusiveStartTableName: start } : {}) }))) as {
        LastEvaluatedTableName?: string
      }
      yield r
      start = r.LastEvaluatedTableName
    } while (start)
  }
  return { DynamoDBClient, ListTablesCommand, DescribeTableCommand, DescribeTimeToLiveCommand, ScanCommand, ExecuteStatementCommand, paginateListTables }
})

vi.mock('@aws-sdk/client-sts', () => {
  class GetCallerIdentityCommand {
    input: Record<string, any>
    constructor(input: Record<string, any>) { this.input = input }
  }
  class STSClient {
    rec: (typeof h.sts)[number]
    constructor(cfg: Record<string, unknown>) {
      this.rec = { cfg, destroyed: false, sent: [] }
      h.sts.push(this.rec)
    }
    async send(cmd: GetCallerIdentityCommand): Promise<unknown> {
      this.rec.sent.push({ name: cmd.constructor.name, input: cmd.input })
      return h.stsHandler(cmd.constructor.name, cmd.input)
    }
    destroy(): void { this.rec.destroyed = true }
  }
  return { STSClient, GetCallerIdentityCommand }
})

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: (...args: unknown[]) => {
    h.chainCalls.push(args)
    return () => h.chainResult()
  }
}))

import {
  MAX_COLUMNS, attrToCell, attrToJson, attrTypeName, buildPage, cleanAwsError, clientFor, closeAll, credentialsFor,
  decodeCursor, describeTable, encodeCursor, executePartiQL, fetchItems, itemToJson, listTables, makeClient, mapDescribe,
  numberToJson, regionFor, tableOfStatement, testConnection
} from '../../src/main/dynamo'

const mkDs = (dynamo: Partial<DynamoConfig> = {}, id = 'd1'): DataSource => ({
  id, name: 'ddb', kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  dynamo: { region: 'eu-west-1', authMode: 'default', ...dynamo }
})
const keys = (over: Partial<DynamoConfig> = {}): DynamoConfig => ({
  region: 'us-west-2', authMode: 'keys', accessKeyId: ' AKIATEST ', secretAccessKey: 'shh', ...over
})

const TABLE = {
  TableName: 'orders', TableArn: 'arn:aws:dynamodb:eu-west-1:1:table/orders', TableStatus: 'ACTIVE',
  KeySchema: [{ AttributeName: 'sk', KeyType: 'RANGE' }, { AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'N' }, { AttributeName: 'gpk', AttributeType: 'S' }
  ],
  ItemCount: 12, TableSizeBytes: 2048, CreationDateTime: new Date('2024-01-02T03:04:05Z')
}

beforeEach(async () => {
  await closeAll()
  h.clients.length = 0
  h.sts.length = 0
  h.chainCalls.length = 0
  h.handler = () => ({})
  h.stsHandler = () => ({})
  h.chainResult = () => Promise.resolve({ accessKeyId: 'chain-key', secretAccessKey: 'chain-secret' })
})

const sentNames = (i = 0): string[] => h.clients[i].sent.map((s) => s.name)

describe('credentialsFor / regionFor', () => {
  it('access keys: static credentials, trimmed key id, session token only when set', () => {
    expect(credentialsFor(keys())).toEqual({ accessKeyId: 'AKIATEST', secretAccessKey: 'shh' })
    expect(credentialsFor(keys({ sessionToken: 'tok' }))).toEqual({ accessKeyId: 'AKIATEST', secretAccessKey: 'shh', sessionToken: 'tok' })
    expect(h.chainCalls).toEqual([])
  })

  it('default: the node provider chain with no options', async () => {
    const c = credentialsFor({ region: '', authMode: 'default' }) as () => Promise<unknown>
    expect(h.chainCalls).toEqual([[]])
    await expect(c()).resolves.toEqual({ accessKeyId: 'chain-key', secretAccessKey: 'chain-secret' })
  })

  it('profile: the chain scoped to the (trimmed) profile', () => {
    credentialsFor({ region: '', authMode: 'profile', profile: ' dev ' })
    expect(h.chainCalls).toEqual([[{ profile: 'dev' }]])
  })

  it('custom endpoint: dummy credentials only when the chain finds nothing', async () => {
    const c = credentialsFor({ region: '', authMode: 'default', endpoint: 'http://localhost:8000' }) as () => Promise<unknown>
    await expect(c()).resolves.toEqual({ accessKeyId: 'chain-key', secretAccessKey: 'chain-secret' })
    h.chainResult = () => Promise.reject(new Error('no creds'))
    await expect(c()).resolves.toEqual({ accessKeyId: 'local', secretAccessKey: 'local' })
  })

  it('no endpoint: a failing chain stays a failure', async () => {
    const c = credentialsFor({ region: '', authMode: 'default' }) as () => Promise<unknown>
    h.chainResult = () => Promise.reject(new Error('no creds'))
    await expect(c()).rejects.toThrow('no creds')
  })

  it('region: explicit wins; keys / endpoint fall back to us-east-1; otherwise left to the SDK', () => {
    expect(regionFor({ region: ' eu-north-1 ', authMode: 'default' })).toBe('eu-north-1')
    expect(regionFor({ region: '', authMode: 'keys' })).toBe('us-east-1')
    expect(regionFor({ region: '', authMode: 'default', endpoint: 'http://x:1' })).toBe('us-east-1')
    expect(regionFor({ region: '', authMode: 'default' })).toBeUndefined()
    expect(regionFor({ region: '', authMode: 'profile', profile: 'p' })).toBeUndefined()
  })
})

describe('makeClient / clientFor / closeAll', () => {
  it('passes region, endpoint, retries and timeouts; never a profile for the other modes', () => {
    makeClient(mkDs(keys({ endpoint: 'http://localhost:8000' })))
    const cfg = h.clients[0].cfg
    expect(cfg).toMatchObject({
      region: 'us-west-2', endpoint: 'http://localhost:8000', maxAttempts: 3,
      credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'shh' },
      requestHandler: { connectionTimeout: 6000, requestTimeout: 60000 }
    })
    expect('profile' in cfg).toBe(false)
  })

  it('omits region / endpoint when they are not set (the SDK resolves the region)', () => {
    makeClient(mkDs({ region: '' }))
    expect('region' in h.clients[0].cfg).toBe(false)
    expect('endpoint' in h.clients[0].cfg).toBe(false)
  })

  it('profile mode hands the profile to the SDK too (it reads the profile region)', () => {
    makeClient(mkDs({ region: '', authMode: 'profile', profile: 'dev' }), { maxAttempts: 1 })
    expect(h.clients[0].cfg).toMatchObject({ profile: 'dev', maxAttempts: 1 })
  })

  it('rejects a source without DynamoDB settings', () => {
    expect(() => makeClient({ ...mkDs(), dynamo: undefined })).toThrow('Not a DynamoDB data source')
  })

  it('caches one client per data source and rebuilds it (destroying the old one) when settings change', () => {
    const a = clientFor(mkDs())
    expect(clientFor(mkDs())).toBe(a)
    expect(h.clients).toHaveLength(1)
    const b = clientFor(mkDs({ region: 'us-east-2' }))
    expect(b).not.toBe(a)
    expect(h.clients[0].destroyed).toBe(true)
    // a different secret also counts as a change
    clientFor(mkDs(keys({ secretAccessKey: 'one' }), 'k'))
    clientFor(mkDs(keys({ secretAccessKey: 'two' }), 'k'))
    expect(h.clients.filter((c) => !c.destroyed)).toHaveLength(2)
  })

  it('closeAll(id) destroys one source, closeAll() all of them', async () => {
    clientFor(mkDs({}, 'a'))
    clientFor(mkDs({}, 'b'))
    await closeAll('a')
    expect(h.clients.map((c) => c.destroyed)).toEqual([true, false])
    await closeAll()
    expect(h.clients.map((c) => c.destroyed)).toEqual([true, true])
    clientFor(mkDs({}, 'a')) // a new client afterwards
    expect(h.clients).toHaveLength(3)
  })
})

describe('listTables', () => {
  it('follows LastEvaluatedTableName across pages and sorts case-insensitively', async () => {
    h.handler = (name, input) => {
      if (name !== 'ListTablesCommand') return {}
      return input.ExclusiveStartTableName === 'b'
        ? { TableNames: ['Zeta', 'alpha'] }
        : { TableNames: ['b', 'C'], LastEvaluatedTableName: 'b' }
    }
    await expect(listTables(mkDs())).resolves.toEqual(['alpha', 'b', 'C', 'Zeta'])
    expect(h.clients[0].sent).toHaveLength(2)
    expect(h.clients[0].sent[1].input.ExclusiveStartTableName).toBe('b')
  })

  it('handles an account without tables', async () => {
    h.handler = () => ({})
    await expect(listTables(mkDs())).resolves.toEqual([])
  })

  it('turns SDK errors into short messages', async () => {
    h.handler = () => { throw Object.assign(new Error('boom'), { name: 'CredentialsProviderError' }) }
    await expect(listTables(mkDs())).rejects.toThrow(/No credentials found/)
  })
})

describe('describeTable / mapDescribe', () => {
  it('maps keys, attributes, indexes, billing, streams and TTL', async () => {
    h.handler = (name) =>
      name === 'DescribeTableCommand'
        ? {
            Table: {
              ...TABLE,
              BillingModeSummary: { BillingMode: 'PROVISIONED' },
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
              GlobalSecondaryIndexes: [{
                IndexName: 'by-gpk', IndexStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'gpk', KeyType: 'HASH' }],
                Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a', 'b'] }, ItemCount: 3, IndexSizeBytes: 9,
                ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 }
              }],
              LocalSecondaryIndexes: [{
                IndexName: 'by-sk', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
                Projection: { ProjectionType: 'KEYS_ONLY' }
              }],
              StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
              LatestStreamArn: 'arn:stream', TableClassSummary: { TableClass: 'STANDARD' }, DeletionProtectionEnabled: true
            }
          }
        : { TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'expires' } }
    const info = await describeTable(mkDs(), 'orders')
    expect(info).toMatchObject({
      name: 'orders', status: 'ACTIVE', billingMode: 'PROVISIONED', rcu: 5, wcu: 2, itemCount: 12, sizeBytes: 2048,
      createdAt: '2024-01-02T03:04:05.000Z', arn: TABLE.TableArn, tableClass: 'STANDARD', deletionProtection: true,
      ttl: { status: 'ENABLED', attribute: 'expires' },
      stream: { enabled: true, viewType: 'NEW_IMAGE', arn: 'arn:stream' }
    })
    expect(info.keySchema).toEqual([
      { name: 'sk', keyType: 'RANGE', attrType: 'N' }, { name: 'pk', keyType: 'HASH', attrType: 'S' }
    ])
    expect(info.attributes).toEqual([{ name: 'pk', type: 'S' }, { name: 'sk', type: 'N' }, { name: 'gpk', type: 'S' }])
    expect(info.indexes).toEqual([
      {
        name: 'by-gpk', kind: 'GSI', status: 'ACTIVE', keys: [{ name: 'gpk', keyType: 'HASH', attrType: 'S' }],
        projection: 'INCLUDE', nonKeyAttributes: ['a', 'b'], itemCount: 3, sizeBytes: 9, rcu: 1, wcu: 1
      },
      {
        name: 'by-sk', kind: 'LSI', keys: [{ name: 'pk', keyType: 'HASH', attrType: 'S' }, { name: 'sk', keyType: 'RANGE', attrType: 'N' }],
        projection: 'KEYS_ONLY', nonKeyAttributes: [], itemCount: undefined, sizeBytes: undefined
      }
    ])
  })

  it('a failing TTL lookup does not fail the description', async () => {
    h.handler = (name) => {
      if (name === 'DescribeTimeToLiveCommand') throw new Error('AccessDenied')
      return { Table: TABLE }
    }
    const info = await describeTable(mkDs(), 'orders')
    expect(info.ttl).toBeNull()
    expect(info.billingMode).toBe('PROVISIONED')
  })

  it('TTL without an attribute name (disabled)', async () => {
    h.handler = (name) => (name === 'DescribeTableCommand' ? { Table: TABLE } : { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } })
    expect((await describeTable(mkDs(), 'orders')).ttl).toEqual({ status: 'DISABLED' })
    h.handler = (name) => (name === 'DescribeTableCommand' ? { Table: TABLE } : {})
    expect((await describeTable(mkDs(), 'orders')).ttl).toEqual({ status: 'DISABLED' })
  })

  it('on-demand tables carry no capacity numbers', () => {
    const info = mapDescribe({ ...TABLE, BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' }, ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 } } as never)
    expect(info.billingMode).toBe('PAY_PER_REQUEST')
    expect('rcu' in info).toBe(false)
    expect(info.stream).toEqual({ enabled: false })
    expect(info.indexes).toEqual([])
  })

  it('mapDescribe tolerates a nearly empty description', () => {
    expect(mapDescribe({})).toMatchObject({ name: '', arn: '', status: '', itemCount: 0, sizeBytes: 0, createdAt: null, keySchema: [], attributes: [] })
  })

  it('a response without a table is an error', async () => {
    h.handler = () => ({})
    await expect(describeTable(mkDs(), 'ghost')).rejects.toThrow('Table "ghost" not found')
  })

  it('missing tables surface as a clean message', async () => {
    h.handler = () => { throw Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException' }) }
    await expect(describeTable(mkDs(), 'ghost')).rejects.toThrow('Not found: Requested resource not found')
  })
})

describe('fetchItems (secondary index)', () => {
  const TBL = {
    ...TABLE,
    GlobalSecondaryIndexes: [{ IndexName: 'by-gpk', KeySchema: [{ AttributeName: 'gpk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }]
  }
  const items = [{ pk: { S: 'a' }, sk: { N: '1' }, gpk: { S: 'g' }, zz: { S: 'z' } }]

  it('scans the index (IndexName) and orders columns by the index keys', async () => {
    h.handler = (name) => (name === 'DescribeTableCommand' ? { Table: TBL } : name === 'ScanCommand' ? { Items: items } : {})
    const page = await fetchItems(mkDs(), 'orders', { limit: 10, index: 'by-gpk' })
    expect(h.clients[0].sent.find((s) => s.name === 'ScanCommand')!.input).toEqual({ TableName: 'orders', Limit: 10, IndexName: 'by-gpk' })
    expect(page.columns.map((c) => [c.name, c.key])).toEqual([['gpk', 'HASH'], ['sk', 'RANGE'], ['pk', undefined], ['zz', undefined]])
  })

  it('with a condition it runs PartiQL against "table"."index" and pages with NextToken', async () => {
    h.handler = (name) => (name === 'DescribeTableCommand' ? { Table: TBL } : name === 'ExecuteStatementCommand' ? { Items: items, NextToken: 'n1' } : {})
    const p = await fetchItems(mkDs(), 'orders', { limit: 10, index: 'by-gpk', where: "gpk = 'g'" })
    const exec = h.clients[0].sent.find((s) => s.name === 'ExecuteStatementCommand')!
    expect(exec.input.Statement).toBe(`SELECT * FROM "orders"."by-gpk" WHERE gpk = 'g'`)
    expect(p.next).toBe(JSON.stringify({ t: 'n1' }))
  })

  it('the table itself is unchanged when no index is given (blank counts as none)', async () => {
    h.handler = (name) => (name === 'DescribeTableCommand' ? { Table: TBL } : name === 'ScanCommand' ? { Items: items } : {})
    await fetchItems(mkDs(), 'orders', { limit: 10, index: '  ' })
    expect(h.clients[0].sent.find((s) => s.name === 'ScanCommand')!.input).toEqual({ TableName: 'orders', Limit: 10 })
  })

  it('an unknown index still scans (AWS reports the error); an invalid name is rejected up front', async () => {
    h.handler = (name) => (name === 'DescribeTableCommand' ? { Table: TBL } : name === 'ScanCommand' ? { Items: items } : {})
    const p = await fetchItems(mkDs(), 'orders', { limit: 10, index: 'ghost-index' })
    expect(p.columns.every((c) => !c.key)).toBe(true)
    await expect(fetchItems(mkDs(), 'orders', { limit: 10, index: 'ab' })).rejects.toThrow('Invalid index name')
    await expect(fetchItems(mkDs(), 'orders', { limit: 10, index: 'x'.repeat(256) })).rejects.toThrow('Invalid index name')
  })
})

describe('fetchItems (Scan paging)', () => {
  const itemsA = [
    { zeta: { S: 'z' }, sk: { N: '1' }, pk: { S: 'a' }, alpha: { BOOL: true } },
    { pk: { S: 'b' }, sk: { N: '2' } }
  ]
  const scanHandler = (extra: Record<string, unknown> = {}) => (name: string) => {
    if (name === 'DescribeTableCommand') return { Table: TABLE }
    if (name === 'ScanCommand') return { Items: itemsA, ...extra }
    return {}
  }

  it('first page: no start key, columns ordered partition key, sort key, then alphabetical', async () => {
    h.handler = scanHandler()
    const page = await fetchItems(mkDs(), 'orders', { limit: 25 })
    const scan = h.clients[0].sent.find((s) => s.name === 'ScanCommand')!
    expect(scan.input).toEqual({ TableName: 'orders', Limit: 25 })
    expect(page.columns.map((c) => c.name)).toEqual(['pk', 'sk', 'alpha', 'zeta'])
    expect(page.columns[0]).toEqual({ name: 'pk', types: ['S'], key: 'HASH' })
    expect(page.columns[1]).toMatchObject({ name: 'sk', key: 'RANGE', types: ['N'] })
    expect(page.rows).toEqual([['a', '1', 'true', 'z'], ['b', '2', null, null]])
    expect(page.next).toBeNull()
    expect(page.columnsCapped).toBe(false)
    expect(page.items[0]).toEqual({ pk: 'a', sk: 1, alpha: true, zeta: 'z' })
  })

  it('returns a cursor from LastEvaluatedKey and sends it back as ExclusiveStartKey (stack of cursors)', async () => {
    h.handler = scanHandler({ LastEvaluatedKey: { pk: { S: 'b' }, sk: { N: '2' } } })
    const p1 = await fetchItems(mkDs(), 'orders', { limit: 2 })
    expect(p1.next).toBe(JSON.stringify({ k: { pk: { S: 'b' }, sk: { N: '2' } } }))
    h.handler = scanHandler()
    const p2 = await fetchItems(mkDs(), 'orders', { limit: 2, cursor: p1.next })
    expect(h.clients[0].sent.filter((s) => s.name === 'ScanCommand')[1].input.ExclusiveStartKey).toEqual({ pk: { S: 'b' }, sk: { N: '2' } })
    expect(p2.next).toBeNull()
  })

  it('binary keys survive the cursor as base64', async () => {
    h.handler = scanHandler({ LastEvaluatedKey: { pk: { B: new Uint8Array([1, 2, 3]) } } })
    const p = await fetchItems(mkDs(), 'orders', { limit: 1 })
    expect(JSON.parse(p.next!)).toEqual({ k: { pk: { B: 'AQID' } } })
    h.handler = scanHandler()
    await fetchItems(mkDs(), 'orders', { limit: 1, cursor: p.next })
    const start = h.clients[0].sent.filter((s) => s.name === 'ScanCommand')[1].input.ExclusiveStartKey
    expect(Array.from(start.pk.B as Uint8Array)).toEqual([1, 2, 3])
  })

  it('refuses a key of an unsupported type', async () => {
    h.handler = scanHandler({ LastEvaluatedKey: { pk: { BOOL: true } } })
    await expect(fetchItems(mkDs(), 'orders', { limit: 1 })).rejects.toThrow('Unsupported key attribute type')
  })

  it('clamps the page size', async () => {
    h.handler = scanHandler()
    await fetchItems(mkDs(), 'orders', { limit: 0 })
    await fetchItems(mkDs(), 'orders', { limit: 999_999 })
    await fetchItems(mkDs(), 'orders', { limit: 7.9 })
    const limits = h.clients[0].sent.filter((s) => s.name === 'ScanCommand').map((s) => s.input.Limit)
    expect(limits).toEqual([100, 10000, 7])
  })

  it('rejects garbage cursors before touching AWS', async () => {
    h.handler = scanHandler()
    for (const bad of ['nope', '{}', '[]', '{"k":{"a":{"BOOL":true}}}', '{"k":{"a":{"S":1}}}', '{"k":5}']) {
      await expect(fetchItems(mkDs(), 'orders', { limit: 5, cursor: bad })).rejects.toThrow('Invalid page cursor')
    }
    expect(h.clients.flatMap((c) => c.sent).filter((s) => s.name === 'ScanCommand')).toHaveLength(0)
  })

  it('reads the key schema once (cached) and still orders columns when DescribeTable fails', async () => {
    h.handler = scanHandler()
    await fetchItems(mkDs(), 'orders', { limit: 5 })
    await fetchItems(mkDs(), 'orders', { limit: 5 })
    expect(h.clients[0].sent.filter((s) => s.name === 'DescribeTableCommand')).toHaveLength(1)

    await closeAll()
    h.handler = (name) => {
      if (name === 'DescribeTableCommand') throw new Error('denied')
      return { Items: itemsA }
    }
    const page = await fetchItems(mkDs({}, 'other'), 'orders', { limit: 5 })
    expect(page.columns.map((c) => c.name)).toEqual(['alpha', 'pk', 'sk', 'zeta'])
    expect(page.columns.every((c) => !c.key)).toBe(true)
  })

  it('an empty table keeps the key columns', async () => {
    h.handler = (name) => (name === 'DescribeTableCommand' ? { Table: TABLE } : {})
    const page = await fetchItems(mkDs(), 'orders', { limit: 5 })
    expect(page.columns.map((c) => c.name)).toEqual(['pk', 'sk'])
    expect(page.rows).toEqual([])
    expect(page.items).toEqual([])
  })
})

describe('fetchItems (WHERE through PartiQL)', () => {
  it('runs SELECT * FROM "table" WHERE ... with Limit and carries the NextToken in the cursor', async () => {
    h.handler = (name) => (name === 'ExecuteStatementCommand' ? { Items: [{ pk: { S: 'a' } }], NextToken: 'tok1' } : { Table: TABLE })
    const p1 = await fetchItems(mkDs(), 'orders', { limit: 50, where: " pk = 'a' " })
    const exec = h.clients[0].sent.find((s) => s.name === 'ExecuteStatementCommand')!
    expect(exec.input).toEqual({ Statement: `SELECT * FROM "orders" WHERE pk = 'a'`, Limit: 50 })
    expect(p1.next).toBe('{"t":"tok1"}')
    h.handler = (name) => (name === 'ExecuteStatementCommand' ? { Items: [] } : { Table: TABLE })
    const p2 = await fetchItems(mkDs(), 'orders', { limit: 50, where: "pk = 'a'", cursor: p1.next })
    const exec2 = h.clients[0].sent.filter((s) => s.name === 'ExecuteStatementCommand')[1]
    expect(exec2.input.NextToken).toBe('tok1')
    expect(p2.next).toBeNull()
  })

  it('quotes table names, doubling embedded double quotes', async () => {
    h.handler = (name) => (name === 'ExecuteStatementCommand' ? { Items: [] } : { Table: TABLE })
    await fetchItems(mkDs(), 'we"ird', { limit: 10, where: 'x = 1' })
    expect(h.clients[0].sent.find((s) => s.name === 'ExecuteStatementCommand')!.input.Statement).toBe('SELECT * FROM "we""ird" WHERE x = 1')
  })

  it('a blank WHERE is a plain scan', async () => {
    h.handler = (name) => (name === 'ScanCommand' ? { Items: [] } : { Table: TABLE })
    await fetchItems(mkDs(), 'orders', { limit: 10, where: '   ' })
    expect(sentNames()).toContain('ScanCommand')
    expect(sentNames()).not.toContain('ExecuteStatementCommand')
  })

  it('PartiQL errors are cleaned', async () => {
    h.handler = (name) => {
      if (name === 'ExecuteStatementCommand') throw Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' })
      return { Table: TABLE }
    }
    await expect(fetchItems(mkDs(), 'orders', { limit: 10, where: 'a = 1' })).rejects.toThrow(/throttled/)
  })
})

describe('executePartiQL', () => {
  it('SELECT: default page of 100, command name, raw NextToken, key ordered columns', async () => {
    h.handler = (name) => (name === 'ExecuteStatementCommand' ? { Items: [{ b: { S: '1' }, pk: { S: 'a' } }], NextToken: 'n1' } : { Table: TABLE })
    const r = await executePartiQL(mkDs(), ' select * from "orders"; ')
    expect(h.clients[0].sent.find((s) => s.name === 'ExecuteStatementCommand')!.input).toEqual({ Statement: 'select * from "orders"', Limit: 100 })
    expect(r.command).toBe('SELECT')
    expect(r.next).toBe('n1')
    expect(r.columns.map((c) => c.name)).toEqual(['pk', 'sk', 'b'])
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('SELECT: explicit limit is clamped, NextToken passed through', async () => {
    h.handler = (name) => (name === 'ExecuteStatementCommand' ? { Items: [] } : { Table: TABLE })
    await executePartiQL(mkDs(), 'SELECT * FROM t', { limit: 5, nextToken: 'abc' })
    await executePartiQL(mkDs(), 'SELECT * FROM t', { limit: 99999999 })
    const execs = h.clients[0].sent.filter((s) => s.name === 'ExecuteStatementCommand')
    expect(execs[0].input).toEqual({ Statement: 'SELECT * FROM t', Limit: 5, NextToken: 'abc' })
    expect(execs[1].input.Limit).toBe(10000)
  })

  it('writes carry no Limit and do not look up keys; parameters are marshalled', async () => {
    h.handler = (name) => (name === 'ExecuteStatementCommand' ? { Items: [] } : { Table: TABLE })
    const r = await executePartiQL(mkDs(), `INSERT INTO "t" VALUE {'pk': ?, 'n': ?, 'ok': ?}`, { params: ['a', 3, true] })
    expect(r.command).toBe('INSERT')
    expect(sentNames()).toEqual(['ExecuteStatementCommand'])
    expect(h.clients[0].sent[0].input).toEqual({
      Statement: `INSERT INTO "t" VALUE {'pk': ?, 'n': ?, 'ok': ?}`,
      Parameters: [{ S: 'a' }, { N: '3' }, { BOOL: true }]
    })
  })

  it('rejects an empty statement', async () => {
    await expect(executePartiQL(mkDs(), '  ;  ')).rejects.toThrow('Statement is empty')
    expect(h.clients).toHaveLength(0)
  })

  it('only ever uses ExecuteStatement for PartiQL', async () => {
    h.handler = (name) => (name === 'ExecuteStatementCommand' ? { Items: [] } : { Table: TABLE })
    await executePartiQL(mkDs(), 'DELETE FROM "t" WHERE pk = 1')
    expect(sentNames().every((n) => n === 'ExecuteStatementCommand' || n === 'DescribeTableCommand')).toBe(true)
  })

  it('tableOfStatement finds the target table', () => {
    expect(tableOfStatement('SELECT * FROM "my""t" WHERE a=1')).toBe('my"t')
    expect(tableOfStatement('select * from orders')).toBe('orders')
    expect(tableOfStatement('UPDATE "a-b" SET x=1')).toBe('a-b')
    expect(tableOfStatement('INSERT INTO t VALUE {}')).toBe('t')
    expect(tableOfStatement('SELECT 1')).toBeNull()
  })
})

describe('testConnection', () => {
  it('ListTables plus the caller identity on real AWS', async () => {
    h.handler = () => ({ TableNames: ['a', 'b'] })
    h.stsHandler = () => ({ Arn: 'arn:aws:iam::123:user/me', Account: '123' })
    await expect(testConnection(mkDs())).resolves.toBe('Connected as arn:aws:iam::123:user/me (account 123). 2 tables visible.')
    expect(h.clients[0].sent[0]).toEqual({ name: 'ListTablesCommand', input: { Limit: 100 } })
    expect(h.clients[0].cfg.maxAttempts).toBe(1)
    expect(h.clients[0].destroyed).toBe(true)
    expect(h.sts[0].destroyed).toBe(true)
    expect('endpoint' in h.sts[0].cfg && h.sts[0].cfg.endpoint).toBeFalsy()
  })

  it('wording for one table, none, and more than a page', async () => {
    h.handler = () => ({ TableNames: ['a'] })
    expect(await testConnection(mkDs({ endpoint: 'http://localhost:8000' }))).toBe('Connected. 1 table visible.')
    h.handler = () => ({ TableNames: [] })
    expect(await testConnection(mkDs({ endpoint: 'http://localhost:8000' }))).toBe('Connected. 0 tables visible.')
    h.handler = () => ({ TableNames: ['a'], LastEvaluatedTableName: 'a' })
    expect(await testConnection(mkDs({ endpoint: 'http://localhost:8000' }))).toBe('Connected. 1+ tables visible.')
  })

  it('a custom endpoint skips STS entirely', async () => {
    h.handler = () => ({ TableNames: [] })
    await testConnection(mkDs({ endpoint: 'http://localhost:8000' }))
    expect(h.sts).toHaveLength(0)
  })

  it('an STS failure does not fail the test', async () => {
    h.handler = () => ({ TableNames: ['a'] })
    h.stsHandler = () => { throw new Error('AccessDenied') }
    await expect(testConnection(mkDs())).resolves.toBe('Connected. 1 table visible.')
    expect(h.sts[0].destroyed).toBe(true)
  })

  it('validates the settings first', async () => {
    await expect(testConnection(mkDs({ region: 'Not A Region!' }))).rejects.toThrow(/Invalid region/)
    await expect(testConnection(mkDs({ authMode: 'keys', accessKeyId: '', secretAccessKey: 'x' }))).rejects.toThrow('Access key ID is required')
    await expect(testConnection(mkDs({ authMode: 'profile', profile: '../x' }))).rejects.toThrow(/Invalid profile/)
    expect(h.clients).toHaveLength(0)
  })

  it('an unreachable endpoint is reported cleanly and the client is destroyed', async () => {
    h.handler = () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) }
    await expect(testConnection(mkDs({ endpoint: 'http://127.0.0.1:1' }))).rejects.toThrow(
      'Could not reach http://127.0.0.1:1 (ECONNREFUSED)'
    )
    expect(h.clients[0].destroyed).toBe(true)
  })

  it('never puts the secret into an error message', async () => {
    h.handler = () => { throw Object.assign(new Error('nope'), { name: 'UnrecognizedClientException' }) }
    const err = await testConnection(mkDs(keys())).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/access key ID or secret access key is invalid/)
    expect((err as Error).message).not.toContain('shh')
  })
})

describe('cleanAwsError', () => {
  const cases: [string, unknown, string | RegExp][] = [
    ['credentials provider', { name: 'CredentialsProviderError', message: 'x' }, /No credentials found/],
    ['could not load credentials', new Error('Could not load credentials from any providers'), /No credentials found/],
    ['missing region', new Error('Region is missing'), /No AWS region configured/],
    ['expired token (name)', { name: 'ExpiredTokenException', message: 'x' }, /have expired/],
    ['expired sso', new Error('The SSO session associated with this profile has expired'), /have expired/],
    ['invalid client token', { name: 'UnrecognizedClientException', message: 'x' }, /access key ID or secret access key is invalid/],
    ['signature', { name: 'InvalidSignatureException', message: 'x' }, /invalid/],
    ['security token message', new Error('The security token included in the request is invalid.'), /invalid/],
    ['access denied', { name: 'AccessDeniedException', message: 'User is not authorized to perform: dynamodb:ListTables' }, /Access denied: User is not authorized.*permission/],
    ['not found', { name: 'ResourceNotFoundException', message: 'Cannot do operations on a non-existent table' }, 'Not found: Cannot do operations on a non-existent table'],
    ['throttling', { name: 'ThrottlingException', message: 'x' }, /throttled/],
    ['request limit', { name: 'RequestLimitExceeded', message: 'x' }, /throttled/],
    ['refused (code)', { name: 'Error', message: 'x', code: 'ECONNREFUSED' }, /Could not reach DynamoDB \(ECONNREFUSED\)/],
    ['refused (cause)', { name: 'TypeError', message: 'fetch failed', cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND dynamodb.x' } }, /ENOTFOUND/],
    ['refused (message)', new Error('connect ETIMEDOUT 1.2.3.4:443'), /ETIMEDOUT/],
    ['timeout', { name: 'TimeoutError', message: 'Connection timed out' }, /\(timeout\)/],
    ['named error', { name: 'ValidationException', message: 'Invalid FilterExpression' }, 'ValidationException: Invalid FilterExpression'],
    ['name already in message', { name: 'ValidationException', message: 'ValidationException: bad' }, 'ValidationException: bad'],
    ['plain error', new Error('plain'), 'plain'],
    ['string', 'just text', 'just text'],
    ['nothing', undefined, 'undefined']
  ]
  it.each(cases)('%s', (_n, err, want) => {
    const got = cleanAwsError(err)
    if (typeof want === 'string') expect(got).toBe(want)
    else expect(got).toMatch(want)
  })

  it('names the region or the endpoint that could not be reached', () => {
    const e = { name: 'Error', message: 'x', code: 'ECONNREFUSED' }
    expect(cleanAwsError(e, { region: 'eu-west-1' })).toContain('DynamoDB in eu-west-1')
    expect(cleanAwsError(e, { endpoint: 'http://localhost:8000', region: 'eu-west-1' })).toContain('http://localhost:8000')
  })

  it('empty messages fall back to the name', () => {
    expect(cleanAwsError({ name: 'Weird', message: '' })).toBe('Weird')
    expect(cleanAwsError({ message: '' })).toBe('Unknown AWS error')
  })
})

describe('value conversion', () => {
  it.each([
    ['0', 0], ['1', 1], ['-5', -5], ['3.14', 3.14], ['1000000', 1000000], ['9007199254740991', 9007199254740991],
    ['9007199254740993', '9007199254740993'], ['0.10', '0.10'], ['1E+2', '1E+2'], ['123456789012345678901234567890', '123456789012345678901234567890'],
    ['1e400', '1e400'], ['-0', '-0'], ['abc', 'abc'], ['', '']
  ])('numberToJson(%s)', (s, want) => {
    expect(numberToJson(s)).toBe(want)
  })

  it('attrTypeName covers every type', () => {
    expect(attrTypeName({ S: 'a' })).toBe('S')
    expect(attrTypeName({ S: '' })).toBe('S')
    expect(attrTypeName({ N: '1' })).toBe('N')
    expect(attrTypeName({ B: new Uint8Array() })).toBe('B')
    expect(attrTypeName({ BOOL: false })).toBe('BOOL')
    expect(attrTypeName({ NULL: true })).toBe('NULL')
    expect(attrTypeName({ SS: ['a'] })).toBe('SS')
    expect(attrTypeName({ NS: ['1'] })).toBe('NS')
    expect(attrTypeName({ BS: [new Uint8Array()] })).toBe('BS')
    expect(attrTypeName({ M: {} })).toBe('M')
    expect(attrTypeName({ L: [] })).toBe('L')
    expect(attrTypeName(undefined)).toBe('NULL')
    expect(attrTypeName({} as never)).toBe('NULL')
  })

  it('attrToJson: scalars, sets, binary, nesting', () => {
    expect(attrToJson({ S: 'x' })).toBe('x')
    expect(attrToJson({ N: '12' })).toBe(12)
    expect(attrToJson({ N: '12345678901234567890' })).toBe('12345678901234567890')
    expect(attrToJson({ B: new Uint8Array([104, 105]) })).toBe('aGk=')
    expect(attrToJson({ BOOL: false })).toBe(false)
    expect(attrToJson({ NULL: true })).toBeNull()
    expect(attrToJson({ SS: ['b', 'a'] })).toEqual(['b', 'a'])
    expect(attrToJson({ NS: ['1', '2.5', '99999999999999999999'] })).toEqual([1, 2.5, '99999999999999999999'])
    expect(attrToJson({ BS: [new Uint8Array([1]), new Uint8Array([2, 3])] })).toEqual(['AQ==', 'AgM='])
    expect(attrToJson({ M: {} })).toEqual({})
    expect(attrToJson({ L: [] })).toEqual([])
    expect(attrToJson(undefined)).toBeNull()
    expect(
      attrToJson({ M: { a: { L: [{ N: '1' }, { M: { b: { SS: ['x'] } } }, { NULL: true }, { S: '' }] }, c: { B: new Uint8Array([0]) } } })
    ).toEqual({ a: [1, { b: ['x'] }, null, ''], c: 'AA==' })
  })

  it('itemToJson keeps empty strings and empty collections', () => {
    expect(itemToJson({ e: { S: '' }, l: { L: [] }, m: { M: {} } })).toEqual({ e: '', l: [], m: {} })
    expect(itemToJson({})).toEqual({})
  })

  it('attrToCell: text for scalars, summaries for binary and sets, JSON for nested', () => {
    expect(attrToCell({ S: 'hi' })).toBe('hi')
    expect(attrToCell({ S: '' })).toBe('')
    expect(attrToCell({ N: '1.50' })).toBe('1.50')
    expect(attrToCell({ B: new Uint8Array(3) })).toBe('Binary(3 bytes)')
    expect(attrToCell({ BOOL: true })).toBe('true')
    expect(attrToCell({ NULL: true })).toBeNull()
    expect(attrToCell(undefined)).toBeNull()
    expect(attrToCell({ SS: ['a', 'b'] })).toBe('SS ["a","b"]')
    expect(attrToCell({ NS: ['1', '2'] })).toBe('NS [1,2]')
    expect(attrToCell({ BS: [new Uint8Array(2)] })).toBe('BS ["Binary(2 bytes)"]')
    expect(attrToCell({ M: { a: { N: '1' }, b: { L: [{ S: 'x' }] } } })).toBe('{"a":1,"b":["x"]}')
    expect(attrToCell({ L: [{ S: 'a' }, { NULL: true }] })).toBe('["a",null]')
  })
})

describe('buildPage', () => {
  it('orders: partition key, sort key (whatever order the schema lists them), then the rest case-insensitively', () => {
    const page = buildPage(
      [{ b: { S: '1' }, B: { S: '2' }, a: { S: '3' }, sk: { S: 's' }, pk: { S: 'p' } }],
      [{ name: 'sk', keyType: 'RANGE' }, { name: 'pk', keyType: 'HASH' }]
    )
    expect(page.columns.map((c) => c.name)).toEqual(['pk', 'sk', 'a', 'B', 'b'])
    expect(page.columns.map((c) => c.key)).toEqual(['HASH', 'RANGE', undefined, undefined, undefined])
  })

  it('works without key information and with items of different shapes', () => {
    const page = buildPage([{ x: { N: '1' } }, { x: { S: 'a' }, y: { NULL: true } }])
    expect(page.columns).toEqual([{ name: 'x', types: ['N', 'S'] }, { name: 'y', types: ['NULL'] }])
    expect(page.rows).toEqual([['1', null], ['a', null]])
  })

  it('caps the columns at 200 and says so; the item JSON keeps everything', () => {
    const item: Record<string, { N: string }> = {}
    for (let i = 0; i < MAX_COLUMNS + 20; i++) item['a' + String(i).padStart(4, '0')] = { N: String(i) }
    const page = buildPage([item])
    expect(page.columns).toHaveLength(MAX_COLUMNS)
    expect(page.rows[0]).toHaveLength(MAX_COLUMNS)
    expect(page.columnsCapped).toBe(true)
    expect(Object.keys(page.items[0])).toHaveLength(MAX_COLUMNS + 20)
  })

  it('exactly 200 attributes is not capped', () => {
    const item: Record<string, { N: string }> = {}
    for (let i = 0; i < MAX_COLUMNS; i++) item['a' + i] = { N: '1' }
    expect(buildPage([item]).columnsCapped).toBe(false)
  })

  it('carries the cursor and handles zero items', () => {
    const p = buildPage([], [], 'next')
    expect(p).toEqual({ items: [], columns: [], rows: [], next: 'next', columnsCapped: false })
  })
})

describe('cursors', () => {
  it('round trips a key and a PartiQL token', () => {
    const k = encodeCursor({ k: { pk: { S: 'a' }, n: { N: '1' } } })
    expect(decodeCursor(k)).toEqual({ k: { pk: { S: 'a' }, n: { N: '1' } } })
    expect(decodeCursor(encodeCursor({ t: 'abc' }))).toEqual({ t: 'abc' })
  })

  it('rejects anything else', () => {
    for (const bad of ['', 'x', 'null', '1', '{"t":1}', '{"k":{"a":{"M":{}}}}']) expect(() => decodeCursor(bad)).toThrow('Invalid page cursor')
  })
})
