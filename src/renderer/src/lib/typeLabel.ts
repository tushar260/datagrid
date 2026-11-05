/** Human-readable object type shown when hovering a tree/tab icon. */
const LABELS: Record<string, string> = {
  table: 'Table',
  view: 'View',
  matview: 'Materialized View',
  foreign: 'Foreign Table',
  partitioned: 'Partitioned Table',
  schema: 'Schema',
  database: 'Database',
  ds: 'Data Source',
  datasource: 'Data Source',
  folder: 'Folder',
  server: 'Server Objects',
  roles: 'Roles',
  role: 'Role',
  tablespaces: 'Tablespaces',
  tablespace: 'Tablespace',
  console: 'Query Console',
  dynamodb: 'DynamoDB',
  redis: 'Redis',
  redisdb: 'Redis Database',
  rtype: 'Key type',
  rfolder: 'Key folder',
  'key-string': 'String key',
  'key-hash': 'Hash key',
  'key-list': 'List key',
  'key-set': 'Set key',
  'key-zset': 'Sorted set key',
  'key-stream': 'Stream key',
  'key-other': 'Key',
  postgres: 'PostgreSQL'
}

/** `kind` is a tree node kind or a `listTables` relkind mapping ('table' | 'view' | 'matview' | 'foreign'). */
export function typeLabel(kind: string | undefined | null): string {
  if (!kind) return 'Table'
  return LABELS[kind] ?? 'Table'
}
