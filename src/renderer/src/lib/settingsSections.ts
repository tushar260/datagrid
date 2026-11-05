/** The sections of the Settings dialog (left nav / tab strip) and which one was open last. */
export type SettingsSectionId = 'appearance' | 'fonts' | 'grid' | 'general' | 'cache' | 'backup' | 'about'

export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'grid', label: 'Data grid' },
  { id: 'general', label: 'General' },
  { id: 'cache', label: 'Cache' },
  { id: 'backup', label: 'Backup & restore' },
  { id: 'about', label: 'About' }
]

const DEFAULT_SECTION: SettingsSectionId = SETTINGS_SECTIONS[0].id

// remembered while the app runs only (not persisted: it is not a setting)
let last: SettingsSectionId = DEFAULT_SECTION

export const getLastSection = (): SettingsSectionId => last

export const setLastSection = (id: SettingsSectionId): void => {
  last = id
}

export const resetLastSection = (): void => {
  last = DEFAULT_SECTION
}

/** The section a navigation key moves to (wraps around); null when the key is not a navigation key. */
export function sectionForKey(current: SettingsSectionId, key: string): SettingsSectionId | null {
  const n = SETTINGS_SECTIONS.length
  const i = Math.max(0, SETTINGS_SECTIONS.findIndex((s) => s.id === current))
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return SETTINGS_SECTIONS[(i + 1) % n].id
    case 'ArrowUp':
    case 'ArrowLeft':
      return SETTINGS_SECTIONS[(i - 1 + n) % n].id
    case 'Home':
      return SETTINGS_SECTIONS[0].id
    case 'End':
      return SETTINGS_SECTIONS[n - 1].id
    default:
      return null
  }
}
