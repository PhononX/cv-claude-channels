export interface PairingRecord {
  senderId: string
  expiresAt: number
}

// Min gap between codes for one sender, so a burst of messages gets one code, not one each.
export const PAIRING_REISSUE_COOLDOWN_MS = 60_000

export function shouldIssuePairing(opts: {
  senderId: string
  pending: Iterable<PairingRecord>
  lastIssuedAt: number | undefined
  now: number
  cooldownMs?: number
}): boolean {
  const { senderId, pending, lastIssuedAt, now, cooldownMs = PAIRING_REISSUE_COOLDOWN_MS } = opts
  for (const p of pending) {
    if (p.senderId === senderId && p.expiresAt > now) return false
  }
  return lastIssuedAt === undefined || now - lastIssuedAt >= cooldownMs
}
