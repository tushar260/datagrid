import { APP_NAME, userDataPath } from './identity'

/** The slice of Electron's `app` this needs (so it can be tested with a fake). */
export interface PinnableApp {
  setName(name: string): void
  setPath(name: 'userData', path: string): void
  getPath(name: 'appData'): string
  commandLine: { hasSwitch(name: string): boolean }
}

/**
 * Startup identity, run before anything reads `app.getPath('userData')` or uses `safeStorage`:
 *  1. the runtime app name is APP_NAME (it names the Keychain item "datagrid Safe Storage");
 *  2. userData is `<appData>/datagrid` unless `--user-data-dir` is given (e2e tests, a second profile: that always wins).
 * Returns the userData path set, or null when it was left to Electron (--user-data-dir).
 */
export function pinIdentity(app: PinnableApp): string | null {
  app.setName(APP_NAME)
  if (app.commandLine.hasSwitch('user-data-dir')) return null
  const userData = userDataPath(app.getPath('appData'))
  app.setPath('userData', userData)
  return userData
}
