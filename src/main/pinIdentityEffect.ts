// Side-effect module: import it FIRST in the main entry (before anything reads app.getPath('userData') or uses safeStorage).
// The logic lives in pinIdentity.ts (testable).
import { app } from 'electron'
import { pinIdentity } from './pinIdentity'

pinIdentity(app)
