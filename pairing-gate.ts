export interface PairingRecord {
  senderId: string
  channelId: string
  expiresAt: number
}

export interface PairingHistory {
  lastAt: number
  count: number
}

// Min gap between codes for one sender, so a burst of messages gets one code, not one each.
export const PAIRING_REISSUE_COOLDOWN_MS = 60_000
// Per sender per session: an operator who ignores a stranger should not be pinged forever.
export const PAIRING_MAX_CODES = 3

export function shouldIssuePairing(opts: {
  senderId: string
  channelId: string
  pending: Iterable<PairingRecord>
  history: PairingHistory | undefined
  now: number
  cooldownMs?: number
  maxCodes?: number
}): boolean {
  const { senderId, channelId, pending, history, now, cooldownMs = PAIRING_REISSUE_COOLDOWN_MS, maxCodes = PAIRING_MAX_CODES } = opts
  // A live code only answers the conversation it was sent to.
  for (const p of pending) {
    if (p.senderId === senderId && p.channelId === channelId && p.expiresAt > now) return false
  }
  if (!history) return true
  return history.count < maxCodes && now - history.lastAt >= cooldownMs
}
