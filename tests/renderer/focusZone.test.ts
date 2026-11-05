// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { explorerClicked, explorerOwnsRefresh, keyBelongsToExplorer, markExplorerActive, resetExplorerClick, setExplorerRefreshProbe, trackExplorerClicks } from '../../src/renderer/src/lib/focusZone'

afterEach(() => {
  resetExplorerClick()
  document.body.innerHTML = ''
})

const mk = (html: string): HTMLElement => {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

describe('focusZone', () => {
  it('explorerOwnsRefresh: the tree owns Cmd+R, but not text fields of the explorer or a tree with nothing to refresh', () => {
    const ex = mk('<div class="explorer"><button id="a"></button><input id="f"><textarea id="t"></textarea></div><div id="main"><input id="b"></div>')
    expect(explorerOwnsRefresh(ex.querySelector('#a'))).toBe(true)
    expect(explorerOwnsRefresh(ex.querySelector('#f'))).toBe(false) // the filter box: the tree ignores keys there
    expect(explorerOwnsRefresh(ex.querySelector('#t'))).toBe(false)
    expect(explorerOwnsRefresh(document.getElementById('b'))).toBe(false)
    const off = setExplorerRefreshProbe(() => false)
    expect(explorerOwnsRefresh(ex.querySelector('#a'))).toBe(false)
    off()
    expect(explorerOwnsRefresh(ex.querySelector('#a'))).toBe(true)
    // body target after a click in the explorer
    const stop = trackExplorerClicks()
    ex.querySelector('#a')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(explorerOwnsRefresh(document.body)).toBe(true)
    const off2 = setExplorerRefreshProbe(() => false)
    expect(explorerOwnsRefresh(document.body)).toBe(false)
    off2()
    stop()
  })

  it('a keystroke targeted inside .explorer belongs to the Explorer; elsewhere it does not', () => {
    const ex = mk('<div class="explorer"><button id="a"></button></div><div id="main"><input id="b"></div>')
    expect(keyBelongsToExplorer(ex.querySelector('#a'))).toBe(true)
    expect(keyBelongsToExplorer(ex)).toBe(true)
    expect(keyBelongsToExplorer(document.getElementById('b'))).toBe(false)
  })

  it('body/document/null targets fall back to the last click', () => {
    mk('<div class="explorer"><button id="a"></button></div><div id="main"></div>')
    expect(keyBelongsToExplorer(document.body)).toBe(false)
    expect(keyBelongsToExplorer(null)).toBe(false)
    const stop = trackExplorerClicks()
    document.getElementById('a')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(explorerClicked()).toBe(true)
    expect(keyBelongsToExplorer(document.body)).toBe(true)
    expect(keyBelongsToExplorer(document.documentElement)).toBe(true)
    expect(keyBelongsToExplorer(null)).toBe(true)
    expect(keyBelongsToExplorer(window)).toBe(true) // not an element
    // a real element outside the explorer is decided by itself, whatever the last click was
    expect(keyBelongsToExplorer(document.getElementById('main'))).toBe(false)
    document.getElementById('main')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(explorerClicked()).toBe(false)
    expect(keyBelongsToExplorer(document.body)).toBe(false)
    stop()
  })

  it('cleanup stops tracking', () => {
    mk('<div class="explorer"><button id="a"></button></div>')
    const stop = trackExplorerClicks()
    stop()
    document.getElementById('a')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(explorerClicked()).toBe(false)
  })

  it('markExplorerActive makes bare-body keystrokes belong to the Explorer without a click (Shift+Esc)', () => {
    mk('<div class="explorer"></div>')
    expect(keyBelongsToExplorer(document.body)).toBe(false)
    markExplorerActive()
    expect(explorerClicked()).toBe(true)
    expect(keyBelongsToExplorer(document.body)).toBe(true)
  })

  it('a click on a non-element target (document) counts as outside', () => {
    mk('<div class="explorer"></div>')
    const stop = trackExplorerClicks()
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(explorerClicked()).toBe(false)
    stop()
  })
})
