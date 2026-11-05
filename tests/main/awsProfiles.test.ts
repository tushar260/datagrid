import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProfiles, mergeProfileNames, parseProfileNames } from '../../src/main/awsProfiles'

describe('parseProfileNames (config file)', () => {
  it('reads [default] and [profile x]; ignores other sections and keys', () => {
    const text = [
      '[default]', 'region = us-east-1', 'aws_secret_access_key = TOPSECRET', '',
      '[profile dev]', 'sso_session = corp', '',
      '[profile  spaced ]', '[sso-session corp]', 'sso_region = x', '[services s3]', '[plugins]', '[other]'
    ].join('\n')
    expect(parseProfileNames(text, 'config')).toEqual(['default', 'dev', 'spaced'])
  })

  it('tolerates CRLF, BOM, indentation, comments and trailing comments', () => {
    const text = '\uFEFF# comment\r\n  [profile a]  # note\r\n; x\r\n[profile b] ; y\r\n[profile c] junk\r\n'
    expect(parseProfileNames(text, 'config')).toEqual(['a', 'b'])
  })

  it('drops unterminated headers and invalid names (path traversal, separators)', () => {
    const text = '[profile ok]\n[profile broken\n[profile ../etc/passwd]\n[profile a/b]\n[profile ]\n[profile x y]\n'
    expect(parseProfileNames(text, 'config')).toEqual(['ok'])
  })

  it('empty text', () => {
    expect(parseProfileNames('', 'config')).toEqual([])
  })
})

describe('parseProfileNames (credentials file)', () => {
  it('every section is a profile, without the "profile" keyword', () => {
    const text = '[default]\naws_access_key_id = AKIA\naws_secret_access_key = SECRET\n[work]\n[profile weird]\n'
    expect(parseProfileNames(text, 'credentials')).toEqual(['default', 'work'])
  })
})

describe('mergeProfileNames', () => {
  it('de-duplicates, puts default first and sorts the rest', () => {
    expect(mergeProfileNames(['zed', 'default', 'b'], ['b', 'Alpha'])).toEqual(['default', 'Alpha', 'b', 'zed'])
    expect(mergeProfileNames(['b', 'a'])).toEqual(['a', 'b'])
    expect(mergeProfileNames()).toEqual([])
  })
})

describe('listProfiles', () => {
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dgl-aws-'))
    mkdirSync(join(home, '.aws'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('merges config and credentials files', () => {
    writeFileSync(join(home, '.aws', 'config'), '[default]\n[profile dev]\n')
    writeFileSync(join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key=x\n[ci]\n')
    expect(listProfiles({}, home)).toEqual(['default', 'ci', 'dev'])
  })

  it('missing files are fine', () => {
    expect(listProfiles({}, join(home, 'nowhere'))).toEqual([])
    writeFileSync(join(home, '.aws', 'credentials'), '[only]\n')
    expect(listProfiles({}, home)).toEqual(['only'])
  })

  it('honours AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE', () => {
    const c = join(home, 'c.ini')
    const k = join(home, 'k.ini')
    writeFileSync(c, '[profile custom]\n')
    writeFileSync(k, '[creds]\n')
    expect(listProfiles({ AWS_CONFIG_FILE: c, AWS_SHARED_CREDENTIALS_FILE: k }, home)).toEqual(['creds', 'custom'])
  })

  it('an unreadable path (a directory) is ignored', () => {
    expect(listProfiles({ AWS_CONFIG_FILE: join(home, '.aws') }, home)).toEqual([])
  })
})
