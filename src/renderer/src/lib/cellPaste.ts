/** Pure planning of a paste into the data grid (⌘/Ctrl+V on selected cells). */
export interface PasteCell { lin: number; col: number; value: string | null }

const asText = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v)

/**
 * Where does each pasted value go?
 *  - a JSON array of objects (what ⌘C produces for several cells): keys are matched to column names, one object per row;
 *  - text with tabs / newlines (spreadsheet or DataGrip TSV): a block starting at the top-left selected cell;
 *  - a single value: the focused cell, or every selected cell when several are selected (fill).
 * Cells outside the loaded rows / columns are skipped.
 */
export function planPaste(
  text: string, colNames: readonly string[], totalRows: number,
  start: { lin: number; col: number }, selLins: readonly number[], selCols: [number, number]
): PasteCell[] {
  const t = text.replace(/\r\n?/g, '\n')
  const out: PasteCell[] = []
  const put = (lin: number, col: number, value: string | null): void => {
    if (lin >= 0 && lin < totalRows && col >= 0 && col < colNames.length) out.push({ lin, col, value })
  }

  if (/^\s*\[/.test(t)) {
    try {
      const arr: unknown = JSON.parse(t)
      if (Array.isArray(arr) && arr.length && arr.every((o) => o && typeof o === 'object' && !Array.isArray(o))) {
        arr.forEach((o, k) => {
          for (const [key, v] of Object.entries(o as Record<string, unknown>)) {
            const ci = colNames.indexOf(key)
            if (ci >= 0) put(start.lin + k, ci, asText(v))
          }
        })
        return out
      }
    } catch { /* not JSON: paste as plain text */ }
  }

  const body = t.endsWith('\n') ? t.slice(0, -1) : t
  if (!body.includes('\t') && !body.includes('\n')) {
    const cells = selLins.length > 1 || selCols[0] !== selCols[1] ? selLins : [start.lin]
    const [c0, c1] = cells === selLins ? selCols : [start.col, start.col]
    for (const lin of cells) for (let c = c0; c <= c1; c++) put(lin, c, body)
    return out
  }
  body.split('\n').forEach((line, r) => line.split('\t').forEach((v, k) => put(start.lin + r, start.col + k, v)))
  return out
}
