// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import RedisItems from '../../src/renderer/src/RedisItems'
import type { RedisValue } from '../../src/shared'

afterEach(cleanup)

type Items = Extract<RedisValue, { kind: 'hash' | 'list' | 'set' | 'zset' }>
const ui = (value: Items): React.JSX.Element => <RedisItems value={value} onOp={vi.fn(async () => true)} onMore={vi.fn()} loadingMore={false} busy={false} />

describe('RedisItems', () => {
  it('re-rendering with another kind of value (hash -> list -> zset -> set) swaps the add row instead of crashing', () => {
    const hash: Items = { kind: 'hash', items: [{ field: 'a', value: '1' }], next: null }
    const list: Items = { kind: 'list', items: ['x'], offset: 0, next: null }
    const zset: Items = { kind: 'zset', items: [{ member: 'm', score: '1' }], offset: 0, next: null }
    const set: Items = { kind: 'set', items: ['s'], next: null }
    const r = render(ui(hash))
    expect(screen.getByPlaceholderText('field')).toBeTruthy()
    r.rerender(ui(list))
    expect(screen.queryByPlaceholderText('field')).toBeNull()
    expect(screen.getByRole('button', { name: 'Push left' })).toBeTruthy()
    r.rerender(ui(zset))
    expect(screen.getByPlaceholderText('score')).toBeTruthy()
    r.rerender(ui(set))
    expect(screen.getByPlaceholderText('member')).toBeTruthy()
    expect(screen.queryByPlaceholderText('score')).toBeNull()
    r.rerender(ui(hash))
    expect(screen.getByPlaceholderText('field')).toBeTruthy()
  })
})
