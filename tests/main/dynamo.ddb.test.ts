/**
 * Integration tests against DynamoDB Local (or LocalStack). Skipped unless both RUN_DDB_TESTS=1 and DDB_ENDPOINT are set, e.g.
 *   RUN_DDB_TESTS=1 DDB_ENDPOINT=http://127.0.0.1:8000 npx vitest run tests/main/dynamo.ddb.test.ts
 * It uses obviously fake static keys (never real AWS credentials) and creates / deletes its own uniquely named table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'crypto'
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb'
import type { DataSource } from '../../src/shared'
import { closeAll, describeTable, executePartiQL, fetchItems, listTables, testConnection } from '../../src/main/dynamo'

const endpoint = process.env.DDB_ENDPOINT ?? ''
const on = !!(process.env.RUN_DDB_TESTS && endpoint)
const TABLE = `dgl_ddb_${randomBytes(4).toString('hex')}`
const ds: DataSource = {
  id: 'ddb-int', name: 'ddb', kind: 'dynamodb', host: '', port: 0, user: '', password: '', database: '', ssl: false,
  dynamo: { region: 'us-east-1', authMode: 'keys', accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake-secret-local-only', endpoint }
}
const admin = on
  ? new DynamoDBClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: ds.dynamo!.accessKeyId!, secretAccessKey: 'fake-secret-local-only' } })
  : null

describe.skipIf(!on)('DynamoDB Local integration', () => {
  beforeAll(async () => {
    await admin!.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'N' }]
      })
    )
    await waitUntilTableExists({ client: admin!, maxWaitTime: 30 }, { TableName: TABLE })
    for (let i = 1; i <= 7; i++) {
      await executePartiQL(ds, `INSERT INTO "${TABLE}" VALUE {'pk': 'u${i % 2}', 'sk': ${i}, 'name': 'n${i}', 'tags': <<'a','b'>>}`)
    }
  }, 60_000)

  afterAll(async () => {
    await closeAll(ds.id)
    if (admin) {
      await admin.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined)
      admin.destroy()
    }
  })

  it('Test Connection and ListTables see the table', async () => {
    expect(await testConnection(ds)).toBeTruthy()
    expect(await listTables(ds)).toContain(TABLE)
  })

  it('describes the key schema', async () => {
    const info = await describeTable(ds, TABLE)
    expect(info.keySchema.map((k) => [k.name, k.keyType])).toEqual([['pk', 'HASH'], ['sk', 'RANGE']])
  })

  it('Scan pages with an opaque cursor until every item was seen once', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await fetchItems(ds, TABLE, { limit: 3, cursor })
      expect(page.columns.slice(0, 2).map((c) => c.name)).toEqual(['pk', 'sk'])
      seen.push(...page.items.map((i) => `${i.pk}/${i.sk}`))
      cursor = page.next
      pages++
    } while (cursor)
    expect(pages).toBeGreaterThanOrEqual(3)
    expect(new Set(seen).size).toBe(7)
  })

  it('a PartiQL WHERE filters, and pages through NextToken', async () => {
    const page = await fetchItems(ds, TABLE, { limit: 100, where: `"pk" = 'u1'` })
    expect(page.items.map((i) => i.sk).sort()).toEqual([1, 3, 5, 7])
  })

  it('console statements: SELECT, UPDATE and DELETE', async () => {
    const sel = await executePartiQL(ds, `SELECT * FROM "${TABLE}" WHERE "pk" = 'u0'`)
    expect(sel.command).toBe('SELECT')
    expect(sel.items).toHaveLength(3)
    await executePartiQL(ds, `UPDATE "${TABLE}" SET name = 'changed' WHERE "pk" = 'u0' AND "sk" = 2`)
    const one = await executePartiQL(ds, `SELECT name FROM "${TABLE}" WHERE "pk" = 'u0' AND "sk" = 2`)
    expect(one.items[0].name).toBe('changed')
    await executePartiQL(ds, `DELETE FROM "${TABLE}" WHERE "pk" = 'u0' AND "sk" = 2`)
    expect((await executePartiQL(ds, `SELECT * FROM "${TABLE}" WHERE "pk" = 'u0'`)).items).toHaveLength(2)
  })

  it('an invalid statement is reported as a short error', async () => {
    await expect(executePartiQL(ds, 'SELEC nonsense')).rejects.toThrow(/./)
  })
})
