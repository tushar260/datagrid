import type React from "react"
import { useEffect, useState } from 'react'
import RegionInput from './RegionInput'
import { useModalClose } from './lib/useModalClose'
import {
  dsKind, validateDynamoConfig, validateRedisConfig, redisDelimiter, REDIS_MAX_DELIMITER, REDIS_DEFAULT_PORT, type DataSource, type DynamoAuthMode, type DynamoConfig, type DsKind, type RedisConfig
} from '../../shared'

const PG_NAME = 'postgres@localhost'
const DDB_NAME = 'dynamodb'
const REDIS_NAME = 'redis@localhost'
const DEFAULT_NAMES: Record<DsKind, string> = { postgres: PG_NAME, dynamodb: DDB_NAME, redis: REDIS_NAME }
const TITLES: Record<DsKind, string> = { postgres: 'PostgreSQL', dynamodb: 'DynamoDB', redis: 'Redis' }

const newSource = (kind: DsKind, folderId: string | null, name?: string): DataSource =>
  kind === 'redis'
    ? {
        id: '', kind: 'redis', name: name ?? REDIS_NAME, host: '', port: 0, user: '', password: '', database: '', ssl: false, folderId,
        redis: { host: 'localhost', port: REDIS_DEFAULT_PORT, db: 0, tls: false }
      }
    : kind === 'dynamodb'
    ? {
        id: '', kind: 'dynamodb', name: name ?? DDB_NAME, host: '', port: 0, user: '', password: '', database: '', ssl: false, folderId,
        dynamo: { region: '', authMode: 'default' }
      }
    : { id: '', name: name ?? PG_NAME, host: 'localhost', port: 5432, user: 'postgres', password: '', database: 'postgres', ssl: false, folderId }

const AUTH_MODES: { mode: DynamoAuthMode; label: string; hint?: string }[] = [
  { mode: 'default', label: 'Default (AWS CLI / environment)', hint: 'Uses the AWS default credential chain: environment variables, ~/.aws (profiles, SSO), container or instance roles.' },
  { mode: 'profile', label: 'Named profile' },
  { mode: 'keys', label: 'Access key' }
]

