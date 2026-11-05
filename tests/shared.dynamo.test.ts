import { describe, expect, it } from 'vitest'
import {
  AWS_REGIONS, dsKind, isValidProfile, isValidRegion, parseEndpoint, selectAllPartiql, splitStatements, validateDynamoConfig
} from '../src/shared'

describe('dsKind', () => {
  it('missing kind is postgres (sources saved before DynamoDB support)', () => {
    expect(dsKind({})).toBe('postgres')
    expect(dsKind(null)).toBe('postgres')
    expect(dsKind(undefined)).toBe('postgres')
    expect(dsKind({ kind: 'postgres' })).toBe('postgres')
    expect(dsKind({ kind: 'dynamodb' })).toBe('dynamodb')
    expect(dsKind({ kind: 'mysql' as never })).toBe('postgres')
  })
})

describe('isValidRegion', () => {
  it.each(['us-east-1', 'eu-central-2', 'local', 'cn-north-1', 'us-gov-west-1', 'a', 'x1'])('accepts %s', (r) => expect(isValidRegion(r)).toBe(true))
  it.each(['', 'US-EAST-1', '-us', 'us-', 'us east', 'us_east_1', 'a.b', 'a/b', '../x', 'x'.repeat(41), 'us-east-1\n', 'é'])('rejects %j', (r) =>
    expect(isValidRegion(r)).toBe(false))
  it('every offered region is valid', () => {
    for (const r of AWS_REGIONS) expect(isValidRegion(r)).toBe(true)
    expect(new Set(AWS_REGIONS).size).toBe(AWS_REGIONS.length)
  })
})

describe('isValidProfile', () => {
  it.each(['default', 'dev', 'my-profile_1', 'corp.sso', 'a@b', 'x:y', 'a+b=c,d'])('accepts %s', (p) => expect(isValidProfile(p)).toBe(true))
  it.each(['', ' ', '../etc/passwd', 'a/b', 'a\\b', 'a..b', '..', 'a b', 'x'.repeat(129), '~', 'a\nb'])('rejects %j', (p) =>
    expect(isValidProfile(p)).toBe(false))
})

describe('parseEndpoint', () => {
  it('accepts http / https and strips trailing slashes', () => {
    expect(parseEndpoint('http://localhost:8000')).toBe('http://localhost:8000')
    expect(parseEndpoint(' https://dynamodb.us-east-1.amazonaws.com/ ')).toBe('https://dynamodb.us-east-1.amazonaws.com')
    expect(parseEndpoint('http://127.0.0.1:1///')).toBe('http://127.0.0.1:1')
    expect(parseEndpoint('http://[::1]:8000')).toBe('http://[::1]:8000')
  })
  it.each(['', '   ', 'localhost:8000', 'ftp://x', 'file:///etc/passwd', 'javascript:alert(1)', 'http://', 'http://user:pw@host', 'http://user@host', 'not a url', '//host'])(
    'rejects %j',
    (e) => expect(parseEndpoint(e)).toBeNull()
  )
})

