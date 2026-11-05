import { describe, expect, it, vi } from 'vitest'

// aboutPanel.ts only needs electron for types, but mock it like the other main tests so importing it never loads the real binary
vi.mock('electron', () => ({ app: {} }))

import { buildAboutPanelOptions, setupAboutPanel } from '../../src/main/aboutPanel'
import { APP_AUTHOR, APP_CREDIT, APP_DISPLAY_NAME, appCopyright } from '../../src/credits'

describe('About panel options', () => {
  it('names the product DataGrid explicitly and credits the developer', () => {
    expect(buildAboutPanelOptions('1.2.3', 2026)).toEqual({
      applicationName: 'DataGrid',
      applicationVersion: '1.2.3',
      copyright: '© 2026 Tushar Arora',
      credits: 'Designed and developed by Tushar Arora'
    })
  })

  it('defaults the copyright year to the current year', () => {
    expect(buildAboutPanelOptions('0.1.0').copyright).toBe(`© ${new Date().getFullYear()} Tushar Arora`)
  })

  it('shares its strings with the renderer credits module', () => {
    expect(APP_DISPLAY_NAME).toBe('DataGrid')
    expect(APP_AUTHOR).toBe('Tushar Arora')
    expect(APP_CREDIT).toBe('Designed and developed by Tushar Arora')
    expect(appCopyright(2030)).toBe('© 2030 Tushar Arora')
  })

  it('setupAboutPanel passes app.getVersion() to app.setAboutPanelOptions', () => {
    const app = { getVersion: vi.fn(() => '9.9.9'), setAboutPanelOptions: vi.fn() }
    setupAboutPanel(app)
    expect(app.setAboutPanelOptions).toHaveBeenCalledTimes(1)
    expect(app.setAboutPanelOptions).toHaveBeenCalledWith(expect.objectContaining({ applicationName: 'DataGrid', applicationVersion: '9.9.9', credits: APP_CREDIT }))
  })
})
