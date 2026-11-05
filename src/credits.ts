/**
 * Product name and credits shown in the native About panel (main) and in Settings > About (renderer).
 * Display strings only: the runtime app name lives in src/main/identity.ts.
 */
export const APP_DISPLAY_NAME = 'DataGrid'
export const APP_AUTHOR = 'Tushar Arora'
export const APP_CREDIT = `Designed and developed by ${APP_AUTHOR}`
export const appCopyright = (year: number = new Date().getFullYear()): string => `© ${year} ${APP_AUTHOR}`
