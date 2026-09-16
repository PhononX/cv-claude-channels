/**
 * reactions.ts
 *
 * Carbon Voice reactions after the full-emoji migration (CV-13453).
 *
 * Reactions are plain unicode emoji now. The curated slug catalog is frozen and
 * exists only to map legacy slugs stored on old messages onto their canonical emoji,
 * which is why this server no longer calls `GET /reactions` at startup (CV-13516 —
 * that endpoint stays alive server-side only for old app versions).
 *
 * The CV-13479 contract split means a message summary can carry reactions in two
 * shapes at once: `top_user_reactions` (legacy, one entry per user/reaction pair)
 * and `top_user_emojis` (emoji-native, grouped with a user_ids list). Reading both
 * and collapsing onto the emoji key is what makes us correct regardless of which
 * shape a given message was written with.
 */

/**
 * Curated legacy slug → canonical emoji.
 *
 * MUST mirror cv-api's `CURATED_EMOJI_BY_REACTION_ID` (src/reaction/reaction.util.ts)
 * and carbon-voice-flutter's `CuratedReactions.slugToEmoji`. The server groups stored
 * reactions with that map, so a divergence here silently splits one reaction into two.
 */
export const CURATED_SLUG_TO_EMOJI: Readonly<Record<string, string>> = Object.freeze({
  love: '❤️',
  acknowledged: '✅',
  negative: '⛔',
  confused: '⁉️',
  busy: '⏰', // deprecated: still read on old messages, never written
  affirmative: '💯',
  lol: '🤣',
})

/**
 * Collapses a reaction identifier onto its canonical emoji key. Arbitrary emoji and
 * unknown identifiers pass through unchanged — an unrecognised value (say a pre-
 * migration UUID) simply won't match any emoji we care about, which is the desired
 * outcome rather than an error.
 */
export function canonicalReactionKey(reactionId: string): string {
  return CURATED_SLUG_TO_EMOJI[reactionId] ?? reactionId
}

/**
 * One user-perceived emoji, per UTS #51. Mirrors carbon-voice-flutter's `isSingleEmoji`
 * and the cv-api validator it was built against, so we never send what the server
 * rejects. Accepts ZWJ sequences, skin tones, flags and keycaps; rejects plain text
 * and curated slugs like `love`.
 */
const MAX_EMOJI_CODE_UNITS = 32
const PICTOGRAPHIC = '\\p{Extended_Pictographic}(?:\\u{FE0F}|[\\u{1F3FB}-\\u{1F3FF}])*'
const KEYCAP = '[#*0-9]\\u{FE0F}?\\u{20E3}'
const ELEMENT = `(?:${KEYCAP}|${PICTOGRAPHIC})`
const SUBDIVISION_FLAG =
  '\\u{1F3F4}\\u{E0067}\\u{E0062}(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}'

const SINGLE_EMOJI = new RegExp(
  `^(?:\\p{Regional_Indicator}{2}|${SUBDIVISION_FLAG}|${ELEMENT}(?:\\u{200D}${ELEMENT})*)$`,
  'u',
)

export function isSingleEmoji(value: string): boolean {
  if (!value || value.length > MAX_EMOJI_CODE_UNITS) return false
  return SINGLE_EMOJI.test(value)
}

export interface ReactionSummaryShape {
  top_user_reactions?: Array<{ user_id: string; reaction_id: string }>
  top_user_emojis?: Array<{ reaction: string; count?: number; user_ids?: string[] }>
}

/**
 * Flattens both summary shapes into canonical-emoji → the users who reacted with it.
 * Callers ask "did an allowed user react with X?" without caring which array it
 * arrived in or whether it was stored as a slug.
 */
export function collectReactors(summary: ReactionSummaryShape | undefined): Map<string, Set<string>> {
  const byEmoji = new Map<string, Set<string>>()
  const add = (rawKey: string, userId: string) => {
    if (!rawKey || !userId) return
    const key = canonicalReactionKey(rawKey)
    const users = byEmoji.get(key) ?? new Set<string>()
    users.add(userId)
    byEmoji.set(key, users)
  }

  for (const r of summary?.top_user_reactions ?? []) add(r.reaction_id, r.user_id)
  for (const e of summary?.top_user_emojis ?? []) {
    for (const userId of e.user_ids ?? []) add(e.reaction, userId)
  }
  return byEmoji
}

/** True when `userId` reacted to this summary with `emoji`, in either shape. */
export function hasReacted(
  summary: ReactionSummaryShape | undefined,
  emoji: string,
  userId: string,
): boolean {
  return collectReactors(summary).get(canonicalReactionKey(emoji))?.has(userId) ?? false
}
