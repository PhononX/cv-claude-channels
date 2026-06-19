import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  attachmentFromString,
  resolveActualPath,
  resolveAttachmentUrls,
  init,
  postActionRequest,
  getActionRequest,
  registerPendingRequest,
  deliverActionResponse,
  hasPendingRequest,
  type CVAttachment,
  type FileAttachment,
  type LinkAttachment,
  type ActionRequestEnvelope,
  type ActionResponsePayload,
} from './cv-api.ts'

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
// Agent ↔ Client Interaction Protocol transport
// ─────────────────────────────────────────────────────────────────────────────

describe('postActionRequest', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    init({ pat: 'test-pat', log: () => {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mockFetch.mockReset()
  })

  function envelope(overrides: Partial<ActionRequestEnvelope> = {}): ActionRequestEnvelope {
    return {
      type: 'action_request',
      channelId: 'chan_1',
      intent: 'permission',
      title: 'Claude wants to run Bash',
      render: {
        kind: 'options',
        presentation: 'permission',
        options: [{ optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' }],
      },
      ...overrides,
    }
  }

  it('POSTs to the channel action-requests endpoint with a Bearer PAT and JSON body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ requestId: 'areq_1' }) })

    const result = await postActionRequest('chan_1', envelope())

    expect(result).toEqual({ requestId: 'areq_1' })
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.carbonvoice.app/channels/chan_1/action-requests')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer test-pat')
    expect(init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body.intent).toBe('permission')
    expect(body.render.options[0].kind).toBe('allow_once')
  })

  it('accepts request_id / id aliases for the returned requestId', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ request_id: 'areq_alias' }) })
    expect(await postActionRequest('chan_1', envelope())).toEqual({ requestId: 'areq_alias' })
  })

  it('throws when the server returns a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    await expect(postActionRequest('chan_1', envelope())).rejects.toThrow('500')
  })

  it('throws when the response is missing a requestId', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await expect(postActionRequest('chan_1', envelope())).rejects.toThrow('missing requestId')
  })
})

describe('pending request registry (socket action_response)', () => {
  beforeEach(() => {
    init({ pat: 'test-pat', log: () => {} })
  })

  it('resolves the matching pending promise when an action_response is delivered', () => {
    const resolved: ActionResponsePayload[] = []
    registerPendingRequest('areq_1', (p) => resolved.push(p), () => {}, null)

    expect(hasPendingRequest('areq_1')).toBe(true)
    deliverActionResponse({ requestId: 'areq_1', outcome: 'selected', optionId: 'allow_once' })

    expect(resolved).toHaveLength(1)
    expect(resolved[0].optionId).toBe('allow_once')
    expect(hasPendingRequest('areq_1')).toBe(false)
  })

  it('ignores an action_response whose requestId does not match any pending request', () => {
    const resolved: ActionResponsePayload[] = []
    registerPendingRequest('areq_keep', (p) => resolved.push(p), () => {}, null)

    deliverActionResponse({ requestId: 'areq_other', outcome: 'declined' })

    expect(resolved).toHaveLength(0)
    expect(hasPendingRequest('areq_keep')).toBe(true)
  })

  it('clears the timer and unregisters when the unregister fn is called', () => {
    const timer = setTimeout(() => {}, 60_000)
    const unregister = registerPendingRequest('areq_timer', () => {}, () => {}, timer)
    expect(hasPendingRequest('areq_timer')).toBe(true)
    unregister()
    expect(hasPendingRequest('areq_timer')).toBe(false)
  })

  it('only delivers once — a second action_response for the same id is a no-op', () => {
    let count = 0
    registerPendingRequest('areq_once', () => { count++ }, () => {}, null)
    deliverActionResponse({ requestId: 'areq_once', outcome: 'selected', optionId: 'allow_once' })
    deliverActionResponse({ requestId: 'areq_once', outcome: 'declined' })
    expect(count).toBe(1)
  })
})

describe('getActionRequest', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    init({ pat: 'test-pat', log: () => {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mockFetch.mockReset()
  })

  it('GETs the action-request and returns the resolution outcome', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        requestId: 'areq_1',
        status: 'resolved',
        resolution: { outcome: 'selected', optionId: 'allow_always', by: 'user_9', at: '2026-06-18T00:00:00Z' },
      }),
    })

    const result = await getActionRequest('chan_1', 'areq_1')
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.carbonvoice.app/channels/chan_1/action-requests/areq_1')
    expect(result).toMatchObject({ requestId: 'areq_1', outcome: 'selected', optionId: 'allow_always', respondedBy: 'user_9' })
  })

  it('returns null when the request is still pending (no resolution)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'pending', resolution: null }) })
    expect(await getActionRequest('chan_1', 'areq_1')).toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })
    expect(await getActionRequest('chan_1', 'areq_1')).toBeNull()
  })
})
