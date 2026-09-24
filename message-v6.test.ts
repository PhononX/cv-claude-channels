import { describe, it, expect } from 'vitest'
import { mapV6ToEvent, mapV6ToSharedMessage, type MessageV6 } from './message-v6.js'

function v6(overrides: Partial<MessageV6> = {}): MessageV6 {
  return {
    id: 'm1',
    created_at: '2026-09-24T10:00:00.000Z',
    updated_at: '2026-09-24T10:00:05.000Z',
    conversation_id: 'c1',
    workspace_id: 'w1',
    creator_id: 'u1',
    status: 'active',
    thread_id: 'm1',
    tagged_user_ids: [],
    ...overrides,
  }
}

describe('mapV6ToEvent', () => {
  it('maps core fields onto the legacy event shape', () => {
    const e = mapV6ToEvent(v6({ share_link_id: 's1', kind: 'text' }))
    expect(e).toMatchObject({
      message_id: 'm1',
      channel_ids: ['c1'],
      workspace_ids: ['w1'],
      creator_id: 'u1',
      created_at: '2026-09-24T10:00:00.000Z',
      last_updated_at: '2026-09-24T10:00:05.000Z',
      status: 'active',
      share_link_id: 's1',
      is_text_message: true,
    })
  })

  it('treats a message as a reply only when thread_id differs from id', () => {
    expect(mapV6ToEvent(v6({ thread_id: 'm1' })).parent_message_id).toBeNull()
    expect(mapV6ToEvent(v6({ thread_id: 'parent' })).parent_message_id).toBe('parent')
  })

  it('prefers content.transcript over time codes', () => {
    const e = mapV6ToEvent(v6({
      content: { transcript: 'hello there', time_codes: [{ t: 'ignored', s: 0, e: 1 }] },
    }))
    expect(e.text_models).toEqual([{ type: 'transcript', value: 'hello there' }])
  })

  it('falls back to joined time-code words when transcript is empty', () => {
    const e = mapV6ToEvent(v6({
      content: { transcript: '', time_codes: [{ t: 'hi', s: 0, e: 1 }, { t: 'you', s: 1, e: 2 }] },
    }))
    expect(e.text_models).toEqual([{ type: 'transcript', value: 'hi you' }])
  })

  it('carries ai_summary as a summary text model', () => {
    const e = mapV6ToEvent(v6({ content: { transcript: 't', ai_summary: 'short' } }))
    expect(e.text_models).toContainEqual({ type: 'summary', value: 'short' })
  })

  it('takes audio from presigned_url or url, never streaming_url', () => {
    expect(mapV6ToEvent(v6({ content: { presigned_url: 'p', url: 'u', duration_ms: 9 } })).audio_models)
      .toEqual([{ url: 'p', duration_ms: 9 }])
    expect(mapV6ToEvent(v6({ content: { url: 'u' } })).audio_models).toEqual([{ url: 'u', duration_ms: undefined }])
    expect(mapV6ToEvent(v6({ content: { streaming_url: 's' } })).audio_models).toEqual([])
  })

  it('maps attachment id/url to _id/link and keeps upload status', () => {
    const e = mapV6ToEvent(v6({
      attachments: [{ id: 'a1', type: 'file', url: 'https://x/a1', filename: 'f.png', mime_type: 'image/png', status: 'Uploaded' }],
    }))
    expect(e.attachments).toEqual([expect.objectContaining({
      _id: 'a1', type: 'file', link: 'https://x/a1', filename: 'f.png', mime_type: 'image/png', status: 'Uploaded',
    })])
  })

  it('tolerates missing content, attachments and conversation', () => {
    const e = mapV6ToEvent(v6({ conversation_id: undefined }))
    expect(e.text_models).toEqual([])
    expect(e.audio_models).toEqual([])
    expect(e.attachments).toEqual([])
    expect(e.channel_ids).toEqual([])
    expect(e.share_link_id).toBeNull()
  })

  it('passes the reaction summary through untouched', () => {
    const reaction_summary = { reaction_counts: { '👀': 1 }, top_user_reactions: [], top_user_emojis: [{ reaction: '👀', count: 1, user_ids: ['bot'] }] }
    expect(mapV6ToEvent(v6({ reaction_summary })).reaction_summary).toBe(reaction_summary)
  })
})

describe('mapV6ToSharedMessage', () => {
  it('builds the forwarded-message shape from a MessageV6', () => {
    const sm = mapV6ToSharedMessage(v6({
      id: 'orig', creator_id: 'author',
      content: { transcript: 'forwarded words', duration_ms: 1200 },
      attachments: [{ id: 'a1', type: 'file', url: '/message-sharelinks/s1/attachments/signedurl/a1', status: 'Uploaded' }],
    }))
    expect(sm).toMatchObject({
      message_id: 'orig',
      creator_id: 'author',
      channel_ids: ['c1'],
      duration_ms: 1200,
      text_models: [{ type: 'transcript', value: 'forwarded words' }],
    })
    expect(sm.attachments?.[0]._id).toBe('a1')
  })
})
