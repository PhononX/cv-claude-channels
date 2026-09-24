import { describe, it, expect, vi } from 'vitest'
import {
  mapV6ToEvent, mapV6ToSharedMessage, syncMessageUpdates,
  type FetchUpdatesPage, type MessageV6, type UpdatesPageResult,
} from './message-v6.js'

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
    const e = mapV6ToEvent(v6({ share_link_id: 's1', kind: 'text', name: 'Standup' }))
    expect(e).toMatchObject({
      message_id: 'm1',
      name: 'Standup',
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

describe('syncMessageUpdates', () => {
  const DATE = '2026-09-24T09:00:00.000Z'
  const page = (ids: string[], hasMore: boolean, nextCursor: string | null): UpdatesPageResult => ({
    ok: true, status: 200, hasMore, nextCursor,
    messages: ids.map(id => mapV6ToEvent(v6({ id, thread_id: id }))),
  })
  const fail = (status: number): UpdatesPageResult => ({ ok: false, status })
  const fetcher = (...results: UpdatesPageResult[]) => {
    const fn = vi.fn<FetchUpdatesPage>()
    for (const r of results) fn.mockResolvedValueOnce(r)
    return fn
  }

  it('reports an incomplete sync when the page cap is hit with more pending', async () => {
    const pages = Array.from({ length: 50 }, (_, i) => page([`m${i}`], true, `c${i}`))
    const fetchPage = fetcher(...pages)
    const r = await syncMessageUpdates({ cursor: 'stored', date: DATE, fetchPage })
    expect(fetchPage).toHaveBeenCalledTimes(50)
    expect(r).toMatchObject({ ok: true, cursor: 'c49', complete: false })
    if (r.ok) expect(r.messages).toHaveLength(50)
  })

  it('is complete when the last page within the cap has no more', async () => {
    const pages = Array.from({ length: 50 }, (_, i) => page([`m${i}`], i < 49, `c${i}`))
    const r = await syncMessageUpdates({ cursor: 'stored', date: DATE, fetchPage: fetcher(...pages) })
    expect(r).toMatchObject({ ok: true, cursor: 'c49', complete: true })
  })

  it('anchors the first page by date when there is no cursor', async () => {
    const fetchPage = fetcher(page(['a'], false, 'c1'))
    const r = await syncMessageUpdates({ cursor: null, date: DATE, conversationId: 'conv', fetchPage })
    expect(fetchPage).toHaveBeenCalledWith({ date: DATE, conversationId: 'conv' })
    expect(r).toEqual({ ok: true, messages: [expect.objectContaining({ message_id: 'a' })], cursor: 'c1', reanchored: false, complete: true })
  })

  it('follows next_cursor until has_more is false and returns the tail cursor', async () => {
    const fetchPage = fetcher(page(['a', 'b'], true, 'c1'), page(['c'], true, 'c2'), page([], false, 'c3'))
    const r = await syncMessageUpdates({ cursor: 'stored', date: DATE, fetchPage })
    expect(fetchPage.mock.calls.map(c => c[0])).toEqual([
      { cursor: 'stored', conversationId: undefined },
      { cursor: 'c1', conversationId: undefined },
      { cursor: 'c2', conversationId: undefined },
    ])
    expect(r.ok && r.messages.map(m => m.message_id)).toEqual(['a', 'b', 'c'])
    expect(r.ok && r.cursor).toBe('c3')
  })

  it('does not treat a short page as the end while has_more is true', async () => {
    const fetchPage = fetcher(page(['a'], true, 'c1'), page(['b'], false, 'c2'))
    await syncMessageUpdates({ cursor: null, date: DATE, fetchPage })
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('keeps the stored cursor when an empty cursor page echoes nothing back', async () => {
    const fetchPage = fetcher(page([], false, null))
    const r = await syncMessageUpdates({ cursor: 'stored', date: DATE, fetchPage })
    expect(r.ok && r.cursor).toBe('stored')
  })

  it('returns a null cursor for an empty date-anchored page', async () => {
    const fetchPage = fetcher(page([], false, null))
    const r = await syncMessageUpdates({ cursor: null, date: DATE, fetchPage })
    expect(r).toEqual({ ok: true, messages: [], cursor: null, reanchored: false, complete: true })
  })

  it('de-duplicates re-delivered messages by id, keeping the newest copy', async () => {
    const edited = mapV6ToEvent(v6({ id: 'a', thread_id: 'a', updated_at: '2026-09-24T10:00:09.000Z' }))
    const fetchPage = fetcher(
      page(['a', 'b'], true, 'c1'),
      { ok: true, status: 200, hasMore: false, nextCursor: 'c2', messages: [edited] },
    )
    const r = await syncMessageUpdates({ cursor: null, date: DATE, fetchPage })
    expect(r.ok && r.messages.map(m => m.message_id)).toEqual(['b', 'a'])
    expect(r.ok && r.messages[1].last_updated_at).toBe('2026-09-24T10:00:09.000Z')
  })

  it('drops a stored cursor rejected with 400 and re-anchors by date', async () => {
    const log = vi.fn()
    const fetchPage = fetcher(fail(400), page(['a'], false, 'fresh'))
    const r = await syncMessageUpdates({ cursor: 'stale', date: DATE, fetchPage, log })
    expect(fetchPage.mock.calls.map(c => c[0])).toEqual([
      { cursor: 'stale', conversationId: undefined },
      { date: DATE, conversationId: undefined },
    ])
    expect(r).toEqual({ ok: true, messages: [expect.objectContaining({ message_id: 'a' })], cursor: 'fresh', reanchored: true, complete: true })
    expect(log).toHaveBeenCalled()
  })

  it('never keeps the rejected cursor, even when the re-anchored page is empty', async () => {
    const fetchPage = fetcher(fail(400), page([], false, null))
    const r = await syncMessageUpdates({ cursor: 'stale', date: DATE, fetchPage })
    expect(r.ok && r.cursor).toBeNull()
  })

  it.each([500, 503, 401, 0])('reports failure without discarding the cursor on %i', async (status) => {
    const fetchPage = fetcher(fail(status))
    const r = await syncMessageUpdates({ cursor: 'stored', date: DATE, fetchPage })
    expect(r).toEqual({ ok: false, status })
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('treats a thrown network error as a non-400 failure', async () => {
    const fetchPage = vi.fn<FetchUpdatesPage>().mockRejectedValueOnce(new Error('ECONNRESET'))
    const r = await syncMessageUpdates({ cursor: 'stored', date: DATE, fetchPage })
    expect(r).toEqual({ ok: false, status: 0 })
  })

  it('fails the whole sync when a later page errors, so nothing half-read is committed', async () => {
    const fetchPage = fetcher(page(['a'], true, 'c1'), fail(502))
    const r = await syncMessageUpdates({ cursor: 'stored', date: DATE, fetchPage })
    expect(r).toEqual({ ok: false, status: 502 })
  })
})
