import { contextBridge, ipcRenderer } from 'electron'
import type {
  BackupApplyOptions, BackupApplyOutcome, BackupExportRequest, BackupExportResult, BackupPickResult, BackupUnlockResult,
  CacheEntry, DynamoPage, DynamoStatementResult, DynamoTableInfo, RedisCommandResult, RedisDatabases, RedisItemOp, RedisKeyDetail, RedisKeyTree, RedisKeyTreeOpts, RedisNewKey,
  RedisPageOpts, RedisScanOpts, RedisScanResult
} from '../shared'

const inv = (ch: string, ...a: unknown[]): Promise<any> => ipcRenderer.invoke(ch, ...a)

const api = {
  relaunch: () => inv('app:relaunch'),
  /** the app version (package.json), shown in Settings > About */
  appVersion: (): Promise<string> => inv('app:version'),
  listSources: () => inv('ds:list'),
  saveSource: (ds: unknown) => inv('ds:save', ds),
  deleteSource: (id: string) => inv('ds:delete', id),
  moveSource: (id: string, folderId: string | null) => inv('ds:move', id, folderId),
  listFolders: () => inv('folders:list'),
  createFolder: (name: string, parentId: string | null) => inv('folders:create', name, parentId),
  renameFolder: (id: string, name: string) => inv('folders:rename', id, name),
  moveFolder: (id: string, parentId: string | null) => inv('folders:move', id, parentId),
  deleteFolder: (id: string) => inv('folders:delete', id),
  renameSource: (id: string, name: string) => inv('ds:rename', id, name),
  setSort: (id: string, sort: string) => inv('ds:setSort', id, sort),
  setVisibleDbs: (id: string, list: string[] | null) => inv('ds:setVisibleDbs', id, list),
  setSchemaFilter: (id: string, db: string, list: string[] | null) => inv('ds:setSchemaFilter', id, db, list),
  setTableFilter: (id: string, db: string, schema: string, filter: unknown) => inv('ds:setTableFilter', id, db, schema, filter),
  tableNames: (id: string, d: string) => inv('db:tableNames', id, d),
  schemasAll: (id: string, d: string) => inv('db:schemasAll', id, d),
  duplicateSource: (id: string) => inv('ds:duplicate', id),
  query: (id: string, d: string, schema: string | undefined, sql: string) => inv('db:query', id, d, schema, sql),
  dropDatabase: (id: string, d: string) => inv('db:dropDatabase', id, d),
  createDatabase: (id: string, name: string, owner?: string) => inv('db:createDatabase', id, name, owner),
  createSchema: (id: string, d: string, name: string, owner?: string) => inv('db:createSchema', id, d, name, owner),
  createTable: (id: string, d: string, s: string, name: string, columns: unknown[]) => inv('db:createTable', id, d, s, name, columns),
  addColumn: (id: string, d: string, s: string, t: string, column: unknown) => inv('db:addColumn', id, d, s, t, column),
  schemaTotal: (id: string, d: string) => inv('db:schemaTotal', id, d),
  roles: (id: string) => inv('server:roles', id),
  tablespaces: (id: string) => inv('server:tablespaces', id),
  renameTable: (id: string, d: string, s: string, t: string, to: string) => inv('db:renameTable', id, d, s, t, to),
  dropTable: (id: string, d: string, s: string, t: string, kind: string) => inv('db:dropTable', id, d, s, t, kind),
  testSource: (ds: unknown) => inv('ds:test', ds),
  databases: (id: string) => inv('db:databases', id),
  schemas: (id: string, d: string) => inv('db:schemas', id, d),
  tables: (id: string, d: string, s: string) => inv('db:tables', id, d, s),
  /** every table / view of a database grouped by schema, one query (the ⌘O indexer) */
  tablesAll: (id: string, d: string): Promise<Record<string, { name: string; kind: string }[]>> => inv('db:tablesAll', id, d),
  columns: (id: string, d: string, s: string, t: string) => inv('db:columns', id, d, s, t),
  indexes: (id: string, d: string, s: string, t: string) => inv('db:indexes', id, d, s, t),
  rows: (q: unknown) => inv('db:rows', q),
  apply: (id: string, d: string, s: string, t: string, ch: unknown) => inv('db:apply', id, d, s, t, ch),
  disconnect: (id: string) => inv('db:disconnect', id),
  // DynamoDB (separate channels; the Postgres API above is unchanged)
  dynamo: {
    profiles: (): Promise<string[]> => inv('dynamo:profiles'),
    tables: (id: string): Promise<string[]> => inv('dynamo:tables', id),
    describe: (id: string, table: string): Promise<DynamoTableInfo> => inv('dynamo:describe', id, table),
    items: (id: string, table: string, o: { limit: number; cursor?: string | null; where?: string; index?: string }): Promise<DynamoPage> =>
      inv('dynamo:items', id, table, o),
    partiql: (id: string, statement: string, o?: { nextToken?: string; limit?: number }): Promise<DynamoStatementResult> =>
      inv('dynamo:partiql', id, statement, o),
    setTableFilter: (id: string, filter: unknown) => inv('dynamo:setTableFilter', id, filter)
  },
  // Redis (separate channels; `db` is the logical database index; keys / fields / members are strings, see REDIS_BIN_PREFIX)
  redis: {
    databases: (id: string): Promise<RedisDatabases> => inv('redis:databases', id),
    dbsize: (id: string, db: number): Promise<number> => inv('redis:dbsize', id, db),
    scan: (id: string, db: number, o?: RedisScanOpts): Promise<RedisScanResult> => inv('redis:scan', id, db, o),
    keyTree: (id: string, db: number, o?: RedisKeyTreeOpts): Promise<RedisKeyTree> => inv('redis:keyTree', id, db, o),
    keyTreeCancel: (id: string, db: number): Promise<void> => inv('redis:keyTreeCancel', id, db),
    get: (id: string, db: number, key: string, o?: RedisPageOpts): Promise<RedisKeyDetail> => inv('redis:get', id, db, key, o),
    setString: (id: string, db: number, key: string, value: string, o?: { keepTtl?: boolean }): Promise<void> =>
      inv('redis:setString', id, db, key, value, o),
    setTtl: (id: string, db: number, key: string, seconds: number | null): Promise<void> => inv('redis:setTtl', id, db, key, seconds),
    delete: (id: string, db: number, keys: string[]): Promise<number> => inv('redis:delete', id, db, keys),
    rename: (id: string, db: number, key: string, to: string): Promise<void> => inv('redis:rename', id, db, key, to),
    create: (id: string, db: number, key: string, spec: RedisNewKey, o?: { ttl?: number | null }): Promise<void> =>
      inv('redis:create', id, db, key, spec, o),
    item: (id: string, db: number, key: string, op: RedisItemOp): Promise<number> => inv('redis:item', id, db, key, op),
    command: (id: string, db: number, text: string): Promise<RedisCommandResult> => inv('redis:command', id, db, text)
  },
  // Local cache of the explorer's lists (see src/main/objectCache.ts). Keys / prefixes are validated in the main process.
  cache: {
    get: (id: string, key: string): Promise<CacheEntry | null> => inv('cache:get', id, key),
    set: (id: string, key: string, data: unknown): Promise<boolean> => inv('cache:set', id, key, data),
    delete: (id: string, prefix?: string): Promise<number> => inv('cache:delete', id, prefix),
    clear: (id?: string): Promise<void> => inv('cache:clear', id),
    all: (prefixes?: string[]): Promise<Record<string, Record<string, CacheEntry>>> => inv('cache:all', prefixes),
    size: (): Promise<number> => inv('cache:size'),
    /** cached lists were dropped by the main process (`['']` = everything of that data source); returns an unsubscribe function */
    onInvalidated: (cb: (id: string, prefixes: string[]) => void): (() => void) => {
      const h = (_e: unknown, id: string, prefixes: string[]): void => cb(id, prefixes)
      ipcRenderer.on('cache:invalidated', h)
      return () => ipcRenderer.removeListener('cache:invalidated', h)
    }
  },
  // Settings > Backup & restore. The main process owns the native dialogs, the file writes and the parsed import (by `importId`).
  backup: {
    export: (req: BackupExportRequest): Promise<BackupExportResult> => inv('backup:export', req),
    pick: (): Promise<BackupPickResult> => inv('backup:pick'),
    unlock: (importId: string, passphrase: string): Promise<BackupUnlockResult> => inv('backup:unlock', importId, passphrase),
    apply: (importId: string, opts: BackupApplyOptions): Promise<BackupApplyOutcome> => inv('backup:apply', importId, opts),
    cancel: (importId: string): Promise<boolean> => inv('backup:cancel', importId),
    undo: (current?: BackupApplyOptions['current']): Promise<BackupApplyOutcome> => inv('backup:undo', current),
    showInFolder: (path: string): Promise<boolean> => inv('backup:showInFolder', path)
  },
  // Cmd+W from the application menu; returns an unsubscribe function
  onCloseTab: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:closeTab', h)
    return () => ipcRenderer.removeListener('menu:closeTab', h)
  },
  // Ctrl+Tab / Ctrl+Shift+Tab from the application menu (next / previous editor tab); return an unsubscribe function
  onNextTab: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:nextTab', h)
    return () => ipcRenderer.removeListener('menu:nextTab', h)
  },
  onPrevTab: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:prevTab', h)
    return () => ipcRenderer.removeListener('menu:prevTab', h)
  },
  // Go > Go to Database or Table... (Cmd/Ctrl+O) from the application menu; returns an unsubscribe function
  onGoto: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:goto', h)
    return () => ipcRenderer.removeListener('menu:goto', h)
  },
  // Settings... (Cmd/Ctrl+,) from the application menu; returns an unsubscribe function
  onSettings: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:settings', h)
    return () => ipcRenderer.removeListener('menu:settings', h)
  },
  // View > Increase / Decrease / Reset Font Size; cb gets 'in' | 'out' | 'reset'. Returns an unsubscribe function
  onFontSize: (cb: (dir: 'in' | 'out' | 'reset') => void): (() => void) => {
    const h = (_e: unknown, dir: 'in' | 'out' | 'reset'): void => cb(dir)
    ipcRenderer.on('menu:fontSize', h)
    return () => ipcRenderer.removeListener('menu:fontSize', h)
  },
  // browser-style zoom: current percent, and one step 'in' / 'out' / 'reset' (resolves to the new percent)
  zoomGet: (): Promise<number> => inv('zoom:get'),
  zoomStep: (dir: 'in' | 'out' | 'reset'): Promise<number> => inv('zoom:step', dir),
  // zoom changed via Cmd/Ctrl +, -, 0 (or wheel); cb gets the new zoom in percent. Returns an unsubscribe function
  onZoom: (cb: (percent: number) => void): (() => void) => {
    const h = (_e: unknown, percent: number): void => cb(percent)
    ipcRenderer.on('zoom:changed', h)
    return () => ipcRenderer.removeListener('zoom:changed', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
