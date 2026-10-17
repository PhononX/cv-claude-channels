import { describe, it, expect } from 'vitest'
import { shouldIssuePairing, PAIRING_REISSUE_COOLDOWN_MS } from './pairing-gate.js'

const base = { senderId: 'u1', pending: [], lastIssuedAt: undefined, now: 1_000_000 }

describe('shouldIssuePairing', () => {
  it('issues a first code', () => {
    expect(shouldIssuePairing(base)).toBe(true)
  })

  it('does not issue while the sender has a live code', () => {
    const pending = [{ senderId: 'u1', expiresAt: base.now + 1 }]
    expect(shouldIssuePairing({ ...base, pending })).toBe(false)
  })

  it('ignores live codes that belong to other senders', () => {
    const pending = [{ senderId: 'u2', expiresAt: base.now + 1 }]
    expect(shouldIssuePairing({ ...base, pending })).toBe(true)
  })

  it('issues a fresh code once the old one has expired', () => {
    const pending = [{ senderId: 'u1', expiresAt: base.now - 1 }]
    const lastIssuedAt = base.now - 600_000
    expect(shouldIssuePairing({ ...base, pending, lastIssuedAt })).toBe(true)
  })

  it('issues again when the code vanished from pending.json', () => {
    const lastIssuedAt = base.now - 5 * 60_000
    expect(shouldIssuePairing({ ...base, lastIssuedAt })).toBe(true)
  })

  it('rate limits reissue inside the cooldown', () => {
    const lastIssuedAt = base.now - (PAIRING_REISSUE_COOLDOWN_MS - 1)
    expect(shouldIssuePairing({ ...base, lastIssuedAt })).toBe(false)
  })

  it('allows reissue exactly at the cooldown boundary', () => {
    const lastIssuedAt = base.now - PAIRING_REISSUE_COOLDOWN_MS
    expect(shouldIssuePairing({ ...base, lastIssuedAt })).toBe(true)
  })
})
