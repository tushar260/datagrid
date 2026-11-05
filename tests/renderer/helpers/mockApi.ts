import { vi } from 'vitest'
import { resetObjectCache } from '../../../src/renderer/src/lib/objectCache'

type Fn = ReturnType<typeof vi.fn>
export type MockApi = Record<string, Fn> & {
  dynamo: Record<'profiles' | 'tables' | 'describe' | 'items' | 'partiql' | 'setTableFilter', Fn>
  redis: Record<'databases' | 'dbsize' | 'keyTree' | 'keyTreeCancel' | 'scan' | 'get' | 'setString' | 'setTtl' | 'delete' | 'rename' | 'create' | 'item' | 'command', Fn>
  cache: Record<'get' | 'set' | 'delete' | 'clear' | 'all' | 'size' | 'onInvalidated', Fn>
  backup: Record<'export' | 'pick' | 'unlock' | 'apply' | 'cancel' | 'undo' | 'showInFolder', Fn>
  _goto: (() => void)[]
  _invalidated: ((id: string, prefixes: string[]) => void)[]
  _closeTab: (() => void)[]
  _nextTab: (() => void)[]
  _prevTab: (() => void)[]
  _zoom: ((p: number) => void)[]
  _settings: (() => void)[]
  _fontSize: ((dir: 'in' | 'out' | 'reset') => void)[]
  _next: (() => void)[]
  _prev: (() => void)[]
}

const names = [
  'relaunch', 'listSources', 'saveSource', 'deleteSource', 'moveSource', 'listFolders', 'createFolder', 'renameFolder',
  'moveFolder', 'deleteFolder', 'renameSource', 'setSort', 'setVisibleDbs', 'setSchemaFilter', 'setTableFilter', 'tableNames',
  'schemasAll', 'duplicateSource', 'query', 'dropDatabase', 'createDatabase', 'createSchema', 'createTable', 'addColumn',
  'schemaTotal', 'roles', 'tablespaces', 'renameTable', 'dropTable', 'testSource', 'databases', 'schemas', 'tables',
  'columns', 'indexes', 'rows', 'apply', 'disconnect', 'zoomGet', 'zoomStep', 'tablesAll', 'appVersion'
]

