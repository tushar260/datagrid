import type { App } from 'electron'
import { APP_CREDIT, APP_DISPLAY_NAME, appCopyright } from '../credits'

export interface AboutPanelOptions {
  applicationName: string
  applicationVersion: string
  copyright: string
  credits: string
}

/** The options of the native About panel (macOS "About DataGrid"). The name is explicit: app.name is the lowercase runtime name (identity.ts), not a display name. */
export function buildAboutPanelOptions(version: string, year: number = new Date().getFullYear()): AboutPanelOptions {
  return { applicationName: APP_DISPLAY_NAME, applicationVersion: version, copyright: appCopyright(year), credits: APP_CREDIT }
}

/** Installs the About panel options (version comes from package.json through app.getVersion()). */
export function setupAboutPanel(app: Pick<App, 'getVersion' | 'setAboutPanelOptions'>): void {
  app.setAboutPanelOptions(buildAboutPanelOptions(app.getVersion()))
}
