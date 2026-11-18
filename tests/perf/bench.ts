/**
 * Resource benchmark (RAM + CPU) of the real Electron app against a large throw-away Postgres.
 * Run: node --experimental-strip-types tests/perf/bench.ts   (see PERF_* env below)
 * It never touches real app data: a temp --user-data-dir and a seeded data source for the benchmark database only.
 *
 *   PERF_PG_PORT (5432)  PERF_DB (perf)  PERF_MAIN (path to built out/main/index.js)  PERF_ELECTRON (electron binary)
 * Expects tables perf_wide (150 cols x 200k rows) and perf_tall (12 cols x 2M rows) (see tests/perf/seed.sh).
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { Cdp, freePort, sleep } from '../e2e/cdp.ts'

const PORT = Number(process.env.PERF_PG_PORT ?? 5432)
const DB = process.env.PERF_DB ?? 'perf'
const ROOT = process.cwd()
const MAIN = process.env.PERF_MAIN ?? join(ROOT, 'out/main/index.js')
const ELECTRON = process.env.PERF_ELECTRON ?? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

// ---- process sampling (RSS + cumulative CPU time of the whole app process tree) ----
const cpuSecs = (t: string): number => {
  const [m, s] = t.split(':')
  return Number(m) * 60 + Number(s)
}
interface Snap { t: number; cpu: number; rssMB: number; procs: number }
function snap(rootPid: number): Snap {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=']).toString().trim().split('\n')
  const rows = out.map((l) => l.trim().split(/\s+/)).map(([pid, ppid, rss, time]) => ({ pid: +pid, ppid: +ppid, rss: +rss, cpu: cpuSecs(time) }))
  const kids = new Set<number>([rootPid])
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) if (!kids.has(r.pid) && kids.has(r.ppid)) { kids.add(r.pid); grew = true }
  }
  const mine = rows.filter((r) => kids.has(r.pid))
  return { t: Date.now(), cpu: mine.reduce((a, r) => a + r.cpu, 0), rssMB: mine.reduce((a, r) => a + r.rss, 0) / 1024, procs: mine.length }
}

interface Row { phase: string; ms: number; cpuPct: number; rssMB: number; peakRssMB: number; heapMB: number; note: string }
const results: Row[] = []

let proc: ChildProcess
let cdp: Cdp
const js = (s: string): string => JSON.stringify(s)

async function heapMB(gc = false): Promise<number> {
  if (gc) await cdp.send('HeapProfiler.collectGarbage')
  const h = await Promise.race([cdp.send<{ usedSize: number }>('Runtime.getHeapUsage'), sleep(15_000).then(() => null)])
  return h ? h.usedSize / 1048576 : -1 // -1 = page did not answer within 15s (frozen)
}

/** Run `fn`, sampling RSS every 100ms; record wall time, avg CPU% (100% = one core) and memory. */
async function phase(name: string, fn: () => Promise<string | void>): Promise<void> {
  const s0 = snap(proc.pid!)
  let peak = s0.rssMB
  const timer = setInterval(() => { try { peak = Math.max(peak, snap(proc.pid!).rssMB) } catch { /* ignore */ } }, 100)
  const t0 = Date.now()
  let note = ''
  let hung = false
  // watchdog: the page must answer a trivial evaluate within 20s while a phase runs, otherwise the UI thread is frozen
  const dog = (async (): Promise<void> => {
    for (;;) {
      await sleep(5000)
      const ok = await Promise.race([cdp.eval('1').then(() => true), sleep(20_000).then(() => false)]).catch(() => true)
      if (!ok) { hung = true; throw new Error('UI THREAD FROZEN (no response for 20s)') }
    }
  })()
  try { note = (await Promise.race([fn(), dog]) as string | void) ?? '' } catch (e) { note = 'ERROR ' + (e as Error).message }
  dog.catch(() => {})
  const ms = Date.now() - t0
  clearInterval(timer)
  const s1 = snap(proc.pid!)
  peak = Math.max(peak, s1.rssMB)
  results.push({
    phase: name, ms, cpuPct: Math.round(((s1.cpu - s0.cpu) / Math.max(0.001, (s1.t - s0.t) / 1000)) * 100),
    rssMB: Math.round(s1.rssMB), peakRssMB: Math.round(peak), heapMB: Math.round(await heapMB()), note
  })
  const r = results.at(-1)!
  if (hung) { console.log(`${name.padEnd(46)} FROZEN after ${ms}ms, rss ${r0(results.at(-1))}`); throw new Error('aborting: UI frozen in phase ' + name) }
  console.log(`${name.padEnd(46)} ${String(r.ms).padStart(6)}ms  cpu ${String(r.cpuPct).padStart(4)}%  rss ${String(r.rssMB).padStart(5)}MB (peak ${r.peakRssMB})  heap ${r.heapMB}MB  ${note}`)
}

