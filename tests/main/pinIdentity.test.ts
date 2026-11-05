import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_NAME, LOG_FILE_NAME, userDataPath } from '../../src/main/identity'
import { pinIdentity } from '../../src/main/pinIdentity'
import type { PinnableApp } from '../../src/main/pinIdentity'

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))
const APP_DATA = '/A/Application Support'

function fakeApp(switches: string[] = []): PinnableApp & { name?: string; paths: Record<string, string> } {
  const a = {
    name: undefined as string | undefined,
    paths: {} as Record<string, string>,
    setName(n: string) { a.name = n },
    setPath(k: string, p: string) { a.paths[k] = p },
    getPath: () => APP_DATA,
    commandLine: { hasSwitch: (s: string) => switches.includes(s) }
  }
  return a
}

describe('identity', () => {
  it('the app name and the data folder are "datagrid"', () => {
    expect(APP_NAME).toBe('datagrid')
    expect(userDataPath(APP_DATA)).toBe('/A/Application Support/datagrid')
    expect(LOG_FILE_NAME).toBe('datagrid.log')
  })

  it('package.json carries the same name and does not override it for the packaged app', () => {
    expect(pkg.name).toBe('datagrid')
    expect(pkg.build.productName).toBe('DataGrid')
    expect(pkg.build.appId).toBe('com.local.datagrid')
    expect(pkg.build.extraMetadata).toBeUndefined()
  })
})

describe('pinIdentity', () => {
  it('sets the app name and points userData at <appData>/datagrid', () => {
    const app = fakeApp()
    expect(pinIdentity(app)).toBe(join(APP_DATA, 'datagrid'))
    expect(app.name).toBe(APP_NAME)
    expect(app.paths.userData).toBe(join(APP_DATA, 'datagrid'))
  })

  it('--user-data-dir wins: the path is left alone', () => {
    const app = fakeApp(['user-data-dir'])
    expect(pinIdentity(app)).toBeNull()
    expect(app.name).toBe(APP_NAME)
    expect(app.paths.userData).toBeUndefined()
  })
})
