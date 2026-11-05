import type React from "react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  applyTableFilter, cacheKeys, compactKeyTree, dsKind, expandKeyTree, isRedisBinaryName, redisDelimiter, redisDisplayName, REDIS_KEYTREE_MAX, type DataSource, type DbSort,
  type Folder, type RedisDatabases, type RedisKeyTree, type TableFilter
} from '../../shared'
import { Chevron, Icon, type IconName } from './icons'
import ListPicker from './DbPicker'
import CreateDialog, { type CreateReq } from './CreateDialogs'
import { initialSession, patchSession } from './session'
import { rangeBetween } from './lib/selection'
import { typeLabel } from './lib/typeLabel'
import { partiqlSelectAll, redisKeyRef, redisRef } from './lib/refs'
import { buildKeyTree, prefixPattern, type KeyEntry, type TypeGroup } from './lib/redisTree'
import { FOCUS_EXPLORER_EVENT, keyBelongsToExplorer, markExplorerActive, setExplorerRefreshProbe, trackExplorerClicks } from './lib/focusZone'
import { cacheMeta, cacheNote, cached, markStale } from './lib/objectCache'
import { sourcesIn } from './lib/sortSources'

export interface TableRef {
  dsId: string
  dsName: string
  database: string
  schema: string
  table: string
  kind: string
  /** 'dynamodb' = a DynamoDB table (database / schema are empty, `region` is shown in tooltips);
   *  'redis' = the key browser of logical database `db` (see lib/refs `redisRef`) */
  engine?: 'dynamodb' | 'redis'
  region?: string
  db?: number
  /** 'redis' key tab: the key (as sent over IPC) shown in `db` (see lib/refs `redisKeyRef`) */
  redisKey?: string
  /** 'redis' key browser opened from a tree folder: prefill its search (`n` makes repeated requests distinct) */
  redisFilter?: { pattern: string; type: string; n: number }
}

interface Props {
  onOpen: (t: TableRef) => void
  onEdit: (ds: DataSource | null, folderId?: string | null) => void
  onConsole: (c: { dsId: string; dsName: string; database: string; schema?: string; sql?: string; engine?: 'dynamodb' | 'redis'; region?: string; db?: number }) => void
  onTableRenamed: (dsId: string, database: string, schema: string, from: string, to: string) => void
  onRefreshed: (id: string) => void
  onObjectGone: (scope: { dsId: string; database?: string; schema?: string; table?: string }) => void
  reloadKey: number
  /** called with the freshly loaded data sources (used to restore the previous session's tabs) */
  onSources?: (sources: DataSource[]) => void
  /** tree id of the active tab's object: ds/db[/schema[/table]] */
  activeTarget?: string | null
  /** Redis: a key was renamed in the tree (its open tab follows) */
  onKeyRenamed?: (dsId: string, db: number, from: string, to: string) => void
  /** Redis: keys were deleted in the tree (their tabs close) */
  onKeysGone?: (dsId: string, db: number, keys: string[]) => void
  /** ask the tree to re-scan a Redis database node (only if it is expanded or loaded); `n` makes repeats count */
  treeRefresh?: { id: string; n: number } | null
  /** ⌘O: select (and, for `expand`, open) this tree node: ds/db[/schema], revealing it first; `n` makes repeats count */
  revealRequest?: { target: string; n: number; expand?: boolean } | null
}

interface NodeInfo {
  kind: 'ds' | 'db' | 'schema' | 'table' | 'rtype' | 'rfolder' | 'rkey'
  dsId: string
  dsName: string
  name: string
  database?: string
  schema?: string
  tableKind?: string
  /** a DynamoDB / Redis node (no database / schema levels) */
  engine?: 'dynamodb' | 'redis'
  /** Redis tree nodes below a database: the tree id to re-scan (the database node) */
  refreshId?: string
  /** Redis key / folder: text for "Copy Names" (the prefix) when it differs from `name` */
  copyText?: string
  /** Redis key: the key as sent over IPC, and its database */
  redisKey?: string
  db?: number
}
interface NodeCtl {
  leaf: boolean
  isOpen: boolean
  /** children are available (loaded or in memory) */
  loaded: boolean
  setOpen: (v: boolean) => void
  activate: () => void
}

interface TreeCtx {
  sel: string
  multi: Set<string>
  setSel: (id: string) => void
  click: (id: string, e: React.MouseEvent) => void
  ctl: { current: Record<string, NodeCtl> }
  infos: { current: Record<string, NodeInfo> }
  collapseKey: number
  expandKey: number
  reveal: { target: string; n: number; expand?: boolean } | null
  reg: { current: Record<string, () => MenuItem[]> }
  openMenuAt: (e: React.MouseEvent, id: string, items: MenuItem[]) => void
  /** node ids still to be re-expanded from the previous session (consumed when the node mounts) */
  restore?: { current: Set<string> }
  /** a node opened/closed/unmounted (drives the persisted expansion state) */
  track?: (id: string, open: boolean) => void
  /** per-node count of explicit refreshes of exactly that node (not its ancestors) */
  direct?: Record<string, number>
}
const SelCtx = createContext<TreeCtx>({
  sel: '',
  multi: new Set(),
  setSel: () => {},
  click: () => {},
  ctl: { current: {} },
  infos: { current: {} },
  collapseKey: 0,
  expandKey: 0,
  reveal: null,
  reg: { current: {} },
  openMenuAt: () => {}
})

type Kid = { name: string; kind?: string; data?: unknown }
type Kids = Kid[]
/** children of an in-memory (key) folder are rendered in chunks so a folder with 50k keys stays light */
const KID_PAGE = 500
/** "Expand All" skips key folders with more keys than this (it would render thousands of rows) */
const EXPAND_ALL_MAX = 1000
const entryKids = new WeakMap<KeyEntry[], Kids>()
/** The Node children of a key folder, built once per (immutable) children array */
function kidsOfEntries(list: KeyEntry[]): Kids {
  let k = entryKids.get(list)
  if (!k) entryKids.set(list, (k = list.map((e) => ({ name: e.kind === 'folder' ? 'd:' + e.prefix : 'k:' + e.key, kind: e.kind, data: e }))))
  return k
}

