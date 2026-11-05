// Side-effect module: import it FIRST in the main entry (before anything reads app.getPath('userData') or uses safeStorage).
// See legacyIdentity.ts for why the runtime name / data folder are pinned to the pre-"DataGrid" identity.
import { app } from 'electron'
import { LEGACY_APP_NAME, legacyUserDataPath } from './legacyIdentity'

app.setName(LEGACY_APP_NAME)
// an explicit --user-data-dir (the e2e tests, a second profile) must win: only pin the default location
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', legacyUserDataPath(app.getPath('appData')))
