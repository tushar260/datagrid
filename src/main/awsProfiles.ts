import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { isValidProfile } from '../shared'

/**
 * Profile names for the data source dialog, read from the AWS shared config files. Only section headers are looked at:
 * keys, secrets and every other line are ignored (and never kept).
 */

/** `~/.aws/config` names a profile `[profile x]` (the default one is `[default]`); `~/.aws/credentials` just `[x]`. */
export type ProfileFileKind = 'config' | 'credentials'

/** Pure: the profile names declared in one file's text. Comments (# ;), CRLF, a BOM and odd spacing are tolerated. */
export function parseProfileNames(text: string, kind: ProfileFileKind): string[] {
  const out: string[] = []
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('[')) continue
    const end = line.indexOf(']')
    if (end < 0) continue
    const tail = line.slice(end + 1).trim()
    if (tail && !/^[#;]/.test(tail)) continue // junk after the header
    const inner = line.slice(1, end).trim()
    let name: string | null = inner
    if (kind === 'config') {
      const m = /^profile\s+(.+)$/i.exec(inner)
      if (m) name = m[1].trim()
      else if (inner === 'default') name = 'default'
      else name = null // [sso-session x], [services x], ...
    }
    if (name && isValidProfile(name)) out.push(name)
  }
  return out
}

/** Pure: merged, de-duplicated and sorted names (`default` first). */
export function mergeProfileNames(...lists: string[][]): string[] {
  const set = new Set(lists.flat())
  const rest = [...set].filter((n) => n !== 'default').sort((a, b) => a.localeCompare(b))
  return set.has('default') ? ['default', ...rest] : rest
}

const read = (file: string): string => {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

/** Profiles found in the shared config and credentials files (honours AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE). */
export function listProfiles(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const config = env.AWS_CONFIG_FILE || join(home, '.aws', 'config')
  const creds = env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials')
  return mergeProfileNames(parseProfileNames(read(config), 'config'), parseProfileNames(read(creds), 'credentials'))
}