function Node({
  id, label, icon, depth, load, kidsData, cancellable, onCancel, loadingText, expandAll, render, leaf, onDouble, menu, forceReload, dragPayload, tooltip, tooltip2, tipNote, iconTip, info, badgeTitle, onBadgeClick, badgeOf, badgePlaceholder, badgeText, rawName, renaming, onRename, onCancelRename
}: {
  id: string
  label: string
  icon: React.ReactNode
  depth: number
  /** what this row is (used for multi-select bulk actions) */
  info?: NodeInfo
  /** hover text for a clickable count pill */
  badgeTitle?: string
  /** makes the count pill clickable */
  onBadgeClick?: (anchor: { x: number; y: number }) => void
  /** hover text for the row (omit to only show the label when it is truncated) */
  tooltip?: string
  /** dimmed second tooltip line */
  tooltip2?: string
  /** extra dim text appended to the second tooltip line, read on every render (e.g. "Loaded from cache 3h ago") */
  tipNote?: () => string | undefined
  /** object type name shown when hovering the leading icon (overrides the row tooltip there) */
  iconTip?: string
  /** text for the count pill once children are loaded */
  badgeOf?: (kids: Kids) => string | Promise<string>
  /** pill text before children are loaded */
  badgePlaceholder?: string
  /** pill text controlled by the parent (wins over badgeOf / placeholder) */
  badgeText?: string
  load?: () => Promise<Kids>
  /** children that are already in memory (no load; the parent re-renders when they change) */
  kidsData?: Kids
  /** collapsing (or the ctl) while `load` is running abandons it instead of being ignored */
  cancellable?: boolean
  onCancel?: () => void
  /** row shown under an expanded node while its first load runs */
  loadingText?: string
  /** false: "Expand All" skips this node (huge subtrees) */
  expandAll?: boolean
  render?: (k: Kid) => React.JSX.Element
  leaf?: boolean
  onDouble?: () => void
  menu?: () => MenuItem[]
  forceReload?: number
  dragPayload?: string
  rawName?: string
  renaming?: boolean
  onRename?: (name: string) => void
  onCancelRename?: () => void
}): React.JSX.Element {
  const { multi, setSel, click, ctl, infos, collapseKey, expandKey, reveal, reg, openMenuAt, direct, restore, track } = useContext(SelCtx)
  if (menu) reg.current[id] = menu
  if (info) infos.current[id] = info
  const rowRef = useRef<HTMLDivElement>(null)
  const init = useRef({ collapseKey, expandKey })
  const [open, setOpen] = useState(false)
  const [kids, setKids] = useState<Kids | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const loadingRef = useRef(false)
  const [badge, setBadge] = useState<string | null>(null)
  const [shown, setShown] = useState(KID_PAGE)
  const gen = useRef(0) // a newer load (or a cancel) makes an older answer irrelevant

  const doLoad = useCallback(async () => {
    if (!load) return
    const g = ++gen.current
    loadingRef.current = true
    const t0 = Date.now()
    setBusy(true)
    setErr('')
    try {
      const list = await load()
      if (g !== gen.current) return
      setKids(list)
      if (badgeOf) Promise.resolve(badgeOf(list)).then((t) => g === gen.current && setBadge(t), () => setBadge(null))
    } catch (e) {
      if (g !== gen.current) return
      setErr(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
    if (g !== gen.current) return
    loadingRef.current = false
    // keep the spinner visible long enough to be noticed (local loads finish in a few ms)
    window.setTimeout(() => g === gen.current && setBusy(false), Math.max(0, 450 - (Date.now() - t0)))
  }, [load])
  /** abandons the running load and collapses (the answer, if it still comes, is dropped) */
  const cancelLoad = (): void => {
    gen.current++
    loadingRef.current = false
    setBusy(false)
    setOpen(false)
    onCancel?.()
  }
  const kidList = kidsData ?? kids

  const directSeen = useRef(direct?.[id] ?? 0)
  const mountedForce = useRef(forceReload)
  useEffect(() => {
    // leaf rows (tables) have nothing to load, but still show the spinner briefly on refresh
    if (leaf && forceReload !== mountedForce.current) {
      setBusy(true)
      const h = window.setTimeout(() => setBusy(false), 450)
      return () => window.clearTimeout(h)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceReload])

  useEffect(() => {
    // refreshing: reload open nodes, and also closed nodes that were already loaded (updates their count pill).
    // A node that was refreshed explicitly (menu / ⌘R, incl. multi-select) always loads, even if it is
    // collapsed and was never loaded: the spinner shows and its count pill gets filled in.
    const forced = (direct?.[id] ?? 0) !== directSeen.current
    directSeen.current = direct?.[id] ?? 0
    if (open || kids || badge || (forced && load)) void doLoad()
    else setKids(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceReload])

  useEffect(() => {
    if (collapseKey !== init.current.collapseKey) setOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseKey])

  // session restore: a node that was expanded last time re-expands (and loads) as soon as it mounts. Nodes only
  // mount once their parent is open + loaded, so this walks down the tree lazily and skips nodes that no longer exist.
  useEffect(() => {
    if (leaf || (!load && !kidsData) || !restore?.current.delete(id)) return
    void doLoad()
    setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // report expansion changes (not the initial closed state) and removal, for persistence
  const trackedOnce = useRef(false)
  useEffect(() => {
    if (!trackedOnce.current) { trackedOnce.current = true; return }
    if (!leaf) track?.(id, open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => () => track?.(id, false), []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // "Expand All" only opens nodes that are already loaded (like DataGrip), it never fires new queries
    if (expandKey !== init.current.expandKey && !leaf && kidList && expandAll !== false) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandKey])

  useEffect(() => {
    if (!reveal) return
    if (id === reveal.target) {
      setSel(id)
      rowRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
      if (reveal.expand && !leaf) {
        if (!kids && !loadingRef.current) void doLoad()
        setOpen(true)
      }
    } else if (!leaf && reveal.target.startsWith(id + '/')) {
      if (!kids && !loadingRef.current) void doLoad()
      setOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal])

  const toggle = (): void => {
    if (leaf) return
    if (loadingRef.current) return cancellable && open ? cancelLoad() : undefined
    if (!open && !kids) void doLoad()
    setOpen(!open)
  }

  ctl.current[id] = {
    leaf: !!leaf,
    isOpen: open,
    loaded: !!kidList,
    setOpen: (v) => {
      if (leaf) return
      if (loadingRef.current) return cancellable && open && !v ? cancelLoad() : undefined
      if (v && !kids) void doLoad()
      setOpen(v)
    },
    activate: () => (leaf ? onDouble?.() : toggle())
  }

  return (
    <div>
      <div
        ref={rowRef}
        data-id={id}
        data-depth={depth}
        data-tip={tooltip}
        data-tip2={tipNote ? [tooltip2, tipNote()].filter(Boolean).join(' · ') || undefined : tooltip2}
        className={'tree-row' + (multi.has(id) ? ' sel' : '')}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!!dragPayload}
        onDragStart={(e) => dragPayload && e.dataTransfer.setData('text/plain', dragPayload)}
        onClick={(e) => click(id, e)}
        onDoubleClick={() => (leaf ? onDouble?.() : toggle())}
        onContextMenu={(e) => {
          if (menu) openMenuAt(e, id, menu())
          else setSel(id)
        }}
      >
        <span className="twisty">
          {busy ? (
            <span
              className="loader"
              onClick={
                cancellable && open
                  ? (e) => {
                      // a cancellable scan (Redis keys) is abandoned by clicking its spinner, like collapsing the node
                      e.stopPropagation()
                      setSel(id)
                      toggle()
                    }
                  : undefined
              }
            />
          ) : leaf ? (
            ''
          ) : (
            <span
              className="arrow"
              onClick={(e) => {
                e.stopPropagation()
                setSel(id)
                toggle()
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Chevron open={open} />
            </span>
          )}
        </span>
        <span className="ticon" data-tip={iconTip}>{icon}</span>
        {renaming ? (
          <input
            className="tree-input"
            autoFocus
            defaultValue={rawName ?? label}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => (e.target.dataset.cancel ? onCancelRename?.() : onRename?.(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                ;(e.target as HTMLInputElement).dataset.cancel = '1'
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
        ) : (
          <>
            <span className={'tlabel' + (rawName !== undefined ? ' strong' : '')}>{label}</span>
            {(badgeText ?? badge ?? badgePlaceholder) && (
              <span
                className={'badge' + (onBadgeClick ? ' clickable' : '')}
                data-tip={onBadgeClick ? badgeTitle : undefined}
                onClick={(e) => {
                  if (!onBadgeClick) return
                  e.stopPropagation()
                  const r = e.currentTarget.getBoundingClientRect()
                  onBadgeClick({ x: r.left, y: r.bottom + 4 })
                }}
                onDoubleClick={(e) => onBadgeClick && e.stopPropagation()}
              >
                {badgeText ?? badge ?? badgePlaceholder}
              </span>
            )}
          </>
        )}
      </div>
      {open && err && <div className="tree-err" style={{ paddingLeft: 36 + depth * 14 }}>{err}</div>}
      {open && busy && !kids && loadingText && <div className="tree-empty" style={{ paddingLeft: 36 + depth * 14 }}>{loadingText}</div>}
      {open && kidList && render && kidList.slice(0, kidsData ? shown : undefined).map((k) => render(k))}
      {open && kidsData && kidsData.length > shown && (
        <div
          className="tree-more"
          style={{ paddingLeft: 36 + depth * 14 }}
          onClick={() => setShown((n) => n + KID_PAGE)}
        >
          Show {Math.min(KID_PAGE, kidsData.length - shown).toLocaleString()} more ({(kidsData.length - shown).toLocaleString()} remaining)
        </div>
      )}
      {open && kidList && kidList.length === 0 && !err && (
        <div className="tree-empty" style={{ paddingLeft: 36 + depth * 14 }}>empty</div>
      )}
    </div>
  )
}

interface MenuItem {
  label: string
  onClick: () => void
  /** shortcut override (defaults to KEYS[label]) */
  key?: string
  children?: MenuItem[]
  danger?: boolean
  sep?: boolean
}
interface Menu {
  x: number
  y: number
  items: MenuItem[]
}

// label -> shortcut. Single source of truth for what is shown in the menu AND what the keyboard handler runs.
const SYSTEM_SCHEMAS = ['information_schema', 'pg_catalog']

const KEYS: Record<string, string> = {
  'New Query Console': '⇧⌘L',
  'Edit Data Source…': 'F4',
  'Open Table': 'F4',
  'Open Key Browser': 'F4',
  Open: 'F4',
  Rename: 'F2',
  Refresh: '⌘R', // tree item; outside the explorer the table view claims ⌘R for its grid (see TableView + lib/focusZone)
  'Copy Name': '⌥⌘C',
  'Copy Key Name': '⌘C',
  'Copy Key Names': '⌘C',
  'Copy Prefix': '⌘C',
  'Copy Prefixes': '⌘C',
  'Delete Data Source…': '⌘⌫',
  'Drop Database…': '⌘⌫',
  'Drop…': '⌘⌫',
  'Delete Folder': '⌘⌫'
}

function comboOf(e: KeyboardEvent): string {
  const m = e.metaKey || e.ctrlKey
  if (e.key === 'F2') return 'F2'
  if (e.key === 'F4') return 'F4'
  if (m && !e.shiftKey && !e.altKey && e.code === 'KeyR') return '⌘R'
  if (m && e.shiftKey && !e.altKey && e.code === 'KeyL') return '⇧⌘L'
  if (m && e.altKey && !e.shiftKey && e.code === 'KeyC') return '⌥⌘C'
  // plain copy: only Redis key / prefix rows declare it, so on other rows the browser's own copy is left alone
  if (m && !e.shiftKey && !e.altKey && e.code === 'KeyC') return '⌘C'
  if (m && !e.shiftKey && !e.altKey && (e.key === 'Backspace' || e.key === 'Delete')) return '⌘⌫'
  return ''
}

export default function Explorer({
  onOpen, onEdit, onConsole, onTableRenamed, onObjectGone, onRefreshed, reloadKey, activeTarget, onSources, onKeyRenamed, onKeysGone, treeRefresh, revealRequest
}: Props): React.JSX.Element {
  const [sources, setSources] = useState<DataSource[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [filter, setFilter] = useState('')
  const [tick, setTick] = useState(0)
  const [sel, setSelState] = useState('')
  const [multi, setMulti] = useState<Set<string>>(new Set())
  const anchor = useRef('')
  const infos = useRef<Record<string, NodeInfo>>({})
  const ctl = useRef<Record<string, NodeCtl>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialSession.folders))
  const [menu, setMenu] = useState<Menu | null>(null)
  // inline name editor: renaming an existing folder, or creating one under parentId
  const [editing, setEditing] = useState<{ id: string | 'new'; parentId: string | null } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [picker, setPicker] = useState<{ dsId: string; database?: string; schema?: string; dynamo?: boolean; x: number; y: number } | null>(null)
  /** table names per schema node id (from one cheap query per database), for the schema count pill */
  const [tblNames, setTblNames] = useState<Record<string, string[]>>({})
  const [creating, setCreating] = useState<(CreateReq & { nodeId: string }) | null>(null)
  const dbTotals = useRef<Record<string, number>>({})
  /** per Redis source: the key delimiter last rendered and how often it changed (a change re-scans / regroups its databases) */
  const delimSeen = useRef<Record<string, { d: string; n: number }>>({})
  const schemaTotals = useRef<Record<string, number>>({})
  const [retry, setRetry] = useState<'idle' | 'busy' | 'still'>('idle')
  const [refreshes, setRefreshes] = useState<Record<string, number>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const builders = useRef<Record<string, () => MenuItem[]>>({})
  const [collapseKey, setCollapseKey] = useState(0)
  const [expandKey, setExpandKey] = useState(0)
  const [reveal, setReveal] = useState<{ target: string; n: number; expand?: boolean } | null>(null)

  // ---- expansion persistence: `restore` = ids still to re-expand (consumed by Node on mount), `live` = currently expanded ids ----
  const restore = useRef<Set<string>>(new Set(initialSession.expanded))
  const live = useRef<Set<string>>(new Set(initialSession.expanded))
  const sessionReady = useRef(false)
  const track = useCallback((id: string, isOpen: boolean) => {
    if (isOpen) live.current.add(id)
    else live.current.delete(id)
    if (sessionReady.current) patchSession({ expanded: [...live.current] })
  }, [])
  const onSourcesRef = useRef(onSources)
  onSourcesRef.current = onSources

  const reload = useCallback(async () => {
    const [s, f]: [DataSource[], Folder[]] = await Promise.all([window.api.listSources(), window.api.listFolders()])
    if (!sessionReady.current) {
      // forget expansion of data sources / folders that no longer exist; don't auto-expand sources whose keychain
      // password is unreadable (that would only show an error per node); they stay in `live` for a later run
      const ids = new Set(s.map((d) => d.id))
      const unreadable = s.filter((d) => d.passwordUnavailable).map((d) => d.id)
      for (const id of [...live.current]) if (!ids.has(id.split('/')[0])) (live.current.delete(id), restore.current.delete(id))
      for (const id of [...restore.current]) if (unreadable.includes(id.split('/')[0])) restore.current.delete(id)
      const fids = new Set(f.map((x) => x.id))
      setOpen((o) => new Set([...o].filter((x) => fids.has(x))))
      sessionReady.current = true
      patchSession({ expanded: [...live.current] })
    }
    setSources(s)
    setFolders(f)
    onSourcesRef.current?.(s)
  }, [])
  // persist which folders are expanded (only after the first load, so a failed load can't wipe the saved state)
  useEffect(() => {
    if (sessionReady.current) patchSession({ folders: [...open] })
  }, [open])

  useEffect(() => {
    void reload()
  }, [reload, reloadKey])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])

  const f = filter.toLowerCase()
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
    await reload()
  }

  const expand = (id: string): void => setOpen((o) => new Set(o).add(id))
  const toggle = (id: string): void =>
    setOpen((o) => {
      const n = new Set(o)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const startNewFolder = (parentId: string | null): void => {
    if (parentId) expand(parentId)
    setEditing({ id: 'new', parentId })
  }
  const commitName = (name: string): void => {
    const e = editing
    setEditing(null)
    if (!e) return
    if (e.id === 'new') {
      if (name.trim()) void run(() => window.api.createFolder(name, e.parentId))
    } else if (name.trim()) void run(() => window.api.renameFolder(e.id, name))
  }

  const onDrop = (e: React.DragEvent, folderId: string | null): void => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const [kind, id] = e.dataTransfer.getData('text/plain').split(':')
    if (folderId) expand(folderId)
    if (kind === 'ds') void run(() => window.api.moveSource(id, folderId))
    else if (kind === 'folder' && id !== folderId) void run(() => window.api.moveFolder(id, folderId))
  }

  const moveTargets = (): { id: string; label: string }[] => {
    const out: { id: string; label: string }[] = []
    const walk = (parent: string | null, depth: number): void => {
      for (const fo of folders.filter((x) => x.parentId === parent)) {
        out.push({ id: fo.id, label: '  '.repeat(depth) + fo.name })
        walk(fo.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }

  const sourceMenu = (ds: DataSource): Menu['items'] => [
    ...(ds.folderId
      ? [{ label: 'Remove from Folder', sep: true, onClick: () => void run(() => window.api.moveSource(ds.id, null)) }]
      : []),
    ...moveTargets()
      .filter((t) => t.id !== ds.folderId)
      .map((t, i) => ({
        label: 'Move to 📁 ' + t.label.trimStart(),
        sep: i === 0 && !ds.folderId,
        onClick: () => void run(() => window.api.moveSource(ds.id, t.id))
      }))
  ]

  const refreshFolder = (folderId: string): void => {
    const ids = new Set([folderId])
    for (let grew = true; grew; ) {
      grew = false
      for (const x of folders) if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) (ids.add(x.id), (grew = true))
    }
    for (const d of sources) if (d.folderId && ids.has(d.folderId)) refresh(d.id)
  }

  const folderItems = (fo: Folder): MenuItem[] => [
    { label: 'New Folder', onClick: () => startNewFolder(fo.id) },
    { label: 'New Data Source…', onClick: () => onEdit(null, fo.id) },
    { label: 'Rename', onClick: () => setEditing({ id: fo.id, parentId: fo.parentId }) },
    { label: 'Refresh', sep: true, onClick: () => refreshFolder(fo.id) },
    { label: 'Delete Folder', danger: true, sep: true, onClick: () => void run(() => window.api.deleteFolder(fo.id)) }
  ]

  const nameInput = (initial: string, depth: number): React.JSX.Element => (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="twisty" />
      <span className="ticon"><Icon name="folder" /></span>
      <input
        className="tree-input"
        autoFocus
        defaultValue={initial}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => (e.target.dataset.cancel ? setEditing(null) : commitName(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            ;(e.target as HTMLInputElement).dataset.cancel = '1'
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
    </div>
  )

  const collapseAll = (): void => {
    setCollapseKey((k) => k + 1)
    setOpen(new Set())
  }
  const expandAll = (): void => {
    setExpandKey((k) => k + 1)
    setOpen(new Set(folders.map((x) => x.id)))
  }
  /** opens the folder chain of the data source, then selects (and optionally expands) the node `target` */
  const revealTarget = (target: string, expand = false): void => {
    const dsId = target.split('/')[0]
    const chain = new Set(open)
    for (let cur = sources.find((x) => x.id === dsId)?.folderId ?? null; cur; cur = folders.find((x) => x.id === cur)?.parentId ?? null) {
      chain.add(cur)
    }
    setOpen(chain)
    const n = Date.now()
    setReveal({ target, n, ...(expand ? { expand: true } : {}) })
    window.setTimeout(() => setReveal((r) => (r && r.n === n ? null : r)), 5000)
  }
  const locate = (): void => {
    if (activeTarget) revealTarget(activeTarget)
  }
  const revealSeen = useRef<number | null>(null)
  useEffect(() => {
    if (!revealRequest || revealSeen.current === revealRequest.n) return
    revealSeen.current = revealRequest.n
    revealTarget(revealRequest.target, !!revealRequest.expand)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest])
  // ---- selection (single, Cmd/Ctrl-click toggle, Shift-click / Shift+Arrow range) ----
  const rowIds = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('.explorer .tree-row[data-id]')].map((r) => r.dataset.id!)
  const rangeIds = (a: string, b: string): string[] => rangeBetween(rowIds(), a, b)
  function select(id: string): void {
    setSelState(id)
    setMulti(new Set([id]))
    anchor.current = id
  }
  const click = (id: string, e: React.MouseEvent): void => {
    if (e.shiftKey && anchor.current) {
      setSelState(id)
      setMulti(new Set(rangeIds(anchor.current, id)))
    } else if (e.metaKey || e.ctrlKey) {
      setMulti((m) => {
        const n = new Set(m)
        n.has(id) ? n.delete(id) : n.add(id)
        return n
      })
      setSelState(id)
      anchor.current = id
    } else select(id)
  }
  /** a refresh bypasses the local cache for what it covers: the next load of those lists asks the server and updates the cache */
  const staleFor = (id: string): void => {
    const [dsId, a, b] = id.split('/')
    const src = sources.find((x) => x.id === dsId)
    if (!src || id.startsWith('folder:')) return
    if (a === undefined) return markStale(dsId)
    const kind = dsKind(src)
    if (kind === 'redis') {
      const n = /^db(\d+)$/.exec(a)
      if (n) markStale(dsId, cacheKeys.redisTree(Number(n[1])))
    } else if (kind === 'postgres') {
      if (a === '__server') {
        markStale(dsId, cacheKeys.pgRoles)
        markStale(dsId, cacheKeys.pgTablespaces)
      } else if (b === undefined) {
        markStale(dsId, cacheKeys.pgSchemas(a))
        markStale(dsId, cacheKeys.pgTableNames(a))
        markStale(dsId, cacheKeys.pgTablesOf(a))
      } else markStale(dsId, cacheKeys.pgTables(a, b))
    }
  }
  const refresh = (id: string): void => {
    staleFor(id)
    setRefreshes((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 }))
    onRefreshed(id)
  }
  /** after creating something under nodeId: expand/load that node and refresh it so the new item shows up */
  const revealCreated = (nodeId: string): void => {
    ctl.current[nodeId]?.setOpen(true)
    refresh(nodeId)
  }
  // a node reloads when it or any ancestor was refreshed (or the global refresh was pressed)
  const rv = (id: string): number =>
    tick + Object.entries(refreshes).reduce((n, [k, v]) => (id === k || id.startsWith(k + '/') ? n + v : n), 0)
  // App asks for a re-scan of a Redis database (a key tab renamed / deleted its key): only if that node was ever opened
  useEffect(() => {
    if (!treeRefresh) return
    const c = ctl.current[treeRefresh.id]
    if (c && (c.isOpen || c.loaded)) refresh(treeRefresh.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeRefresh])
  const copy = (t: string): void => void navigator.clipboard.writeText(t)
  const quote = (x: string): string => '"' + x.replace(/"/g, '""') + '"'
  const showErr = (e: unknown): void =>
    setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  /** delete Redis keys (already confirmed); tabs of those keys close, the database node re-scans */
  const deleteRedisKeys = (dsId: string, db: number, dbId: string, keys: string[]): Promise<void> => {
    setError('')
    return window.api.redis
      .delete(dsId, db, keys)
      .then(() => onKeysGone?.(dsId, db, keys))
      .catch(showErr)
      .then(() => refresh(dbId))
  }
  const confirmDeleteKeys = (dsId: string, db: number, dbId: string, keys: string[]): void => {
    const shown = keys.map(redisDisplayName)
    const what = keys.length === 1 ? `key "${shown[0]}"` : `${keys.length} keys`
    if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return
    void deleteRedisKeys(dsId, db, dbId, keys)
  }
  // ---- bulk actions for a multi-selection ----
  const selectedInfos = (): NodeInfo[] => [...multi].map((i) => infos.current[i]).filter(Boolean)
  const bulkItems = (): MenuItem[] | null => {
    const list = selectedInfos()
    if (multi.size < 2 || list.length < 2) return null
    const kinds = new Set(list.map((x) => x.kind))
    const one = kinds.size === 1 ? [...kinds][0] : null
    const n = list.length
    const names = list.map((x) => x.copyText ?? x.name)
    const items: MenuItem[] = [
      {
        label: 'Refresh',
        key: '⌘R',
        onClick: () =>
          list.forEach((x) => {
            if (x.refreshId) {
              refresh(x.refreshId) // Redis key tree node: re-scan its database
            } else if (x.engine === 'dynamodb' || x.engine === 'redis') {
              // DynamoDB tables / Redis databases sit directly under the data source
              refresh(x.kind === 'table' ? `${x.dsId}/${x.name}` : x.dsId)
            } else if (x.kind === 'table') {
              refresh(`${x.dsId}/${x.database}/${x.schema}`)
              refresh(`${x.dsId}/${x.database}/${x.schema}/${x.name}`)
            } else {
              refresh([x.dsId, x.database, x.kind === 'schema' ? x.schema : undefined].filter(Boolean).join('/'))
            }
          })
      },
      one === 'rkey' || one === 'rfolder'
        ? { label: one === 'rkey' ? 'Copy Key Names' : 'Copy Prefixes', key: '⌘C', onClick: () => copy(names.join('\n')) }
        : { label: 'Copy Names', key: '⌥⌘C', onClick: () => copy(names.join('\n')) }
    ]
    const bulkRun = async (
      what: string,
      fn: (x: NodeInfo) => Promise<unknown>,
      after: (x: NodeInfo) => void
    ): Promise<void> => {
      setError('')
      const failed: string[] = []
      for (const x of list) {
        try {
          await fn(x)
          after(x)
        } catch (e) {
          failed.push(`${x.name} (${String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')})`)
        }
      }
      if (failed.length) setError(`Could not ${what}: ${failed.join('; ')}`)
      setSelState('')
      setMulti(new Set())
      anchor.current = ''
      await reload()
    }
    const listNames = (): string => names.slice(0, 12).map((x) => '  • ' + x).join('\n') + (n > 12 ? `\n  … and ${n - 12} more` : '')
    if (one === 'rkey') {
      items.push({
        label: `Delete ${n} Keys…`,
        danger: true,
        sep: true,
        key: '⌘⌫',
        onClick: () => {
          if (!window.confirm(`Delete ${n} keys?\n\n${listNames()}\n\nThis cannot be undone.`)) return
          const byDb = new Map<string, NodeInfo[]>()
          for (const x of list) byDb.set(`${x.dsId}|${x.db}`, [...(byDb.get(`${x.dsId}|${x.db}`) ?? []), x])
          setSelState('')
          setMulti(new Set())
          anchor.current = ''
          for (const g of byDb.values()) void deleteRedisKeys(g[0].dsId, g[0].db!, g[0].refreshId!, g.map((x) => x.redisKey!))
        }
      })
    } else if (one === 'db' && !list.some((x) => x.engine)) {
      items.push({
        label: `Drop ${n} Databases…`,
        danger: true,
        sep: true,
        key: '⌘⌫',
        onClick: () => {
          if (!window.confirm(`Drop ${n} databases?\n\n${listNames()}\n\nAll their data will be permanently deleted. This cannot be undone.`)) return
          void bulkRun(
            'drop some databases',
            (x) => window.api.dropDatabase(x.dsId, x.database!),
            (x) => {
              onObjectGone({ dsId: x.dsId, database: x.database })
              refresh(x.dsId)
            }
          )
        }
      })
    } else if (one === 'table' && !list.some((x) => x.engine)) {
      items.push({
        label: `Drop ${n} Tables…`,
        danger: true,
        sep: true,
        key: '⌘⌫',
        onClick: () => {
          if (!window.confirm(`Drop ${n} tables/views?\n\n${listNames()}\n\nThis cannot be undone.`)) return
          void bulkRun(
            'drop some tables',
            (x) => window.api.dropTable(x.dsId, x.database!, x.schema!, x.name, x.tableKind ?? 'table'),
            (x) => {
              onObjectGone({ dsId: x.dsId, database: x.database, schema: x.schema, table: x.name })
              refresh(`${x.dsId}/${x.database}/${x.schema}`)
            }
          )
        }
      })
    } else if (one === 'ds') {
      items.push({
        label: `Delete ${n} Data Sources…`,
        danger: true,
        sep: true,
        key: '⌘⌫',
        onClick: () => {
          if (!window.confirm(`Remove ${n} data sources?\n\n${listNames()}\n\nThis does not touch the databases.`)) return
          void bulkRun(
            'delete some data sources',
            (x) => window.api.deleteSource(x.dsId),
            (x) => onObjectGone({ dsId: x.dsId })
          )
        }
      })
    }
    return items
  }
  const bulkRef = useRef<() => MenuItem[] | null>(() => null)
  bulkRef.current = bulkItems

  // ---- keyboard navigation: arrows (Shift extends), Left/Right collapse/expand, Enter opens ----
  const navRef = useRef<(e: KeyboardEvent) => boolean>(() => false)
  navRef.current = (e) => {
    const k = e.key
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(k) || e.metaKey || e.ctrlKey || e.altKey) return false
    const ids = rowIds()
    if (!ids.length) return false
    // with nothing highlighted (after Escape) the arrows resume from the last selected row; Enter needs a real selection
    const cur = selRef.current || (k === 'Enter' ? '' : kbAnchor.current)
    const i = ids.indexOf(cur)
    const go = (j: number, extend: boolean): void => {
      const id = ids[Math.max(0, Math.min(ids.length - 1, j))]
      if (extend) {
        if (!anchor.current) anchor.current = cur || id
        setSelState(id)
        setMulti(new Set(rangeIds(anchor.current, id)))
      } else select(id)
      document.querySelector(`.explorer .tree-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    const depthOf = (id: string): number =>
      Number(document.querySelector<HTMLElement>(`.explorer .tree-row[data-id="${CSS.escape(id)}"]`)?.dataset.depth ?? 0)
    if (i < 0) {
      if (k === 'ArrowDown' || k === 'ArrowUp') go(0, false)
      else return false
      return true
    }
    if (k === 'ArrowDown') go(i + 1, e.shiftKey)
    else if (k === 'ArrowUp') go(i - 1, e.shiftKey)
    else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      const isFolder = cur.startsWith('folder:')
      const isOpen = isFolder ? open.has(cur.slice(7)) : ctl.current[cur]?.isOpen
      const expandable = isFolder ? true : ctl.current[cur] && !ctl.current[cur].leaf
      if (k === 'ArrowRight') {
        if (expandable && !isOpen) {
          if (isFolder) expand(cur.slice(7))
          else ctl.current[cur].setOpen(true)
        } else if (isOpen && ids[i + 1] && depthOf(ids[i + 1]) > depthOf(cur)) go(i + 1, false)
      } else if (expandable && isOpen) {
        if (isFolder) setOpen((o) => (o.delete(cur.slice(7)), new Set(o)))
        else ctl.current[cur].setOpen(false)
      } else {
        // move to parent: nearest previous row with a smaller depth
        const d = depthOf(cur)
        for (let j = i - 1; j >= 0; j--) {
          if (depthOf(ids[j]) < d) {
            go(j, false)
            break
          }
        }
      }
    } else if (k === 'Enter') {
      if (cur.startsWith('folder:')) toggle(cur.slice(7))
      else ctl.current[cur]?.activate()
    }
    return true
  }

  // keyboard shortcuts act on the selected tree item, using the same items as its right-click menu
  const selRef = useRef('')
  selRef.current = sel
  const editingRef = useRef(false)
  editingRef.current = !!editing || !!renaming
  // Escape = "remove selection". The keyboard anchor remembers the last selected row so the arrow keys resume from it
  // after the highlight is gone (kbAnchor is never persisted; nothing about the selection is saved in the session).
  const kbAnchor = useRef('')
  if (sel) kbAnchor.current = sel
  const popupOpenRef = useRef(false) // context menu / db picker / create dialog own Escape while they are open
  popupOpenRef.current = !!menu || !!picker || !!creating
  const clearSelRef = useRef<() => boolean>(() => false)
  clearSelRef.current = () => {
    if (multi.size > 1) {
      // several rows -> collapse to just the primary row
      const keep = multi.has(sel) ? sel : [...multi][multi.size - 1]
      setSelState(keep)
      setMulti(new Set([keep]))
      anchor.current = keep
      return true
    }
    if (multi.size === 1 || sel) {
      // a single row -> deselect it entirely; arrows resume from the remembered anchor
      kbAnchor.current = sel || [...multi][0]
      setSelState('')
      setMulti(new Set())
      anchor.current = ''
      return true
    }
    return false
  }
  // Shift+Esc (see useSidebarFocus): the tree takes keyboard focus. Row: the selected one, else the last selected one (after Escape),
  // else the one of the active tab (or its nearest visible ancestor), else the first. The arrows / Enter handler above then drives it.
  const activeTargetRef = useRef(activeTarget)
  activeTargetRef.current = activeTarget
  const rootRef = useRef<HTMLDivElement>(null)
  const focusTreeRef = useRef<() => void>(() => {})
  focusTreeRef.current = () => {
    const ids = rowIds()
    let id = [selRef.current, kbAnchor.current].find((x) => x && ids.includes(x)) ?? ''
    if (!id && activeTargetRef.current) {
      const parts = activeTargetRef.current.split('/')
      for (let n = parts.length; n > 0 && !id; n--) {
        const p = parts.slice(0, n).join('/')
        if (ids.includes(p)) id = p
      }
    }
    if (!id) id = ids[0] ?? ''
    if (id && id !== selRef.current) select(id)
    markExplorerActive()
    rootRef.current?.focus({ preventScroll: true })
    if (id) document.querySelector(`.explorer .tree-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  useEffect(() => {
    const on = (): void => focusTreeRef.current()
    window.addEventListener(FOCUS_EXPLORER_EVENT, on)
    return () => window.removeEventListener(FOCUS_EXPLORER_EVENT, on)
  }, [])
  useEffect(() => {
    // shortcuts only apply after the last click was inside the explorer (so e.g. Cmd+Backspace elsewhere can't drop a table).
    // The click tracking is shared (lib/focusZone) so the table view can tell which pane owns Cmd/Ctrl+R.
    const untrack = trackExplorerClicks()
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      // (a keystroke aimed at an element outside the tree never belongs here, even if the last click was inside it)
      if (!keyBelongsToExplorer(e.target)) return
      if (t.closest('input, textarea, select, .modal-bg')) return
      if (editingRef.current) return
      if (e.key === 'Escape') {
        // plain Escape only (Shift+Esc moves focus between the tree and the editor pane); open popups / modals keep their own Escape
        if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
        if (popupOpenRef.current || document.querySelector('.modal-bg, .cd-bg') || !keyBelongsToExplorer(e.target)) return
        clearSelRef.current()
        return
      }
      if (navRef.current(e)) {
        e.preventDefault()
        return
      }
      const combo = comboOf(e)
      if (!combo) return
      const items = bulkRef.current() ?? builders.current[selRef.current]?.()
      if (!items) return
      const item = items.find((it) => (it.key ?? KEYS[it.label]) === combo)
      if (!item) return
      e.preventDefault()
      item.onClick()
    }
    window.addEventListener('keydown', onKey)
    // lets the open tab take Cmd/Ctrl+R when nothing here would handle it (see focusZone `explorerOwnsRefresh`)
    const unprobe = setExplorerRefreshProbe(() => {
      if (editingRef.current) return false
      const items = bulkRef.current() ?? builders.current[selRef.current]?.()
      return !!items?.some((it) => (it.key ?? KEYS[it.label]) === '⌘R')
    })
    return () => {
      unprobe()
      untrack()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const openMenu = (e: React.MouseEvent, id: string, items: Menu['items']): void => {
    e.preventDefault()
    e.stopPropagation()
    // right-clicking inside a multi-selection acts on the whole selection
    if (multi.size > 1 && multi.has(id)) {
      const bulk = bulkItems()
      if (bulk) {
        setMenu({ x: e.clientX, y: e.clientY, items: bulk })
        return
      }
    }
    select(id)
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const renderSource = (ds: DataSource, depth: number): React.JSX.Element => {
    const sep = (it: Menu['items'][number]): Menu['items'][number] => ({ ...it, sep: true })
    return (
    <Node
      key={ds.id}
      id={ds.id}
      label={ds.name}
      tooltip2={`${ds.host}:${ds.port} · ${ds.user}@${ds.database || 'postgres'}`}
      tipNote={() => cacheNote(cacheMeta(ds.id, cacheKeys.pgDbs))}
      info={{ kind: 'ds', dsId: ds.id, dsName: ds.name, name: ds.name }}
      rawName={ds.name}
      icon={<Icon name={ds.passwordUnavailable ? 'warning' : 'postgres'} />}
      iconTip={typeLabel('ds')}
      badgeTitle="Choose which databases are shown"
      onBadgeClick={(a) => setPicker({ dsId: ds.id, x: a.x, y: a.y })}
      badgeOf={(kids) => {
        const n = kids.filter((k) => k.kind !== 'server').length
        const total = dbTotals.current[ds.id] ?? n
        return ds.visibleDbs ? `${n} of ${total}` : String(total)
      }}
      depth={depth}
      forceReload={rv(ds.id)}
      dragPayload={'ds:' + ds.id}
      renaming={renaming === ds.id}
      onCancelRename={() => setRenaming(null)}
      onRename={(name) => {
        setRenaming(null)
        if (name.trim() && name.trim() !== ds.name) void run(() => window.api.renameSource(ds.id, name))
      }}
      menu={() => {
        const base = sourceMenu(ds)
        return [
          { label: 'New Query Console', onClick: () => onConsole({ dsId: ds.id, dsName: ds.name, database: ds.database || 'postgres' }) },
          { label: 'New Database…', onClick: () => setCreating({ kind: 'database', dsId: ds.id, nodeId: ds.id }) },
          sep({ label: 'Edit Data Source…', onClick: () => onEdit(ds) }),
          { label: 'Rename', onClick: () => setRenaming(ds.id) },
          { label: 'Duplicate', onClick: () => void run(() => window.api.duplicateSource(ds.id)) },
          sep({ label: 'Refresh', onClick: () => refresh(ds.id) }),
          { label: 'Disconnect', onClick: () => void window.api.disconnect(ds.id).then(() => refresh(ds.id)) },
          sep({
            label: 'Sort Databases',
            onClick: () => undefined,
            children: ([
              ['name-asc', 'Name (A → Z)'],
              ['name-desc', 'Name (Z → A)'],
              ['size-desc', 'Size (largest first)'],
              ['size-asc', 'Size (smallest first)']
            ] as [DbSort, string][]).map(([k, label]) => ({
              label: ((ds.dbSort ?? 'name-asc') === k ? '✓ ' : '    ') + label,
              onClick: () => void run(() => window.api.setSort(ds.id, k)).then(() => refresh(ds.id))
            }))
          }),
          sep({ label: 'Copy Name', onClick: () => copy(ds.name) }),
          ...base,
          sep({
            label: 'Delete Data Source…',
            danger: true,
            onClick: () => {
              if (!window.confirm(`Remove data source "${ds.name}"? This does not touch the database.`)) return
              void run(() => window.api.deleteSource(ds.id)).then(() => onObjectGone({ dsId: ds.id }))
            }
          })
        ]
      }}
      load={() =>
        cached(ds.id, cacheKeys.pgDbs, () => window.api.databases(ds.id) as Promise<string[]>).then((a: string[]) => {
          dbTotals.current[ds.id] = a.length
          const vis = ds.visibleDbs ? a.filter((n) => ds.visibleDbs!.includes(n)) : a
          return [...vis.map((name) => ({ name })), { name: 'Server Objects', kind: 'server' }]
        })
      }
      render={(d) => {
        if (d.kind === 'server') {
          const soId = `${ds.id}/__server`
          return (
            <Node
              key="__server"
              id={soId}
              label="Server Objects"
              icon={<Icon name="server" />}
              iconTip={typeLabel('server')}
              depth={depth + 1}
              forceReload={rv(soId)}
              load={async () => [
                { name: 'Roles', kind: 'roles' },
                { name: 'Tablespaces', kind: 'tablespaces' }
              ]}
              render={(g) => (
                <Node
                  key={g.name}
                  id={`${soId}/${g.name}`}
                  label={g.name}
                  icon={<Icon name="folder" />}
                  iconTip={typeLabel(g.kind)}
                  depth={depth + 2}
                  forceReload={rv(`${soId}/${g.name}`)}
                  badgeOf={(kids) => String(kids.length)}
                  load={() =>
                    (g.kind === 'roles'
                      ? cached(ds.id, cacheKeys.pgRoles, () => window.api.roles(ds.id) as Promise<string[]>)
                      : cached(ds.id, cacheKeys.pgTablespaces, () => window.api.tablespaces(ds.id) as Promise<string[]>)
                    ).then((a: string[]) => a.map((name) => ({ name })))
                  }
                  render={(o) => (
                    <Node
                      key={o.name}
                      id={`${soId}/${g.name}/${o.name}`}
                      label={o.name}
                      icon={<Icon name={g.kind === 'roles' ? 'role' : 'tablespace'} />}
                      iconTip={typeLabel(g.kind === 'roles' ? 'role' : 'tablespace')}
                      depth={depth + 3}
                      leaf
                    />
                  )}
                />
              )}
            />
          )
        }
        const dbId = `${ds.id}/${d.name}`
        return (
        <Node
          key={d.name}
          id={dbId}
          label={d.name}
          icon={<Icon name="database" />}
          iconTip={typeLabel('database')}
          info={{ kind: 'db', dsId: ds.id, dsName: ds.name, name: d.name, database: d.name }}
          tipNote={() => cacheNote(cacheMeta(ds.id, cacheKeys.pgSchemas(d.name)))}
          badgePlaceholder="…"
          badgeTitle="Choose which schemas are shown"
          onBadgeClick={(a) => setPicker({ dsId: ds.id, database: d.name, x: a.x, y: a.y })}
          badgeOf={(kids) => `${kids.length} of ${schemaTotals.current[dbId] ?? kids.length}`}
          depth={depth + 1}
          forceReload={rv(dbId)}
          menu={() => [
              { label: 'New Query Console', onClick: () => onConsole({ dsId: ds.id, dsName: ds.name, database: d.name }) },
              { label: 'New Schema…', onClick: () => setCreating({ kind: 'schema', dsId: ds.id, database: d.name, nodeId: dbId }) },
              sep({ label: 'Refresh', onClick: () => refresh(dbId) }),
              sep({ label: 'Copy Name', onClick: () => copy(d.name) }),
              sep({
                label: 'Drop Database…',
                danger: true,
                onClick: () => {
                  if (!window.confirm(`Drop database "${d.name}"?\n\nAll its schemas, tables and data will be permanently deleted. This cannot be undone.`)) return
                  setError('')
                  window.api
                    .dropDatabase(ds.id, d.name)
                    .then(() => {
                      onObjectGone({ dsId: ds.id, database: d.name })
                      refresh(ds.id)
                    })
                    .catch(showErr)
                }
              })
            ]}
          load={() =>
            cached(ds.id, cacheKeys.pgSchemas(d.name), () => window.api.schemasAll(ds.id, d.name) as Promise<string[]>).then((a: string[]) => {
              schemaTotals.current[dbId] = a.length
              // one cheap query fills every schema's table count pill without expanding them
              cached(ds.id, cacheKeys.pgTableNames(d.name), () => window.api.tableNames(ds.id, d.name) as Promise<Record<string, string[]>>).then(
                (m: Record<string, string[]>) =>
                  setTblNames((cur) => {
                    const next = { ...cur }
                    for (const s of a) next[`${dbId}/${s}`] = m[s] ?? []
                    return next
                  }),
                () => undefined
              )
              const saved = ds.schemaFilter?.[d.name]
              return a.filter((n) => (saved ? saved.includes(n) : !SYSTEM_SCHEMAS.includes(n))).map((name) => ({ name }))
            })
          }
          render={(sc) => {
            const scId = `${dbId}/${sc.name}`
            return (
            <Node
              key={sc.name}
              id={scId}
              label={sc.name}
              icon={<Icon name="schema" />}
              iconTip={typeLabel('schema')}
              info={{ kind: 'schema', dsId: ds.id, dsName: ds.name, name: sc.name, database: d.name, schema: sc.name }}
              badgePlaceholder="…"
              badgeTitle="Choose which tables are shown"
              onBadgeClick={(a) => setPicker({ dsId: ds.id, database: d.name, schema: sc.name, x: a.x, y: a.y })}
              badgeText={(() => {
                const all = tblNames[scId]
                if (!all) return undefined
                const flt = ds.tableFilter?.[`${d.name}/${sc.name}`]
                return flt ? `${applyTableFilter(flt, all).length} of ${all.length}` : String(all.length)
              })()}
              depth={depth + 2}
              forceReload={rv(scId)}
              menu={() => [
                  { label: 'New Query Console', onClick: () => onConsole({ dsId: ds.id, dsName: ds.name, database: d.name, schema: sc.name }) },
                  { label: 'New Table…', onClick: () => setCreating({ kind: 'table', dsId: ds.id, database: d.name, schema: sc.name, nodeId: scId }) },
                  {
                    label: 'New View…',
                    onClick: () =>
                      onConsole({
                        dsId: ds.id, dsName: ds.name, database: d.name, schema: sc.name,
                        sql: `create view ${quote(sc.name)}.view_name as\nselect *\nfrom ${quote(sc.name)}.table_name;\n`
                      })
                  },
                  sep({ label: 'Refresh', onClick: () => refresh(scId) }),
                  sep({ label: 'Copy Name', onClick: () => copy(sc.name) })
                ]}
              load={() =>
                cached(ds.id, cacheKeys.pgTables(d.name, sc.name), () => window.api.tables(ds.id, d.name, sc.name) as Promise<{ name: string; kind: string }[]>).then((rows: { name: string; kind: string }[]) => {
                  const all = rows.map((r) => r.name)
                  setTblNames((cur) => (cur[scId]?.join('\n') === all.join('\n') ? cur : { ...cur, [scId]: all }))
                  const keep = new Set(applyTableFilter(ds.tableFilter?.[`${d.name}/${sc.name}`], all))
                  return rows.filter((r) => keep.has(r.name))
                })
              }
              render={(t) => {
                if (f && !t.name.toLowerCase().includes(f)) return <span key={t.name} />
                const tId = `${scId}/${t.name}`
                const ref = { dsId: ds.id, dsName: ds.name, database: d.name, schema: sc.name, table: t.name, kind: t.kind ?? 'table' }
                const qn = `${quote(sc.name)}.${quote(t.name)}`
                return (
                  <Node
                    key={t.name}
                    id={tId}
                    forceReload={rv(tId)}
                    label={t.name}
                    tooltip={`${sc.name}.${t.name}`}
                    icon={<Icon name={t.kind === 'view' || t.kind === 'matview' ? 'view' : 'table'} />}
                    iconTip={typeLabel(t.kind)}
                    depth={depth + 3}
                    leaf
                    info={{ kind: 'table', dsId: ds.id, dsName: ds.name, name: t.name, database: d.name, schema: sc.name, tableKind: t.kind ?? 'table' }}
                    renaming={renaming === tId}
                    onCancelRename={() => setRenaming(null)}
                    onRename={(name) => {
                      setRenaming(null)
                      const to = name.trim()
                      if (!to || to === t.name) return
                      window.api
                        .renameTable(ds.id, d.name, sc.name, t.name, to)
                        .then(() => {
                          onTableRenamed(ds.id, d.name, sc.name, t.name, to)
                          const tf = ds.tableFilter?.[`${d.name}/${sc.name}`]
                          if (tf?.list?.includes(t.name))
                            void window.api.setTableFilter(ds.id, d.name, sc.name, { list: [...tf.list.filter((n) => n !== t.name), to] }).then(reload)
                          refresh(scId)
                        })
                        .catch(showErr)
                    }}
                    onDouble={() => onOpen(ref)}
                    menu={() => [
                        { label: 'Open Table', onClick: () => onOpen(ref) },
                        {
                          label: 'New Query Console',
                          onClick: () =>
                            onConsole({ dsId: ds.id, dsName: ds.name, database: d.name, schema: sc.name, sql: `select * from ${qn} limit 100;\n` })
                        },
                        ...((t.kind ?? 'table') === 'table'
                          ? [sep({ label: 'New Column…', onClick: () => setCreating({ kind: 'column', dsId: ds.id, database: d.name, schema: sc.name, table: t.name, nodeId: tId }) })]
                          : []),
                        sep({ label: 'Rename', onClick: () => setRenaming(tId) }),
                        sep({ label: 'Copy Name', onClick: () => copy(t.name) }),
                        { label: 'Copy Qualified Name', onClick: () => copy(`${sc.name}.${t.name}`) },
                        { label: 'Copy SELECT Statement', onClick: () => copy(`select * from ${qn};`) },
                        sep({ label: 'Refresh', onClick: () => (refresh(scId), refresh(tId)) }),
                        sep({
                          label: 'Drop…',
                          danger: true,
                          onClick: () => {
                            if (!window.confirm(`Drop ${t.kind ?? 'table'} ${sc.name}.${t.name}? This cannot be undone.`)) return
                            window.api
                              .dropTable(ds.id, d.name, sc.name, t.name, t.kind ?? 'table')
                              .then(() => {
                                onObjectGone({ dsId: ds.id, database: d.name, schema: sc.name, table: t.name })
                                refresh(scId)
                              })
                              .catch(showErr)
                          }
                        })
                      ]}
                  />
                )
              }}
            />
            )
          }}
        />
        )
      }}
    />
    )
  }

  /** DynamoDB data source: the tables sit directly under it (no databases / schemas / server objects). */
  const renderDynamoSource = (ds: DataSource, depth: number): React.JSX.Element => {
    const sep = (it: Menu['items'][number]): Menu['items'][number] => ({ ...it, sep: true })
    const cfg = ds.dynamo
    const region = cfg?.region ?? ''
    const auth = cfg?.authMode === 'keys' ? 'access key' : cfg?.authMode === 'profile' ? `profile ${cfg.profile ?? ''}` : 'default credentials'
    const tf = ds.tableFilter?.['dynamodb']
    const consoleOf = (sql?: string): void =>
      onConsole({ dsId: ds.id, dsName: ds.name, database: '', engine: 'dynamodb', region, ...(sql ? { sql } : {}) })
    return (
      <Node
        key={ds.id}
        id={ds.id}
        label={ds.name}
        tooltip2={`${region || 'default region'} · ${cfg?.endpoint ? cfg.endpoint + ' · ' : ''}${auth}`}
        tipNote={() => cacheNote(cacheMeta(ds.id, cacheKeys.ddbTables))}
        info={{ kind: 'ds', dsId: ds.id, dsName: ds.name, name: ds.name, engine: 'dynamodb' }}
        rawName={ds.name}
        icon={<Icon name={ds.passwordUnavailable ? 'warning' : 'dynamodb'} />}
        iconTip={typeLabel('dynamodb')}
        badgeTitle="Choose which tables are shown"
        onBadgeClick={(a) => setPicker({ dsId: ds.id, dynamo: true, x: a.x, y: a.y })}
        badgeOf={(kids) => {
          const total = dbTotals.current[ds.id] ?? kids.length
          return tf ? `${kids.length} of ${total}` : String(total)
        }}
        depth={depth}
        forceReload={rv(ds.id)}
        dragPayload={'ds:' + ds.id}
        renaming={renaming === ds.id}
        onCancelRename={() => setRenaming(null)}
        onRename={(name) => {
          setRenaming(null)
          if (name.trim() && name.trim() !== ds.name) void run(() => window.api.renameSource(ds.id, name))
        }}
        menu={() => [
          { label: 'New Query Console', onClick: () => consoleOf() },
          sep({ label: 'Edit Data Source…', onClick: () => onEdit(ds) }),
          { label: 'Rename', onClick: () => setRenaming(ds.id) },
          { label: 'Duplicate', onClick: () => void run(() => window.api.duplicateSource(ds.id)) },
          sep({ label: 'Refresh', onClick: () => refresh(ds.id) }),
          { label: 'Disconnect', onClick: () => void window.api.disconnect(ds.id).then(() => refresh(ds.id)) },
          sep({ label: 'Copy Name', onClick: () => copy(ds.name) }),
          ...sourceMenu(ds),
          sep({
            label: 'Delete Data Source…',
            danger: true,
            onClick: () => {
              if (!window.confirm(`Remove data source "${ds.name}"? This does not touch the DynamoDB tables.`)) return
              void run(() => window.api.deleteSource(ds.id)).then(() => onObjectGone({ dsId: ds.id }))
            }
          })
        ]}
        load={() =>
          cached(ds.id, cacheKeys.ddbTables, () => window.api.dynamo.tables(ds.id)).then((all: string[]) => {
            dbTotals.current[ds.id] = all.length
            const keep = new Set(applyTableFilter(tf, all))
            return all.filter((n) => keep.has(n)).map((name) => ({ name, kind: 'table' }))
          })
        }
        render={(t) => {
          if (f && !t.name.toLowerCase().includes(f)) return <span key={t.name} />
          const tId = `${ds.id}/${t.name}`
          const ref: TableRef = { dsId: ds.id, dsName: ds.name, database: '', schema: '', table: t.name, kind: 'table', engine: 'dynamodb', region }
          return (
            <Node
              key={t.name}
              id={tId}
              forceReload={rv(tId)}
              label={t.name}
              tooltip={t.name}
              icon={<Icon name="table" />}
              iconTip={typeLabel('table')}
              depth={depth + 1}
              leaf
              info={{ kind: 'table', dsId: ds.id, dsName: ds.name, name: t.name, tableKind: 'table', engine: 'dynamodb' }}
              onDouble={() => onOpen(ref)}
              menu={() => [
                { label: 'Open Table', onClick: () => onOpen(ref) },
                { label: 'New Query Console', onClick: () => consoleOf(partiqlSelectAll(t.name)) },
                sep({ label: 'Refresh', onClick: () => refresh(tId) }),
                sep({ label: 'Copy Name', onClick: () => copy(t.name) }),
                {
                  label: 'Copy ARN',
                  onClick: () => void window.api.dynamo.describe(ds.id, t.name).then((d: { arn: string }) => copy(d.arn), showErr)
                }
              ]}
            />
          )
        }}
      />
    )
  }

  /**
   * Redis data source, DataGrip style: source -> databases -> type folders (strings, lists, ...) -> key folders grouped by
   * the source's key delimiter -> keys. Expanding a database scans all of its keys once (main process, capped); the
   * folder tree is built from that answer in memory (lib/redisTree) and only expanded folders are rendered.
   */
  const renderRedisSource = (ds: DataSource, depth: number): React.JSX.Element => {
    const sep = (it: Menu['items'][number]): Menu['items'][number] => ({ ...it, sep: true })
    const cfg = ds.redis
    const delimiter = redisDelimiter(cfg)
    // a changed delimiter regroups the keys: bump the database nodes' reload counter when it differs from last render
    const seen = delimSeen.current[ds.id]
    if (!seen) delimSeen.current[ds.id] = { d: delimiter, n: 0 }
    else if (seen.d !== delimiter) delimSeen.current[ds.id] = { d: delimiter, n: seen.n + 1 }
    const delimEpoch = delimSeen.current[ds.id].n
    const consoleOf = (db: number): void =>
      onConsole({ dsId: ds.id, dsName: ds.name, database: `db${db}`, engine: 'redis', db })
    const browse = (db: number, pattern: string, type: string): void =>
      onOpen({ ...redisRef(ds.id, ds.name, db), redisFilter: { pattern, type, n: Date.now() } })

    const keyEntry = (parentId: string, d: number, db: number, dbId: string, group: TypeGroup, en: KeyEntry): React.JSX.Element => {
      if (en.kind === 'folder') {
        const id = `${parentId}/d:${en.prefix}`
        return (
          <Node
            key={'d:' + en.prefix}
            id={id}
            label={en.name}
            icon={<Icon name="folder" />}
            iconTip={typeLabel('rfolder')}
            tooltip={redisDisplayName(en.prefix)}
            badgeText={en.count.toLocaleString()}
            depth={d}
            forceReload={rv(id)}
            expandAll={en.count <= EXPAND_ALL_MAX}
            kidsData={kidsOfEntries(en.children)}
            info={{ kind: 'rfolder', dsId: ds.id, dsName: ds.name, name: en.name, engine: 'redis', refreshId: dbId, copyText: redisDisplayName(en.prefix) }}
            menu={() => [
              { label: 'Browse in Key Browser', onClick: () => browse(db, prefixPattern(en.prefix, en.binary), group.scanType ?? '') },
              { label: 'Copy Prefix', key: '⌘C', onClick: () => copy(redisDisplayName(en.prefix)) },
              sep({ label: 'Refresh', onClick: () => refresh(dbId) })
            ]}
            render={(k) => keyEntry(id, d + 1, db, dbId, group, k.data as KeyEntry)}
          />
        )
      }
      const id = `${parentId}/k:${en.key}`
      const shown = redisDisplayName(en.key)
      const open = (): void => onOpen(redisKeyRef(ds.id, ds.name, db, en.key))
      return (
        <Node
          key={'k:' + en.key}
          id={id}
          label={en.name}
          icon={<Icon name={`key-${en.type}` as IconName} />}
          iconTip={typeLabel('key-' + en.type)}
          tooltip={shown}
          rawName={renaming === id ? shown : undefined}
          renaming={renaming === id}
          onCancelRename={() => setRenaming(null)}
          onRename={(name) => {
            setRenaming(null)
            if (!name || name === shown) return
            setError('')
            window.api.redis
              .rename(ds.id, db, en.key, name)
              .then(() => onKeyRenamed?.(ds.id, db, en.key, name))
              .catch(showErr)
              .then(() => refresh(dbId))
          }}
          depth={d}
          leaf
          forceReload={rv(id)}
          info={{ kind: 'rkey', dsId: ds.id, dsName: ds.name, name: shown, engine: 'redis', refreshId: dbId, redisKey: en.key, db }}
          onDouble={open}
          menu={() => [
            { label: 'Open', onClick: open },
            { label: 'Copy Key Name', key: '⌘C', onClick: () => copy(shown) },
            sep({
              label: 'Rename…',
              key: 'F2',
              onClick: () => (isRedisBinaryName(en.key) ? setError('Binary key names cannot be renamed here; use the console.') : setRenaming(id))
            }),
            { label: 'Delete…', danger: true, key: '⌘⌫', onClick: () => confirmDeleteKeys(ds.id, db, dbId, [en.key]) },
            sep({ label: 'Refresh', onClick: () => refresh(dbId) })
          ]}
        />
      )
    }

    return (
      <Node
        key={ds.id}
        id={ds.id}
        label={ds.name}
        tooltip2={`${cfg?.host ?? 'localhost'}:${cfg?.port ?? 6379}${cfg?.tls ? ' · TLS' : ''}${cfg?.username ? ' · ' + cfg.username : ''}`}
        tipNote={() => cacheNote(cacheMeta(ds.id, cacheKeys.redisDbs))}
        info={{ kind: 'ds', dsId: ds.id, dsName: ds.name, name: ds.name, engine: 'redis' }}
        rawName={ds.name}
        icon={<Icon name={ds.passwordUnavailable ? 'warning' : 'redis'} />}
        iconTip={typeLabel('redis')}
        badgeOf={(kids) => String(kids.length)}
        depth={depth}
        forceReload={rv(ds.id)}
        dragPayload={'ds:' + ds.id}
        renaming={renaming === ds.id}
        onCancelRename={() => setRenaming(null)}
        onRename={(name) => {
          setRenaming(null)
          if (name.trim() && name.trim() !== ds.name) void run(() => window.api.renameSource(ds.id, name))
        }}
        menu={() => [
          { label: 'New Query Console', onClick: () => consoleOf(cfg?.db ?? 0) },
          sep({ label: 'Edit Data Source…', onClick: () => onEdit(ds) }),
          { label: 'Rename', onClick: () => setRenaming(ds.id) },
          { label: 'Duplicate', onClick: () => void run(() => window.api.duplicateSource(ds.id)) },
          sep({ label: 'Refresh', onClick: () => refresh(ds.id) }),
          { label: 'Disconnect', onClick: () => void window.api.disconnect(ds.id).then(() => refresh(ds.id)) },
          sep({ label: 'Copy Name', onClick: () => copy(ds.name) }),
          ...sourceMenu(ds),
          sep({
            label: 'Delete Data Source…',
            danger: true,
            onClick: () => {
              if (!window.confirm(`Remove data source "${ds.name}"? This does not touch the Redis server.`)) return
              void run(() => window.api.deleteSource(ds.id)).then(() => onObjectGone({ dsId: ds.id }))
            }
          })
        ]}
        load={() =>
          cached(ds.id, cacheKeys.redisDbs, () => window.api.redis.databases(ds.id)).then((r: RedisDatabases) =>
            r.databases.map((d) => ({ name: `db${d.db}`, kind: String(d.keys) }))
          )
        }
        render={(d) => {
          if (f && !d.name.toLowerCase().includes(f)) return <span key={d.name} />
          const db = Number(d.name.slice(2))
          const dId = `${ds.id}/${d.name}`
          const n = Number(d.kind ?? 0)
          return (
            <Node
              key={d.name}
              id={dId}
              forceReload={rv(dId) + delimEpoch}
              label={String(db)}
              tooltip={`${d.name} · ${n.toLocaleString()} ${n === 1 ? 'key' : 'keys'}`}
              icon={<Icon name="database" />}
              iconTip={typeLabel('redisdb')}
              tipNote={() => cacheNote(cacheMeta(ds.id, cacheKeys.redisTree(db)))}
              badgeText={`${n.toLocaleString()} ${n === 1 ? 'key' : 'keys'}`}
              depth={depth + 1}
              cancellable
              onCancel={() => void window.api.redis.keyTreeCancel(ds.id, db)}
              loadingText="Scanning keys…"
              info={{ kind: 'db', dsId: ds.id, dsName: ds.name, name: d.name, engine: 'redis', refreshId: dId }}
              menu={() => [
                { label: 'Open Key Browser', onClick: () => onOpen(redisRef(ds.id, ds.name, db)) },
                { label: 'New Query Console', onClick: () => consoleOf(db) },
                sep({ label: 'Refresh', onClick: () => (refresh(ds.id), refresh(dId)) }),
                sep({ label: 'Copy Name', onClick: () => copy(d.name) })
              ]}
              load={() =>
                cached(ds.id, cacheKeys.redisTree(db), () => window.api.redis.keyTree(ds.id, db, { max: REDIS_KEYTREE_MAX }), {
                  encode: compactKeyTree,
                  decode: expandKeyTree,
                  // a scan that was cancelled / superseded / ran out of time is not worth keeping; a capped one is the best there is
                  store: (r) => r.complete || r.keys.length >= REDIS_KEYTREE_MAX
                }).then((r: RedisKeyTree) => {
                  const kids: Kids = buildKeyTree(r.keys, delimiter).map((g) => ({ name: g.id, kind: 'rtype', data: g }))
                  if (!r.complete && r.keys.length > 0)
                    kids.push({ name: '__note', kind: 'note', data: { shown: r.keys.length, total: Math.max(r.dbsize, r.keys.length) } })
                  return kids
                })
              }
              render={(k) => {
                if (k.kind === 'note') {
                  const x = k.data as { shown: number; total: number }
                  return (
                    <div key="__note" className="tree-empty tree-note" style={{ paddingLeft: 36 + (depth + 2) * 14 }}>
                      Showing first {x.shown.toLocaleString()} of {x.total.toLocaleString()} keys — use the key browser to search
                    </div>
                  )
                }
                const g = k.data as TypeGroup
                const gId = `${dId}/${g.id}`
                return (
                  <Node
                    key={g.id}
                    id={gId}
                    label={g.label}
                    icon={<Icon name="folder" />}
                    iconTip={typeLabel('rtype')}
                    badgeText={g.count.toLocaleString()}
                    depth={depth + 2}
                    forceReload={rv(gId)}
                    expandAll={g.count <= EXPAND_ALL_MAX}
                    kidsData={kidsOfEntries(g.children)}
                    info={{ kind: 'rtype', dsId: ds.id, dsName: ds.name, name: g.label, engine: 'redis', refreshId: dId }}
                    menu={() => [
                      { label: 'Browse in Key Browser', onClick: () => browse(db, '', g.scanType ?? '') },
                      sep({ label: 'Refresh', onClick: () => refresh(dId) })
                    ]}
                    render={(e) => keyEntry(gId, depth + 3, db, dId, g, e.data as KeyEntry)}
                  />
                )
              }}
            />
          )
        }}
      />
    )
  }

  const renderLevel = (parentId: string | null, depth: number): React.JSX.Element[] => {
    const out: React.JSX.Element[] = []
    for (const fo of folders.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      const isOpen = open.has(fo.id)
      builders.current['folder:' + fo.id] = () => folderItems(fo)
      if (editing && editing.id === fo.id) {
        out.push(<div key={'ed' + fo.id}>{nameInput(fo.name, depth)}</div>)
        continue
      }
      out.push(
        <div key={'f' + fo.id}>
          <div
            className={'tree-row' + (multi.has('folder:' + fo.id) ? ' sel' : '') + (dropTarget === fo.id ? ' drop' : '')}
            style={{ paddingLeft: 8 + depth * 14 }}
            data-id={'folder:' + fo.id}
            data-depth={depth}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', 'folder:' + fo.id)}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDropTarget(fo.id)
            }}
            onDragLeave={() => setDropTarget((t) => (t === fo.id ? null : t))}
            onDrop={(e) => onDrop(e, fo.id)}
            onClick={(e) => click('folder:' + fo.id, e)}
            onDoubleClick={() => toggle(fo.id)}
            onContextMenu={(e) => openMenu(e, 'folder:' + fo.id, folderItems(fo))}
          >
            <span className="twisty">
              <span
                className="arrow"
                onClick={(e) => {
                  e.stopPropagation()
                  select('folder:' + fo.id)
                  toggle(fo.id)
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Chevron open={isOpen} />
              </span>
            </span>
            <span className="ticon" data-tip={typeLabel('folder')}><Icon name={isOpen ? 'folderOpen' : 'folder'} /></span>
            <span className="tlabel">{fo.name}</span>
          </div>
          {isOpen && renderLevel(fo.id, depth + 1)}
        </div>
      )
    }
    if (editing && editing.id === 'new' && editing.parentId === parentId) {
      out.push(<div key="new-folder">{nameInput('New Folder', depth)}</div>)
    }
    for (const ds of sourcesIn(sources, parentId)) {
      const kind = dsKind(ds)
      out.push(kind === 'dynamodb' ? renderDynamoSource(ds, depth) : kind === 'redis' ? renderRedisSource(ds, depth) : renderSource(ds, depth))
    }
    return out
  }

  return (
    <div className="explorer" ref={rootRef} tabIndex={-1}>
      <div className="explorer-head">
        <span>Database Explorer</span>
        <span className="spacer" />
        <button className="ibtn" data-tip="Select Opened Object" disabled={!activeTarget} onClick={locate}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6.2" /><circle cx="8" cy="8" r="3.2" /><circle cx="8" cy="8" r="0.8" fill="currentColor" />
          </svg>
        </button>
        <button className="ibtn pink" data-tip="Expand All (loaded)" onClick={expandAll}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
          </svg>
        </button>
        <button className="ibtn pink" data-tip="Collapse All" onClick={collapseAll}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14" />
          </svg>
        </button>
        <span className="sep" />
        <button className="ibtn" data-tip="New folder" onClick={() => startNewFolder(null)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.2 12.8H2.8c-.7 0-1.2-.5-1.2-1.2V4.2c0-.7.5-1.2 1.2-1.2h3l1.3 1.5h5.1c.7 0 1.2.5 1.2 1.2v1.6" />
            <path d="M12.4 9v4.4M10.2 11.2h4.4" />
          </svg>
        </button>
        <button className="ibtn" data-tip="Refresh all" onClick={() => (sources.forEach((d) => markStale(d.id)), setTick((t) => t + 1))}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
            <path d="M13.6 2.4v3.2h-3.2" />
          </svg>
        </button>
        <button className="ibtn" data-tip="New data source" onClick={() => onEdit(null)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M8 2.8v10.4M2.8 8h10.4" />
          </svg>
        </button>
      </div>
      <input className="tree-filter" placeholder="Filter tables…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {sources.some((d) => d.passwordUnavailable) && (
        <div className="keychain-banner">
          <b>Keychain access denied.</b> Saved passwords can't be read for:{' '}
          {sources.filter((d) => d.passwordUnavailable).map((d) => d.name).join(', ')}.
          <div>
            Restart the app and click <i>Always Allow</i> when macOS asks, or re-enter the password via Edit Data Source.
          </div>
          {retry === 'still' && (
            <div style={{ color: '#f26b6b' }}>
              Still denied. macOS only asks again when the app starts, so use Restart App.
            </div>
          )}
          <div className="kb-actions">
            <button
              disabled={retry === 'busy'}
              onClick={async () => {
                setRetry('busy')
                const s = await window.api.listSources()
                setSources(s)
                setRetry(s.some((d: DataSource) => d.passwordUnavailable) ? 'still' : 'idle')
              }}
            >
              {retry === 'busy' ? 'Retrying…' : 'Retry'}
            </button>
            <button className="primary" onClick={() => void window.api.relaunch()}>Restart App</button>
          </div>
        </div>
      )}
      {error && <div className="tree-err" style={{ padding: '0 8px 6px' }}>{error}</div>}
      <SelCtx.Provider value={{ sel, multi, setSel: select, click, ctl, infos, collapseKey, expandKey, reveal, reg: builders, openMenuAt: openMenu, direct: refreshes, restore, track }}>
        <div
          className={'tree' + (dropTarget === 'root' ? ' drop' : '')}
          onDragOver={(e) => {
            e.preventDefault()
            setDropTarget('root')
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDropTarget(null)}
          onDrop={(e) => onDrop(e, null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: 'New Folder', onClick: () => startNewFolder(null) },
                { label: 'New Data Source…', onClick: () => onEdit(null) }
              ]
            })
          }}
        >
          {sources.length === 0 && folders.length === 0 && (
            <div className="tree-empty" style={{ padding: 12 }}>No data sources. Click ＋ to add a connection.</div>
          )}
          {renderLevel(null, 0)}
        </div>
      </SelCtx.Provider>
      {creating && (
        <CreateDialog
          req={creating}
          onClose={(created, newName) => {
            const nodeId = creating.nodeId
            const req = creating
            setCreating(null)
            if (!created) return
            if (req.kind === 'table' && newName) {
              // an explicit table selection would hide the new table: add it (a pattern rule follows its own pattern)
              const ds = sources.find((x) => x.id === req.dsId)
              const tf = ds?.tableFilter?.[`${req.database}/${req.schema}`]
              if (tf && !tf.rule && tf.list && !tf.list.includes(newName))
                void window.api.setTableFilter(req.dsId, req.database, req.schema, { list: [...tf.list, newName] }).then(reload)
            }
            revealCreated(nodeId)
            // adding a column: the parent schema's table list is unaffected, but open table views should reload
            if (creating.kind === 'column') refresh(nodeId.split('/').slice(0, -1).join('/'))
          }}
        />
      )}
      {picker && sources.find((d) => d.id === picker.dsId) && (() => {
        const ds = sources.find((d) => d.id === picker.dsId)!
        const database = picker.database
        const schema = picker.schema
        const tfKey = `${database}/${schema}`
        const tf = ds.tableFilter?.[tfKey]
        if (picker.dynamo) {
          const dtf = ds.tableFilter?.['dynamodb']
          return (
            <ListPicker
              x={picker.x}
              y={picker.y}
              icon="table"
              placeholder="Search tables…"
              load={() => window.api.dynamo.tables(ds.id)}
              selected={dtf?.list ?? null}
              rule={dtf?.rule ?? null}
              persistRule
              defaultOf={(all) => all}
              onClose={() => setPicker(null)}
              onChange={(list, rule) => {
                const filter: TableFilter | null = rule ? { rule } : list ? { list } : null
                void run(() => window.api.dynamo.setTableFilter(ds.id, filter)).then(() => refresh(ds.id))
              }}
            />
          )
        }
        return database && schema ? (
          <ListPicker
            x={picker.x}
            y={picker.y}
            icon="table"
            placeholder="Search tables…"
            load={() => window.api.tables(ds.id, database, schema).then((r: { name: string }[]) => r.map((t) => t.name))}
            selected={tf?.list ?? null}
            rule={tf?.rule ?? null}
            persistRule
            defaultOf={(all) => all}
            onClose={() => setPicker(null)}
            onChange={(list, rule) => {
              const filter: TableFilter | null = rule ? { rule } : list ? { list } : null
              void run(() => window.api.setTableFilter(ds.id, database, schema, filter)).then(() => refresh(`${ds.id}/${database}/${schema}`))
            }}
          />
        ) : database ? (
          <ListPicker
            x={picker.x}
            y={picker.y}
            icon="schema"
            placeholder="Search schemas…"
            load={() => window.api.schemasAll(ds.id, database)}
            selected={ds.schemaFilter?.[database] ?? null}
            defaultOf={(all) => all.filter((n) => !SYSTEM_SCHEMAS.includes(n))}
            onClose={() => setPicker(null)}
            onChange={(list) =>
              void run(() => window.api.setSchemaFilter(ds.id, database, list)).then(() => refresh(`${ds.id}/${database}`))
            }
          />
        ) : (
          <ListPicker
            x={picker.x}
            y={picker.y}
            icon="database"
            placeholder="Search databases…"
            load={() => window.api.databases(ds.id)}
            selected={ds.visibleDbs ?? null}
            defaultOf={(all) => all}
            onClose={() => setPicker(null)}
            onChange={(list) => void run(() => window.api.setVisibleDbs(ds.id, list)).then(() => refresh(ds.id))}
          />
        )
      })()}
      {menu && (
        <div className="ctxmenu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) => (
            <div
              key={i}
              className={'ctxitem' + (it.danger ? ' danger' : '') + (it.sep && i > 0 ? ' sep' : '') + (it.children ? ' has-sub' : '')}
              onClick={() => {
                if (it.children) return
                setMenu(null)
                it.onClick()
              }}
            >
              <span>{it.label}</span>
              {it.children ? (
                <span className="kbd">▸</span>
              ) : (
                (it.key ?? KEYS[it.label]) && <span className="kbd">{it.key ?? KEYS[it.label]}</span>
              )}
              {it.children && (
                <div className="ctxmenu submenu">
                  {it.children.map((c, j) => (
                    <div
                      key={j}
                      className="ctxitem"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenu(null)
                        c.onClick()
                      }}
                    >
                      <span style={{ whiteSpace: 'pre' }}>{c.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
