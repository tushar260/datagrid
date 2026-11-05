import type React from 'react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** True when the OS asks for less motion (all tab animations are skipped then). */
export const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const CLOSE_MS = 160 // a bit longer than the 150ms CSS `tab-out` animation: fallback when animationend never fires
const OPEN_CLEAR_MS = 260 // fallback to clear the `tab-new` class if animationend never fires
const FLIP_MS = 200
const FLIP_EASE = 'cubic-bezier(.2,.8,.2,1)'

interface Opts {
  /** current tab keys in display order */
  keys: string[]
  /** false until the saved session was restored: tabs present at that moment never animate */
  ready: boolean
  /** key of the tab being dragged (it is never FLIP-animated: the user already placed it) */
  dragKey: string | null
  stripRef: React.RefObject<HTMLElement | null>
  /** really remove the tab (called after its close animation finished) */
  onRemove: (key: string) => void
}

/**
 * Tab strip animations:
 *  - reorder: FLIP (positions are remembered after every layout; when only the ORDER changes, each moved tab starts at
 *    its old offset and transitions to 0),
 *  - open: `addedKeys` get the `tab-new` class (only for tabs added after the session was restored),
 *  - close: `requestClose` marks the tab `closing`; it is removed via `onRemove` when its animation ended.
 */
export function useTabAnimations({ keys, ready, dragKey, stripRef, onRemove }: Opts): {
  addedKeys: ReadonlySet<string>
  closingKeys: ReadonlySet<string>
  requestClose: (key: string) => void
  isClosing: (key: string) => boolean
  onAnimationEnd: (e: React.AnimationEvent<HTMLElement>, key: string) => void
} {
  const [addedKeys, setAdded] = useState<ReadonlySet<string>>(new Set())
  const [closingKeys, setClosing] = useState<ReadonlySet<string>>(new Set())
  const closingRef = useRef(new Set<string>())
  const removeRef = useRef(onRemove)
  removeRef.current = onRemove
  const prevKeys = useRef<string[] | null>(null)
  const prevDrag = useRef<string | null>(null)
  const lefts = useRef(new Map<string, number>())
  const known = useRef<Set<string> | null>(null)

  const tabEls = (): Map<string, HTMLElement> => {
    const m = new Map<string, HTMLElement>()
    stripRef.current?.querySelectorAll<HTMLElement>('[data-tabkey]').forEach((n) => m.set(n.dataset.tabkey ?? '', n))
    return m
  }

  // runs after every render (cheap: a handful of tabs); must stay before paint so nothing flashes
  useLayoutEffect(() => {
    const els = tabEls()
    const prev = prevKeys.current
    const skipDrag = dragKey ?? prevDrag.current
    const reduced = reducedMotion()

    // ---- reorder (FLIP): same set of tabs, different order ----
    if (prev && !reduced && prev.length === keys.length && prev.join('\n') !== keys.join('\n') && prev.every((k) => keys.includes(k))) {
      const moved: HTMLElement[] = []
      for (const k of keys) {
        const el = els.get(k)
        const was = lefts.current.get(k)
        if (!el || was === undefined || k === skipDrag || closingRef.current.has(k)) continue
        const delta = was - el.offsetLeft
        if (!delta) continue
        el.style.transition = 'none'
        el.style.transform = `translateX(${delta}px)`
        moved.push(el)
      }
      if (moved.length) {
        void (stripRef.current as HTMLElement).offsetWidth // force reflow so the start transform is committed
        for (const el of moved) {
          el.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASE}`
          el.style.transform = ''
          const done = (): void => {
            el.style.transition = ''
            el.removeEventListener('transitionend', done)
          }
          el.addEventListener('transitionend', done)
          setTimeout(done, FLIP_MS + 60)
        }
      }
    }

    // ---- open: tabs added by the user after the session restore ----
    if (ready) {
      if (known.current === null) known.current = new Set(keys) // restore / first render: nothing animates
      else {
        const added = keys.filter((k) => !known.current!.has(k))
        known.current = new Set(keys)
        if (added.length && !reduced) {
          for (const k of added) els.get(k)?.style.setProperty('--tab-w', els.get(k)!.offsetWidth + 'px') // natural width = animation target
          setAdded((s) => new Set([...s, ...added]))
          setTimeout(() => setAdded((s) => (added.some((k) => s.has(k)) ? new Set([...s].filter((k) => !added.includes(k))) : s)), OPEN_CLEAR_MS)
        }
      }
    }

    // ---- forget closing marks of tabs that vanished some other way (bulk close, object dropped, ...) ----
    let changed = false
    for (const k of [...closingRef.current]) {
      if (!keys.includes(k)) {
        closingRef.current.delete(k)
        changed = true
      }
    }
    if (changed) setClosing(new Set(closingRef.current))

    prevKeys.current = keys
    prevDrag.current = dragKey
    lefts.current = new Map(keys.map((k) => [k, els.get(k)?.offsetLeft ?? 0])) // offsetLeft ignores transforms and scrolling
  })

  const finalize = useCallback((key: string): void => {
    if (!closingRef.current.delete(key)) return // already removed (animationend and the timeout can both fire)
    setClosing(new Set(closingRef.current))
    removeRef.current(key)
  }, [])

  const requestClose = useCallback(
    (key: string): void => {
      if (closingRef.current.has(key)) return // repeated clicks / Cmd+W while it is already going away
      if (reducedMotion()) {
        removeRef.current(key)
        return
      }
      const el = tabEls().get(key)
      if (!el) {
        removeRef.current(key)
        return
      }
      el.style.setProperty('--tab-w', el.offsetWidth + 'px')
      closingRef.current.add(key)
      setClosing(new Set(closingRef.current))
      setTimeout(() => finalize(key), CLOSE_MS)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finalize]
  )

  const onAnimationEnd = useCallback(
    (e: React.AnimationEvent<HTMLElement>, key: string): void => {
      if (e.target !== e.currentTarget) return
      if (e.animationName === 'tab-out') finalize(key)
      else if (e.animationName === 'tab-in') {
        setAdded((s) => (s.has(key) ? new Set([...s].filter((k) => k !== key)) : s))
        // the tab only reached its full width now: make sure it is completely visible (it is the active tab when opened)
        if (e.currentTarget.classList.contains('on')) e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    },
    [finalize]
  )

  const isClosing = useCallback((key: string): boolean => closingRef.current.has(key), [])
  return { addedKeys, closingKeys, requestClose, isClosing, onAnimationEnd }
}
