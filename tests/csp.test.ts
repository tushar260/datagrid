import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..', 'src', 'renderer')
const html = readFileSync(join(root, 'index.html'), 'utf8')
const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8')
const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''
const directive = (name: string): string[] | undefined =>
  csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name)?.slice(1)

describe('renderer Content-Security-Policy', () => {
  it('exists and is restrictive by default', () => {
    expect(directive('default-src')).toEqual(["'self'"])
    expect(csp).not.toMatch(/unsafe-eval/)
    expect(directive('script-src') ?? directive('default-src')).not.toContain("'unsafe-inline'")
  })

  // REGRESSION: the <select> chevron is a data: SVG background in styles.css; without img-src data: Chromium blocks it
  // ("Loading the image 'data:image/svg+xml…' violates the following Content Security Policy directive")
  it('allows every kind of url() the stylesheet uses', () => {
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1])
    const needsData = urls.some((u) => u.startsWith('data:'))
    const img = directive('img-src') ?? directive('default-src') ?? []
    if (needsData) expect(img).toContain('data:')
    expect(urls.filter((u) => /^https?:/i.test(u))).toEqual([]) // nothing remote: the app must work offline
  })
})
