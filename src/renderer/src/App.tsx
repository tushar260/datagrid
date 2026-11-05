import type React from "react"
import { useEffect, useRef, useState } from 'react'
import { redisDisplayName, type DataSource } from '../../shared'
import Explorer, { TableRef } from './Explorer'
import TableView from './TableView'
import DynamoTableView from './DynamoTableView'
import RedisKeyView from './RedisKeyView'
import RedisKeyTab from './RedisKeyTab'
import DataSourceDialog from './DataSourceDialog'
import Console, { ConsoleRef } from './Console'
import { Icon, type IconName } from './icons'
import { initialSession, patchSession, saveTabs } from './session'
import { cycleTab, moveTabBy as moveTab, reorderTabs, restoreTabs as restoreSaved, tabsUpTo } from './lib/tabs'
import { useTabAnimations } from './useTabAnimations'
import { typeLabel } from './lib/typeLabel'
import { isDynamoRef, isRedisKeyRef, isRedisRef, keyTabTitle, tableKey, tablePath } from './lib/refs'
import ZoomIndicator from './ZoomIndicator'
import SettingsButton from './SettingsButton'
import SettingsDialog from './SettingsDialog'
import GoToModal from './GoToModal'
import { useSidebarFocus } from './lib/useSidebarFocus'
import { recordOpenedTable } from './lib/gotoIndex'
import { getSettings, stepFontSizes, updateSettings } from './lib/settings'

type Tab = { type: 'table'; t: TableRef } | { type: 'console'; c: ConsoleRef }
// (DynamoDB tables carry their kind and region in the key, so they can never collide with PostgreSQL ones)
const keyOf = (x: Tab): string => (x.type === 'table' ? tableKey(x.t) : 'c|' + x.c.id)
/** hover text of a tab: `data source / database.schema` (PostgreSQL), `data source / region` (DynamoDB), `data source / db3` (Redis
 *  key browser) or `data source / db3 / the:key` (Redis key tab) */
const tabTip = (x: Tab): string =>
  x.type === 'table'
    ? isDynamoRef(x.t) ? `${x.t.dsName} / ${x.t.region || 'default region'}`
      : isRedisKeyRef(x.t) ? `${x.t.dsName} / db${x.t.db ?? 0} / ${redisDisplayName(x.t.redisKey!)}`
      : isRedisRef(x.t) ? `${x.t.dsName} / db${x.t.db ?? 0}`
      : `${x.t.dsName} / ${x.t.database}.${x.t.schema}`
    : x.c.engine === 'dynamodb' ? `${x.c.dsName} / ${x.c.region || 'default region'}`
      : x.c.engine === 'redis' ? `${x.c.dsName} / db${x.c.db ?? 0}`
      : `${x.c.dsName} / ${x.c.database}`

