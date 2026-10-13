import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { timeoutSignal } from './timeoutSignal.js'

describe('timeoutSignal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('aborts after the timeout', () => {
    const linked = timeoutSignal(undefined, 100)
    vi.advanceTimersByTime(99)
    expect(linked.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(linked.signal.aborted).toBe(true)
  })

  it('follows the parent signal, including one already aborted', () => {
    const parent = new AbortController()
    const linked = timeoutSignal(parent.signal, 1000)
    parent.abort()
    expect(linked.signal.aborted).toBe(true)
    expect(timeoutSignal(parent.signal, 1000).signal.aborted).toBe(true)
  })

  it('done() stops both the timer and the parent link', () => {
    const parent = new AbortController()
    const linked = timeoutSignal(parent.signal, 100)
    linked.done()
    parent.abort()
    vi.advanceTimersByTime(200)
    expect(linked.signal.aborted).toBe(false)
  })
})