/** A complete `window.api` stand-in: every IPC method is a vi.fn resolving to a sensible empty value. */
export function makeApi(over: Record<string, unknown> = {}): MockApi {
  const api: Record<string, unknown> = {}
  const empty: Record<string, unknown> = {
    listSources: [], listFolders: [], tableNames: {}, schemasAll: [], roles: [], tablespaces: [], databases: [],
    schemas: [], tables: [], columns: [], indexes: [], schemaTotal: 0, rows: { columns: [], rows: [], total: 0 },
    query: { results: [], durationMs: 0 }, testSource: 'PostgreSQL 16', createFolder: undefined, duplicateSource: undefined,
    zoomGet: 100, zoomStep: 100, tablesAll: {}, appVersion: '1.2.3'
  }
  for (const n of names) api[n] = vi.fn(async () => empty[n])
  const closeTab: (() => void)[] = []
  const nextTab: (() => void)[] = []
  const prevTab: (() => void)[] = []
  const zoom: ((p: number) => void)[] = []
  api.onCloseTab = vi.fn((cb: () => void) => {
    closeTab.push(cb)
    return () => void closeTab.splice(closeTab.indexOf(cb), 1)
  })
  api.onZoom = vi.fn((cb: (p: number) => void) => {
    zoom.push(cb)
    return () => void zoom.splice(zoom.indexOf(cb), 1)
  })
  api.onNextTab = vi.fn((cb: () => void) => {
    nextTab.push(cb)
    return () => void nextTab.splice(nextTab.indexOf(cb), 1)
  })
  api.onPrevTab = vi.fn((cb: () => void) => {
    prevTab.push(cb)
    return () => void prevTab.splice(prevTab.indexOf(cb), 1)
  })
  const settings: (() => void)[] = []
  api.onSettings = vi.fn((cb: () => void) => {
    settings.push(cb)
    return () => void settings.splice(settings.indexOf(cb), 1)
  })
  api._settings = settings
  const goto: (() => void)[] = []
  api.onGoto = vi.fn((cb: () => void) => {
    goto.push(cb)
    return () => void goto.splice(goto.indexOf(cb), 1)
  })
  api._goto = goto
  const fontSize: ((dir: 'in' | 'out' | 'reset') => void)[] = []
  api.onFontSize = vi.fn((cb: (dir: 'in' | 'out' | 'reset') => void) => {
    fontSize.push(cb)
    return () => void fontSize.splice(fontSize.indexOf(cb), 1)
  })
  api._fontSize = fontSize
  api._nextTab = nextTab
  api._prevTab = prevTab
  api._next = nextTab // aliases
  api._prev = prevTab
  api._closeTab = closeTab
  api._zoom = zoom
  // DynamoDB namespace: `over.dynamo` may replace individual methods (plain values are wrapped into async mocks)
  const emptyPage = { items: [], columns: [], rows: [], next: null, columnsCapped: false }
  const dyn: Record<string, unknown> = {
    profiles: vi.fn(async () => []),
    tables: vi.fn(async () => []),
    describe: vi.fn(async () => undefined),
    items: vi.fn(async () => emptyPage),
    partiql: vi.fn(async () => ({ ...emptyPage, command: 'SELECT', durationMs: 1 })),
    setTableFilter: vi.fn(async () => undefined)
  }
  for (const [k, v] of Object.entries((over.dynamo as Record<string, unknown> | undefined) ?? {})) {
    dyn[k] = typeof v === 'function' ? (vi.isMockFunction(v) ? v : vi.fn(v as never)) : vi.fn(async () => v)
  }
  api.dynamo = dyn
  // Redis namespace: same override rules as `dynamo`
  const rds: Record<string, unknown> = {
    databases: vi.fn(async () => ({ databases: [], count: 16, cluster: false })),
    dbsize: vi.fn(async () => 0),
    keyTree: vi.fn(async () => ({ keys: [], complete: true, dbsize: 0 })),
    keyTreeCancel: vi.fn(async () => undefined),
    scan: vi.fn(async () => ({ keys: [], cursor: null })),
    get: vi.fn(async (_id: string, _db: number, key: string) => ({ key, type: 'none', ttl: -2, size: null, length: null, value: { kind: 'none' } })),
    setString: vi.fn(async () => undefined),
    setTtl: vi.fn(async () => undefined),
    delete: vi.fn(async (_id: string, _db: number, keys: string[]) => keys.length),
    rename: vi.fn(async () => undefined),
    create: vi.fn(async () => undefined),
    item: vi.fn(async () => 1),
    command: vi.fn(async () => ({ results: [], durationMs: 0 }))
  }
  for (const [k, v] of Object.entries((over.redis as Record<string, unknown> | undefined) ?? {})) {
    rds[k] = typeof v === 'function' ? (vi.isMockFunction(v) ? v : vi.fn(v as never)) : vi.fn(async () => v)
  }
  api.redis = rds
  // cache namespace: by default nothing is ever cached (get -> null); `over.cache` replaces single methods, `cacheFake()` is a stateful one
  const invalidated: ((id: string, prefixes: string[]) => void)[] = []
  const cch: Record<string, unknown> = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => true),
    delete: vi.fn(async () => 0),
    clear: vi.fn(async () => undefined),
    all: vi.fn(async () => ({})),
    size: vi.fn(async () => 0),
    onInvalidated: vi.fn((cb: (id: string, prefixes: string[]) => void) => {
      invalidated.push(cb)
      return () => void invalidated.splice(invalidated.indexOf(cb), 1)
    })
  }
  for (const [k, v] of Object.entries((over.cache as Record<string, unknown> | undefined) ?? {})) {
    cch[k] = typeof v === 'function' ? (vi.isMockFunction(v) ? v : vi.fn(v as never)) : vi.fn(async () => v)
  }
  api.cache = cch
  api._invalidated = invalidated
  // backup namespace: by default every dialog is cancelled / nothing to undo; `over.backup` replaces single methods (same rules as `redis`)
  const bk: Record<string, unknown> = {
    export: vi.fn(async () => ({ ok: false, canceled: true })),
    pick: vi.fn(async () => ({ ok: false, canceled: true })),
    unlock: vi.fn(async () => ({ ok: false, error: 'Wrong passphrase or the file was modified' })),
    apply: vi.fn(async () => ({ ok: false, error: 'This import expired. Choose the backup file again.', expired: true })),
    cancel: vi.fn(async () => true),
    undo: vi.fn(async () => ({ ok: false, error: 'There is nothing to undo' })),
    showInFolder: vi.fn(async () => true)
  }
  for (const [k, v] of Object.entries((over.backup as Record<string, unknown> | undefined) ?? {})) {
    bk[k] = typeof v === 'function' ? (vi.isMockFunction(v) ? v : vi.fn(v as never)) : vi.fn(async () => v)
  }
  api.backup = bk
  for (const [k, v] of Object.entries(over)) {
    if (k === 'dynamo' || k === 'redis' || k === 'cache' || k === 'backup') continue
    api[k] = typeof v === 'function' ? (vi.isMockFunction(v) ? v : vi.fn(v as never)) : vi.fn(async () => v)
  }
  return api as MockApi
}

