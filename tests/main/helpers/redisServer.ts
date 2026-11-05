import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * A throwaway `redis-server` for the integration tests: random free high port, bound to 127.0.0.1, nothing persisted,
 * its own temp dir. It never touches (or even looks at) a Redis on the default port 6379.
 */
export const REDIS_SERVER_BIN = process.env.REDIS_SERVER_BIN || '/opt/homebrew/bin/redis-server'

export interface TestServer {
  port: number
  stop: () => Promise<void>
}

/** A free TCP port above 20000 (asks the OS, never 6379). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => (port > 20000 && port !== 6379 ? resolve(port) : freePort().then(resolve, reject)))
    })
  })
}

export async function startRedis(extra: string[] = []): Promise<TestServer> {
  const port = await freePort()
  if (port === 6379) throw new Error('refusing to use port 6379')
  const dir = mkdtempSync(join(tmpdir(), 'grid-redis-it-'))
  const child: ChildProcess = spawn(
    REDIS_SERVER_BIN,
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', dir, '--daemonize', 'no', ...extra],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let log = ''
  child.stdout?.on('data', (d) => (log += d))
  child.stderr?.on('data', (d) => (log += d))
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis-server did not start:\n' + log)), 10_000)
    child.once('exit', (code) => {
      clearTimeout(t)
      reject(new Error(`redis-server exited early (${code}):\n${log}`))
    })
    const tick = (): void => {
      if (log.includes('Ready to accept connections')) {
        clearTimeout(t)
        child.removeAllListeners('exit')
        resolve()
      } else setTimeout(tick, 25)
    }
    tick()
  })
  return {
    port,
    stop: async () => {
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 3000).unref()
        })
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