const r0 = (r?: Row): string => (r ? `${r.rssMB}MB cpu ${r.cpuPct}%` : '')
const rowOf = (suffix: string): string =>
  `Array.from(document.querySelectorAll('.explorer .tree-row[data-id]')).find(r => r.dataset.id.endsWith(${js(suffix)}))`
const gridRows = (): Promise<number> => cdp.eval(`document.querySelectorAll('.gridwrap tbody tr').length`)

async function openTable(name: string, rows: number): Promise<void> {
  await cdp.eval(`${rowOf('/public/' + name)}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await cdp.waitFor(`document.querySelectorAll('.gridwrap tbody tr').length > 0`, 'rows', 120_000)
  if (rows > 100) await setRange(rows)
}
async function setRange(n: number): Promise<void> {
  await cdp.waitFor(`!!document.querySelector('.range-label')`, 'range label')
  await cdp.eval(`document.querySelector('.range-label').click()`)
  await cdp.waitFor(`!!document.querySelector('.range-input')`, 'range input')
  await cdp.eval(`(() => { const i = document.querySelector('.range-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i, '1-${n}'); i.dispatchEvent(new Event('input', {bubbles:true})) })()`)
  await cdp.press('Enter', 'Enter', 13)
  await cdp.waitFor(`document.querySelectorAll('.gridwrap tbody tr').length === ${n}`, `${n} rows`, 180_000)
}
const focusGrid = (): Promise<unknown> => cdp.eval(`(() => { const g = document.querySelector('.gridwrap'); g.focus(); g.dispatchEvent(new FocusEvent('focus')); return true })()`)
const cellAt = (r: number, c: number): string => `document.querySelectorAll('.gridwrap tbody tr')[${r}].querySelectorAll('td')[${c + 1}]`
const mouse = (el: string, type: string, init = ''): Promise<unknown> =>
  cdp.eval(`${el}.dispatchEvent(new MouseEvent(${js(type)}, { bubbles: true, button: 0, buttons: 1, ${init} }))`)

async function main(): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), 'dgl-perf-'))
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'datasources.json'), JSON.stringify([{
    id: 'perf', name: 'perf', host: 'localhost', port: PORT, user: process.env.PERF_PG_USER ?? userInfo().username, password: 'raw:', database: DB, ssl: false
  }]))
  const app = join(tmpdir(), 'dgl-perf-app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'datagrid', main: MAIN }))
  const dbg = await freePort(9455)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  proc = spawn(ELECTRON, [app, `--user-data-dir=${userData}`, `--remote-debugging-port=${dbg}`], { stdio: 'ignore', env })
  try {
    cdp = await Cdp.connect(dbg, 40_000)
    await cdp.send('Runtime.enable')
    await cdp.send('HeapProfiler.enable')
    await cdp.send('Page.reload')
    await cdp.waitFor(`!!document.querySelector('.app .explorer')`, 'app window', 30_000)
    await sleep(2000)
    await phase('idle (empty app, 5s)', async () => { await sleep(5000) })

    await phase('expand tree to perf tables', async () => {
      await cdp.eval(`${rowOf('')}.querySelector('.arrow').click()`)
      await cdp.waitFor(`!!(${rowOf('/' + DB)})`, 'db row')
      await cdp.waitFor(`!!(${rowOf('/' + DB)}).querySelector('.arrow')`, 'db arrow')
      await cdp.eval(`${rowOf('/' + DB)}.querySelector('.arrow').click()`)
      await cdp.waitFor(`!!(${rowOf('/public')})`, 'schema')
      await cdp.waitFor(`!!(${rowOf('/public')}).querySelector('.arrow')`, 'schema arrow')
      await cdp.eval(`${rowOf('/public')}.querySelector('.arrow').click()`)
      await cdp.waitFor(`!!(${rowOf('/public/perf_wide')}) && !!(${rowOf('/public/perf_tall')})`, 'tables', 30_000)
    })

    // ---------- tall table: 12 columns x 2M rows ----------
    await phase('open perf_tall (default page)', async () => { await openTable('perf_tall', 0); return `${await gridRows()} rows` })
    for (const n of [1000, 5000, 10000]) {
      await phase(`perf_tall: load ${n} rows x 12 cols`, async () => { await setRange(n); return `${await gridRows()} rows` })
    }
    if (process.env.PERF_PROFILE) {
      const prof = async (label: string, keys: [string, string, number, number][]): Promise<void> => {
        await clickCell()
        await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start')
        const t0 = Date.now()
        for (const k of keys) await Promise.race([cdp.press(...k), sleep(60_000)])
        const ms = Date.now() - t0
        const p = (await cdp.send<{ profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } }>('Profiler.stop')).profile
        const self = new Map<number, number>()
        p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)))
        const top = [...self].sort((a, c) => c[1] - a[1]).slice(0, 8).map(([id, us]) => {
          const n = p.nodes.find((x) => x.id === id)!.callFrame
          return `${Math.round(us / 1000)}ms ${n.functionName || '(anon)'} ${n.url.split('/').pop()}:${n.lineNumber}`
        })
        console.log(`PROFILE ${label}: ${ms}ms total\n  ` + top.join('\n  '))
      }
      await prof('1x ArrowDown (1 row selected)', [['ArrowDown', 'ArrowDown', 40, 0]])
      await prof('1x Shift+ArrowDown', [['ArrowDown', 'ArrowDown', 40, 8]])
      await focusGrid(); await cdp.press('a', 'KeyA', 65, 4); await sleep(1500)
      await prof('1x ArrowDown after Cmd+A', [['ArrowDown', 'ArrowDown', 40, 0]])
      return
    }
    await phase('perf_tall 10000: scroll top→bottom (4s)', scrollRun)
    await phase('perf_tall 10000: plain ArrowDown x5 (baseline)', plainDown)
    await phase('perf_tall 10000: Shift+Down x5', shiftDown)
    await phase('perf_tall 10000: drag-select 30 rows x 12 cols', dragSelect)
    await phase('perf_tall 10000: Cmd+A (select all)', selectAll)
    await phase('perf_tall 10000: Cmd+C (120k cells → JSON)', copyRun)
    await phase('perf_tall 10000: ArrowDown after Cmd+A (1 key)', async () => { await focusGrid(); return timedKeys('ArrowDown', 'ArrowDown', 40, 0, 1) })

    // ---------- wide table: 150 columns x 200k rows ----------
    await phase('close perf_tall tab (memory released?)', async () => { await cdp.press('w', 'KeyW', 87, 4); await sleep(3000); return `post-GC heap ${Math.round(await heapMB(true))}MB` })
    await phase('open perf_wide (default page, 150 cols)', async () => { await openTable('perf_wide', 0); return `${await gridRows()} rows` })
    for (const n of [500, 1000, 2000]) {
      await phase(`perf_wide: load ${n} rows x 150 cols`, async () => { await setRange(n); return `${await gridRows()} rows` })
    }
    await phase('perf_wide 2000: scroll top→bottom (4s)', scrollRun)
    await phase('perf_wide 2000: scroll left→right (3s)', scrollH)
    await phase('perf_wide 2000: plain ArrowDown x5 (baseline)', plainDown)
    await phase('perf_wide 2000: Shift+Down x5', shiftDown)
    await phase('perf_wide 2000: Shift+Right x5', shiftRight)
    await phase('perf_wide 2000: drag-select 30 rows x 40 cols', dragSelect)
    await phase('perf_wide 2000: Cmd+A (300k cells)', selectAll)
    await phase('perf_wide 2000: Cmd+C (300k cells → JSON)', copyRun)

    // ---------- churn / leak check ----------
    await phase('perf_wide: reload x8 (2000 rows each)', async () => {
      for (let i = 0; i < 8; i++) {
        await cdp.eval(`document.querySelector('[title^="Reload"]').click()`)
        await sleep(300)
        await cdp.waitFor(`document.querySelectorAll('.gridwrap tbody tr').length === 2000 && !document.querySelector('.loading-overlay')`, 'reload', 120_000)
      }
    })
    await sleep(1500)
    const h = await heapMB(true)
    await phase('settle 5s (post-GC heap)', async () => { await sleep(5000); return `post-GC heap ${Math.round(await heapMB(true))}MB (was ${Math.round(h)}MB)` })
    await phase('close grid tabs → memory released?', async () => {
      for (let i = 0; i < 3; i++) await cdp.press('w', 'KeyW', 87, 4)
      await sleep(2500)
      await heapMB(true)
    })
  } finally {
    try { cdp?.close() } catch { /* ignore */ }
    proc.kill('SIGTERM')
    await sleep(1500)
    if (proc.exitCode === null) proc.kill('SIGKILL')
    rmSync(userData, { recursive: true, force: true })
    rmSync(app, { recursive: true, force: true })
  }
  console.log('\nJSON ' + JSON.stringify(results))
}

