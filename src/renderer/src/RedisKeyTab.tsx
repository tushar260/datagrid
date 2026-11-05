import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { RedisKeyDetail as Detail } from '../../shared'
import type { TableRef } from './Explorer'
import RedisKeyDetail from './RedisKeyDetail'
import { explorerOwnsRefresh } from './lib/focusZone'

/**
 * A tab holding ONE Redis key (opened from the explorer's key tree): the key detail pane at full width. The pane does the
 * work (type badge, TTL, size, rename, delete, copy, per-type editors); this wrapper adds what a tab needs: lazy loading of
 * restored tabs, Cmd/Ctrl+R to reload, and reporting rename / delete / type to the app (tab title, icon, tree refresh).
 */
export default function RedisKeyTab({
  t, active = true, reloadToken = 0, onType, onRenamed, onDeleted
}: {
  t: TableRef
  active?: boolean
  reloadToken?: number
  /** the key's type, once loaded (tab icon) */
  onType?: (type: string) => void
  onRenamed: (to: string) => void
  onDeleted: () => void
}): React.JSX.Element {
  const db = t.db ?? 0
  const key = t.redisKey ?? t.table
  const [started, setStarted] = useState(active) // restored tabs load lazily: nothing is fetched until first shown
  useEffect(() => { if (active) setStarted(true) }, [active])
  const [token, setToken] = useState(0)
  const first = useRef(reloadToken)
  useEffect(() => {
    if (reloadToken !== first.current) setToken((n) => n + 1)
  }, [reloadToken])

  // Cmd/Ctrl+R reloads the key (not while the explorer owns the shortcut)
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'r' && e.code !== 'KeyR') return
      if (document.querySelector('.modal-bg, .cd-bg')) return
      if (explorerOwnsRefresh(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      setToken((n) => n + 1)
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  })

  const onTypeRef = useRef(onType)
  onTypeRef.current = onType
  const onDetail = (d: Detail): void => {
    if (d.ttl !== -2) onTypeRef.current?.(d.type)
  }

  return (
    <div className="rk-tab" data-testid="redis-key-tab">
      {started ? (
        <RedisKeyDetail
          dsId={t.dsId}
          db={db}
          keyName={key}
          reloadToken={token}
          onDetail={onDetail}
          onRenamed={onRenamed}
          onDeleted={onDeleted}
        />
      ) : (
        <div className="tree-empty rk-pad">Loading…</div>
      )}
    </div>
  )
}