/**
 * A stateful in-memory stand-in for the main process' cache (for `installApi({ cache: cacheFake() })`): entries survive
 * between calls like the real one. `entries` is the live store, keyed `dsId\0key`.
 */
export function cacheFake(initial: Record<string, Record<string, { at: number; data: unknown }>> = {}): {
  entries: Map<string, { at: number; data: unknown }>
  get: Fn
  set: Fn
  delete: Fn
  clear: Fn
  all: Fn
  size: Fn
} {
  const entries = new Map<string, { at: number; data: unknown }>()
  for (const [id, m] of Object.entries(initial)) for (const [k, e] of Object.entries(m)) entries.set(id + '\u0000' + k, e)
  return {
    entries,
    get: vi.fn(async (id: string, key: string) => entries.get(id + '\u0000' + key) ?? null),
    set: vi.fn(async (id: string, key: string, data: unknown) => (entries.set(id + '\u0000' + key, { at: Date.now(), data: JSON.parse(JSON.stringify(data)) }), true)),
    delete: vi.fn(async (id: string, prefix?: string) => {
      let n = 0
      for (const k of [...entries.keys()]) if (k.startsWith(id + '\u0000' + (prefix ?? ''))) (entries.delete(k), n++)
      return n
    }),
    clear: vi.fn(async (id?: string) => {
      for (const k of [...entries.keys()]) if (!id || k.startsWith(id + '\u0000')) entries.delete(k)
    }),
    all: vi.fn(async (prefixes?: string[]) => {
      const out: Record<string, Record<string, { at: number; data: unknown }>> = {}
      for (const [k, e] of entries) {
        const [id, key] = k.split('\u0000')
        if (prefixes && !prefixes.some((p) => key.startsWith(p))) continue
        ;(out[id] ??= {})[key] = e
      }
      return out
    }),
    size: vi.fn(async () => [...entries.values()].reduce((n, e) => n + JSON.stringify(e).length, 0))
  }
}

export function installApi(over: Record<string, unknown> = {}): MockApi {
  resetObjectCache() // the wrapper keeps module state (in-flight fetches, stale markers, the name index): every test starts clean
  const api = makeApi(over)
  Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true })
  return api
}
