import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  init,
  attachmentFromString,
  resolveActualPath,
  resolveAttachmentUrls,
  sendSignal,
  getMessageUpdates,
  getShareLink,
  shouldFetchForSocketEvent,
  type CVAttachment,
  type FileAttachment,
  type LinkAttachment,
} from './cv-api.js'

// ─────────────────────────────────────────────────────────────────────────────
// attachmentFromString
// ─────────────────────────────────────────────────────────────────────────────

describe('attachmentFromString', () => {
  describe('URL inputs', () => {
    it('returns a link attachment for http:// URLs', () => {
      const result = attachmentFromString('http://example.com/doc.pdf')
      expect(result).toEqual<LinkAttachment>({ type: 'link', url: 'http://example.com/doc.pdf' })
    })

    it('returns a link attachment for https:// URLs', () => {
      const result = attachmentFromString('https://example.com/image.png')
      expect(result).toEqual<LinkAttachment>({ type: 'link', url: 'https://example.com/image.png' })
    })

    it('is case-insensitive for the URL scheme', () => {
      const result = attachmentFromString('HTTPS://example.com/x')
      expect(result).toMatchObject({ type: 'link' })
    })

    it('preserves URLs with query strings and fragments', () => {
      const url = 'https://example.com/path?a=1&b=2#section'
      expect(attachmentFromString(url)).toEqual<LinkAttachment>({ type: 'link', url })
    })
  })

  describe('file path inputs', () => {
    it('returns a file attachment for an absolute path', () => {
      const result = attachmentFromString('/tmp/report.pdf')
      expect(result).toMatchObject<Partial<FileAttachment>>({
        type: 'file',
        path: '/tmp/report.pdf',
        filename: 'report.pdf',
      })
    })

    it('resolves a relative path to absolute using cwd', () => {
      const result = attachmentFromString('notes.txt')
      const expected = path.resolve(process.cwd(), 'notes.txt')
      expect(result).toMatchObject<Partial<FileAttachment>>({
        type: 'file',
        path: expected,
        filename: 'notes.txt',
      })
    })

    it('extracts the filename from a deeply nested path', () => {
      const result = attachmentFromString('/a/b/c/document.md') as FileAttachment
      expect(result.filename).toBe('document.md')
    })
  })

  describe('MIME type mapping', () => {
    const cases: Array<[string, string]> = [
      ['.md',       'text/markdown'],
      ['.markdown', 'text/markdown'],
      ['.txt',      'text/plain'],
      ['.csv',      'text/csv'],
      ['.json',     'application/json'],
      ['.xml',      'application/xml'],
      ['.pdf',      'application/pdf'],
      ['.png',      'image/png'],
      ['.jpg',      'image/jpeg'],
      ['.jpeg',     'image/jpeg'],
      ['.gif',      'image/gif'],
      ['.webp',     'image/webp'],
      ['.mp4',      'video/mp4'],
      ['.mov',      'video/quicktime'],
      ['.zip',      'application/zip'],
    ]

    it.each(cases)('%s → %s', (ext, expectedMime) => {
      const result = attachmentFromString(`/file${ext}`) as FileAttachment
      expect(result.mime_type).toBe(expectedMime)
    })

    it('is case-insensitive for extensions (.PNG → image/png)', () => {
      const result = attachmentFromString('/photo.PNG') as FileAttachment
      expect(result.mime_type).toBe('image/png')
    })

    it('falls back to application/octet-stream for unknown extensions', () => {
      const result = attachmentFromString('/data.xyz') as FileAttachment
      expect(result.mime_type).toBe('application/octet-stream')
    })

    it('falls back to application/octet-stream for files with no extension', () => {
      const result = attachmentFromString('/Makefile') as FileAttachment
      expect(result.mime_type).toBe('application/octet-stream')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveActualPath
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveActualPath', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the path unchanged when the file exists with the exact name', async () => {
    const p = path.join(tmpDir, 'exact.txt')
    await fs.writeFile(p, '')
    expect(await resolveActualPath(p)).toBe(p)
  })

  it('resolves macOS narrow no-break space (U+202F) to a regular-space match', async () => {
    // macOS screenshot filenames use U+202F before "AM"/"PM"; Claude types a regular space
    const actualName = 'Screenshot 2024-01-01 at 10.00 AM.png'
    const actualPath = path.join(tmpDir, actualName)
    await fs.writeFile(actualPath, '')

    const lookupPath = path.join(tmpDir, 'Screenshot 2024-01-01 at 10.00 AM.png')
    expect(await resolveActualPath(lookupPath)).toBe(actualPath)
  })

  it('returns the original path when no fuzzy match exists in the directory', async () => {
    const missing = path.join(tmpDir, 'nonexistent.txt')
    expect(await resolveActualPath(missing)).toBe(missing)
  })

  it('returns the original path when the parent directory does not exist', async () => {
    const p = path.join(tmpDir, 'no-such-dir', 'file.txt')
    expect(await resolveActualPath(p)).toBe(p)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveAttachmentUrls
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAttachmentUrls', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mockFetch.mockReset()
  })

  function att(overrides: Partial<CVAttachment> = {}): CVAttachment {
    return {
      _id: 'att-1',
      type: 'file',
      link: 'https://example.com/file',
      status: 'Uploaded',
      ...overrides,
    }
  }

  it('returns an empty Map and skips any fetch for an empty input', async () => {
    const result = await resolveAttachmentUrls([])
    expect(result.size).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns an empty Map and skips any fetch when no attachments are Uploaded', async () => {
    const result = await resolveAttachmentUrls([
      att({ type: 'link', status: undefined }),
      att({ _id: 'att-2', status: 'Initializing' }),
      att({ _id: 'att-3', status: 'Uploading' }),
      att({ _id: 'att-4', status: 'Failed' }),
    ])
    expect(result.size).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches signed URLs and returns a Map keyed by attachment ID', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { attachment_id: 'att-1', signed_url: 'https://s3.test/file1' },
        { attachment_id: 'att-2', signed_url: 'https://s3.test/file2' },
      ],
    })

    const result = await resolveAttachmentUrls([
      att({ _id: 'att-1' }),
      att({ _id: 'att-2' }),
    ])

    expect(result.size).toBe(2)
    expect(result.get('att-1')).toBe('https://s3.test/file1')
    expect(result.get('att-2')).toBe('https://s3.test/file2')
  })

  it('only sends Uploaded file attachment IDs in the bulk API request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ attachment_id: 'att-1', signed_url: 'https://s3.test/file1' }],
    })

    await resolveAttachmentUrls([
      att({ _id: 'att-1', status: 'Uploaded' }),
      att({ _id: 'att-2', type: 'link' }),
      att({ _id: 'att-3', status: 'Uploading' }),
    ])

    const [, fetchInit] = mockFetch.mock.calls[0]
    const body = JSON.parse(fetchInit.body)
    expect(body.ids).toEqual(['att-1'])
  })

  it('throws when the bulk signed-URL API returns a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })
    await expect(resolveAttachmentUrls([att()])).rejects.toThrow('403')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// sendSignal
// ─────────────────────────────────────────────────────────────────────────────

describe('sendSignal', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    init({ pat: 'cv_pat_test', log: () => {} })
    mockFetch.mockResolvedValue({ ok: true, status: 204 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mockFetch.mockReset()
  })

  function lastCall() {
    const [url, fetchInit] = mockFetch.mock.calls.at(-1)!
    return { url, init: fetchInit, body: JSON.parse(fetchInit.body) }
  }

  it('POSTs to the conversation signal endpoint with a Bearer PAT', async () => {
    await sendSignal({ conversationId: 'conv-1', signalType: 'thinking' })
    const { url, init: fetchInit } = lastCall()
    expect(url).toBe('https://api.carbonvoice.app/v5/conversations/conv-1/signal')
    expect(fetchInit.method).toBe('POST')
    expect(fetchInit.headers.Authorization).toBe('Bearer cv_pat_test')
  })

  it('sends signal_type and passes ttl_ms / message_id through', async () => {
    await sendSignal({ conversationId: 'conv-1', signalType: 'tool_call', body: 'Bash', ttlMs: 4000, messageId: 'msg-9' })
    const { body } = lastCall()
    expect(body).toMatchObject({ signal_type: 'tool_call', body: 'Bash', ttl_ms: 4000, message_id: 'msg-9' })
  })

  it('truncates body to the 200-char server limit', async () => {
    await sendSignal({ conversationId: 'conv-1', signalType: 'thinking', body: 'x'.repeat(250) })
    const { body } = lastCall()
    expect(body.body).toHaveLength(200)
  })

  it('is best-effort: does not throw on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 })
    await expect(sendSignal({ conversationId: 'conv-1', signalType: 'thinking' })).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getMessageUpdates
// ─────────────────────────────────────────────────────────────────────────────

describe('getMessageUpdates', () => {
  const mockFetch = vi.fn()
  const okPage = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    init({ pat: 'cv_pat_test', log: () => {} })
    mockFetch.mockResolvedValue(okPage({ data: [], has_more: false, next_cursor: null }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mockFetch.mockReset()
  })

  function lastUrl(): URL {
    return new URL(mockFetch.mock.calls.at(-1)![0])
  }

  it('GETs the v6 updates route anchored by date, direction=newer, limit 200', async () => {
    await getMessageUpdates({ date: '2026-09-24T09:00:00.000Z' })
    const url = lastUrl()
    expect(url.pathname).toBe('/v6/messages/updates')
    expect(mockFetch.mock.calls.at(-1)![1].method).toBe('GET')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      direction: 'newer', limit: '200', date: '2026-09-24T09:00:00.000Z',
    })
  })

  it('sends the cursor instead of the date once it has one', async () => {
    await getMessageUpdates({ cursor: 'abc', date: '2026-09-24T09:00:00.000Z' })
    const params = lastUrl().searchParams
    expect(params.get('cursor')).toBe('abc')
    expect(params.has('date')).toBe(false)
    expect(params.get('direction')).toBe('newer')
  })

  it('scopes with conversation_id and never the legacy channel_id', async () => {
    await getMessageUpdates({ date: '2026-09-24T09:00:00.000Z', conversationId: 'conv-1' })
    const params = lastUrl().searchParams
    expect(params.get('conversation_id')).toBe('conv-1')
    expect(params.has('channel_id')).toBe(false)
  })

  it('normalises MessageV6 rows to the legacy event shape and surfaces paging fields', async () => {
    mockFetch.mockResolvedValueOnce(okPage({
      data: [{
        id: 'm2', thread_id: 'm1', conversation_id: 'conv-1', workspace_id: 'w', creator_id: 'u',
        status: 'active', created_at: '2026-09-24T10:00:00.000Z', updated_at: '2026-09-24T10:00:01.000Z',
        content: { transcript: 'hi' }, tagged_user_ids: [],
      }],
      has_more: true,
      next_cursor: 'next',
    }))
    const r = await getMessageUpdates({ date: '2026-09-24T09:00:00.000Z' })
    expect(r).toMatchObject({ ok: true, hasMore: true, nextCursor: 'next' })
    expect(r.ok && r.messages[0]).toMatchObject({
      message_id: 'm2', channel_ids: ['conv-1'], parent_message_id: 'm1',
      text_models: [{ type: 'transcript', value: 'hi' }],
    })
  })

  it('reports the HTTP status on failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 })
    expect(await getMessageUpdates({ cursor: 'bad' })).toEqual({ ok: false, status: 400 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getShareLink
// ─────────────────────────────────────────────────────────────────────────────

describe('getShareLink', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    init({ pat: 'cv_pat_test', log: () => {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mockFetch.mockReset()
  })

  it('reads the v6 route and normalises the MessageV6 shared message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        _id: 's1', share_type: 'forward', created_by: 'fwd', end_access_at: 123, has_channel_access: false,
        shared_message: {
          id: 'orig', thread_id: 'orig', creator_id: 'author', workspace_id: 'w', status: 'active',
          created_at: '2026-09-24T10:00:00.000Z', updated_at: '2026-09-24T10:00:00.000Z', tagged_user_ids: [],
          content: { time_codes: [{ t: 'hello', s: 0, e: 1 }], duration_ms: 500 },
          attachments: [{ id: 'a1', type: 'file', url: 'https://api/x', status: 'Uploaded', filename: 'f.pdf' }],
        },
      }),
    })
    const link = await getShareLink('s1')
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.carbonvoice.app/v6/message-sharelinks/s1')
    expect(link).toMatchObject({ share_type: 'forward', created_by: 'fwd', end_access_at: 123 })
    expect(link?.shared_message).toMatchObject({
      message_id: 'orig',
      creator_id: 'author',
      duration_ms: 500,
      text_models: [{ type: 'transcript', value: 'hello' }],
      attachments: [expect.objectContaining({ _id: 'a1', link: 'https://api/x', status: 'Uploaded' })],
    })
  })

  it('returns null on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })
    expect(await getShareLink('missing')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// shouldFetchForSocketEvent — legacy socket payloads
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldFetchForSocketEvent', () => {
  const legacy = { _id: 'm1', status: 'active', channel_ids: ['conv-1'], last_updated_at: 1 }

  it('triggers a fetch for an active legacy event', () => {
    expect(shouldFetchForSocketEvent(legacy, undefined)).toBe(true)
    expect(shouldFetchForSocketEvent(legacy, 'conv-1')).toBe(true)
  })

  it('reads the conversation from channel_id or channel_ids[0]', () => {
    expect(shouldFetchForSocketEvent({ status: 'active', channel_id: 'conv-2' }, 'conv-1')).toBe(false)
    expect(shouldFetchForSocketEvent({ ...legacy, channel_ids: ['conv-2'] }, 'conv-1')).toBe(false)
  })

  it('still fetches when the payload names no conversation', () => {
    expect(shouldFetchForSocketEvent({ status: 'active' }, 'conv-1')).toBe(true)
  })

  it('ignores non-active events', () => {
    expect(shouldFetchForSocketEvent({ ...legacy, status: 'processing' }, undefined)).toBe(false)
    expect(shouldFetchForSocketEvent(undefined, undefined)).toBe(false)
  })
})
