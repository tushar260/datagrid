/**
 * Fast, compact shared tooltip (replaces the slow native `title` tooltip).
 *
 * One singleton element + document-level event delegation, so there is no per-row state or re-render.
 * Convention: put `data-tip="main line"` (+ optional `data-tip2="dim second line"`) on any element.
 * Explorer tree rows (`.tree-row`) without `data-tip` show their label only when it is truncated.
 */

const SHOW_DELAY = 180 // ms of hover before the first tooltip appears
const WARM_WINDOW = 300 // ms after a tooltip was visible during which the next one shows immediately

let installed = false

export function installTooltips(): void {
  if (installed || typeof document === 'undefined') return
  installed = true

  const tip = document.createElement('div')
  tip.className = 'fast-tip'
  const l1 = document.createElement('div')
  l1.className = 'fast-tip-main'
  const l2 = document.createElement('div')
  l2.className = 'fast-tip-sub'
  tip.append(l1, l2)
  document.body.appendChild(tip)

  let current: Element | null = null
  let timer = 0
  let visible = false
  let lastHidden = 0
  let px = 0

  const contentOf = (el: Element): { a: string; b: string } | null => {
    const h = el as HTMLElement
    let a = h.dataset.tip ?? ''
    const b = h.dataset.tip2 ?? ''
    if (!a && el.classList.contains('tree-row')) {
      const lab = el.querySelector<HTMLElement>('.tlabel')
      if (lab && lab.scrollWidth > lab.clientWidth + 1) a = lab.textContent ?? ''
    }
    return a || b ? { a, b } : null
  }

  const hide = (): void => {
    window.clearTimeout(timer)
    timer = 0
    if (visible) {
      visible = false
      lastHidden = Date.now()
      tip.classList.remove('show')
    }
  }

  const place = (el: Element): void => {
    const r = el.getBoundingClientRect()
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    const m = 6
    let x = Math.min(Math.max(px + 10, r.left), window.innerWidth - w - m)
    x = Math.max(m, x)
    let y = r.bottom + 3
    if (y + h > window.innerHeight - m) y = Math.max(m, r.top - h - 3) // flip above the row
    tip.style.left = x + 'px'
    tip.style.top = y + 'px'
  }

  const show = (el: Element): void => {
    timer = 0
    if (!el.isConnected) return
    const c = contentOf(el)
    if (!c) return
    l1.textContent = c.a
    l1.style.display = c.a ? '' : 'none'
    l2.textContent = c.b
    l2.style.display = c.b ? '' : 'none'
    tip.classList.add('show')
    visible = true
    place(el)
  }

  const schedule = (el: Element): void => {
    window.clearTimeout(timer)
    timer = 0
    if (visible || Date.now() - lastHidden < WARM_WINDOW) {
      // moving between tooltip targets: swap content immediately
      if (contentOf(el)) show(el)
      else hide()
    } else if (contentOf(el)) {
      timer = window.setTimeout(() => show(el), SHOW_DELAY)
    }
  }

  const find = (t: EventTarget | null): Element | null =>
    t instanceof Element ? t.closest('[data-tip], [data-tip2], .tree-row') : null

  document.addEventListener(
    'mouseover',
    (e) => {
      px = e.clientX
      const el = find(e.target)
      if (el === current) return
      current = el
      if (!el) return hide()
      if (!contentOf(el)) return hide()
      schedule(el)
    },
    true
  )
  document.addEventListener(
    'mousemove',
    (e) => {
      px = e.clientX
    },
    true
  )
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) {
      current = null
      hide()
    }
  })
  const reset = (): void => {
    current = null
    hide()
  }
  for (const ev of ['mousedown', 'click', 'wheel', 'keydown', 'contextmenu', 'dragstart', 'scroll'])
    document.addEventListener(ev, reset, true)
  window.addEventListener('blur', reset)
}
