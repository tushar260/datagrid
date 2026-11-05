import './pinLegacyIdentity' // MUST stay the first import: pins app name / userData to the pre-"DataGrid" identity (see legacyIdentity.ts)
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { randomUUID } from 'crypto'
import * as db from './db'
import * as dynamo from './dynamo'
import * as redis from './redis'
import { listProfiles } from './awsProfiles'
import { loadSourcesForRenderer, publicSource, mergeStoredSecrets, loadSource, upsertSource, deleteSource, KEYCHAIN_HELP, loadFolders, createFolder, renameFolder, moveFolder, deleteFolder, updateSourceFolders, patchSource, mutateSource, duplicateSource, explainKeychain, hasStoredPasswords, sourceIds, loadSourceRaw, loadSourcesRaw, commitState, encryptionAvailable, secretBlobs, loadSources } from './store'
import { createBackupService } from './backupService'
import { setupAboutPanel } from './aboutPanel'
import { createObjectCache, cacheIdentity, invalidationsFor, validCacheDsId, validCacheKey, validCachePrefix } from './objectCache'
import { initialWindowState, trackWindowState } from './windowState'
import { ZOOM_DEFAULT, clampPercent, factorToPercent, nextZoom, percentToFactor, readZoom, stepZoom, writeZoom } from './zoom'
import { CACHE_INDEX_PREFIXES, dsKind } from '../shared'
import type { DataSource, NewColumn, RedisItemOp, RedisKeyTreeOpts, RedisNewKey, RedisPageOpts, RedisScanOpts, TableFilter } from '../shared'

// ---- browser-style zoom (Cmd/Ctrl +, -, 0). Applied with webContents.setZoomFactor so it covers the whole window; persisted in zoom.json ----
const zoomFile = (): string => join(app.getPath('userData'), 'zoom.json')
let zoomPercent = ZOOM_DEFAULT

function applyZoom(win: BrowserWindow, announce: boolean): void {
  if (win.isDestroyed()) return
  win.webContents.setZoomFactor(percentToFactor(zoomPercent))
  if (announce) win.webContents.send('zoom:changed', zoomPercent)
}

function setZoomPercent(percent: number): void {
  zoomPercent = clampPercent(percent)
  writeZoom(zoomFile(), zoomPercent)
  for (const w of BrowserWindow.getAllWindows()) applyZoom(w, true)
}

