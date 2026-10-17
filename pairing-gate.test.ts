import { describe, it, expect } from 'vitest'
import { shouldIssuePairing, PAIRING_REISSUE_COOLDOWN_MS, PAIRING_MAX_CODES } from './pairing-gate.js'

const base = { senderId: 'u1', channelId: 'c1', pending: [], history: undefined, now: 1_000_000 }
const live = (over = {}) => ({ senderId: 'u1', channelId: 'c1', expiresAt: base.now + 1, ...over })

describe('shouldIssuePairing', () => {
  it('issues a first code', () => {
    expect(shouldIssuePairing(base)).toBe(true)
  })

  it('does not issue while the sender has a live code for this conversation', () => {
    expect(shouldIssuePairing({ ...base, pending: [live()] })).toBe(false)
  })

  it('ignores live codes that belong to other senders', () => {
    expect(shouldIssuePairing({ ...base, pending: [live({ senderId: 'u2' })] })).toBe(true)
  })

  it('answers the same sender in a different conversation', () => {
    const history = { lastAt: base.now - PAIRING_REISSUE_COOLDOWN_MS, count: 1 }
    expect(shouldIssuePairing({ ...base, pending: [live({ channelId: 'c2' })], history })).toBe(true)
  })

  it('issues a fresh code once the old one has expired', () => {
    const history = { lastAt: base.now - 600_000, count: 1 }
    expect(shouldIssuePairing({ ...base, pending: [live({ expiresAt: base.now - 1 })], history })).toBe(true)
  })

  it('issues again when the code vanished from pending.json', () => {
    expect(shouldIssuePairing({ ...base, history: { lastAt: base.now - 5 * 60_000, count: 1 } })).toBe(true)
  })

  it('rate limits reissue inside the cooldown', () => {
    const history = { lastAt: base.now - (PAIRING_REISSUE_COOLDOWN_MS - 1), count: 1 }
    expect(shouldIssuePairing({ ...base, history })).toBe(false)
  })

  it('allows reissue exactly at the cooldown boundary', () => {
    const history = { lastAt: base.now - PAIRING_REISSUE_COOLDOWN_MS, count: 1 }
    expect(shouldIssuePairing({ ...base, history })).toBe(true)
  })

  it('stops after the per-sender cap', () => {
    const history = { lastAt: base.now - 3_600_000, count: PAIRING_MAX_CODES }
    expect(shouldIssuePairing({ ...base, history })).toBe(false)
  })
})
