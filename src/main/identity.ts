import { join } from 'path'

/**
 * The runtime identity of DataGrid: one name everywhere.
 *
 * APP_NAME is the Electron app name. Besides naming the data folder it names the macOS Keychain item that holds the
 * `safeStorage` key ("<app.name> Safe Storage"), which encrypts the saved passwords in datasources.json.
 * The window title / menu / About panel use the explicit display name "DataGrid" (credits.ts).
 */
export const APP_NAME = 'datagrid'

/** The userData folder (under the OS app-data folder). */
export const userDataPath = (appDataPath: string): string => join(appDataPath, APP_NAME)

/** The error log inside userData. */
export const LOG_FILE_NAME = 'datagrid.log'
