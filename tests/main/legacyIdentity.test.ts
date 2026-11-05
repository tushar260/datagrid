import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { LEGACY_APP_NAME, legacyUserDataPath } from '../../src/main/legacyIdentity'

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))

describe('legacy runtime identity (data continuity after the rename to DataGrid)', () => {
  it('keeps the pre-rename runtime name, which names the userData folder and the Keychain item', () => {
    expect(LEGACY_APP_NAME).toBe('datagrip-lite')
  })

  it('pins userData to <appData>/datagrip-lite', () => {
    expect(legacyUserDataPath('/Users/x/Library/Application Support')).toBe('/Users/x/Library/Application Support/datagrip-lite')
  })

  it('the product is DataGrid: package.json name intentionally differs from the runtime name', () => {
    expect(pkg.name).toBe('datagrid')
    expect(pkg.name).not.toBe(LEGACY_APP_NAME)
    expect(pkg.build.productName).toBe('DataGrid')
    expect(pkg.build.appId).toBe('com.local.datagrid')
  })

  it('the packaged app keeps the legacy name in its own package.json (what Electron derives app.name / Keychain from)', () => {
    expect(pkg.build.extraMetadata.name).toBe(LEGACY_APP_NAME)
  })
})
