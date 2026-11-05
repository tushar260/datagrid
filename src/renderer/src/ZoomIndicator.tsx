import type React from 'react'
import { useEffect, useRef, useState } from 'react'

export const ZOOM_BADGE_MS = 1200

/** Chrome-like transient "110%" bubble shown after a zoom change (Cmd/Ctrl +, -, 0). */
export default function ZoomIndicator(): React.JSX.Element | null {
  const [percent, setPercent] = useState<number | null>(null)
  const [shown, setShown] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const off = window.api.onZoom((p) => {
      setPercent(p)
      setShown(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setShown(false), ZOOM_BADGE_MS)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  if (percent === null) return null
  return (
    <div
      className={'zoom-badge' + (shown ? ' show' : '')}
      role="status"
      aria-hidden={!shown}
      // the whole page is zoomed, so counter-scale to keep the badge the same visual size
      style={{ transform: `translateX(-50%) scale(${100 / percent})` }}
    >
      {percent}%
    </div>
  )
}
