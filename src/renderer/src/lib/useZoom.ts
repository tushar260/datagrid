import { useEffect, useRef, useState } from 'react'

/** The current display size (browser-style zoom) in percent, kept in sync with menu / keyboard / wheel zoom, plus a stepper. */
export function useZoom(): { percent: number; step: (dir: 'in' | 'out' | 'reset') => void } {
  const [percent, setPercent] = useState(100)
  const gotEvent = useRef(false)

  useEffect(() => {
    const off = window.api.onZoom((p) => {
      gotEvent.current = true
      setPercent(p)
    })
    // zoom.json is applied before the renderer subscribes, so read the initial value (unless an event already arrived)
    void Promise.resolve(window.api.zoomGet())
      .then((p) => {
        if (!gotEvent.current && typeof p === 'number') setPercent(p)
      })
      .catch(() => {})
    return off
  }, [])

  const step = (dir: 'in' | 'out' | 'reset'): void => void Promise.resolve(window.api.zoomStep(dir)).catch(() => {})
  return { percent, step }
}
