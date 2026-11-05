// @vitest-environment jsdom
// REGRESSION: in the table/schema/database filter popup the icon (and checkbox) of rows with a long name was squeezed to nothing
// (flex-shrink: 1 + a nowrap label that could not shrink). jsdom has no layout, so assert on the CSS source + DOM structure.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ListPicker from '../../src/renderer/src/DbPicker'

afterEach(cleanup)

const css = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')

/** declarations of every rule whose selector list contains `selector` exactly */
function decls(selector: string): string {
  const out: string[] = []
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of plain.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').some((s) => s.trim() === selector)) out.push(m[2])
  }
  return out.join(';')
}

describe('flex children are not squeezed by long labels', () => {
  it('icons, icon wrappers and checkboxes never shrink', () => {
    expect(decls('svg')).toMatch(/flex-shrink:\s*0/)
    expect(decls('.ticon')).toMatch(/flex-shrink:\s*0/)
    expect(decls('input[type=checkbox]')).toMatch(/flex-shrink:\s*0/)
    expect(decls('.picker-row svg')).toMatch(/flex:\s*none/)
    expect(decls('.picker-row input[type=checkbox]')).toMatch(/flex:\s*none/)
  })

  it('the picker row label takes the remaining space and ellipsizes; the list scrolls vertically only', () => {
    const label = decls('.picker-row > span')
    expect(label).toMatch(/min-width:\s*0/)
    expect(label).toMatch(/overflow:\s*hidden/)
    expect(label).toMatch(/text-overflow:\s*ellipsis/)
    expect(label).toMatch(/white-space:\s*nowrap/)
    expect(decls('.picker-row')).toMatch(/min-width:\s*0/)
    expect(decls('.picker-list')).toMatch(/overflow-x:\s*hidden/)
    expect(decls('.picker-list')).toMatch(/overflow-y:\s*auto/)
  })

  it('the index picker name can shrink instead of overflowing the row', () => {
    const name = decls('.idx-name')
    expect(name).toMatch(/min-width:\s*0/)
    expect(name).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('ListPicker rows render checkbox + svg icon + a name span carrying the full name as tooltip', async () => {
    const long = 'scrut_admin_panel_role_permission_templates'
    render(
      <ListPicker x={0} y={0} icon="table" placeholder="Search tables..." load={async () => [long, 'migrations']} selected={null}
        defaultOf={(a) => a} onClose={() => {}} onChange={() => {}} />
    )
    const name = await screen.findByText(long)
    expect(name.getAttribute('title')).toBe(long)
    const row = name.closest('label.picker-row')!
    expect(row.querySelector('input[type=checkbox]')).toBeTruthy()
    expect(row.querySelector('svg')).toBeTruthy()
    expect(name.parentElement).toBe(row)
  })
})