function log(msg: string): void {
  try {
    // 'datagrip-lite.log' keeps its legacy name (existing users' log file)
    appendFileSync(join(app.getPath('userData'), 'datagrip-lite.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (e) => log('uncaughtException: ' + (e.stack || e)))
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + ((e as Error)?.stack || e)))

const find = (id: string): DataSource => {
  const ds = loadSource(id)
  if (!ds) throw new Error('Data source not found')
  if (ds.passwordUnavailable) {
    throw new Error(`The saved password for "${ds.name}" could not be read. ${KEYCHAIN_HELP}`)
  }
  return ds
}

/** A saved DynamoDB source with its secrets decrypted (main process only). */
const findDynamo = (id: string): DataSource => {
  const ds = loadSource(id)
  if (!ds) throw new Error('Data source not found')
  if (dsKind(ds) !== 'dynamodb') throw new Error(`"${ds.name}" is not a DynamoDB data source`)
  if (ds.passwordUnavailable) {
    throw new Error(`The saved secret access key for "${ds.name}" could not be read. ${KEYCHAIN_HELP}`)
  }
  return ds
}

/** A saved Redis source with its password decrypted (main process only). */
const findRedis = (id: string): DataSource => {
  const ds = loadSource(id)
  if (!ds) throw new Error('Data source not found')
  if (dsKind(ds) !== 'redis') throw new Error(`"${ds.name}" is not a Redis data source`)
  if (ds.passwordUnavailable) {
    throw new Error(`The saved password for "${ds.name}" could not be read. ${KEYCHAIN_HELP}`)
  }
  return ds
}

// ---- local cache of the explorer's lists (databases, schemas, tables, keys...): <userData>/cache/<dsId>.json ----
const objectCache = createObjectCache({ dir: () => join(app.getPath('userData'), 'cache'), onError: (m) => log(m) })

/** tells every window that cached lists were dropped (`['']` = everything of that source) */
function announceCache(id: string, prefixes: string[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('cache:invalidated', id, prefixes)
}
/** drops cached entries (and tells the renderer) after a successful structure change */
function dropCached(id: string, prefixes: string[]): void {
  if (!prefixes.length) return
  for (const p of prefixes) objectCache.delete(id, p)
  announceCache(id, prefixes)
}
/** runs a structure-changing call; once it succeeded the cached lists it affects are dropped (a failed call changes nothing) */
const changes = <T>(channel: string, id: string, args: unknown[], p: Promise<T>): Promise<T> =>
  p.then((r) => (dropCached(id, invalidationsFor(channel, args)), r))
const savedCacheId = (id: unknown): id is string => validCacheDsId(id) && sourceIds().includes(id)

/** Closes every connection of a data source, whatever it connects to. */
const closeSource = (id: string): Promise<unknown> => Promise.all([db.closeAll(id), dynamo.closeAll(id), redis.closeAll(id)])

function registerIpc(): void {
  // on-screen zoom controls (same setZoomPercent as the menu; it broadcasts 'zoom:changed')
  ipcMain.handle('zoom:get', () => zoomPercent)
  ipcMain.handle('zoom:step', (_e, dir: 'in' | 'out' | 'reset') => {
    setZoomPercent(stepZoom(zoomPercent, dir))
    return zoomPercent
  })
  ipcMain.handle('app:version', () => app.getVersion()) // Settings > About
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })
  // the renderer never gets a DynamoDB secret back: only hasSecret / hasSessionToken flags
  ipcMain.handle('ds:list', () => loadSourcesForRenderer())
  ipcMain.handle('ds:save', async (_e, ds: DataSource) => {
    if (ds.password || ds.dynamo?.secretAccessKey || ds.dynamo?.sessionToken || ds.redis?.password) await explainKeychain()
    const next = { ...ds, id: ds.id || randomUUID() }
    const prev = loadSourceRaw(next.id)
    upsertSource(next)
    // a different server / database / region / endpoint...: everything cached for it describes something else now
    if (prev && cacheIdentity(prev) !== cacheIdentity(next)) {
      objectCache.clear(next.id)
      announceCache(next.id, [''])
    }
    await closeSource(next.id)
    return publicSource(next)
  })
  ipcMain.handle('ds:delete', async (_e, id: string) => {
    deleteSource(id)
    objectCache.clear(id)
    announceCache(id, [''])
    await closeSource(id)
  })
  ipcMain.handle('ds:move', (_e, id: string, folderId: string | null) =>
    updateSourceFolders((d) => (d.id === id ? folderId : undefined))
  )
  ipcMain.handle('folders:list', () => loadFolders())
  ipcMain.handle('folders:create', (_e, name: string, parentId: string | null) => createFolder(name, parentId))
  ipcMain.handle('folders:rename', (_e, id: string, name: string) => renameFolder(id, name))
  ipcMain.handle('folders:move', (_e, id: string, parentId: string | null) => moveFolder(id, parentId))
  ipcMain.handle('folders:delete', (_e, id: string) => deleteFolder(id))
  ipcMain.handle('ds:rename', (_e, id: string, name: string) => {
    if (name.trim()) patchSource(id, { name: name.trim() })
  })
  ipcMain.handle('ds:setSort', (_e, id: string, dbSort: string) =>
    patchSource(id, { dbSort: dbSort as DataSource['dbSort'] })
  )
  ipcMain.handle('ds:setVisibleDbs', (_e, id: string, list: string[] | null) =>
    patchSource(id, { visibleDbs: list })
  )
  ipcMain.handle('ds:setSchemaFilter', (_e, id: string, database: string, list: string[] | null) =>
    mutateSource(id, (d) => {
      const f = { ...(d.schemaFilter ?? {}) }
      if (list) f[database] = list
      else delete f[database]
      return { schemaFilter: f }
    })
  )
  ipcMain.handle('ds:setTableFilter', (_e, id: string, database: string, schema: string, filter: TableFilter | null) =>
    mutateSource(id, (d) => {
      const f = { ...(d.tableFilter ?? {}) }
      const key = `${database}/${schema}`
      if (filter) f[key] = filter
      else delete f[key]
      return { tableFilter: f }
    })
  )
  ipcMain.handle('db:tableNames', (_e, id: string, d: string) => db.tableNames(find(id), d))
  ipcMain.handle('db:schemasAll', (_e, id: string, d: string) => db.listAllSchemas(find(id), d))
  ipcMain.handle('ds:duplicate', (_e, id: string) => duplicateSource(id, randomUUID()))
  ipcMain.handle('db:query', (_e, id: string, d: string, schema: string | undefined, sql: string) =>
    // (a script that creates / drops / alters something also drops the cached lists, even when a later statement failed)
    db.runQuery(find(id), d, schema, sql).finally(() => dropCached(id, invalidationsFor('db:query', [d, schema, sql])))
  )
  ipcMain.handle('db:dropDatabase', (_e, id: string, d: string) => changes('db:dropDatabase', id, [d], db.dropDatabase(find(id), d)))
  ipcMain.handle('db:createDatabase', (_e, id: string, name: string, owner?: string) =>
    changes('db:createDatabase', id, [name], db.createDatabase(find(id), name, owner))
  )
  ipcMain.handle('db:createSchema', (_e, id: string, d: string, name: string, owner?: string) =>
    changes('db:createSchema', id, [d, name], db.createSchema(find(id), d, name, owner))
  )
  ipcMain.handle('db:createTable', (_e, id: string, d: string, s: string, name: string, columns: NewColumn[]) =>
    changes('db:createTable', id, [d, s, name], db.createTable(find(id), d, s, name, columns))
  )
  ipcMain.handle('db:addColumn', (_e, id: string, d: string, s: string, t: string, column: NewColumn) =>
    db.addColumn(find(id), d, s, t, column)
  )
  ipcMain.handle('db:schemaTotal', (_e, id: string, d: string) => db.schemaTotal(find(id), d))
  ipcMain.handle('server:roles', (_e, id: string) => db.listRoles(find(id)))
  ipcMain.handle('server:tablespaces', (_e, id: string) => db.listTablespaces(find(id)))
  ipcMain.handle('db:renameTable', (_e, id: string, d: string, s: string, t: string, to: string) =>
    changes('db:renameTable', id, [d, s, t, to], db.renameTable(find(id), d, s, t, to))
  )
  ipcMain.handle('db:dropTable', (_e, id: string, d: string, s: string, t: string, kind: string) =>
    changes('db:dropTable', id, [d, s, t], db.dropTable(find(id), d, s, t, kind))
  )
  ipcMain.handle('ds:test', (_e, ds: DataSource) =>
    dsKind(ds) === 'dynamodb'
      ? dynamo.testConnection(mergeStoredSecrets(ds))
      : dsKind(ds) === 'redis'
        ? redis.testConnection(mergeStoredSecrets(ds))
        : db.testConnection(ds)
  )
  // ---- Redis (own channels; inputs are validated in redis.ts) ----
  ipcMain.handle('redis:databases', (_e, id: string) => redis.listDatabases(findRedis(id)))
  ipcMain.handle('redis:dbsize', (_e, id: string, d: number) => redis.dbSize(findRedis(id), d))
  ipcMain.handle('redis:scan', (_e, id: string, d: number, o?: RedisScanOpts) => redis.scanKeys(findRedis(id), d, o))
  ipcMain.handle('redis:keyTree', (_e, id: string, d: number, o?: RedisKeyTreeOpts) => redis.keyTree(findRedis(id), d, o))
  ipcMain.handle('redis:keyTreeCancel', (_e, id: string, d: number) => redis.cancelKeyTree(findRedis(id), d))
  ipcMain.handle('redis:get', (_e, id: string, d: number, key: string, o?: RedisPageOpts) => redis.getKey(findRedis(id), d, key, o))
  ipcMain.handle('redis:setString', (_e, id: string, d: number, key: string, value: string, o?: { keepTtl?: boolean }) =>
    changes('redis:setString', id, [d, key], redis.setString(findRedis(id), d, key, value, o))
  )
  ipcMain.handle('redis:setTtl', (_e, id: string, d: number, key: string, seconds: number | null) => redis.setTtl(findRedis(id), d, key, seconds))
  ipcMain.handle('redis:delete', (_e, id: string, d: number, keys: string[]) => changes('redis:delete', id, [d], redis.deleteKeys(findRedis(id), d, keys)))
  ipcMain.handle('redis:rename', (_e, id: string, d: number, key: string, to: string) =>
    changes('redis:rename', id, [d], redis.renameKey(findRedis(id), d, key, to))
  )
  ipcMain.handle('redis:create', (_e, id: string, d: number, key: string, spec: RedisNewKey, o?: { ttl?: number | null }) =>
    changes('redis:create', id, [d], redis.createKey(findRedis(id), d, key, spec, o))
  )
  ipcMain.handle('redis:item', (_e, id: string, d: number, key: string, op: RedisItemOp) => redis.itemOp(findRedis(id), d, key, op))
  ipcMain.handle('redis:command', (_e, id: string, d: number, text: string) =>
    redis.runCommands(findRedis(id), d, text).finally(() => dropCached(id, invalidationsFor('redis:command', [d, text])))
  )
  // ---- DynamoDB (own channels; the Postgres ones above are untouched) ----
  ipcMain.handle('dynamo:profiles', () => listProfiles())
  ipcMain.handle('dynamo:tables', (_e, id: string) => dynamo.listTables(findDynamo(id)))
  ipcMain.handle('dynamo:describe', (_e, id: string, table: string) => dynamo.describeTable(findDynamo(id), table))
  ipcMain.handle('dynamo:items', (_e, id: string, table: string, o: dynamo.ItemsOpts) => dynamo.fetchItems(findDynamo(id), table, o))
  ipcMain.handle('dynamo:partiql', (_e, id: string, statement: string, o?: dynamo.StatementOpts) =>
    dynamo.executePartiQL(findDynamo(id), statement, o)
  )
  ipcMain.handle('dynamo:setTableFilter', (_e, id: string, filter: TableFilter | null) =>
    mutateSource(id, (d) => {
      const f = { ...(d.tableFilter ?? {}) }
      if (filter) f['dynamodb'] = filter
      else delete f['dynamodb']
      return { tableFilter: f }
    })
  )
  ipcMain.handle('db:databases', (_e, id: string) => db.listDatabases(find(id)))
  ipcMain.handle('db:schemas', (_e, id: string, d: string) => db.listSchemas(find(id), d))
  ipcMain.handle('db:tablesAll', (_e, id: string, d: string) => db.tablesAll(find(id), d))
  ipcMain.handle('db:tables', (_e, id: string, d: string, s: string) => db.listTables(find(id), d, s))
  ipcMain.handle('db:columns', (_e, id: string, d: string, s: string, t: string) => db.getColumns(find(id), d, s, t))
  ipcMain.handle('db:indexes', (_e, id: string, d: string, s: string, t: string) => db.getIndexes(find(id), d, s, t))
  ipcMain.handle('db:rows', (_e, a) => db.fetchRows(find(a.dsId), a))
  ipcMain.handle('db:apply', (_e, id: string, d: string, s: string, t: string, ch) =>
    db.applyChanges(find(id), d, s, t, ch)
  )
  ipcMain.handle('db:disconnect', (_e, id: string) => closeSource(id).then(() => undefined))
  // ---- cache (every input is validated; ids must be saved data sources, anything else is ignored) ----
  ipcMain.handle('cache:get', (_e, id: unknown, key: unknown) => (savedCacheId(id) && validCacheKey(key) ? objectCache.get(id, key) ?? null : null))
  ipcMain.handle('cache:set', (_e, id: unknown, key: unknown, data: unknown) =>
    savedCacheId(id) && validCacheKey(key) ? objectCache.set(id, key, data) : false
  )
  ipcMain.handle('cache:delete', (_e, id: unknown, prefix?: unknown) =>
    savedCacheId(id) && (prefix === undefined || prefix === null || validCachePrefix(prefix)) ? objectCache.delete(id, prefix ?? undefined) : 0
  )
  ipcMain.handle('cache:clear', (_e, id?: unknown) => {
    if (id === undefined || id === null) objectCache.clear()
    else if (validCacheDsId(id)) objectCache.clear(id)
  })
  ipcMain.handle('cache:all', (_e, prefixes?: unknown) => {
    const ps = Array.isArray(prefixes) ? prefixes.filter(validCachePrefix).slice(0, 20) : [...CACHE_INDEX_PREFIXES]
    return objectCache.all(sourceIds(), ps)
  })
  ipcMain.handle('cache:size', () => objectCache.size())
  // ---- Settings > Backup & restore (native dialogs and file writes stay here; every input is validated in backupService.ts) ----
  const backupService = createBackupService({
    dialog: {
      save: (o) => {
        const w = BrowserWindow.getFocusedWindow()
        return w ? dialog.showSaveDialog(w, o as SaveDialogOptions) : dialog.showSaveDialog(o as SaveDialogOptions)
      },
      open: (o) => {
        const w = BrowserWindow.getFocusedWindow()
        return w ? dialog.showOpenDialog(w, o as OpenDialogOptions) : dialog.showOpenDialog(o as OpenDialogOptions)
      }
    },
    shell,
    store: { loadSources, loadSourcesRaw, loadFolders, commit: commitState, encryptionAvailable, secretBlobs },
    userDataDir: () => app.getPath('userData'),
    defaultDir: () => {
      try {
        return app.getPath('documents')
      } catch {
        return app.getPath('downloads')
      }
    },
    appVersion: app.getVersion(),
    platform: process.platform,
    closeSource,
    dropCache: (id) => {
      objectCache.clear(id)
      announceCache(id, [''])
    },
    beforeKeychain: explainKeychain,
    log
  })
  ipcMain.handle('backup:export', (_e, req: unknown) => backupService.export(req))
  ipcMain.handle('backup:pick', () => backupService.pick())
  ipcMain.handle('backup:unlock', (_e, id: unknown, passphrase: unknown) => backupService.unlock(id, passphrase))
  ipcMain.handle('backup:apply', (_e, id: unknown, opts: unknown) => backupService.apply(id, opts))
  ipcMain.handle('backup:cancel', (_e, id: unknown) => backupService.cancel(id))
  ipcMain.handle('backup:undo', (_e, current?: unknown) => backupService.undo(current))
  ipcMain.handle('backup:showInFolder', (_e, path: unknown) => backupService.showInFolder(path))
}

function createWindow(): void {
  const saved = initialWindowState()
  const win = new BrowserWindow({
    ...saved.options,
    backgroundColor: '#2b2d30',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  if (saved.maximized) win.maximize()
  if (saved.fullscreen) win.setFullScreen(true)
  trackWindowState(win)
  // pinch zoom is disabled so it can't fight with the stepped zoom; Ctrl/Cmd+wheel arrives as 'zoom-changed'
  void win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {})
  win.webContents.on('zoom-changed', (_e, dir) => setZoomPercent(nextZoom(factorToPercent(win.webContents.getZoomFactor()), dir)))
  // (re-)apply the saved zoom after every load (first start, reload after a renderer crash)
  win.webContents.on('did-finish-load', () => applyZoom(win, false))
  win.webContents.on('render-process-gone', (_e, d) => {
    log('render-process-gone: ' + JSON.stringify(d))
    // never resurrect the window while quitting: that left a half-quit app that ignored Cmd+Q (app.quit() is a no-op once a quit is in flight)
    if (!quitting && !win.isDestroyed()) win.reload()
  })
  win.on('unresponsive', () => log('window unresponsive'))
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  // Settings... (Cmd/Ctrl+,): the renderer opens its settings dialog
  const fontItem = (label: string, accelerator: string, dir: 'in' | 'out' | 'reset', visible = true): MenuItemConstructorOptions => ({
    label,
    accelerator,
    visible,
    click: (_item, win) => {
      const w = (win as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow()
      if (w && !w.isDestroyed()) w.webContents.send('menu:fontSize', dir)
    }
  })
  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: (_item, win) => {
      const w = (win as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow()
      if (w && !w.isDestroyed()) w.webContents.send('menu:settings')
    }
  }
  // The default View menu binds Cmd+R to "reload the page". We remove it so Cmd+R reaches the renderer: it refreshes the
  // selected tree item (focus in the explorer) or reloads the grid of the active table tab. Never add a reload / forceReload
  // role or an F5 / Cmd+Shift+R accelerator here.
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'DataGrid', // fixed: app.name is pinned to the legacy "datagrip-lite" (see legacyIdentity.ts) so saved data / Keychain entries stay put
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(process.platform === 'darwin' ? [] : [settingsItem, { type: 'separator' } as MenuItemConstructorOptions]),
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Custom zoom items (not the zoomIn/zoomOut roles: those only bind Cmd+Plus, not Cmd+=). Hidden twins add the
        // extra accelerators; hidden items still fire on their key combination.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoomPercent(ZOOM_DEFAULT) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => setZoomPercent(nextZoom(zoomPercent, 'in')) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: () => setZoomPercent(nextZoom(zoomPercent, 'in')) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+numadd', visible: false, click: () => setZoomPercent(nextZoom(zoomPercent, 'in')) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => setZoomPercent(nextZoom(zoomPercent, 'out')) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+numsub', visible: false, click: () => setZoomPercent(nextZoom(zoomPercent, 'out')) },
        { type: 'separator' },
        // font size (Settings > Display): Cmd/Ctrl+Alt with +, - and 0 (plain Cmd/Ctrl +, -, 0 is the display size above)
        fontItem('Increase Font Size', 'CmdOrCtrl+Alt+Plus', 'in'),
        fontItem('Increase Font Size', 'CmdOrCtrl+Alt+=', 'in', false),
        fontItem('Increase Font Size', 'CmdOrCtrl+Alt+numadd', 'in', false),
        fontItem('Decrease Font Size', 'CmdOrCtrl+Alt+-', 'out'),
        fontItem('Decrease Font Size', 'CmdOrCtrl+Alt+numsub', 'out', false),
        fontItem('Reset Font Size', 'CmdOrCtrl+Alt+0', 'reset')
      ]
    },
    // Go > Go to Database or Table… (Cmd/Ctrl+O): the renderer opens its search popup
    {
      label: 'Go',
      submenu: [
        {
          label: 'Go to Database or Table…',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, win) => {
            const w = (win as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow()
            if (w && !w.isDestroyed()) w.webContents.send('menu:goto')
          }
        }
      ]
    },
    // Custom Window menu: the stock `windowMenu` role owns Cmd+W ("Close" -> closes the BrowserWindow),
    // so the keystroke never reaches the renderer. Cmd+W closes the active editor tab instead.
    {
      label: 'Window',
      submenu: [
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, win) => {
            const w = (win as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow()
            if (w && !w.isDestroyed()) w.webContents.send('menu:closeTab')
          }
        },
        {
          label: 'Next Tab',
          accelerator: 'Ctrl+Tab', // Ctrl (not Cmd) on macOS too, like browsers / IDEs
          click: (_item, win) => {
            const w = (win as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow()
            if (w && !w.isDestroyed()) w.webContents.send('menu:nextTab')
          }
        },
        {
          label: 'Previous Tab',
          accelerator: 'Ctrl+Shift+Tab',
          click: (_item, win) => {
            const w = (win as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow()
            if (w && !w.isDestroyed()) w.webContents.send('menu:prevTab')
          }
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'front' } as MenuItemConstructorOptions] : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  zoomPercent = readZoom(zoomFile()) ?? ZOOM_DEFAULT
  setupAboutPanel(app) // native "About DataGrid" (the menu has the standard `about` role)
  buildMenu()
  registerIpc()
  // explain the upcoming macOS keychain prompt before the first saved password is decrypted
  if (hasStoredPasswords()) await explainKeychain()
  createWindow()
})
// ---- quitting: Cmd+Q must always end the process ----
let quitting = false
app.on('before-quit', () => {
  quitting = true
  objectCache.flush()
  void dynamo.closeAll()
  void redis.closeAll()
  // a hung / dead renderer can keep the graceful quit waiting for ever: give it a few seconds, then exit for real
  setTimeout(() => app.exit(0), 4000).unref()
})
// kill / pkill / logout: exit right away (the default graceful path could hang on an unresponsive window and leave a zombie that ignores Cmd+Q)
app.on('will-quit', () => objectCache.flush())
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => (objectCache.flush(), app.exit(0)))
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
app.on('child-process-gone', (_e, d) => log('child-process-gone: ' + JSON.stringify(d)))