/** icon of a Redis key tab by the key's type (`other` until it is known / for module types) */
const keyIconName = (type: string | undefined): IconName =>
  (['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(type ?? '') ? `key-${type}` : 'key-other') as IconName

export default function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ ds: DataSource | null; folderId?: string | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => window.api.onSettings?.(() => setSettingsOpen(true)), [])
  // ---- ⌘O "Go to database or table": from the Go menu (IPC) or the keystroke, from anywhere, but never over another modal ----
  const [sources, setSources] = useState<DataSource[]>([]) // the data sources as the explorer last loaded them (the search scope)
  const [gotoOpen, setGotoOpen] = useState(false)
  const [revealReq, setRevealReq] = useState<{ target: string; n: number; expand?: boolean } | null>(null)
  useEffect(() => {
    let last = 0
    const fire = (): void => {
      const now = Date.now()
      if (now - last < 150) return // the menu accelerator and the keydown can both fire for one keystroke
      last = now
      if (document.querySelector('.modal-bg, .cd-bg')) return
      setGotoOpen(true)
    }
    const off = window.api.onGoto?.(fire)
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyO') {
        e.preventDefault()
        fire()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      off?.()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])
  // Increase / Decrease / Reset Font Size (View menu)
  useEffect(() => window.api.onFontSize?.((dir) => void updateSettings(stepFontSizes(getSettings(), dir))), [])
  const [reloadKey, setReloadKey] = useState(0)
  const [width, setWidth] = useState(initialSession.width)
  const [sidebarHidden, setSidebarHidden] = useState(initialSession.sidebarHidden) // width is kept, so showing restores it

  const [consoleN, setConsoleN] = useState(initialSession.consoleN)
  // ---- session restore: tabs come back once the data sources are known (tabs of deleted sources are dropped) ----
  const restoredRef = useRef(false)
  const [restored, setRestored] = useState(false)
  const restoreTabs = (sources: DataSource[]): void => {
    if (restoredRef.current) return
    restoredRef.current = true
    const back: Tab[] = !getSettings().restoreTabs
      ? []
      : restoreSaved(initialSession.tabs, initialSession.consoleSql, new Map(sources.map((s) => [s.id, s.name])))
    setTabs((cur) => [...back, ...cur.filter((c) => !back.some((b) => keyOf(b) === keyOf(c)))])
    const want = initialSession.active
    setActive((a) => a ?? (want && back.some((b) => keyOf(b) === want) ? want : back.length ? keyOf(back[back.length - 1]) : null))
    setRestored(true)
  }
  // persist the session (debounced inside session.ts); closing tabs / Cmd+W go through setTabs so they are covered too
  useEffect(() => {
    if (restored) saveTabs(tabs, active)
  }, [restored, tabs, active])
  useEffect(() => {
    if (restored) patchSession({ width, sidebarHidden, consoleN })
  }, [restored, width, sidebarHidden, consoleN])
  // (the restored active tab is scrolled into view by the "keep the active tab visible" effect below)
  const activeTab = tabs.find((x) => keyOf(x) === active)
  const activeTarget = !activeTab
    ? null
    : activeTab.type === 'table'
      ? isRedisKeyRef(activeTab.t) ? `${activeTab.t.dsId}/db${activeTab.t.db ?? 0}` : tablePath(activeTab.t) // (a key tab reveals its database)
      : [activeTab.c.dsId, activeTab.c.database, activeTab.c.schema].filter(Boolean).join('/')
  const open = (t: TableRef): void => {
    recordOpenedTable(t) // feeds the "recent" list of ⌘O
    const tab: Tab = { type: 'table', t }
    if (!tabs.find((x) => keyOf(x) === keyOf(tab))) setTabs([...tabs, tab])
    else if (isRedisKeyRef(t)) { /* an open key tab is just focused (a reload would drop an unsaved value edit) */ }
    else if (t.redisFilter) setTabs(tabs.map((x) => (keyOf(x) === keyOf(tab) ? tab : x))) // "Browse in Key Browser" again: new prefill
    else bumpOpen(t) // already open: activating it also reloads rows / count / structure (keeps unsaved edits, see TableView)
    setActive(keyOf(tab))
  }
  const openConsole = (c: Omit<ConsoleRef, 'id' | 'title'>): void => {
    const n = consoleN + 1
    setConsoleN(n)
    const tab: Tab = {
      type: 'console',
      c: {
        ...c,
        id: String(Date.now()) + '-' + n,
        title: `${c.engine === 'dynamodb' ? c.dsName : c.engine === 'redis' ? `${c.dsName} ${c.database}` : c.schema ? c.schema : c.database} console${n > 1 ? ' ' + n : ''}`
      }
    }
    setTabs([...tabs, tab])
    setActive(keyOf(tab))
  }
  const renameTab = (dsId: string, database: string, schema: string, from: string, to: string): void => {
    // keep open tabs in sync after a table rename
    setTabs((ts) =>
      ts.map((x) =>
        x.type === 'table' && x.t.dsId === dsId && x.t.database === database && x.t.schema === schema && x.t.table === from
          ? { type: 'table', t: { ...x.t, table: to } }
          : x
      )
    )
    setActive((a) => (a === ['t', dsId, database, schema, from].join('|') ? ['t', dsId, database, schema, to].join('|') : a))
  }
  // ---- Redis key tabs ----
  /** per key tab: the key's type once loaded (tab icon) */
  const [keyTypes, setKeyTypes] = useState<Record<string, string>>({})
  const [treeRefresh, setTreeRefresh] = useState<{ id: string; n: number } | null>(null)
  const isKeyTab = (x: Tab, dsId: string, db: number): x is Tab & { type: 'table' } =>
    x.type === 'table' && isRedisKeyRef(x.t) && x.t.dsId === dsId && (x.t.db ?? 0) === db
  /** a key was renamed (in the tree or its tab): its tab follows and keeps its place in the strip */
  const renameKey = (dsId: string, db: number, from: string, to: string, refreshTree = false): void => {
    const fromKey = tableKey({ dsId, dsName: '', database: `db${db}`, schema: '', table: from, kind: 'redis', engine: 'redis', db, redisKey: from })
    const toKey = tableKey({ dsId, dsName: '', database: `db${db}`, schema: '', table: to, kind: 'redis', engine: 'redis', db, redisKey: to })
    // a tab for the new name may exist already (the key was overwritten elsewhere): keep that one
    setTabs((ts) => {
      const dup = ts.some((x) => keyOf(x) === toKey)
      return ts.flatMap((x): Tab[] =>
        isKeyTab(x, dsId, db) && x.t.redisKey === from ? (dup ? [] : [{ type: 'table', t: { ...x.t, table: to, redisKey: to } }]) : [x]
      )
    })
    setActive((a) => (a === fromKey ? toKey : a))
    setKeyTypes((cur) => {
      if (!(fromKey in cur)) return cur
      const { [fromKey]: ty, ...rest } = cur
      return { ...rest, [toKey]: ty }
    })
    if (refreshTree) setTreeRefresh((r) => ({ id: `${dsId}/db${db}`, n: (r?.n ?? 0) + 1 }))
  }
  /** keys were deleted (in the tree or their tab): their tabs close */
  const dropKeys = (dsId: string, db: number, keys: string[], refreshTree = false): void => {
    const set = new Set(keys)
    const remaining = tabs.filter((x) => !(isKeyTab(x, dsId, db) && set.has(x.t.redisKey!)))
    if (remaining.length !== tabs.length) {
      setTabs(remaining)
      if (active && !remaining.find((x) => keyOf(x) === active)) setActive(remaining.length ? keyOf(remaining[remaining.length - 1]) : null)
    }
    if (refreshTree) setTreeRefresh((r) => ({ id: `${dsId}/db${db}`, n: (r?.n ?? 0) + 1 }))
  }
  // tree refresh also reloads open table tabs under the refreshed node
  const [tokens, setTokens] = useState<Record<string, number>>({})
  // re-opening an already open table bumps the same token as a tree refresh, flagged "soft" so TableView keeps pending edits
  const [softAt, setSoftAt] = useState<Record<string, number>>({})
  const bumpOpen = (t: TableRef): void => {
    const p = tablePath(t)
    const n = (tokens[p] ?? 0) + 1
    setTokens((cur) => ({ ...cur, [p]: n }))
    setSoftAt((cur) => ({ ...cur, [p]: n }))
  }
  const refreshed = (id: string): void =>
    setTokens((cur) => {
      const next = { ...cur }
      for (const x of tabs) {
        if (x.type !== 'table') continue
        const p = tablePath(x.t)
        if (p === id || p.startsWith(id + '/')) next[p] = (next[p] ?? 0) + 1
      }
      return next
    })
  const gone = (sc: { dsId: string; database?: string; schema?: string; table?: string }): void => {
    const hit = (x: Tab): boolean => {
      const o = x.type === 'table' ? x.t : x.c
      const table = x.type === 'table' ? x.t.table : undefined
      return (
        o.dsId === sc.dsId &&
        (!sc.database || o.database === sc.database) &&
        (!sc.schema || o.schema === sc.schema) &&
        (!sc.table || (x.type === 'table' && table === sc.table))
      )
    }
    const remaining = tabs.filter((x) => !hit(x))
    setTabs(remaining)
    if (active && !remaining.find((x) => keyOf(x) === active)) setActive(remaining.length ? keyOf(remaining[remaining.length - 1]) : null)
  }
  // really removing a tab happens after its close animation (see useTabAnimations); the neighbour is selected right away
  const removeTab = (k: string): void => {
    setTabs((ts) => ts.filter((x) => keyOf(x) !== k))
    if (active === k) { // it became active again while animating out (e.g. Cmd+Shift+]): fall back to a neighbour
      const rest = tabs.filter((x) => keyOf(x) !== k)
      const i = tabs.findIndex((x) => keyOf(x) === k)
      setActive(rest.length ? keyOf(rest[Math.min(Math.max(i, 0), rest.length - 1)]) : null)
    }
  }
  const close = (k: string): void => {
    if (anim.isClosing(k)) return // already animating out (rapid clicks / repeated Cmd+W)
    const live = tabs.filter((x) => !anim.isClosing(keyOf(x))) // tabs that are still going to stay or are being closed now
    const idx = live.findIndex((x) => keyOf(x) === k)
    const next = live.filter((x) => keyOf(x) !== k)
    // select the neighbour that slides into the closed tab's slot (or the new last tab)
    if (active === k) setActive(next.length ? keyOf(next[Math.min(Math.max(idx, 0), next.length - 1)]) : null)
    anim.requestClose(k)
  }
  // ---- tab reordering (pure updates of `tabs`, tracked by key so `active` follows the tab) ----
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ key: string | null; after: boolean } | null>(null) // key null = end of strip
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; key: string } | null>(null)
  const tabbarRef = useRef<HTMLDivElement>(null)
  const anim = useTabAnimations({ keys: tabs.map(keyOf), ready: restored, dragKey, stripRef: tabbarRef, onRemove: removeTab })
  const reorder = (ts: Tab[], from: string, to: string | null, after: boolean): Tab[] => reorderTabs(ts, keyOf, from, to, after)
  const moveTabBy = (k: string, delta: number): void => setTabs((ts) => moveTab(ts, keyOf, k, delta))
  const TAB_MIME = 'application/x-datagrip-lite-tab' // unique type so explorer drags are ignored (legacy name, kept on purpose)
  const isTabDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes(TAB_MIME)
  const dropTarget = (e: React.DragEvent): { key: string | null; after: boolean } => {
    const el = (e.target as HTMLElement).closest?.('[data-tabkey]') as HTMLElement | null
    if (!el) return { key: null, after: true }
    const r = el.getBoundingClientRect()
    return { key: el.dataset.tabkey ?? null, after: e.clientX > r.left + r.width / 2 }
  }
  const onStripDragOver = (e: React.DragEvent): void => {
    if (!isTabDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const strip = tabbarRef.current
    if (strip) {
      const r = strip.getBoundingClientRect()
      const edge = 48
      if (e.clientX < r.left + edge) strip.scrollLeft -= 14
      else if (e.clientX > r.right - edge) strip.scrollLeft += 14
    }
    const d = dropTarget(e)
    setDrop((cur) => (cur && cur.key === d.key && cur.after === d.after ? cur : d))
  }
  const onStripDrop = (e: React.DragEvent): void => {
    if (!isTabDrag(e)) return
    e.preventDefault()
    const from = e.dataTransfer.getData(TAB_MIME) || dragKey
    const d = dropTarget(e)
    if (from) setTabs((ts) => reorder(ts, from, d.key, d.after))
    setDragKey(null)
    setDrop(null)
  }
  // would dropping here actually change the order? (hide the indicator for no-op positions)
  const dropMeaningful = (): boolean => {
    if (!dragKey || !drop) return false
    return reorder(tabs, dragKey, drop.key, drop.after) !== tabs
  }
  const closeOthers = (k: string): void => {
    setTabs((ts) => ts.filter((x) => keyOf(x) === k))
    setActive(k)
  }
  const closeRight = (k: string): void => {
    const next = tabsUpTo(tabs, keyOf, k)
    if (!next) return
    setTabs(next)
    if (active && !next.find((x) => keyOf(x) === active)) setActive(k)
  }
  // dismiss the tab context menu on outside click / Escape / blur
  useEffect(() => {
    if (!tabMenu) return
    const hide = (): void => setTabMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    window.addEventListener('mousedown', hide)
    window.addEventListener('blur', hide)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', hide)
      window.removeEventListener('blur', hide)
      window.removeEventListener('keydown', onKey)
    }
  }, [tabMenu])
  // keep the active tab visible (after selecting, opening or moving it)
  const order = tabs.map(keyOf).join('\n')
  useEffect(() => {
    const strip = tabbarRef.current
    if (!strip || !active) return
    const el = Array.from(strip.querySelectorAll<HTMLElement>('[data-tabkey]')).find((n) => n.dataset.tabkey === active)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, order])
  // Ctrl+Shift+PageUp/PageDown moves the active tab; Cmd/Ctrl+Shift+[ / ] switches to prev/next tab.
  const tabKeysRef = useRef<(e: KeyboardEvent) => void>(() => {})
  tabKeysRef.current = (e: KeyboardEvent): void => {
    if (!active || e.altKey || document.querySelector('.modal-bg')) return
    if (e.ctrlKey && e.shiftKey && !e.metaKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault()
      moveTabBy(active, e.key === 'PageUp' ? -1 : 1)
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight') && tabs.length > 1) {
      e.preventDefault()
      const i = tabs.findIndex((x) => keyOf(x) === active)
      const n = tabs.length
      setActive(keyOf(tabs[(i + (e.code === 'BracketLeft' ? -1 : 1) + n) % n]))
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => tabKeysRef.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // Ctrl+Tab / Ctrl+Shift+Tab: next / previous tab, wrapping around (Ctrl on macOS too, like browsers and IDEs).
  // Two paths: the Window menu accelerators (IPC) and a capture-phase keydown listener (whichever sees the key
  // first; a short guard drops the twin). Not MRU order, just strip order. Tabs animating out are skipped.
  const focusAfterCycleRef = useRef(false)
  const cycleRef = useRef<(dir: 1 | -1) => void>(() => {})
  cycleRef.current = (dir: 1 | -1): void => {
    if (document.querySelector('.modal-bg, .cd-bg')) return
    const next = cycleTab(tabs, keyOf, active, dir, anim.isClosing)
    if (next === null) return
    focusAfterCycleRef.current = true
    setActive(next)
  }
  useEffect(() => {
    let last = 0
    const fire = (dir: 1 | -1): void => {
      const now = Date.now()
      if (now - last < 150) return
      last = now
      cycleRef.current(dir)
    }
    const offNext = window.api.onNextTab?.(() => fire(1))
    const offPrev = window.api.onPrevTab?.(() => fire(-1))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.metaKey || e.altKey) return
      if (document.querySelector('.modal-bg, .cd-bg')) return // dialogs keep their own Tab handling
      e.preventDefault() // never move focus to the next focusable element
      e.stopPropagation() // nor let the console / grid cell editor see it
      fire(e.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      offNext?.()
      offPrev?.()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])
  // after cycling, put the keyboard focus into the new tab (grid container / console editor) so arrows and typing work
  useEffect(() => {
    if (!focusAfterCycleRef.current) return
    focusAfterCycleRef.current = false
    const pane = Array.from(document.querySelectorAll<HTMLElement>('.content > .pane')).find((p) => p.dataset.pane === active)
    pane?.querySelector<HTMLElement>('.gridwrap, textarea.editor')?.focus({ preventScroll: true })
  }, [active])
  // Cmd/Ctrl+W closes the active tab. Primary path is the app menu accelerator (IPC); the keydown
  // listener is a fallback. Both go through a ref so they always see the latest state.
  const closeActiveRef = useRef<() => void>(() => {})
  closeActiveRef.current = (): void => {
    if (active) close(active)
  }
  useEffect(() => {
    let last = 0
    const fire = (): void => {
      const now = Date.now()
      if (now - last < 150) return // menu + keydown can both fire for one keystroke
      last = now
      closeActiveRef.current()
    }
    const off = window.api.onCloseTab(fire)
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        fire()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      off()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])
  // Shift+Esc moves the keyboard focus into the Database Explorer tree (revealing a hidden sidebar) and back (lib/useSidebarFocus).
  useSidebarFocus(sidebarHidden, setSidebarHidden, active)
  const drag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const move = (ev: MouseEvent): void => setWidth(Math.max(180, Math.min(700, ev.clientX)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="app">
      <div style={{ width, display: sidebarHidden ? 'none' : undefined }} className="side">
        <Explorer treeRefresh={treeRefresh} onKeyRenamed={(ds, db, a, b) => renameKey(ds, db, a, b)} onKeysGone={(ds, db, ks) => dropKeys(ds, db, ks)} activeTarget={activeTarget} onOpen={open} onConsole={openConsole} onTableRenamed={renameTab} onObjectGone={gone} onRefreshed={refreshed} onEdit={(ds, folderId) => setDialog({ ds, folderId })} reloadKey={reloadKey} onSources={(s) => { setSources(s); restoreTabs(s) }} revealRequest={revealReq} />
      </div>
      {!sidebarHidden && <div className="splitter" onMouseDown={drag} />}
      <div className="main">
        <div className="topbar">
        <div
          className="tabbar"
          ref={tabbarRef}
          onDragOver={onStripDragOver}
          onDrop={onStripDrop}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
          }}
        >
          {tabs.map((t, ti) => (
            <div
              key={keyOf(t)}
              data-tabkey={keyOf(t)}
              draggable
              className={
                'tab ' +
                (anim.addedKeys.has(keyOf(t)) ? 'tab-new ' : '') +
                (anim.closingKeys.has(keyOf(t)) ? 'closing ' : '') +
                (active === keyOf(t) ? 'on ' : '') +
                (dragKey === keyOf(t) ? 'dragging ' : '') +
                (dropMeaningful() && drop && (drop.key === keyOf(t) || (drop.key === null && ti === tabs.length - 1))
                  ? (drop.key === null || drop.after ? 'drop-after' : 'drop-before')
                  : '')
              }
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, keyOf(t))
                e.dataTransfer.effectAllowed = 'move'
                setDragKey(keyOf(t))
              }}
              onDragEnd={() => {
                setDragKey(null)
                setDrop(null)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 190), key: keyOf(t) })
              }}
              onClick={() => setActive(keyOf(t))}
              onAnimationEnd={(e) => anim.onAnimationEnd(e, keyOf(t))}
              data-tip={tabTip(t)}
            >
              <span className="tabtitle">
                <span className="ticon" data-tip={typeLabel(t.type === 'table' ? (isRedisKeyRef(t.t) ? keyIconName(keyTypes[keyOf(t)]) : t.t.kind) : 'console')}>
                  <Icon
                    name={
                      t.type === 'table'
                        ? isDynamoRef(t.t) ? 'dynamodb' : isRedisKeyRef(t.t) ? keyIconName(keyTypes[keyOf(t)]) : isRedisRef(t.t) ? 'redis' : t.t.kind === 'view' || t.t.kind === 'matview' ? 'view' : 'table'
                        : 'console'
                    }
                    size={14}
                  />
                </span>
                {t.type === 'table' ? (isRedisKeyRef(t.t) ? keyTabTitle(t.t.redisKey!) : t.t.table) : t.c.title}
              </span>
              <span className="x" onClick={(e) => { e.stopPropagation(); close(keyOf(t)) }}>×</span>
            </div>
          ))}
        </div>
        <SettingsButton onClick={() => setSettingsOpen(true)} />
        </div>
        {tabMenu &&
          (() => {
            const i = tabs.findIndex((x) => keyOf(x) === tabMenu.key)
            if (i < 0) return null
            const n = tabs.length
            const items: { label: string; disabled?: boolean; sep?: boolean; run: () => void }[] = [
              { label: 'Close', run: () => close(tabMenu.key) },
              { label: 'Close Others', disabled: n < 2, run: () => closeOthers(tabMenu.key) },
              { label: 'Close Tabs to the Right', disabled: i >= n - 1, run: () => closeRight(tabMenu.key) },
              { label: 'Move Left', sep: true, disabled: i === 0, run: () => moveTabBy(tabMenu.key, -1) },
              { label: 'Move Right', disabled: i >= n - 1, run: () => moveTabBy(tabMenu.key, 1) },
              { label: 'Move to Start', disabled: i === 0, run: () => setTabs((ts) => reorder(ts, tabMenu.key, keyOf(ts[0]), false)) },
              { label: 'Move to End', disabled: i >= n - 1, run: () => setTabs((ts) => reorder(ts, tabMenu.key, null, true)) }
            ]
            return (
              <div className="ctxmenu" style={{ left: tabMenu.x, top: tabMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
                {items.map((it) => (
                  <div
                    key={it.label}
                    className={'ctxitem' + (it.sep ? ' sep' : '') + (it.disabled ? ' disabled' : '')}
                    onClick={() => {
                      if (it.disabled) return
                      setTabMenu(null)
                      it.run()
                    }}
                  >
                    <span>{it.label}</span>
                  </div>
                ))}
              </div>
            )
          })()}
        <div className="content">
          {tabs.map((t) => (
            <div key={keyOf(t)} data-pane={keyOf(t)} style={{ display: active === keyOf(t) ? 'flex' : 'none' }} className="pane">
              {t.type === 'table' ? (
                isDynamoRef(t.t)
                  ? <DynamoTableView t={t.t} active={active === keyOf(t)} reloadToken={tokens[tablePath(t.t)] ?? 0} />
                  : isRedisKeyRef(t.t)
                  ? (
                    <RedisKeyTab
                      t={t.t}
                      active={active === keyOf(t)}
                      reloadToken={tokens[tablePath(t.t)] ?? 0}
                      onType={(ty) => setKeyTypes((cur) => (cur[keyOf(t)] === ty ? cur : { ...cur, [keyOf(t)]: ty }))}
                      onRenamed={(to) => renameKey(t.t.dsId, t.t.db ?? 0, t.t.redisKey!, to, true)}
                      onDeleted={() => dropKeys(t.t.dsId, t.t.db ?? 0, [t.t.redisKey!], true)}
                    />
                  )
                  : isRedisRef(t.t)
                  ? <RedisKeyView t={t.t} active={active === keyOf(t)} reloadToken={tokens[tablePath(t.t)] ?? 0} />
                  : <TableView t={t.t} active={active === keyOf(t)} reloadToken={tokens[tablePath(t.t)] ?? 0} reloadSoft={softAt[tablePath(t.t)] === tokens[tablePath(t.t)]} />
              ) : <Console c={t.c} />}
            </div>
          ))}
          {tabs.length === 0 && <div className="placeholder">Double-click a table in the Database Explorer to open it.</div>}
        </div>
      </div>
      {dialog && (
        <DataSourceDialog
          initial={dialog.ds}
          folderId={dialog.folderId}
          onClose={(changed) => {
            setDialog(null)
            if (changed) setReloadKey((k) => k + 1)
          }}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSourcesChanged={() => setReloadKey((k) => k + 1)} />}
      {gotoOpen && (
        <GoToModal
          sources={sources}
          onClose={() => setGotoOpen(false)}
          onOpenTable={open}
          onRevealDb={(target) => {
            setSidebarHidden(false)
            setRevealReq({ target, n: Date.now(), expand: true })
          }}
        />
      )}
      <ZoomIndicator />
    </div>
  )
}
