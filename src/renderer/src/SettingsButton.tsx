import type React from 'react'
import { GearIcon } from './icons'
import { isMac } from './lib/platform'

/** The gear at the right end of the editor tab bar; opens Settings (display size, fonts, ...). */
export default function SettingsButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const mac = isMac()
  return (
    <div className="tabtools">
      <button
        type="button"
        className="ibtn zbtn settings-btn"
        aria-label="Settings"
        onClick={onClick}
        data-tip="Settings"
        data-tip2={mac ? '⌘,' : 'Ctrl+,'}
      >
        <GearIcon />
      </button>
    </div>
  )
}
