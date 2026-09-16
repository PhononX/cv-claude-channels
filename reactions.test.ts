import { describe, it, expect } from 'vitest'
import {
  CURATED_SLUG_TO_EMOJI,
  canonicalReactionKey,
  isSingleEmoji,
  collectReactors,
  hasReacted,
} from './reactions.js'

describe('CURATED_SLUG_TO_EMOJI', () => {
  // Divergence from cv-api's CURATED_EMOJI_BY_REACTION_ID silently splits one
  // reaction into two, so pin every pair.
  it('matches the frozen catalog', () => {
    expect(CURATED_SLUG_TO_EMOJI).toEqual({
      love: '❤️',
      acknowledged: '✅',
      negative: '⛔',
      confused: '⁉️',
      busy: '⏰',
      affirmative: '💯',
      lol: '🤣',
    })
  })

  it('is frozen, so a caller cannot mutate the shared map', () => {
    expect(Object.isFrozen(CURATED_SLUG_TO_EMOJI)).toBe(true)
  })
})

describe('canonicalReactionKey', () => {
  it('maps a legacy slug onto its emoji', () => {
    expect(canonicalReactionKey('love')).toBe('❤️')
    expect(canonicalReactionKey('acknowledged')).toBe('✅')
    expect(canonicalReactionKey('negative')).toBe('⛔')
  })

  it('passes an emoji through unchanged, so it is idempotent', () => {
    expect(canonicalReactionKey('❤️')).toBe('❤️')
    expect(canonicalReactionKey(canonicalReactionKey('love'))).toBe('❤️')
  })

  it('passes arbitrary emoji through', () => {
    expect(canonicalReactionKey('🦆')).toBe('🦆')
  })

  it('passes an unknown identifier through rather than throwing', () => {
    // A pre-migration UUID lands here; it simply matches nothing we look for.
    expect(canonicalReactionKey('6f1c2f9e-0000-4a1b-9c3d-000000000000')).toBe(
      '6f1c2f9e-0000-4a1b-9c3d-000000000000',
    )
  })
})

describe('isSingleEmoji', () => {
  it('accepts plain, keycap, flag, skin-tone and ZWJ emoji', () => {
    expect(isSingleEmoji('✅')).toBe(true)
    expect(isSingleEmoji('🦆')).toBe(true)
    expect(isSingleEmoji('1️⃣')).toBe(true)
    expect(isSingleEmoji('🇵🇹')).toBe(true)
    expect(isSingleEmoji('👍🏽')).toBe(true)
    expect(isSingleEmoji('👨‍👩‍👧')).toBe(true)
  })

  it('rejects curated slugs, so callers can tell the two apart', () => {
    expect(isSingleEmoji('love')).toBe(false)
    expect(isSingleEmoji('acknowledged')).toBe(false)
  })

  it('rejects empty, plain text and multi-emoji strings', () => {
    expect(isSingleEmoji('')).toBe(false)
    expect(isSingleEmoji('hello')).toBe(false)
    expect(isSingleEmoji('✅✅')).toBe(false)
  })

  it('rejects anything longer than a legal emoji sequence', () => {
    expect(isSingleEmoji('👍'.repeat(20))).toBe(false)
  })
})

describe('collectReactors', () => {
  it('reads the legacy top_user_reactions shape', () => {
    const out = collectReactors({ top_user_reactions: [{ user_id: 'u1', reaction_id: 'love' }] })
    expect([...(out.get('❤️') ?? [])]).toEqual(['u1'])
  })

  it('reads the emoji-native top_user_emojis shape', () => {
    const out = collectReactors({
      top_user_emojis: [{ reaction: '❤️', count: 2, user_ids: ['u1', 'u2'] }],
    })
    expect([...(out.get('❤️') ?? [])].sort()).toEqual(['u1', 'u2'])
  })

  it('collapses the same reaction arriving in both shapes onto one key', () => {
    // The CV-13479 split means one message can carry both at once.
    const out = collectReactors({
      top_user_reactions: [{ user_id: 'u1', reaction_id: 'love' }],
      top_user_emojis: [{ reaction: '❤️', count: 1, user_ids: ['u2'] }],
    })
    expect(out.size).toBe(1)
    expect([...(out.get('❤️') ?? [])].sort()).toEqual(['u1', 'u2'])
  })

  it('does not double-count a user present in both shapes', () => {
    const out = collectReactors({
      top_user_reactions: [{ user_id: 'u1', reaction_id: 'acknowledged' }],
      top_user_emojis: [{ reaction: '✅', count: 1, user_ids: ['u1'] }],
    })
    expect([...(out.get('✅') ?? [])]).toEqual(['u1'])
  })

  it('keeps distinct reactions apart', () => {
    const out = collectReactors({
      top_user_emojis: [
        { reaction: '✅', count: 1, user_ids: ['u1'] },
        { reaction: '⛔', count: 1, user_ids: ['u2'] },
      ],
    })
    expect([...(out.get('✅') ?? [])]).toEqual(['u1'])
    expect([...(out.get('⛔') ?? [])]).toEqual(['u2'])
  })

  it('tolerates a missing summary and missing fields', () => {
    expect(collectReactors(undefined).size).toBe(0)
    expect(collectReactors({}).size).toBe(0)
    expect(collectReactors({ top_user_emojis: [{ reaction: '✅' }] }).size).toBe(0)
  })
})

describe('hasReacted', () => {
  const summary = {
    top_user_reactions: [{ user_id: 'legacy-user', reaction_id: 'acknowledged' }],
    top_user_emojis: [{ reaction: '⛔', count: 1, user_ids: ['emoji-user'] }],
  }

  it('matches a user regardless of which shape their reaction arrived in', () => {
    expect(hasReacted(summary, '✅', 'legacy-user')).toBe(true)
    expect(hasReacted(summary, '⛔', 'emoji-user')).toBe(true)
  })

  it('accepts a slug as the needle too, so config may use either', () => {
    expect(hasReacted(summary, 'acknowledged', 'legacy-user')).toBe(true)
    expect(hasReacted(summary, 'negative', 'emoji-user')).toBe(true)
  })

  it('is false for the wrong user or the wrong reaction', () => {
    expect(hasReacted(summary, '✅', 'emoji-user')).toBe(false)
    expect(hasReacted(summary, '🤣', 'legacy-user')).toBe(false)
    expect(hasReacted(undefined, '✅', 'legacy-user')).toBe(false)
  })
})