// ---- scenarios ----
async function scrollRun(): Promise<string> {
  return cdp.eval(`new Promise((res) => {
    const g = document.querySelector('.gridwrap'); g.scrollTop = 0
    const max = g.scrollHeight - g.clientHeight, t0 = performance.now(); let frames = 0, worst = 0, last = t0
    const step = (t) => { frames++; worst = Math.max(worst, t - last); last = t
      const p = Math.min(1, (t - t0) / 4000); g.scrollTop = max * p
      if (p < 1) requestAnimationFrame(step); else res('frames ' + frames + ' (~' + Math.round(frames / 4) + 'fps), worst frame ' + Math.round(worst) + 'ms') }
    requestAnimationFrame(step) })`)
}
async function scrollH(): Promise<string> {
  return cdp.eval(`new Promise((res) => {
    const g = document.querySelector('.gridwrap'); g.scrollTop = 0; g.scrollLeft = 0
    const max = g.scrollWidth - g.clientWidth, t0 = performance.now(); let frames = 0, worst = 0, last = t0
    const step = (t) => { frames++; worst = Math.max(worst, t - last); last = t
      const p = Math.min(1, (t - t0) / 3000); g.scrollLeft = max * p
      if (p < 1) requestAnimationFrame(step); else res('frames ' + frames + ' (~' + Math.round(frames / 3) + 'fps), worst frame ' + Math.round(worst) + 'ms') }
    requestAnimationFrame(step) })`)
}
async function selectAll(): Promise<string> {
  await focusGrid()
  await cdp.eval(`document.querySelector('.gridwrap').scrollTop = 0`)
  const t0 = Date.now()
  await cdp.press('a', 'KeyA', 65, 4)
  await cdp.waitFor(`document.querySelectorAll('.gridwrap tbody tr.sel').length === document.querySelectorAll('.gridwrap tbody tr').length`, 'all rows selected', 60_000)
  return `${Date.now() - t0}ms to paint selection`
}
async function copyRun(): Promise<string> {
  await cdp.eval(`window.__cp = null; const o = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (s) => { window.__cp = { len: s.length, t: performance.now() }; return o(s).catch(() => {}) }; window.__t0 = 0`)
  await focusGrid()
  await cdp.eval(`window.__t0 = performance.now()`)
  await cdp.press('c', 'KeyC', 67, 4)
  const r = await cdp.waitFor<{ len: number; t: number }>(`window.__cp`, 'copy', 120_000)
  const t0 = await cdp.eval<number>(`window.__t0`)
  return `${(r.len / 1048576).toFixed(1)}MB payload, ${Math.round(r.t - t0)}ms`
}
async function timedKeys(key: string, code: string, vk: number, mod: number, n: number): Promise<string> {
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t = Date.now()
    const done = await Promise.race([cdp.press(key, code, vk, mod).then(() => true), sleep(30_000).then(() => false)])
    times.push(Date.now() - t)
    if (!done) { times.push(-1); break }
  }
  const ok = times.filter((x) => x >= 0)
  return `${ok.length}/${n} keys, ms each: ${times.map((x) => (x < 0 ? '>30000' : x)).join(' ')}`
}
const clickCell = async (): Promise<void> => { await focusGrid(); await cdp.eval(`document.querySelector('.gridwrap').scrollTop = 0`); await mouse(cellAt(0, 0), 'mousedown'); await mouse(cellAt(0, 0), 'mouseup') }
async function plainDown(): Promise<string> { await clickCell(); return timedKeys('ArrowDown', 'ArrowDown', 40, 0, 5) }
async function shiftDown(): Promise<string> { await clickCell(); return timedKeys('ArrowDown', 'ArrowDown', 40, 8, 5) }
async function shiftRight(): Promise<string> { await clickCell(); return timedKeys('ArrowRight', 'ArrowRight', 39, 8, 5) }
async function dragSelect(): Promise<string> {
  const t0 = Date.now()
  await mouse(cellAt(0, 0), 'mousedown')
  for (let r = 1; r < 30; r++) for (const c of [3, 12, 25, 39]) await mouse(cellAt(r, Math.min(c, 11)), 'mouseover').then(() => mouse(cellAt(r, Math.min(c, 11)), 'mouseenter', 'bubbles: false'))
  await mouse(cellAt(29, 11), 'mouseup')
  return `${Math.round((Date.now() - t0))}ms for ${29 * 4} cell hovers`
}

main().catch((e) => { console.error(e); process.exit(1) })
