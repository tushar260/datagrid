/**
 * Pure helpers for the data grid's multi-row selection.
 * Rows are addressed by a linear index: 0..nRows-1 = loaded rows, nRows.. = pending-insert ("new") rows.
 */
export type RowKind = 'row' | 'new'

export const NO_ROWS: ReadonlySet<number> = new Set<number>()

export const linOf = (cu: { kind: RowKind; i: number }, nRows: number): number =>
  cu.kind === 'row' ? cu.i : nRows + cu.i

/** The effective selection: the explicit multi-selection, else just the focused cell's row. */
export const selectedLins = (
  explicit: ReadonlySet<number>, cu: { kind: RowKind; i: number } | null, nRows: number
): ReadonlySet<number> => (explicit.size ? explicit : cu ? new Set([linOf(cu, nRows)]) : NO_ROWS)

/**
 * Like selectedLins, but honours an explicit "nothing selected" state (Escape): the cell cursor stays where it is,
 * yet no row counts as selected until the next click / arrow key re-establishes a selection.
 */
export const effectiveSelection = (
  explicit: ReadonlySet<number>, cu: { kind: RowKind; i: number } | null, nRows: number, cleared: boolean
): ReadonlySet<number> => (cleared ? NO_ROWS : selectedLins(explicit, cu, nRows))

/** Inclusive range a..b (either direction). */
export const rangeSet = (a: number, b: number): Set<number> => {
  const s = new Set<number>()
  for (let k = Math.min(a, b); k <= Math.max(a, b); k++) s.add(k)
  return s
}

/** Cmd/Ctrl+click: toggle one row. */
export const toggleLin = (sel: ReadonlySet<number>, lin: number): Set<number> => {
  const s = new Set(sel)
  if (!s.delete(lin)) s.add(lin)
  return s
}

/**
 * What "delete selected rows" does: loaded rows become pending deletes (toggled back off when they all already are,
 * unless `force`), pending-insert rows are simply dropped. Tables without a primary key cannot delete loaded rows.
 */
export function computeDelete(
  lins: Iterable<number>, nRows: number, deleted: ReadonlySet<number>, hasPk: boolean, force = false
): { deleted: Set<number>; dropNew: Set<number>; noPk: boolean } {
  const all = [...lins]
  const existing = all.filter((l) => l < nRows)
  const dropNew = new Set(all.filter((l) => l >= nRows).map((l) => l - nRows))
  const d = new Set(deleted)
  const noPk = existing.length > 0 && !hasPk
  if (existing.length && hasPk) {
    const undo = !force && existing.every((l) => d.has(l))
    for (const l of existing) undo ? d.delete(l) : d.add(l)
  }
  return { deleted: d, dropNew, noPk }
}
