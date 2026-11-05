/**
 * Which pane the user is "in": the Explorer tree or the editor pane (table / console tabs).
 *
 * Keyboard shortcuts that exist in both places (e.g. Cmd/Ctrl+R: refresh the tree item vs. reload the grid) use this to
 * decide who handles the keystroke. The Explorer records it on every mousedown (capture phase): "the last click was
 * inside `.explorer`". Keystrokes whose target is a real element are decided by the target itself (`inExplorer`);
 * only keystrokes that land on the document body fall back to the last click.
 */
let lastClickInExplorer = false

/** Start tracking clicks (call once, from the Explorer); returns the cleanup. */
export function trackExplorerClicks(): () => void {
  const onDown = (e: MouseEvent): void => {
    lastClickInExplorer = !!(e.target as HTMLElement | null)?.closest?.('.explorer')
  }
  window.addEventListener('mousedown', onDown, true)
  return () => window.removeEventListener('mousedown', onDown, true)
}

/** True when the last click was inside the Explorer. */
export const explorerClicked = (): boolean => lastClickInExplorer

/** Mark the Explorer as the active pane without a click (Shift+Esc moved the keyboard focus into the tree). */
export const markExplorerActive = (): void => { lastClickInExplorer = true }

/** Window event (fired by `useSidebarFocus` once the sidebar is visible): the Explorer selects a row and takes keyboard focus. */
export const FOCUS_EXPLORER_EVENT = 'explorer:focus'

/** Test helper: forget the tracked click. */
export const resetExplorerClick = (): void => { lastClickInExplorer = false }

/**
 * True when a keystroke aimed at `target` belongs to the Explorer: the target is inside `.explorer`, or it is the
 * document body (nothing focused) and the last click was inside the Explorer.
 */
export function keyBelongsToExplorer(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (el?.closest?.('.explorer')) return true
  const bare = !el || el === document.body || el === document.documentElement || !('closest' in el)
  return bare && lastClickInExplorer
}

/** Whether the Explorer has something to refresh right now (a selected node with a Refresh item); registered by the Explorer. */
let explorerCanRefresh: () => boolean = () => true
export function setExplorerRefreshProbe(fn: () => boolean): () => void {
  explorerCanRefresh = fn
  return () => { explorerCanRefresh = () => true }
}

/**
 * Does the Explorer own a Cmd/Ctrl+R aimed at `target`? Like `keyBelongsToExplorer`, except that the editor pane's
 * reload takes the keystroke when the Explorer would not act on it: focus in a text field of the Explorer (the filter
 * box, an inline rename; the tree ignores keys there) or nothing selected in the tree to refresh. Without this, Cmd+R
 * did nothing after clicking into the filter box.
 */
export function explorerOwnsRefresh(target: EventTarget | null): boolean {
  if (!keyBelongsToExplorer(target)) return false
  if ((target as HTMLElement | null)?.closest?.('input, textarea, select')) return false
  return explorerCanRefresh()
}
