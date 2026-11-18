/** Pure helpers for the data grid's cell-range selection and copy. */
export interface ColRange { a: number; b: number }

/** Inclusive [lo, hi] column bounds; a null range is just the focused column. */
export const colBounds = (sel: ColRange | null, focused: number): [number, number] =>
  sel ? [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)] : [focused, focused]

export const inColRange = (sel: ColRange | null, ci: number): boolean => {
  if (!sel) return true
  const [lo, hi] = colBounds(sel, 0)
  return ci >= lo && ci <= hi
}

/**
 * What ⌘/Ctrl+C puts on the clipboard for a rows × columns rectangle.
 * One cell → its plain text (NULL → ''); several cells → pretty JSON array of objects (one per row, keys = column names).
 */
export function copyPayload(
  colNames: readonly string[], lins: readonly number[], sel: ColRange | null, focused: number,
  valueAt: (lin: number, col: number) => unknown
): string {
  const [c0, c1] = colBounds(sel, focused)
  const rows = [...lins].sort((x, y) => x - y)
  if (rows.length <= 1 && c0 === c1) {
    const v = rows.length ? valueAt(rows[0], c0) : undefined
    return v == null ? '' : String(v)
  }
  const out = rows.map((lin) => {
    const o: Record<string, unknown> = {}
    for (let c = c0; c <= c1; c++) o[colNames[c]] = valueAt(lin, c)
    return o
  })
  return JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
}
