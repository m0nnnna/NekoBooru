import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS, createBudget, retryAfterSeconds } from './budget.js'

function fakeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

describe('createBudget', () => {
  it('allows a burst, then declines', () => {
    const clock = fakeClock()
    const budget = createBudget({ burst: 3, perSecond: 1, now: clock.now })
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, true])
    expect(budget.take()).toBe(false)
    expect(budget.retryInMs()).toBe(1000)
  })

  it('defaults to a burst of 6 at one request per second', () => {
    const clock = fakeClock()
    const budget = createBudget({ now: clock.now })
    for (let i = 0; i < 6; i += 1) expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(false)
    clock.advance(999)
    expect(budget.take()).toBe(false)
    clock.advance(1)
    expect(budget.take()).toBe(true)
  })

  it('refills at perSecond up to the burst size', () => {
    const clock = fakeClock()
    const budget = createBudget({ burst: 2, perSecond: 2, now: clock.now })
    budget.take()
    budget.take()
    expect(budget.retryInMs()).toBe(500)
    clock.advance(250)
    expect(budget.retryInMs()).toBe(250)
    expect(budget.take()).toBe(false)
    clock.advance(250)
    expect(budget.retryInMs()).toBe(0)
    expect(budget.take()).toBe(true)
    // A long idle stretch refills only up to the burst.
    clock.advance(60_000)
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false])
  })

  it('cools down for Retry-After seconds and refuses meanwhile', () => {
    const clock = fakeClock()
    const budget = createBudget({ now: clock.now })
    budget.coolDown(30)
    expect(budget.coolingDown()).toBe(true)
    expect(budget.take()).toBe(false)
    expect(budget.retryInMs()).toBe(30_000)
    clock.advance(29_999)
    expect(budget.take()).toBe(false)
    clock.advance(1)
    expect(budget.coolingDown()).toBe(false)
    expect(budget.retryInMs()).toBe(0)
    expect(budget.take()).toBe(true)
  })

  it('uses the default cooldown without a Retry-After and caps it at 900 s', () => {
    const clock = fakeClock()
    const budget = createBudget({ now: clock.now })
    budget.coolDown(null)
    expect(budget.retryInMs()).toBe(DEFAULT_COOLDOWN_SECONDS * 1000)
    budget.reset()
    budget.coolDown(undefined)
    expect(budget.retryInMs()).toBe(60_000)
    budget.reset()
    budget.coolDown(86_400)
    expect(budget.retryInMs()).toBe(MAX_COOLDOWN_SECONDS * 1000)
    expect(MAX_COOLDOWN_SECONDS).toBe(900)
    budget.reset()
    budget.coolDown(0.2)
    expect(budget.retryInMs()).toBe(1000)
  })

  it('never shortens a running cooldown', () => {
    const clock = fakeClock()
    const budget = createBudget({ now: clock.now })
    budget.coolDown(120)
    budget.coolDown(10)
    expect(budget.retryInMs()).toBe(120_000)
  })

  it('reports the longer of the cooldown and the refill wait', () => {
    const clock = fakeClock()
    const budget = createBudget({ burst: 1, perSecond: 0.1, now: clock.now })
    budget.take()
    expect(budget.retryInMs()).toBe(10_000)
    budget.coolDown(5)
    expect(budget.retryInMs()).toBe(10_000)
    budget.coolDown(20)
    expect(budget.retryInMs()).toBe(20_000)
  })

  it('reset() refills the bucket and ends the cooldown', () => {
    const clock = fakeClock()
    const budget = createBudget({ burst: 1, now: clock.now })
    budget.take()
    budget.coolDown(60)
    budget.reset()
    expect(budget.coolingDown()).toBe(false)
    expect(budget.take()).toBe(true)
  })
})

describe('createBudget with vitest fake timers', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('reads Date.now by default', () => {
    const budget = createBudget({ burst: 1, perSecond: 1 })
    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(budget.take()).toBe(true)
  })
})

describe('retryAfterSeconds', () => {
  it('reads the delta form from strings, Headers and responses', () => {
    expect(retryAfterSeconds('120')).toBe(120)
    expect(retryAfterSeconds(' 1.5 ')).toBe(1.5)
    expect(retryAfterSeconds(new Headers({ 'Retry-After': '30' }))).toBe(30)
    expect(retryAfterSeconds({ headers: new Headers({ 'retry-after': '45' }) })).toBe(45)
  })

  it('gives null for anything else', () => {
    expect(retryAfterSeconds(null)).toBeNull()
    expect(retryAfterSeconds('')).toBeNull()
    expect(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull()
    expect(retryAfterSeconds('-5')).toBeNull()
    expect(retryAfterSeconds(new Headers())).toBeNull()
    expect(retryAfterSeconds({ headers: {} })).toBeNull()
  })
})