describe('validateDynamoConfig', () => {
  const ok = { region: 'us-east-1', authMode: 'default' as const }
  it('accepts the three modes', () => {
    expect(validateDynamoConfig(ok, false)).toBeNull()
    expect(validateDynamoConfig({ ...ok, region: '' }, false)).toBeNull()
    expect(validateDynamoConfig({ region: '', authMode: 'profile', profile: 'dev' }, false)).toBeNull()
    expect(validateDynamoConfig({ ...ok, authMode: 'keys', accessKeyId: 'AKIA', secretAccessKey: 's' }, false)).toBeNull()
    expect(validateDynamoConfig({ ...ok, authMode: 'default', endpoint: 'http://localhost:8000' }, false)).toBeNull()
  })
  it('rejects a bad region / endpoint / profile', () => {
    expect(validateDynamoConfig({ ...ok, region: 'Bad Region' }, false)).toMatch(/Invalid region "Bad Region"/)
    expect(validateDynamoConfig({ ...ok, endpoint: 'ftp://x' }, false)).toMatch(/Endpoint URL/)
    expect(validateDynamoConfig({ ...ok, authMode: 'profile' }, false)).toMatch(/profile name/)
    expect(validateDynamoConfig({ ...ok, authMode: 'profile', profile: '   ' }, false)).toMatch(/profile name/)
    expect(validateDynamoConfig({ ...ok, authMode: 'profile', profile: 'a/b' }, false)).toMatch(/Invalid profile name "a\/b"/)
  })
  it('keys mode needs a key id, and a secret unless one is already saved', () => {
    const keys = { ...ok, authMode: 'keys' as const }
    expect(validateDynamoConfig(keys, false)).toMatch(/Access key ID is required/)
    expect(validateDynamoConfig({ ...keys, accessKeyId: '  ' }, true)).toMatch(/Access key ID is required/)
    expect(validateDynamoConfig({ ...keys, accessKeyId: 'AKIA' }, false)).toMatch(/Secret access key is required/)
    expect(validateDynamoConfig({ ...keys, accessKeyId: 'AKIA' }, true)).toBeNull()
    expect(validateDynamoConfig({ ...keys, accessKeyId: 'AKIA', secretAccessKey: 'x' }, false)).toBeNull()
  })
  it('never echoes the secret', () => {
    expect(validateDynamoConfig({ ...ok, authMode: 'keys', accessKeyId: '', secretAccessKey: 'TOPSECRET' }, false)).not.toContain('TOPSECRET')
  })
})

describe('selectAllPartiql', () => {
  it('quotes the table name, doubling embedded quotes', () => {
    expect(selectAllPartiql('orders')).toBe('SELECT * FROM "orders"')
    expect(selectAllPartiql('we"ird')).toBe('SELECT * FROM "we""ird"')
    expect(selectAllPartiql('a b-c.d')).toBe('SELECT * FROM "a b-c.d"')
    expect(selectAllPartiql('"')).toBe('SELECT * FROM """"')
  })
  it('appends a trimmed WHERE only when there is one', () => {
    expect(selectAllPartiql('t', " pk = 'a' ")).toBe(`SELECT * FROM "t" WHERE pk = 'a'`)
    expect(selectAllPartiql('t', '   ')).toBe('SELECT * FROM "t"')
    expect(selectAllPartiql('t', '')).toBe('SELECT * FROM "t"')
    expect(selectAllPartiql('t', undefined)).toBe('SELECT * FROM "t"')
  })
  it('addresses a secondary index as "table"."index"', () => {
    expect(selectAllPartiql('orders', undefined, 'by-gpk')).toBe('SELECT * FROM "orders"."by-gpk"')
    expect(selectAllPartiql('orders', "gpk = 'x'", 'by"gpk')).toBe('SELECT * FROM "orders"."by""gpk" WHERE gpk = \'x\'')
  })
})

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(splitStatements('SELECT 1;  SELECT 2 ;\nSELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })
  it('drops blank statements', () => {
    expect(splitStatements('')).toEqual([])
    expect(splitStatements(' ; ;; \n')).toEqual([])
    expect(splitStatements('a;;b;')).toEqual(['a', 'b'])
  })
  it('keeps semicolons inside strings and quoted names', () => {
    expect(splitStatements(`SELECT * FROM "a;b" WHERE x = 'p;q'; SELECT 2`)).toEqual([`SELECT * FROM "a;b" WHERE x = 'p;q'`, 'SELECT 2'])
  })
  it('handles doubled quotes inside quoted text', () => {
    expect(splitStatements(`SELECT 'it''s; fine'; SELECT "we""ird;"`)).toEqual([`SELECT 'it''s; fine'`, `SELECT "we""ird;"`])
  })
  it('an unterminated quote swallows the rest', () => {
    expect(splitStatements(`SELECT 'oops; SELECT 2`)).toEqual([`SELECT 'oops; SELECT 2`])
  })
  it('a single statement without a semicolon', () => {
    expect(splitStatements('  SELECT * FROM "t"  ')).toEqual(['SELECT * FROM "t"'])
  })
})
