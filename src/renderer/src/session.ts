import type { TableRef } from './Explorer'
import type { ConsoleRef } from './Console'
import { tableKey } from './lib/refs'

/**
 * Restores the previous UI session on restart: open tabs (+ order, active tab), sidebar width/visibility,
 * explorer expansion, console SQL drafts and per-table view state. Stored in localStorage under a versioned key.
 * Never stores query results. Corrupt / old data is ignored.
 */

// 'datagrip-lite:' is a legacy persisted prefix (pre-DataGrid name): do not rename or users' saved settings / session reset.
const KEY = 'datagrip-lite:session'
const VERSION = 1

export interface TableViewState {
  page: number
  pageSize: number
  /** 0-based first-row offset (authoritative when present; `page` is the legacy page index) */
  offset?: number
  sort: { column: string; desc: boolean } | null
  /** (Redis key browser: the key pattern) */
  where: string
  /** (Redis key browser: the type filter; page / pageSize / sort are unused there) */
  orderExpr: string
  /** DynamoDB: the secondary index being read (absent = the table itself) */
  index?: string
}
export type SavedTab = { type: 'table'; t: TableRef } | { type: 'console'; c: ConsoleRef }

export interface Session {
  v: number
  tabs: SavedTab[]
  active: string | null
  width: number
  sidebarHidden: boolean
  consoleN: number
  /** unsaved SQL per console id */
  consoleSql: Record<string, string>
  /** per table tab view state, by tableKey */
  views: Record<string, TableViewState>
  /** explorer node ids (ds/db/schema paths) that were expanded */
  expanded: string[]
  /** explorer folder ids that were expanded */
  folders: string[]
}

export { tableKey }
export const consoleKey = (c: { id: string }): string => 'c|' + c.id
export const tabKey = (x: SavedTab): string => (x.type === 'table' ? tableKey(x.t) : consoleKey(x.c))

const str = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** A logical Redis database index (a tab saved with anything else is dropped). */
const dbIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : [])

function parseTab(x: unknown): SavedTab | null {
  if (!isObj(x)) return null
  if (x.type === 'table' && isObj(x.t)) {
    const t = x.t
    if (str(t.dsId) && str(t.dsName) && str(t.database) && str(t.schema) && str(t.table) && str(t.kind)) {
      // `engine` / `region` only exist for DynamoDB tabs; tabs saved before DynamoDB support have neither (PostgreSQL)
      const ddb = t.engine === 'dynamodb' ? { engine: 'dynamodb' as const, region: str(t.region) ? t.region : '' } : {}
      if (t.engine === 'redis') {
        if (!dbIndex(t.db)) return null
        // a key tab (one key) carries `redisKey`; a key browser tab does not
        const key = str(t.redisKey) && t.redisKey !== '' ? { redisKey: t.redisKey } : {}
        return { type: 'table', t: { dsId: t.dsId, dsName: t.dsName, database: t.database, schema: '', table: t.table, kind: 'redis', engine: 'redis', db: t.db, ...key } }
      }
      return { type: 'table', t: { dsId: t.dsId, dsName: t.dsName, database: t.database, schema: t.schema, table: t.table, kind: t.kind, ...ddb } }
    }
  } else if (x.type === 'console' && isObj(x.c)) {
    const c = x.c
    if (str(c.id) && str(c.title) && str(c.dsId) && str(c.dsName) && str(c.database)) {
      const ddb = c.engine === 'dynamodb' ? { engine: 'dynamodb' as const, region: str(c.region) ? c.region : '' } : {}
      if (c.engine === 'redis') {
        if (!dbIndex(c.db)) return null
        return { type: 'console', c: { id: c.id, title: c.title, dsId: c.dsId, dsName: c.dsName, database: c.database, engine: 'redis', db: c.db } }
      }
      return { type: 'console', c: { id: c.id, title: c.title, dsId: c.dsId, dsName: c.dsName, database: c.database, schema: str(c.schema) ? c.schema : undefined, ...ddb } }
    }
  }
  return null
}