export default function DataSourceDialog({
  initial, folderId, onClose: onCloseProp
}: {
  initial: DataSource | null
  folderId?: string | null
  onClose: (changed: boolean) => void
}): React.JSX.Element {
  const { ref: bgRef, closing, close: onClose } = useModalClose(onCloseProp)
  const [ds, setDs] = useState<DataSource>(initial ?? newSource('postgres', folderId ?? null))
  const kind = dsKind(ds)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; warn?: boolean } | null>(
    initial?.passwordUnavailable
      ? {
          ok: false,
          warn: true,
          text:
            dsKind(initial) === 'dynamodb'
              ? 'The saved secret access key could not be read because macOS Keychain access was denied. Enter it again to replace it (or restart the app and choose "Always Allow").'
              : 'The saved password could not be read because macOS Keychain access was denied. Enter it again to replace it (or restart the app and choose "Always Allow").'
        }
      : null
  )
  const [busy, setBusy] = useState(false)
  const [profiles, setProfiles] = useState<string[]>([])
  const [showSecret, setShowSecret] = useState(false)
  const [tokenCleared, setTokenCleared] = useState(false)
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(false)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  useEffect(() => {
    if (kind !== 'dynamodb') return
    let alive = true
    window.api.dynamo.profiles().then((p) => { if (alive) setProfiles(p) }, () => undefined)
    return () => { alive = false }
  }, [kind])
  const set = <K extends keyof DataSource>(k: K, v: DataSource[K]): void => setDs({ ...ds, [k]: v })
  const dyn: DynamoConfig = ds.dynamo ?? { region: '', authMode: 'default' }
  const setDyn = (patch: Partial<DynamoConfig>): void => setDs({ ...ds, dynamo: { ...dyn, ...patch } })
  const rd: RedisConfig = ds.redis ?? { host: 'localhost', port: REDIS_DEFAULT_PORT, db: 0, tls: false }
  const setRd = (patch: Partial<RedisConfig>): void => setDs({ ...ds, redis: { ...rd, ...patch } })
  const clean = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

  /** A new source can pick its type; the default name follows the type until the user edits it. */
  const pickKind = (k: DsKind): void => {
    if (k === kind) return
    const untouched = ds.name === DEFAULT_NAMES[kind]
    setDs(newSource(k, ds.folderId ?? null, untouched ? undefined : ds.name))
    setMsg(null)
  }

  /** The DynamoDB form is validated before test / save so the user gets a precise message instead of an SDK error. */
  const problem = (): string | null =>
    kind === 'dynamodb' ? validateDynamoConfig(dyn, !!dyn.hasSecret) : kind === 'redis' ? validateRedisConfig(rd) : null

  const test = async (): Promise<void> => {
    const bad = problem()
    if (bad) { setMsg({ ok: false, text: bad }); return }
    setBusy(true)
    setMsg(null)
    try {
      const v = await window.api.testSource(ds)
      setMsg({ ok: true, text: 'Succeeded. ' + v })
    } catch (e) {
      setMsg({ ok: false, text: clean(e) })
    } finally {
      setBusy(false)
    }
  }
  const save = async (): Promise<void> => {
    const bad = problem()
    if (bad) { setMsg({ ok: false, text: bad }); return }
    try {
      await window.api.saveSource(ds)
      onClose(true)
    } catch (e) {
      setMsg({ ok: false, text: 'Could not save: ' + clean(e) })
    }
  }
  const del = async (): Promise<void> => {
    try {
      await window.api.deleteSource(ds.id)
      onClose(true)
    } catch (e) {
      setMsg({ ok: false, text: 'Could not delete: ' + clean(e) })
    }
  }

  const hasToken = !!dyn.hasSessionToken && !tokenCleared

  return (
    <div
      ref={bgRef}
      className={'modal-bg' + (closing ? ' closing' : '')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(false)
      }}
    >
      <form
        className="modal"
        onSubmit={(e) => { e.preventDefault(); void save() }}
      >
        <h3>Data Source: {TITLES[kind]}</h3>
        {!ds.id && (
          <label>Type
            <select className="ds-type" value={kind} onChange={(e) => pickKind(e.target.value as DsKind)}>
              <option value="postgres">PostgreSQL</option>
              <option value="dynamodb">DynamoDB</option>
              <option value="redis">Redis</option>
            </select>
          </label>
        )}
        <label>Name<input autoFocus value={ds.name} onChange={(e) => set('name', e.target.value)} /></label>

        {kind === 'postgres' && (
          <>
            <div className="row2">
              <label>Host<input value={ds.host} onChange={(e) => set('host', e.target.value)} /></label>
              <label className="port">Port<input type="number" value={ds.port} onChange={(e) => set('port', Number(e.target.value))} /></label>
            </div>
            <label>User<input value={ds.user} onChange={(e) => set('user', e.target.value)} /></label>
            <label>Password<input type="password" value={ds.password} onChange={(e) => set('password', e.target.value)} /></label>
            <label>Database<input value={ds.database} onChange={(e) => set('database', e.target.value)} /></label>
            <label className="check"><input type="checkbox" checked={ds.ssl} onChange={(e) => set('ssl', e.target.checked)} /> Use SSL</label>
          </>
        )}

        {kind === 'redis' && (
          <>
            <div className="row2">
              <label>Host<input value={rd.host} spellCheck={false} onChange={(e) => setRd({ host: e.target.value })} /></label>
              <label className="port">Port<input type="number" value={rd.port} onChange={(e) => setRd({ port: Number(e.target.value) })} /></label>
            </div>
            <label>
              Username (optional)
              <input value={rd.username ?? ''} autoComplete="off" spellCheck={false} placeholder="default user" onChange={(e) => setRd({ username: e.target.value })} />
            </label>
            <label>
              Password
              <span className="secret-row">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={rd.password ?? ''}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={rd.hasPassword && !rd.clearPassword ? 'saved (leave blank to keep)' : ''}
                  onChange={(e) => setRd({ password: e.target.value, clearPassword: false })}
                />
                <button type="button" className="secret-toggle" onClick={() => setShowSecret(!showSecret)}>{showSecret ? 'Hide' : 'Show'}</button>
                {rd.hasPassword && !rd.clearPassword && (
                  <button type="button" className="secret-toggle" onClick={() => setRd({ password: '', clearPassword: true })}>Clear saved</button>
                )}
              </span>
            </label>
            {rd.clearPassword && <div className="dlg-hint">The saved password will be removed when you press OK.</div>}
            <label className="port">Database (0-255)<input type="number" min={0} max={255} value={rd.db} onChange={(e) => setRd({ db: Number(e.target.value) })} /></label>
            <label className="check"><input type="checkbox" checked={rd.tls} onChange={(e) => setRd({ tls: e.target.checked })} /> Use TLS</label>
            <label>
              Key delimiter
              <input
                className="mono"
                value={redisDelimiter(rd)}
                maxLength={REDIS_MAX_DELIMITER}
                spellCheck={false}
                autoComplete="off"
                placeholder="none (flat list), e.g. :"
                onChange={(e) => setRd({ keyDelimiter: e.target.value })}
              />
            </label>
            <div className="dlg-hint">The Database Explorer groups keys into folders at this text (<code>user:42:name</code> becomes user / 42 / name). Empty = a flat list of keys under each type (the default).</div>
          </>
        )}

        {kind === 'dynamodb' && (
          <>
            <div className="auth-modes" role="radiogroup" aria-label="Authentication">
              <span className="auth-title">Authentication</span>
              {AUTH_MODES.map((m) => (
                <label key={m.mode} className="check">
                  <input
                    type="radio"
                    name="authMode"
                    checked={dyn.authMode === m.mode}
                    onChange={() => setDyn({ authMode: m.mode })}
                  />
                  {m.label}
                </label>
              ))}
            </div>
            {dyn.authMode === 'default' && <div className="dlg-hint">{AUTH_MODES[0].hint}</div>}
            {dyn.authMode === 'profile' && (
              <label>
                Profile
                <input
                  list="ds-aws-profiles"
                  value={dyn.profile ?? ''}
                  placeholder={profiles.length ? 'choose or type a profile name' : 'type a profile name'}
                  onChange={(e) => setDyn({ profile: e.target.value })}
                />
                <datalist id="ds-aws-profiles">{profiles.map((p) => <option key={p} value={p} />)}</datalist>
              </label>
            )}
            {dyn.authMode === 'keys' && (
              <>
                <label>Access key ID<input value={dyn.accessKeyId ?? ''} autoComplete="off" spellCheck={false} onChange={(e) => setDyn({ accessKeyId: e.target.value })} /></label>
                <label>
                  Secret access key
                  <span className="secret-row">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      value={dyn.secretAccessKey ?? ''}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={dyn.hasSecret ? 'saved (leave blank to keep)' : ''}
                      onChange={(e) => setDyn({ secretAccessKey: e.target.value })}
                    />
                    <button type="button" className="secret-toggle" onClick={() => setShowSecret(!showSecret)}>{showSecret ? 'Hide' : 'Show'}</button>
                  </span>
                </label>
                <label>
                  Session token (optional)
                  <span className="secret-row">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      value={dyn.sessionToken ?? ''}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={hasToken ? 'saved (leave blank to keep)' : ''}
                      onChange={(e) => setDyn({ sessionToken: e.target.value === '' && !tokenCleared ? undefined : e.target.value })}
                    />
                    {hasToken && (
                      <button type="button" className="secret-toggle" onClick={() => { setTokenCleared(true); setDyn({ sessionToken: '' }) }}>Clear saved</button>
                    )}
                  </span>
                </label>
              </>
            )}
            <label>
              Region
              <RegionInput
                value={dyn.region}
                placeholder={dyn.authMode === 'keys' ? 'e.g. us-east-1' : 'from the environment / profile (or e.g. us-east-1)'}
                onChange={(region) => setDyn({ region })}
              />
            </label>
            <details className="adv" open={!!dyn.endpoint}>
              <summary>Advanced</summary>
              <label>
                Endpoint URL
                <input
                  value={dyn.endpoint ?? ''}
                  placeholder="http://localhost:8000 (DynamoDB Local, LocalStack)"
                  spellCheck={false}
                  onChange={(e) => setDyn({ endpoint: e.target.value })}
                />
              </label>
            </details>
          </>
        )}

        {msg && <div className={msg.ok ? 'msg ok' : msg.warn ? 'msg warn' : 'msg bad'}>{msg.text}</div>}
        <div className="modal-actions">
          <button type="button" onClick={test} disabled={busy}>{busy ? 'Testing…' : 'Test Connection'}</button>
          <span className="spacer" />
          {ds.id && <button type="button" className="danger" onClick={del}>Delete</button>}
          <button type="button" onClick={() => onClose(false)}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </div>
  )
}
