import { useEffect, useRef } from 'react'
import { FOCUS_EXPLORER_EVENT } from './focusZone'

/** Where the keyboard focus goes when the tree lets go of it: the active pane's grid / editor. */
const PANE_FOCUS = '.gridwrap, textarea.editor'

/** An element we can sensibly give focus back to: still in the document and not inside a hidden (inactive) tab pane. */
function usable(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false
  const pane = el.closest<HTMLElement>('.pane')
  return !pane || pane.style.display !== 'none'
}

/**
 * Shift+Esc, from anywhere (a grid, the console, a filter / cell input, a Redis value textarea ...): the Database Explorer tree gets
 * the keyboard focus, so Up/Down/Left/Right/Enter drive it. A hidden sidebar is revealed first. Pressed again while the tree has
 * the focus, it goes back to where it came from (or the active tab's grid / editor), and hides the sidebar again if that
 * very keystroke had revealed it. Ignored while a modal dialog is open or while a tree name is being edited.
 *
 * Capture phase + stopPropagation: no Escape handler (grid selection, cell editor, console popups ...) also reacts, and the
 * keystroke works inside inputs. The Explorer reacts to `FOCUS_EXPLORER_EVENT` (it knows which row to select and focus).
 */
export function useSidebarFocus(hidden: boolean, setHidden: (v: boolean) => void, activeKey: string | null): void {
  const st = useRef({ hidden, setHidden, activeKey })
  st.current = { hidden, setHidden, activeKey }
  const prev = useRef<HTMLElement | null>(null) // the main-area element that had the focus before the tree took it
  const revealed = useRef(false) // the sidebar was hidden until this Shift+Esc
  const pending = useRef(false) // focus the tree as soon as the sidebar is visible

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.shiftKey && e.key === 'Escape') || e.ctrlKey || e.metaKey || e.altKey) return
      if (document.querySelector('.modal-bg, .cd-bg')) return // never steal focus from behind a dialog
      const ae = document.activeElement as HTMLElement | null
      if (ae?.closest('.tree-input')) return // an inline name editor owns the keyboard (its blur would commit the name)
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const { hidden: isHidden, setHidden: setH, activeKey: key } = st.current
      const tree = document.querySelector<HTMLElement>('.explorer')
      if (!isHidden && tree && ae === tree) {
        // tree -> back to the editor pane
        const target = usable(prev.current) ? prev.current : null
        const pane = Array.from(document.querySelectorAll<HTMLElement>('.content > .pane')).find((p) => p.dataset.pane === key)
        ;(target ?? pane?.querySelector<HTMLElement>(PANE_FOCUS))?.focus({ preventScroll: true })
        if (document.activeElement === tree) tree.blur()
        prev.current = null
        if (revealed.current) setH(true)
        revealed.current = false
        return
      }
      // anywhere else -> tree (remember where we were, unless we were already inside the sidebar)
      if (!ae?.closest('.explorer')) prev.current = ae && ae !== document.body ? ae : null
      revealed.current = isHidden
      if (isHidden) {
        pending.current = true
        setH(false)
      } else window.dispatchEvent(new Event(FOCUS_EXPLORER_EVENT))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // the sidebar was hidden (display: none, can't take focus): focus the tree once it is shown
  useEffect(() => {
    if (hidden || !pending.current) return
    pending.current = false
    window.dispatchEvent(new Event(FOCUS_EXPLORER_EVENT))
  }, [hidden])
}