function parseView(x: unknown): TableViewState | null {
  if (!isObj(x)) return null
  const int = (v: unknown, min: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null)
  const page = int(x.page, 0)
  const pageSize = int(x.pageSize, 1)
  if (page === null || pageSize === null) return null
  const s = x.sort
  const sort = isObj(s) && str(s.column) && typeof s.desc === 'boolean' ? { column: s.column, desc: s.desc } : null
  const offset = int(x.offset, 0) ?? undefined
  return {
    page, pageSize, offset, sort, where: str(x.where) ? x.where : '', orderExpr: str(x.orderExpr) ? x.orderExpr : '',
    ...(str(x.index) && x.index ? { index: x.index } : {})
  }
}

const empty = (): Session => ({
  v: VERSION, tabs: [], active: null, width: 300, sidebarHidden: false, consoleN: 0, consoleSql: {}, views: {}, expanded: [], folders: []
})

function read(): Session {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const j: unknown = JSON.parse(raw)
    if (!isObj(j) || j.v !== VERSION) return empty()
    const s = empty()
    const seen = new Set<string>()
    for (const x of Array.isArray(j.tabs) ? j.tabs : []) {
      const t = parseTab(x)
      if (!t || seen.has(tabKey(t))) continue
      seen.add(tabKey(t))
      s.tabs.push(t)
    }
    s.active = str(j.active) && seen.has(j.active) ? j.active : null
    if (typeof j.width === 'number' && Number.isFinite(j.width)) s.width = Math.max(180, Math.min(700, j.width))
    s.sidebarHidden = j.sidebarHidden === true
    if (typeof j.consoleN === 'number' && Number.isInteger(j.consoleN) && j.consoleN >= 0) s.consoleN = j.consoleN
    if (isObj(j.consoleSql)) for (const [k, v] of Object.entries(j.consoleSql)) if (str(v)) s.consoleSql[k] = v
    if (isObj(j.views)) for (const [k, v] of Object.entries(j.views)) {
      const pv = parseView(v)
      if (pv) s.views[k] = pv
    }
    s.expanded = strList(j.expanded)
    s.folders = strList(j.folders)
    return s
  } catch {
    return empty()
  }
}

let session: Session = read()
let timer: number | null = null

function write(): void {
  timer = null
  try {
    localStorage.setItem(KEY, JSON.stringify(session))
  } catch {
    /* quota / unavailable: ignore */
  }
}
function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = window.setTimeout(write, 300)
}
const flush = (): void => {
  if (timer !== null) {
    clearTimeout(timer)
    write()
  }
}
window.addEventListener('pagehide', flush)
window.addEventListener('beforeunload', flush)

/** The state as it was on disk when the app started (do not mutate). */
export const initialSession: Session = session

export function patchSession(p: Partial<Session>): void {
  session = { ...session, ...p, v: VERSION }
  schedule()
}

/** Save the tab strip; also drops console drafts / table view state that belong to closed tabs. */
export function saveTabs(tabs: SavedTab[], active: string | null): void {
  const keys = new Set(tabs.map(tabKey))
  const consoleSql: Record<string, string> = {}
  for (const [id, sql] of Object.entries(session.consoleSql)) if (keys.has('c|' + id)) consoleSql[id] = sql
  const views: Record<string, TableViewState> = {}
  for (const [k, v] of Object.entries(session.views)) if (keys.has(k)) views[k] = v
  // SQL lives in consoleSql, not in the tab record
  // (a key browser's one-off prefill from the tree is not part of the session either)
  const slim = tabs.map((x): SavedTab =>
    x.type === 'console'
      ? { type: 'console', c: { ...x.c, sql: undefined } }
      : x.t.redisFilter ? { type: 'table', t: { ...x.t, redisFilter: undefined } } : x
  )
  patchSession({ tabs: slim, active, consoleSql, views })
}

export function setConsoleSql(id: string, sql: string): void {
  if (session.consoleSql[id] === sql) return
  session = { ...session, consoleSql: { ...session.consoleSql, [id]: sql } }
  schedule()
}

export function getTableView(key: string): TableViewState | undefined {
  return session.views[key]
}
export function setTableView(key: string, v: TableViewState): void {
  session = { ...session, views: { ...session.views, [key]: v } }
  schedule()
}

/** The saved session as plain JSON (for a backup); undefined when there is none. */
export function exportSession(): unknown {
  flush()
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

/**
 * Replaces the saved session with one from a backup (it is validated by `read` like any stored session). The tabs on screen
 * do not change: it takes effect on the next start / reload (the in-memory session is replaced so nothing overwrites it).
 */
export function replaceSession(value: unknown): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    /* quota / unavailable: ignore */
  }
  session = read()
}
