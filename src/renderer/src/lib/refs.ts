import { redisDisplayName } from '../../../shared'
import type { TableRef } from '../Explorer'

/**
 * Identity helpers for open tabs / tree nodes. PostgreSQL tables live at ds/database/schema/table; DynamoDB tables have no
 * database or schema (ds/table, region in the key) so the two kinds can never collide.
 */
export const isDynamoRef = (x: { engine?: string }): boolean => x.engine === 'dynamodb'
/** A Redis "table" is the key browser of one logical database (ds/db index), see `redisRef`. */
export const isRedisRef = (x: { engine?: string }): boolean => x.engine === 'redis'

/** A Redis key tab (one key, shown full width) as opposed to the key browser of a database. */
export const isRedisKeyRef = (x: { engine?: string; redisKey?: string }): boolean => x.engine === 'redis' && typeof x.redisKey === 'string'

export const tableKey = (t: TableRef): string =>
  isDynamoRef(t)
    ? ['t', 'ddb', t.dsId, t.region ?? '', t.table].join('|')
    : isRedisRef(t)
      ? isRedisKeyRef(t)
        ? ['t', 'rkey', t.dsId, t.db ?? 0, t.redisKey].join('|')
        : ['t', 'redis', t.dsId, t.db ?? 0].join('|')
      : ['t', t.dsId, t.database, t.schema, t.table].join('|')

/** Explorer tree id of the table's node (also what a refresh of an ancestor prefix-matches). */
export const tablePath = (t: TableRef): string =>
  isDynamoRef(t)
    ? [t.dsId, t.table].join('/')
    : isRedisRef(t)
      ? isRedisKeyRef(t)
        ? [t.dsId, `db${t.db ?? 0}`, `k:${t.redisKey}`].join('/')
        : [t.dsId, `db${t.db ?? 0}`].join('/')
      : [t.dsId, t.database, t.schema, t.table].join('/')

/** The tab / tree reference of a Redis database (the other fields only exist because TableRef is shared with PostgreSQL). */
export const redisRef = (dsId: string, dsName: string, db: number): TableRef => ({
  dsId, dsName, database: `db${db}`, schema: '', table: `db${db}`, kind: 'redis', engine: 'redis', db
})

/** The tab reference of one Redis key (`key` is the name as sent over IPC; binary names stay encoded). */
export const redisKeyRef = (dsId: string, dsName: string, db: number, key: string): TableRef => ({
  ...redisRef(dsId, dsName, db), table: key, redisKey: key
})

/** Short tab title of a key: the whole name, or its tail with an ellipsis when it is long. */
export const keyTabTitle = (key: string): string => {
  const shown = redisDisplayName(key)
  return shown.length <= 28 ? shown : '…' + shown.slice(-27)
}

/** Quoted PartiQL name: `"Table"` with embedded double quotes doubled. */
export const partiqlName = (n: string): string => '"' + n.replace(/"/g, '""') + '"'

/** Prefill of a console opened on a table (PartiQL has no LIMIT clause: the console pages through results instead). */
export const partiqlSelectAll = (table: string): string => `SELECT * FROM ${partiqlName(table)}`
