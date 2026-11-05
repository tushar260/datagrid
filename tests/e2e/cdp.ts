/**
 * Tiny Chrome DevTools Protocol client for the E2E smoke test (uses Node's built-in WebSocket + fetch, Node >= 22).
 * It talks to the Electron renderer of an app that was started with --remote-debugging-port.
 */
import { createServer } from 'net'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** First free TCP port at or above `from` on 127.0.0.1. */
export function freePort(from = 9355): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number): void => {
      const s = createServer()
      s.once('error', () => (p < from + 200 ? tryPort(p + 1) : reject(new Error('no free port'))))
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)))
    }
    tryPort(from)
  })
}

type Handler = (params: Record<string, unknown>) => void

export class Cdp {
  private ws!: WebSocket
  private id = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private handlers = new Map<string, Handler[]>()

  /** Wait for the first `page` target on the debugging port and attach to it. */
  static async connect(port: number, timeoutMs = 30_000): Promise<Cdp> {
    const t0 = Date.now()
    let lastErr = ''
    while (Date.now() - t0 < timeoutMs) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl?: string }[]
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) {
          const c = new Cdp()
          await c.open(page.webSocketDebuggerUrl!)
          return c
        }
      } catch (e) {
        lastErr = (e as Error).message
      }
      await sleep(250)
    }
    throw new Error(`could not attach to the app on port ${port}: ${lastErr}`)
  }

  private open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url)
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('websocket error'))
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> }
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (p) msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
        } else if (msg.method) {
          for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {})
        }
      }
    })
  }

  on(method: string, h: Handler): void {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), h])
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate a JS expression in the page (awaits promises) and return its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  /** Poll `expression` until it is truthy; resolves with its value. */
  async waitFor<T = unknown>(expression: string, what: string, timeoutMs = 15_000): Promise<T> {
    const t0 = Date.now()
    let last: unknown
    while (Date.now() - t0 < timeoutMs) {
      try {
        last = await this.eval(expression)
        if (last) return last as T
      } catch (e) {
        last = (e as Error).message
      }
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${what} (last value: ${JSON.stringify(last)})`)
  }

  /** A real key press through the browser input pipeline. modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8 */
  async press(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}
