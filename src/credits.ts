/**
 * Product name and credits shown in the native About panel (main) and in Settings > About (renderer).
 * Display strings only: persisted identifiers (the pinned "datagrip-lite" app name, `datagrip-lite:*` storage keys,
 * Keychain names...) live in src/main/legacyIdentity.ts and must never be derived from these.
 */
export const APP_DISPLAY_NAME = 'DataGrid'
export const APP_AUTHOR = 'Tushar Arora'
export const APP_CREDIT = `Designed and developed by ${APP_AUTHOR}`
export const appCopyright = (year: number = new Date().getFullYear()): string => `© ${year} ${APP_AUTHOR}`
