import { useCallback, useEffect, useRef, useState } from 'react'

const FALLBACK_MS = 400 // safety net if `animationend` never arrives (e.g. the window is hidden)

/**
 * Lets a modal play its exit animation before it is unmounted.
 *
 * `close(...)` replaces the dialog's `onClose`: it adds the `closing` class to the backdrop (attach `ref` to it) and calls the
 * real `onClose` once the backdrop's animation ends. When the backdrop has no animation (Settings > "Animations" off,
 * `html.no-motion`, or a test DOM without the stylesheet) it calls `onClose` immediately, so nothing is ever delayed for no reason.
 */
export function useModalClose<A extends unknown[]>(onClose: (...args: A) => void): {
  ref: React.RefObject<HTMLDivElement | null>
  closing: boolean
  close: (...args: A) => void
} {
  const ref = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const pending = useRef<A | null>(null)
  const latest = useRef(onClose)
  latest.current = onClose

  const finish = useCallback(() => {
    const args = pending.current
    if (!args) return
    pending.current = null
    latest.current(...args)
  }, [])

  const close = useCallback(
    (...args: A) => {
      if (pending.current) return // already on its way out
      pending.current = args
      const el = ref.current
      const name = el ? getComputedStyle(el).animationName : 'none'
      if (!el || !name || name === 'none') finish()
      else setClosing(true)
    },
    [finish]
  )

  useEffect(() => {
    const el = ref.current
    if (!closing || !el) return
    const onEnd = (e: AnimationEvent): void => {
      if (e.target === el) finish()
    }
    el.addEventListener('animationend', onEnd)
    const t = window.setTimeout(finish, FALLBACK_MS)
    return () => {
      el.removeEventListener('animationend', onEnd)
      window.clearTimeout(t)
    }
  }, [closing, finish])

  return { ref, closing, close }
}
