import { useEffect, useRef, useState } from 'react'

/** True while `on` is true and for `ms` after it turned false (lets an element fade out before it is unmounted). */
export function useLinger(on: boolean, ms: number): boolean {
  const [lingering, setLingering] = useState(false)
  const wasOn = useRef(false)
  useEffect(() => {
    if (on) {
      wasOn.current = true
      setLingering(false)
      return
    }
    if (!wasOn.current) return // never shown: nothing to fade out
    wasOn.current = false
    setLingering(true)
    const t = setTimeout(() => setLingering(false), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on || lingering
}
