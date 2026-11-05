import type { DynamoPage } from '../../../shared'

/**
 * Appends a further page (console "Load more") to an accumulated result. Pages are built independently, so the second
 * one may have attributes the first one lacked: columns are unioned and the older rows are padded with nulls.
 */
export function appendPage<T extends DynamoPage>(a: T, b: DynamoPage): T {
  const columns = a.columns.map((c) => ({ ...c, types: [...c.types] }))
  const index = new Map(columns.map((c, i) => [c.name, i]))
  for (const c of b.columns) {
    const at = index.get(c.name)
    if (at === undefined) {
      index.set(c.name, columns.length)
      columns.push({ ...c, types: [...c.types] })
    } else {
      for (const t of c.types) if (!columns[at].types.includes(t)) columns[at].types.push(t)
      if (!columns[at].key && c.key) columns[at].key = c.key
    }
  }
  const padded = a.rows.map((r) => (r.length < columns.length ? [...r, ...Array<null>(columns.length - r.length).fill(null)] : r))
  const added = b.rows.map((r) => {
    const out = Array<string | null>(columns.length).fill(null)
    b.columns.forEach((c, i) => { out[index.get(c.name)!] = r[i] ?? null })
    return out
  })
  return { ...a, columns, rows: [...padded, ...added], items: [...a.items, ...b.items], next: b.next, columnsCapped: a.columnsCapped || b.columnsCapped }
}
