import type React from 'react'

export type IconName =
  | 'postgres'
  | 'dynamodb'
  | 'redis'
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'folder'
  | 'folderOpen'
  | 'server'
  | 'role'
  | 'tablespace'
  | 'warning'
  | 'console'
  | 'key-string'
  | 'key-hash'
  | 'key-list'
  | 'key-set'
  | 'key-zset'
  | 'key-stream'
  | 'key-other'

const S = 16

/** A Redis key leaf: a small tile in the type's colour (same palette as the `.rt` chips) with a glyph for the type. */
const KEY_GLYPHS: Record<string, { color: string; glyph: string }> = {
  'key-string': { color: '#7fd48a', glyph: 'a' },
  'key-hash': { color: '#7fb0ff', glyph: '#' },
  'key-list': { color: '#e5c07b', glyph: '≡' },
  'key-set': { color: '#c68ce8', glyph: '∪' },
  'key-zset': { color: '#f28c78', glyph: '⇅' },
  'key-stream': { color: '#56c8c8', glyph: '≈' },
  'key-other': { color: '#9aa0aa', glyph: '?' }
}

/** Small hand-drawn SVG icons (IDE-style colours, not copied assets). */
export function Icon({ name, size = S }: { name: IconName; size?: number }): React.JSX.Element {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true as const }
  switch (name) {
    case 'postgres': // blue elephant
      return (
        <svg {...common}>
          <path
            d="M8.2 1.6c-2.9 0-5 1.8-5 4.3 0 1.2.4 2.1.9 2.9.3.5.4 1 .4 1.7 0 .9-.5 1.8-.5 2.6 0 .9.7 1.4 1.5 1.4.9 0 1.2-.7 1.3-1.5l.1-1.1c.4.1.9.1 1.3 0l.1 1.1c.1.8.4 1.5 1.3 1.5.8 0 1.5-.5 1.5-1.4 0-.7-.2-1.3-.2-2 0-.8.7-1.5 1.2-2.4.4-.8.7-1.7.6-2.7-.2-2.3-2.2-4.4-5.5-4.4z"
            fill="#4f7fb5"
            stroke="#2f5b8a"
            strokeWidth=".8"
            strokeLinejoin="round"
          />
          <path d="M12.8 6.2c1 .1 1.9.8 1.9 1.9 0 1-.5 1.8-1.4 2.1" stroke="#2f5b8a" strokeWidth=".9" strokeLinecap="round" />
          <circle cx="6.2" cy="5.4" r=".9" fill="#fff" />
          <circle cx="6.4" cy="5.4" r=".4" fill="#1b2a3c" />
        </svg>
      )
    case 'dynamodb': // stacked blue/cyan cylinder with a bolt
      return (
        <svg {...common}>
          <ellipse cx="8" cy="3.4" rx="5.2" ry="1.9" fill="#5fb3e8" />
          <path d="M2.8 3.4v2.9c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9V3.4c0 1-2.3 1.9-5.2 1.9S2.8 4.4 2.8 3.4z" fill="#3a8fd0" />
          <path d="M2.8 6.3v3c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9v-3c0 1-2.3 1.9-5.2 1.9S2.8 7.3 2.8 6.3z" fill="#2f78b8" />
          <path d="M2.8 9.3v3.2c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9V9.3c0 1-2.3 1.9-5.2 1.9S2.8 10.3 2.8 9.3z" fill="#27649a" />
          <path d="M8.9 5.1 6.1 9h1.9l-.7 3.2 3-4.1H8.4l.5-3z" fill="#ffe27a" stroke="#b8861f" strokeWidth=".4" strokeLinejoin="round" />
        </svg>
      )
    case 'redis': // red stack of three diamonds-ish layers (not the trademarked logo)
      return (
        <svg {...common}>
          <path d="M1.8 10.2 8 12.9l6.2-2.7v2.2L8 15.1l-6.2-2.7z" fill="#a62d2a" />
          <path d="M1.8 7.6 8 10.3l6.2-2.7v2.2L8 12.5l-6.2-2.7z" fill="#c9423e" />
          <path d="M8 2 14.2 4.6 8 7.3 1.8 4.6z" fill="#ef6a64" />
          <path d="M1.8 4.6 8 7.3l6.2-2.7v2.2L8 9.5 1.8 6.8z" fill="#dc4b46" />
          <circle cx="8" cy="4.7" r="1.1" fill="#fff" fillOpacity=".85" />
        </svg>
      )
    case 'database': // red cylinder
      return (
        <svg {...common}>
          <ellipse cx="8" cy="3.6" rx="5.2" ry="2" fill="#e8736f" />
          <path d="M2.8 3.6v3.2c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V3.6c0 1.1-2.3 2-5.2 2s-5.2-.9-5.2-2z" fill="#d85d5a" />
          <path d="M2.8 6.8V10c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V6.8c0 1.1-2.3 2-5.2 2s-5.2-.9-5.2-2z" fill="#d85d5a" />
          <path d="M2.8 10v2.4c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V10c0 1.1-2.3 2-5.2 2s-5.2-.9-5.2-2z" fill="#c24f4d" />
        </svg>
      )
    case 'schema': // layered, blue-grey
      return (
        <svg {...common}>
          <rect x="2" y="2.5" width="12" height="3" rx="1" fill="#7f9bd1" />
          <rect x="2" y="6.5" width="12" height="3" rx="1" fill="#6785bd" />
          <rect x="2" y="10.5" width="12" height="3" rx="1" fill="#516ea6" />
        </svg>
      )
    case 'table':
      return (
        <svg {...common}>
          <rect x="2" y="2.5" width="12" height="11" rx="1.2" fill="#2f3a4d" stroke="#7aa2f7" strokeWidth="1" />
          <rect x="2" y="2.5" width="12" height="3" rx="1.2" fill="#7aa2f7" />
          <path d="M2 9.2h12M6.2 5.5v8M10.2 5.5v8" stroke="#7aa2f7" strokeWidth=".9" />
        </svg>
      )
    case 'view':
      return (
        <svg {...common}>
          <path d="M1.5 8S4 3.6 8 3.6 14.5 8 14.5 8 12 12.4 8 12.4 1.5 8 1.5 8z" stroke="#7aa2f7" strokeWidth="1.2" strokeLinejoin="round" />
          <circle cx="8" cy="8" r="2.1" fill="#7aa2f7" />
        </svg>
      )
    case 'folder':
    case 'folderOpen':
      return (
        <svg {...common}>
          <path
            d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.3 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2z"
            fill={name === 'folderOpen' ? '#d7a64a' : '#c9973c'}
          />
          <path d="M1.8 6.2h12.4v5.9c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V6.2z" fill="#e5b75c" />
        </svg>
      )
    case 'server': // orange folder with server lines ("Server Objects")
      return (
        <svg {...common}>
          <path
            d="M1.6 3.8c0-.7.5-1.2 1.2-1.2h3.1l1.3 1.5h6c.7 0 1.2.5 1.2 1.2v6.9c0 .7-.5 1.2-1.2 1.2H2.8c-.7 0-1.2-.5-1.2-1.2V3.8z"
            fill="#f0922b"
          />
          <rect x="4.4" y="6.2" width="7.2" height="1.7" rx=".4" fill="#fff4e0" />
          <rect x="4.4" y="8.9" width="7.2" height="1.7" rx=".4" fill="#fff4e0" />
          <circle cx="5.5" cy="7.05" r=".4" fill="#f0922b" />
          <circle cx="5.5" cy="9.75" r=".4" fill="#f0922b" />
        </svg>
      )
    case 'role':
      return (
        <svg {...common}>
          <circle cx="8" cy="5.2" r="2.6" fill="#9aa5b8" />
          <path d="M2.8 13.4c.3-2.6 2.5-4 5.2-4s4.9 1.4 5.2 4H2.8z" fill="#7b869a" />
        </svg>
      )
    case 'tablespace':
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" rx="1.6" fill="#6f7a8c" />
          <rect x="3.6" y="9.4" width="8.8" height="1.6" rx=".6" fill="#aab3c3" />
          <circle cx="11.2" cy="10.2" r=".5" fill="#6f7a8c" />
        </svg>
      )
    case 'warning':
      return (
        <svg {...common}>
          <path d="M8 2 14.6 13.4H1.4L8 2z" fill="#e5b73c" stroke="#b8861f" strokeWidth=".8" strokeLinejoin="round" />
          <path d="M8 6.2v3.4" stroke="#3a2a00" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="11.3" r=".8" fill="#3a2a00" />
        </svg>
      )
    case 'key-string':
    case 'key-hash':
    case 'key-list':
    case 'key-set':
    case 'key-zset':
    case 'key-stream':
    case 'key-other': {
      const g = KEY_GLYPHS[name]
      return (
        <svg {...common}>
          <rect x="1.8" y="2.4" width="12.4" height="11.2" rx="2.2" fill={g.color} fillOpacity=".18" stroke={g.color} strokeWidth="1" />
          <text x="8" y="11.6" textAnchor="middle" fontSize="9.5" fontWeight="700" fontFamily="ui-monospace, Menlo, monospace" fill={g.color}>{g.glyph}</text>
        </svg>
      )
    }
    case 'console':
      return (
        <svg {...common}>
          <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" fill="#2f3a4d" stroke="#7aa2f7" strokeWidth="1" />
          <path d="m4.6 6 2.4 2-2.4 2" stroke="#7aa2f7" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.6 10.4h3" stroke="#7aa2f7" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
  }
}

/** Tree disclosure chevron: a 12px filled triangle pointing right, rotated 90deg (via CSS) when `open`. */
export function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg className={'chevron' + (open ? ' open' : '')} width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M3.6 1.8 9.2 6 3.6 10.2z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

/** Cog (app settings); strokes use currentColor. */
export function GearIcon({ size = 16 }: { size?: number }): React.JSX.Element {
  const teeth = [0, 45, 90, 135, 180, 225, 270, 315]
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="2.3" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      {teeth.map((a) => (
        <path key={a} d="M8 1.2v1.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" transform={`rotate(${a} 8 8)`} />
      ))}
    </svg>
  )
}
