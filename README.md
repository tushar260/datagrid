# DataGrid

A fast, lightweight desktop client for PostgreSQL, DynamoDB and Redis, with an IDE-style database explorer and query console.

<!-- Screenshot placeholder: add an image here once one is committed to the repo. -->

## Install

DataGrid is macOS only. Run this in a terminal to install the latest release into `/Applications`:

```sh
curl -fsSL https://raw.githubusercontent.com/tushar260/datagrid/main/install.sh | bash
```

Or download the DMG or ZIP from the [releases page](https://github.com/tushar260/datagrid/releases). The app is ad-hoc signed and not notarized, so a browser download is blocked by macOS Gatekeeper on first launch. Clear the quarantine flag once and it opens normally:

```sh
xattr -dr com.apple.quarantine /Applications/DataGrid.app
```

(On macOS 15 and later you can instead open System Settings, Privacy & Security, and click Open Anyway.)

## Features

### Common

- Data sources organised in nested folders; sources inside a folder are sorted A-Z (natural, case-insensitive order).
- Database Explorer tree with per-item context menus, inline rename (F2), multi-select, and a filter box.
- Editor tabs: drag to reorder, close with Cmd+W, cycle with Ctrl+Tab.
- Go to Database or Table (Cmd+O): fuzzy search over cached databases, schemas and tables.
- Persistent local introspection cache of explorer lists (databases, schemas, table names, DynamoDB tables, Redis keys), so the next start needs no refetch. It is invalidated after structure-changing statements and when a source's connection settings change. Can be switched off or cleared in Settings.
- Query console per data source (SQL, PartiQL or Redis commands) with Ctrl+Space completion.
- Settings dialog with sections: Appearance, Fonts, Data grid, General, Cache, Backup & restore, About.
- Backup & restore of data sources, folders and (optionally) settings, layout and open-tab session. Passwords and AWS secrets are included only if you set a passphrase; the file is then encrypted (scrypt + AES-256-GCM). Restore can merge or replace, and an automatic safety backup is kept for Undo.
- Browser-style display zoom (Cmd +/-/0, persisted) and separate font-size shortcuts.
- Window size/position and open tabs, expanded folders and per-table view state (filters, sort, paging) are restored on start (tab restore can be disabled in Settings).

### PostgreSQL

- Explorer: server > databases > schemas > tables/views > columns, with sort order, database/schema visibility filters and table name filters (list or starts/contains/ends/regex rule).
- Create and drop databases, create schemas and tables, add columns, rename and drop tables.
- Table view with Data and Structure tabs (columns, indexes), paging (page size in Settings), header sort, WHERE and ORDER BY inputs, and go-to-row range editing (Cmd+G).
- Inline editing: edit cells, add rows (Cmd+N), delete rows, then submit all pending changes at once (Cmd+Enter).
- SQL console with table/column/keyword completion.

### DynamoDB

- Credentials: default AWS chain, a named profile from your AWS config files, or static keys (optional session token); region picker and optional custom endpoint (for example DynamoDB Local).
- Table list with name filters; table and index picker.
- Read-only grid backed by Scan with cursor paging, or PartiQL when a WHERE condition is entered. Sorting is not supported (it is a scan).
- Structure tab with key schema, attributes and indexes.
- PartiQL console with table/attribute completion.

### Redis

- Explorer: server > databases > type folders (string, list, set, zset, hash, stream) > keys grouped into folders by a key delimiter (default `:`, configurable per source, blank disables grouping).
- Key Browser tab with pattern/type filtering and multi-key selection; per-key tabs.
- Value viewers/editors for strings, hashes, lists, sets and sorted sets (add, edit and remove items); streams are shown as entries.
- Create, rename and delete keys; view and set TTL.
- Optional ACL username, password, logical database (0-255) and TLS.
- Console that runs one Redis command per line.

## Keyboard shortcuts

Cmd is Ctrl on non-macOS platforms. Only shortcuts found in the code are listed.

| Shortcut | Action |
| --- | --- |
| Cmd+O | Go to Database or Table |
| Shift+Esc | Move focus to the Database Explorer (reveals a hidden sidebar); press again to return |
| Cmd+, | Open Settings |
| Cmd+R | Refresh the selected tree item (explorer focused) or reload the active table / key view |
| Cmd+Enter | Run the console; submit pending changes in a table view; save an edited value |
| Cmd+N | Add a row (table view) |
| Cmd+G | Go to row range (table view, Data tab) |
| Cmd+W | Close the active tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Cmd+Shift+[ / ] | Previous / next tab |
| Ctrl+Shift+PageUp / PageDown | Move the active tab left / right |
| Cmd +, -, 0 | Zoom in, out, actual size |
| Cmd+Alt +, -, 0 | Increase, decrease, reset font size |
| Ctrl+Space | Completion in consoles and some inputs |
| F2 / F4 | Rename / open the selected tree item (F4 also edits a data source) |
| Shift+Cmd+L | New query console from the selected tree item |
| Cmd+C, Alt+Cmd+C | Copy key name(s) or prefix (Redis) / copy name(s) |
| Cmd+Backspace | Delete or drop the selected tree item |
| Esc | Close dialogs and popups; cancel inline edits |

## Requirements

- macOS. The packaging script builds for the machine it runs on; the current build is Apple Silicon (arm64). Passwords rely on the macOS Keychain through Electron `safeStorage`.
- Node.js and npm. `package.json` has no `engines` field; the lockfile shows dependencies requiring Node `^22.22.2 || ^24.15.0 || >=26`, and development here uses Node 22.
- Electron 45 is installed as a dev dependency, so no separate Electron install is needed.

## Development

```bash
npm install
npm run dev          # electron-vite dev server with hot reload
npm run typecheck    # tsc --noEmit
npm run build        # production build into out/
npm start            # electron-vite preview of the built app
```

### Tests

Tests live in `tests/` and run with Vitest (jsdom for renderer tests, opt in per file).

```bash
npm test             # unit and component tests (no external services)
npm run test:watch
npm run test:coverage
```

Integration tests are excluded from `npm test` and run only when asked:

| Command | What it needs |
| --- | --- |
| `npm run test:int` (`RUN_PG_TESTS=1`) | A PostgreSQL server. Defaults to `localhost:5432`, current OS user, no password. Override with `PG_TEST_URL=postgres://user:pw@host:5432/postgres`. Creates and drops its own scratch database. |
| `npm run test:redis` (`RUN_REDIS_TESTS=1`) | A `redis-server` binary, default `/opt/homebrew/bin/redis-server` (override with `REDIS_SERVER_BIN`). Starts its own throwaway instance on a random high port, never port 6379. |
| `npm run test:ddb` (`RUN_DDB_TESTS=1`) | DynamoDB Local or LocalStack, and `DDB_ENDPOINT`, for example `RUN_DDB_TESTS=1 DDB_ENDPOINT=http://127.0.0.1:8000 npm run test:ddb`. Uses fake credentials and its own table. |
| `npm run test:e2e` (`RUN_E2E=1`) | The installed app at `/Applications/DataGrid.app` (override with `E2E_APP`), plus the PostgreSQL setup above; the Redis scenario also needs `redis-server`. The app is launched with a throwaway user-data dir. |

## Building a macOS app

```bash
npm run package      # electron-vite build && electron-builder --mac --dir
```

This produces an unpacked `DataGrid.app` under `dist/` (target `dir`, output directory `dist`). `package.json` sets `identity: null`, so electron-builder does not sign with a developer certificate, and there is no notarization. No script creates a DMG or applies a signature; if you want those, do it by hand, for example:

```bash
codesign --force --deep --sign - dist/mac-arm64/DataGrid.app      # ad-hoc signature
hdiutil create -volname DataGrid -srcfolder dist/mac-arm64/DataGrid.app -ov -format UDZO dist/DataGrid.dmg
```

An ad-hoc signed, non-notarized app is blocked by Gatekeeper on first launch. Right-click the app and choose Open, or remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/DataGrid.app
```

### Releases

Pushing a tag that starts with `v` runs `.github/workflows/release.yml`. It type-checks, runs the unit tests, builds Apple Silicon (`arm64`) and Intel (`x64`) apps, ad-hoc signs them, and publishes a GitHub Release with `DataGrid-<version>-<arch>.dmg`, `DataGrid-<version>-<arch>-mac.zip` and `SHA256SUMS.txt` attached. Nothing needs to be uploaded by hand. To cut a release, bump `version` in `package.json` and commit, then run `./tag.sh` (or `git tag v0.1.0 && git push origin v0.1.0`). The workflow fails if the tag is not `v` plus the `package.json` version. Tags with a hyphen, such as `v1.0.0-beta.1`, are marked as pre-releases. The builds are not notarized (see above). Running the workflow manually from the Actions tab builds the files as run artifacts without creating a release.

## Data and privacy

DataGrid has no server component and sends nothing anywhere except to the databases you configure. Data is stored locally in the Electron `userData` folder, `~/Library/Application Support/datagrid/`:

| Path | Content |
| --- | --- |
| `datasources.json`, `folders.json` | Data sources and folders |
| `window-state.json`, `zoom.json` | Window geometry and zoom |
| `cache/<source id>.json` | Local explorer cache (size-capped) |
| `backups/auto-*.datagrid-backup.json` | Automatic safety backups, the latest 5 are kept |
| `datagrid.log` | Error log |

- Passwords, AWS secret keys/session tokens and Redis passwords are encrypted with Electron `safeStorage` (macOS Keychain) and stored as `enc:` values. If encryption is unavailable they are stored as `raw:` values. The renderer never receives saved secrets back.
- Saved passwords are encrypted with Electron `safeStorage`, which keeps its key in the macOS Keychain item "datagrid Safe Storage".
- Settings and the session (open tabs, expanded folders, console drafts) are kept in the renderer's `localStorage`, under keys prefixed `datagrid:`.
- Exported backups are plain JSON unless you choose to include secrets, in which case they are encrypted with your passphrase.

## Project structure

```
src/
  main/        Electron main process: IPC, PostgreSQL (db.ts), DynamoDB (dynamo.ts), Redis (redis.ts),
               data source store, object cache, backup/restore, window state, zoom,
               identity.ts / pinIdentity.ts (app name, data folder, Keychain item name)
  preload/     contextBridge API exposed to the renderer
  renderer/    React UI (index.html, src/*.tsx, src/lib/* helpers, styles.css)
  shared.ts    Types and pure helpers shared by main and renderer
  credits.ts   Product name and credits shown in the About panel
tests/
  main/        Main-process unit and integration tests
  renderer/    Component and library tests (Testing Library)
  e2e/         Smoke test against the installed app
electron.vite.config.ts   vitest.config.mts   tsconfig.json
```

## Tech stack

Electron 45, React 19, TypeScript, electron-vite (Vite), Vitest with Testing Library and jsdom, `pg`, AWS SDK for JavaScript v3 (DynamoDB, STS, credential providers), `ioredis`, electron-builder.

## Credits

Designed and developed by Tushar Arora.

## License

License: not yet specified. The package is marked `private` and the repository contains no `LICENSE` file.
