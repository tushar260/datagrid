import type { DataSource } from '../../../shared'

/** case-insensitive, accent-insensitive, numeric-aware ("db2" < "db10") */
export const compareNames = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

/**
 * Data sources of one folder level, in display order: alphabetical by name. Ties (same name ignoring case/accents) fall back
 * to the exact name, then the id, so the order is deterministic. Returns a new array.
 */
export function sortSources<T extends Pick<DataSource, 'id' | 'name'>>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) => compareNames(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/**
 * The data sources that sit directly in `parentId` (null = root). Sources inside a folder are sorted alphabetically (so added,
 * renamed, moved and imported ones land in place immediately); root-level sources keep their stored order.
 */
export function sourcesIn<T extends Pick<DataSource, 'id' | 'name' | 'folderId'>>(sources: readonly T[], parentId: string | null): T[] {
  const list = sources.filter((d) => (d.folderId ?? null) === parentId)
  return parentId === null ? list : sortSources(list)
}
