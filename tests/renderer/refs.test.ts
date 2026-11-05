import { describe, expect, it } from 'vitest'
import { isDynamoRef, partiqlName, partiqlSelectAll, tableKey, tablePath } from '../../src/renderer/src/lib/refs'
import { typeLabel } from '../../src/renderer/src/lib/typeLabel'
import type { TableRef } from '../../src/renderer/src/Explorer'

const pg: TableRef = { dsId: 'a', dsName: 'A', database: 'db', schema: 's', table: 't', kind: 'table' }
const ddb: TableRef = { dsId: 'a', dsName: 'A', database: '', schema: '', table: 't', kind: 'table', engine: 'dynamodb', region: 'eu-west-1' }

describe('table identity', () => {
  it('Postgres keys are unchanged (old sessions keep matching)', () => {
    expect(tableKey(pg)).toBe('t|a|db|s|t')
    expect(tablePath(pg)).toBe('a/db/s/t')
    expect(isDynamoRef(pg)).toBe(false)
  })
  it('DynamoDB keys include the kind and the region and can never collide with Postgres ones', () => {
    expect(tableKey(ddb)).toBe('t|ddb|a|eu-west-1|t')
    expect(tablePath(ddb)).toBe('a/t')
    expect(isDynamoRef(ddb)).toBe(true)
    expect(tableKey(ddb)).not.toBe(tableKey({ ...pg, database: 'eu-west-1', schema: 't', table: 't' }))
    expect(tableKey({ ...ddb, region: 'us-east-1' })).not.toBe(tableKey(ddb))
    expect(tableKey({ ...ddb, region: undefined })).toBe('t|ddb|a||t')
  })
})

describe('PartiQL names', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(partiqlName('Orders')).toBe('"Orders"')
    expect(partiqlName('a"b')).toBe('"a""b"')
  })
  it('prefill has no LIMIT (PartiQL has none)', () => {
    expect(partiqlSelectAll('orders')).toBe('SELECT * FROM "orders"')
    expect(partiqlSelectAll('x"y')).toBe('SELECT * FROM "x""y"')
  })
})

describe('typeLabel', () => {
  it('knows the data source kinds', () => {
    expect(typeLabel('dynamodb')).toBe('DynamoDB')
    expect(typeLabel('postgres')).toBe('PostgreSQL')
  })
})
