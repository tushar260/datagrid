import { join } from 'path'

/**
 * The runtime identity this app has always had, from before the product was renamed to "DataGrid".
 *
 * The product (package.json name / productName / appId, window title, menu label) is "DataGrid", but the runtime
 * app name MUST stay "datagrip-lite", otherwise existing users silently lose their data:
 *  - Electron's default `userData` folder is `<appData>/<app.name>` (~/Library/Application Support/datagrip-lite):
 *    datasources.json, folders.json, window-state.json, zoom.json, settings.json, datagrip-lite.log, cache/ ...
 *  - `safeStorage` keeps its key in a macOS Keychain item named "<app.name> Safe Storage" (account "<app.name> Key").
 *    Verified on this Mac: the existing item is "datagrip-lite Safe Storage" / "datagrip-lite Key" although the bundle
 *    (CFBundleName) is "Grid" - i.e. it derives from the app name (package.json `name`), not from the bundle name. A new
 *    name would create a new empty Keychain key and every saved password would fail to decrypt.
 * Electron's `app.name` defaults to package.json `productName ?? name` of the app's own package.json. electron-builder
 * does not copy `build.productName` into it, so packaged builds got "datagrip-lite" from `name`. Now that `name` is
 * "datagrid", package.json `build.extraMetadata.name` pins the packaged app's package.json name to this value (so Electron
 * starts with the legacy name from the very beginning, which is what the Keychain service name is read from), and
 * `pinLegacyIdentity` additionally calls `app.setName` + `app.setPath('userData')` as a runtime safety net.
 */
export const LEGACY_APP_NAME = 'datagrip-lite'

/** The userData folder that has always held this app's data; it must never move. */
export const legacyUserDataPath = (appDataPath: string): string => join(appDataPath, LEGACY_APP_NAME)
