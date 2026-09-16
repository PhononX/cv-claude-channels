/**
 * permission-relay.ts
 *
 * Pure helpers for the Claude Code permission relay: parsing a remote verdict,
 * formatting the prompt sent to Carbon Voice, and tracking which requests are still
 * open. Kept separate from cv-claude-channel.ts so it can be tested without starting
 * the server.
 */

export interface PendingPermission {
  requestId: string
  channelId: string
  toolName: string
  expiresAt: number
}

/**
 * Matches "y abcde", "yes abcde", "n abcde", "no abcde".
 *
 * [a-km-z] is the alphabet Claude Code draws request IDs from — lowercase, and never
 * 'l', so it can't be misread as a 1 or I when typed on a phone. The /i flag tolerates
 * autocorrect capitalising the reply; callers lowercase the captured ID.
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export function parseVerdict(
  transcript: string,
): { verdict: 'allow' | 'deny'; requestId: string } | null {
  const m = PERMISSION_REPLY_RE.exec(transcript)
  if (!m) return null
  return {
    verdict: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
    requestId: m[2].toLowerCase(),
  }
}

/**
 * Claude Code (>= v2.1.211) already caps input_preview at 3500 code points and elides
 * the middle of longer values. We trim further because Carbon Voice reads the prompt
 * aloud. Markers Claude Code inserts — "[REDACTED]", "(value unserializable)", and
 * "⋯ N code points elided ⋯" — pass through untouched: the approver needs to see that
 * something was hidden.
 */
export function trimPreview(preview: string, max: number): string {
  if (preview.length <= max) return preview
  return `${preview.slice(0, max)}… (truncated for playback)`
}

export function formatPermissionPrompt(opts: {
  toolName: string
  description: string
  inputPreview: string
  requestId: string
  allowEmoji: string[]
  allowAlwaysEmoji: string[]
  denyEmoji: string[]
  previewMax: number
}): string {
  const { toolName, description, inputPreview, requestId, previewMax } = opts
  const { allowEmoji, allowAlwaysEmoji, denyEmoji } = opts

  // description alone is often the constant "Run shell command" with zero detail, so
  // inputPreview is the part that actually says what is being approved.
  const summary = description || '(no description given)'
  const preview = trimPreview(inputPreview, previewMax)

  // Emoji are configuration, not looked-up ids, so the prompt always names the exact
  // glyph the verdict poller matches — the two can no longer drift.
  // Every accepted glyph is named, so a reader is never told to tap one emoji while the
  // poller quietly also honours another.
  const glyphs = (list: string[]) => list.join(' or ')
  const reactionHelp =
    `${glyphs(allowEmoji)} = allow once. ${glyphs(allowAlwaysEmoji)} = allow ${toolName} ` +
    `for the rest of this session, whatever the arguments. ${glyphs(denyEmoji)} = deny.\n`

  return (
    `Claude wants to run ${toolName}: ${summary}\n\n` +
    (preview ? `${preview}\n\n` : '') +
    reactionHelp +
    `Or reply "yes ${requestId}" or "no ${requestId}".`
  )
}

/**
 * Returns the pending map's key for an open, unexpired request, or null.
 *
 * Claude Code drops verdicts carrying an ID it doesn't recognise, but checking here
 * stops a guessed or replayed ID from resolving a prompt raised for a different
 * conversation.
 */
export function findOpenRequest(
  pending: Map<string, PendingPermission>,
  requestId: string,
  now: number,
): string | null {
  for (const [key, entry] of pending) {
    if (entry.requestId === requestId && entry.expiresAt > now) return key
  }
  return null
}

/** Removes expired entries in place and returns them, so the caller can log each one. */
export function sweepExpired(
  pending: Map<string, PendingPermission>,
  now: number,
): PendingPermission[] {
  const expired: PendingPermission[] = []
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) {
      expired.push(entry)
      pending.delete(key)
    }
  }
  return expired
}
