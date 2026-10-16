import { describe, expect, it } from 'vitest'
import { startupCheckDelay } from './startup-check.js'

describe('startupCheckDelay', () => {
  it('retries quickly at first', () => {
    expect([0, 1, 2, 3].map(startupCheckDelay)).toEqual([5_000, 10_000, 20_000, 30_000])
  })
  it('then settles at once a minute', () => {
    expect(startupCheckDelay(4)).toBe(60_000)
    expect(startupCheckDelay(100)).toBe(60_000)
  })
})
