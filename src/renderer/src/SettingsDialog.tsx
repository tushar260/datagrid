import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ZOOM_MAX_PERCENT, ZOOM_MIN_PERCENT } from '../../shared'
import { APP_CREDIT, APP_DISPLAY_NAME, appCopyright } from '../../credits'
import BackupSection from './BackupSection'
import { isMac } from './lib/platform'
import { useModalClose } from './lib/useModalClose'
import { useZoom } from './lib/useZoom'
import { clearAllCached } from './lib/objectCache'
import { SETTINGS_SECTIONS, getLastSection, sectionForKey, setLastSection, type SettingsSectionId } from './lib/settingsSections'
import {
  DENSITIES, MONO_FONTS, MONO_SIZE_RANGE, NULL_TEXTS, PAGE_SIZE_CHOICES, UI_FONTS, UI_SIZE_RANGE,
  cssVars, resetSettings, stepFontSizes, updateSettings, useSettings,
  type Density, type Motion, type MonoFont, type NullText, type UiFont
} from './lib/settings'

const range = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i)

/** App settings: every change is applied (and saved) immediately; there is no Save button. */
export default function SettingsDialog({ onClose: onCloseProp, onSourcesChanged }: { onClose: () => void; onSourcesChanged?: () => void }): React.JSX.Element {
  const { ref: bgRef, closing, close: onClose } = useModalClose(onCloseProp)
  const s = useSettings()
  const vars = cssVars(s)
  const backupEsc = useRef<(() => boolean) | null>(null) // Backup & restore sub-panel: Esc / backdrop close it before the dialog
  const { percent, step: stepZoom } = useZoom()
  const mac = isMac()
  const [section, setSection] = useState<SettingsSectionId>(getLastSection)
  const go = (id: SettingsSectionId, focus = false): void => {
    setSection(id)
    setLastSection(id)
    if (focus) requestAnimationFrame(() => document.getElementById('set-tab-' + id)?.focus())
  }
  const onNavKey = (e: React.KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const next = sectionForKey(section, e.key)
    if (!next) return
    e.preventDefault()
    go(next, true)
  }
  // size of the object cache on disk ("12.4 MB"), or "Cleared" right after the button was pressed
  const [cacheStatus, setCacheStatus] = useState('')
  useEffect(() => {
    let live = true
    void Promise.resolve(window.api?.cache?.size?.())
      .then((n) => live && typeof n === 'number' && n > 0 && setCacheStatus(n < 100_000 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`))
      .catch(() => undefined)
    return () => void (live = false)
  }, [])
  // app version for Settings > About (package.json, through the main process)
  const [version, setVersion] = useState('')
  useEffect(() => {
    let live = true
    void Promise.resolve(window.api?.appVersion?.())
      .then((v) => live && typeof v === 'string' && setVersion(v))
      .catch(() => undefined)
    return () => void (live = false)
  }, [])
  const keys = (k: string, alt = false): string => (mac ? `${alt ? '⌥' : ''}⌘${k}` : `Ctrl+${alt ? 'Alt+' : ''}${k}`)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (backupEsc.current?.()) return
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // keep the selected tab in view when the nav is a scrolling tab strip
  useEffect(() => {
    document.getElementById('set-tab-' + section)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [section])

  const title = SETTINGS_SECTIONS.find((x) => x.id === section)?.label ?? ''

  return createPortal(
    <div
      ref={bgRef}
      className={'modal-bg cd-bg' + (closing ? ' closing' : '')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !backupEsc.current?.()) onClose()
      }}
    >
      <div className="modal settings-modal" role="dialog" aria-label="Settings">
        <h3>Settings</h3>

        <div className="set-layout">
          <div className="set-nav" role="tablist" aria-label="Settings sections" onKeyDown={onNavKey}>
            {SETTINGS_SECTIONS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                id={'set-tab-' + x.id}
                className="set-tab"
                aria-selected={x.id === section}
                aria-controls={x.id === section ? 'set-pane-' + x.id : undefined}
                tabIndex={x.id === section ? 0 : -1}
                onClick={() => go(x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>

          <div className="set-pane" role="tabpanel" id={'set-pane-' + section} aria-labelledby={'set-tab-' + section} key={section}>
            <div className="set-pane-title">{title}</div>

            {section === 'appearance' && (
              <>
                <div className="set-row" role="group" aria-label="Display size">
                  <label>Display size</label>
                  <div className="set-stepper">
                    <button type="button" aria-label="Zoom out" disabled={percent <= ZOOM_MIN_PERCENT} onClick={() => stepZoom('out')}>−</button>
                    <span className="set-value" aria-live="polite">{percent}%</span>
                    <button type="button" aria-label="Zoom in" disabled={percent >= ZOOM_MAX_PERCENT} onClick={() => stepZoom('in')}>+</button>
                    <button type="button" aria-label="Reset display size" disabled={percent === 100} onClick={() => stepZoom('reset')}>Reset</button>
                  </div>
                  <span className="set-keys" data-testid="zoom-keys">{keys('−')} {keys('+')} {keys('0')}</span>
                </div>
                <div className="set-row" role="group" aria-label="Font size">
                  <label>Font size</label>
                  <div className="set-stepper">
                    <button type="button" aria-label="Decrease font size" disabled={s.uiSize <= UI_SIZE_RANGE.min && s.monoSize <= MONO_SIZE_RANGE.min} onClick={() => updateSettings(stepFontSizes(s, 'out'))}>A−</button>
                    <span className="set-value">{s.uiSize} px</span>
                    <button type="button" aria-label="Increase font size" disabled={s.uiSize >= UI_SIZE_RANGE.max && s.monoSize >= MONO_SIZE_RANGE.max} onClick={() => updateSettings(stepFontSizes(s, 'in'))}>A+</button>
                    <button type="button" aria-label="Reset font size" disabled={s.uiSize === 13 && s.monoSize === 12} onClick={() => updateSettings(stepFontSizes(s, 'reset'))}>Reset</button>
                  </div>
                  <span className="set-keys" data-testid="font-keys">{keys('−', true)} {keys('+', true)} {keys('0', true)}</span>
                </div>
                <div className="set-row">
                  <label htmlFor="set-motion">Animations</label>
                  <select id="set-motion" value={s.motion} onChange={(e) => updateSettings({ motion: e.target.value as Motion })}>
                    <option value="system">On (follow system setting)</option>
                    <option value="off">Off</option>
                  </select>
                </div>
              </>
            )}

            {section === 'fonts' && (
              <>
                <div className="set-row">
                  <label htmlFor="set-ui-font">Interface font</label>
                  <div className="set-controls">
                    <select id="set-ui-font" value={s.uiFont} onChange={(e) => updateSettings({ uiFont: e.target.value as UiFont })}>
                      {UI_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                    <select aria-label="Interface font size" className="set-size" value={s.uiSize} onChange={(e) => updateSettings({ uiSize: Number(e.target.value) })}>
                      {range(UI_SIZE_RANGE.min, UI_SIZE_RANGE.max).map((n) => <option key={n} value={n}>{n} px</option>)}
                    </select>
                  </div>
                </div>
                <div className="set-row">
                  <label htmlFor="set-mono-font">Editor &amp; grid font</label>
                  <div className="set-controls">
                    <select id="set-mono-font" value={s.monoFont} onChange={(e) => updateSettings({ monoFont: e.target.value as MonoFont })}>
                      {MONO_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                    <select aria-label="Editor and grid font size" className="set-size" value={s.monoSize} onChange={(e) => updateSettings({ monoSize: Number(e.target.value) })}>
                      {range(MONO_SIZE_RANGE.min, MONO_SIZE_RANGE.max).map((n) => <option key={n} value={n}>{n} px</option>)}
                    </select>
                  </div>
                </div>
                <div className="set-preview" aria-hidden>
                  <div style={{ fontFamily: vars['--ui-font'], fontSize: vars['--ui-fs'] }}>The quick brown fox jumps over the lazy dog 0123456789</div>
                  <div style={{ fontFamily: vars['--mono'], fontSize: vars['--editor-fs'] }}>select id, name from users where id &gt;= 42;</div>
                </div>
                <div className="set-note">Fonts that are not installed on this machine fall back to the next one in the list.</div>
              </>
            )}

            {section === 'grid' && (
              <>
                <div className="set-row">
                  <label htmlFor="set-density">Row density</label>
                  <select id="set-density" value={s.density} onChange={(e) => updateSettings({ density: e.target.value as Density })}>
                    {DENSITIES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                </div>
                <div className="set-row">
                  <label htmlFor="set-page">Rows per page (new tables)</label>
                  <select id="set-page" value={s.pageSize} onChange={(e) => updateSettings({ pageSize: Number(e.target.value) })}>
                    {PAGE_SIZE_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="set-row">
                  <label htmlFor="set-null">Show NULL as</label>
                  <select id="set-null" value={s.nullText} onChange={(e) => updateSettings({ nullText: e.target.value as NullText })}>
                    {NULL_TEXTS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </>
            )}

            {section === 'general' && (
              <label className="check set-check">
                <input type="checkbox" checked={s.restoreTabs} onChange={(e) => updateSettings({ restoreTabs: e.target.checked })} />
                Reopen previous tabs on launch
              </label>
            )}

            {section === 'cache' && (
              <>
                <label className="check set-check">
                  <input type="checkbox" checked={s.cacheObjects} onChange={(e) => updateSettings({ cacheObjects: e.target.checked })} />
                  Cache database objects locally (faster start)
                </label>
                <div className="set-row">
                  <label>Cached objects</label>
                  <div className="set-controls">
                    <button
                      type="button"
                      onClick={() => void clearAllCached().then(() => setCacheStatus('Cleared'), () => setCacheStatus('Could not clear'))}
                    >
                      Clear cached objects
                    </button>
                    <span className="set-keys" role="status" data-testid="cache-status">{cacheStatus}</span>
                  </div>
                </div>
              </>
            )}

            {section === 'backup' && <BackupSection escapeRef={backupEsc} onRestored={onSourcesChanged} heading={false} />}

            {section === 'about' && (
              <div className="set-about" role="group" aria-label="About DataGrid">
                <svg className="set-about-logo" width="44" height="44" viewBox="0 0 44 44" aria-hidden>
                  <rect x="1" y="1" width="42" height="42" rx="10" fill="#2b2d30" stroke="#4e5157" />
                  <g fill="none" stroke="#6c9ef8" strokeWidth="2" strokeLinejoin="round">
                    <rect x="10" y="12" width="24" height="20" rx="2" />
                    <path d="M10 19h24M10 25.5h24M18 12v20M26 12v20" />
                  </g>
                </svg>
                <div className="set-about-text">
                  <div className="set-about-name">{APP_DISPLAY_NAME}</div>
                  <div className="set-about-version" data-testid="about-version">{version ? `Version ${version}` : ''}</div>
                  <div className="set-about-credit">{APP_CREDIT}</div>
                  <div className="set-about-copy">{appCopyright()}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="set-actions">
          <button type="button" onClick={() => resetSettings()}>Reset to defaults</button>
          <span className="set-spacer" />
          <button type="button" className="primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
