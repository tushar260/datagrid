import { beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS, getLastSection, resetLastSection, sectionForKey, setLastSection } from '../../src/renderer/src/lib/settingsSections'

beforeEach(resetLastSection)

describe('settings sections', () => {
  it('lists the sections in nav order with unique ids', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual(['Appearance', 'Fonts', 'Data grid', 'General', 'Cache', 'Backup & restore', 'About'])
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length)
  })

  it('remembers the last section and can be reset', () => {
    expect(getLastSection()).toBe('appearance')
    setLastSection('cache')
    expect(getLastSection()).toBe('cache')
    resetLastSection()
    expect(getLastSection()).toBe('appearance')
  })

  it('maps navigation keys to the next / previous section, wrapping around', () => {
    expect(sectionForKey('appearance', 'ArrowDown')).toBe('fonts')
    expect(sectionForKey('appearance', 'ArrowRight')).toBe('fonts')
    expect(sectionForKey('fonts', 'ArrowUp')).toBe('appearance')
    expect(sectionForKey('fonts', 'ArrowLeft')).toBe('appearance')
    expect(sectionForKey('appearance', 'ArrowUp')).toBe('about')
    expect(sectionForKey('backup', 'ArrowDown')).toBe('about')
    expect(sectionForKey('about', 'ArrowDown')).toBe('appearance')
    expect(sectionForKey('grid', 'Home')).toBe('appearance')
    expect(sectionForKey('grid', 'End')).toBe('about')
    expect(sectionForKey('grid', 'Enter')).toBeNull()
    expect(sectionForKey('grid', 'a')).toBeNull()
  })
})
