import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { io, Socket } from 'socket.io-client'

const CV_API_BASE = 'https://api.carbonvoice.app'

let _pat = ''
let _log: (msg: string) => void = (msg) => process.stderr.write(msg)

export function init(config: { pat: string; log?: (msg: string) => void }): void {
  _pat = config.pat
  if (config.log) _log = config.log
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface CVTimecode { t: string; s: number; e: number }

export interface CVReactionSummary {
  reaction_counts: Record<string, number>
  top_user_reactions: Array<{ user_id: string; reaction_id: string }>
}

export interface CVMessageEvent {
  message_id: string
  channel_ids: string[]
  creator_id: string
  text_models: Array<{ type: string; value: string; timecodes?: CVTimecode[] }>
  parent_message_id: string | null
  created_at: string
  is_text_message: boolean
  status: string
  reaction_summary?: CVReactionSummary
}

export interface Reaction {
  id: string
  name: string
  code: string
  reaction_tts: string
  image_url: string
}

export interface SendMessageBody {
  transcript: string
  is_text_message: boolean
  unique_client_id: string
  is_streaming: boolean
  channel_id: string
  reply_to_message_id: string
}

export interface AttachmentRecord {
  _id: string
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE
// ─────────────────────────────────────────────────────────────────────────────

function cvFetch(method: string, endpoint: string, body?: unknown): Promise<Response> {
  return fetch(`${CV_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_pat}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

export async function whoami(): Promise<string> {
  const res = await cvFetch('GET', '/whoami')
  if (!res.ok) throw new Error(`/whoami failed: ${res.status}`)
  const data = await res.json() as { user: { user_guid: string } }
  return data.user.user_guid
}

// ─────────────────────────────────────────────────────────────────────────────
// REACTIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function getReactions(): Promise<Reaction[]> {
  const res = await cvFetch('GET', '/reactions')
  if (!res.ok) {
    _log(`cv-claude-channels: GET /reactions failed ${res.status}\n`)
    return []
  }
  const data = await res.json() as Reaction[]
  return Array.isArray(data) ? data : []
}

export async function addReaction(reactionId: string, messageId: string): Promise<void> {
  _log(`cv-claude-channels: addReaction ${reactionId} on ${messageId}\n`)
  const res = await cvFetch('POST', `/reactions/${reactionId}/${messageId}`)
  if (!res.ok) {
    _log(`cv-claude-channels: addReaction failed ${res.status} for ${messageId}\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function markRead(channelId: string, messageId: string): Promise<void> {
  _log(`cv-claude-channels: markRead ${messageId} in ${channelId}\n`)
  const res = await cvFetch(
    'DELETE',
    `/notifications/${channelId}/${messageId}?type=message&notification_removal_mode=hard`,
  )
  if (!res.ok) {
    _log(`cv-claude-channels: markRead failed ${res.status} for ${messageId}\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export async function sendMessage(body: SendMessageBody): Promise<{ message_id?: string; id?: string }> {
  const res = await cvFetch('POST', '/v3/messages/start', body)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`CV sendMessage failed ${res.status}: ${text}`)
  }
  return res.json() as Promise<{ message_id?: string; id?: string }>
}

export async function getRecentMessages(params: {
  date: string
  direction: string
  limit: number
  use_last_updated: boolean
  channel_id?: string
}): Promise<{ ok: boolean; status: number; messages: CVMessageEvent[] }> {
  _log(`cv-claude-channels: POST /v3/messages/recent ${JSON.stringify(params)}\n`)
  const res = await cvFetch('POST', '/v3/messages/recent', params)
  if (!res.ok) return { ok: false, status: res.status, messages: [] }
  const data = await res.json() as CVMessageEvent[]
  return { ok: true, status: res.status, messages: Array.isArray(data) ? data : [] }
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTACHMENTS
// ─────────────────────────────────────────────────────────────────────────────

export async function getSignedUrl(filename: string, mime_type: string): Promise<string> {
  const res = await cvFetch('POST', '/v3/attachments/signedurl', {
    files: [{ filename, mimetype: mime_type }],
  })
  if (!res.ok) throw new Error(`CV signedurl failed ${res.status}: ${await res.text()}`)
  const data = await res.json() as Array<{ url: string }>
  return data[0].url
}

export async function uploadToS3(url: string, filePath: string, mime_type: string): Promise<void> {
  const fileBytes = await fs.readFile(filePath)
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': mime_type },
    body: fileBytes,
  })
  if (!res.ok) throw new Error(`S3 upload failed ${res.status}`)
}

export async function postAttachments(
  messageId: string,
  attachments: unknown[],
): Promise<AttachmentRecord[]> {
  const res = await cvFetch('POST', `/messages/${messageId}/attachments`, { attachments })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`CV postAttachments failed ${res.status}: ${body}`)
  }
  const data = await res.json() as unknown
  _log(`cv-claude-channels: POST attachments response: ${JSON.stringify(data)}\n`)
  return Array.isArray(data) ? (data as AttachmentRecord[]) : []
}

export async function updateAttachment(
  messageId: string,
  attachmentId: string,
  body: {
    type: string
    link: string
    filename: string
    mime_type: string
    status: string
    percent_complete: number
  },
): Promise<void> {
  _log(`cv-claude-channels: PUT attachment ${attachmentId} ${JSON.stringify(body)}\n`)
  const res = await cvFetch('PUT', `/messages/${messageId}/attachment/${attachmentId}`, body)
  const text = await res.text()
  _log(`cv-claude-channels: PUT attachment ${attachmentId} → ${res.status} ${text}\n`)
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE PATH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// macOS screenshot filenames use U+202F (Narrow No-Break Space) before AM/PM.
// Claude types a regular space, so we do a fuzzy match against the directory listing.
export async function resolveActualPath(filePath: string): Promise<string> {
  try {
    await fs.access(filePath)
    return filePath
  } catch {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    const normalizedBase = base.normalize('NFC').replace(/\p{Z}/gu, ' ')
    try {
      const entries = await fs.readdir(dir)
      const match = entries.find(e => e.normalize('NFC').replace(/\p{Z}/gu, ' ') === normalizedBase)
      if (match) {
        _log(`cv-claude-channels: resolved "${base}" → "${match}" (unicode space normalization)\n`)
        return path.join(dir, match)
      }
    } catch { /* directory missing — fall through */ }
    return filePath
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTION (WebSocket + polling fallback)
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionMode = 'connecting' | 'websocket' | 'polling' | 'shutdown'

export interface CVConnectionCallbacks {
  onMessageActivity: () => Promise<void>
  onOwnUserId?: (userId: string) => void
}

export interface CVConnectionOptions {
  conversationId?: string
  pollIntervalMs: number
  wsRetryMaxMs: number
}

export interface CVConnection {
  readonly mode: ConnectionMode
  connect(): Promise<void>
  disconnect(): void
}

export function createConnection(
  opts: CVConnectionOptions,
  callbacks: CVConnectionCallbacks,
): CVConnection {
  let _mode: ConnectionMode = 'connecting'
  let _wsSocket: Socket | null = null
  let _wsRetryBackoff = 1_000
  let _wsRetryTimer: ReturnType<typeof setTimeout> | null = null
  let _pollTimer: ReturnType<typeof setTimeout> | null = null

  function startPolling() {
    if (_pollTimer) return
    _log(`cv-claude-channels: polling every ${opts.pollIntervalMs}ms\n`)
    const tick = async () => {
      if (_mode === 'shutdown' || _mode === 'websocket') return
      await callbacks.onMessageActivity()
      _pollTimer = setTimeout(tick, opts.pollIntervalMs)
    }
    _pollTimer = setTimeout(tick, opts.pollIntervalMs)
  }

  function stopPolling() {
    if (_pollTimer) {
      clearTimeout(_pollTimer)
      _pollTimer = null
      _log('cv-claude-channels: polling stopped (WS reconnected)\n')
    }
  }

  function scheduleWsReconnect() {
    if (_wsRetryTimer || _mode === 'shutdown') return
    _wsRetryTimer = setTimeout(async () => {
      _wsRetryTimer = null
      if (_mode === 'shutdown') return
      _log(`cv-claude-channels: attempting WS reconnect (backoff ${_wsRetryBackoff}ms)\n`)
      try {
        await callbacks.onMessageActivity()
        await connectWebSocket()
      } catch {
        _wsRetryBackoff = Math.min(_wsRetryBackoff * 2, opts.wsRetryMaxMs)
        scheduleWsReconnect()
      }
    }, _wsRetryBackoff)
  }

  async function connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      _log(`cv-claude-channels: connecting Socket.IO to ${CV_API_BASE}\n`)

      const socket = io(CV_API_BASE, {
        auth: { authorization: `Bearer ${_pat}` },
        transports: ['websocket'],
        reconnection: false,
      })

      _wsSocket = socket

      socket.on('connected', (user: { user_guid?: string; id?: string }) => {
        _log('cv-claude-channels: Socket.IO connected\n')
        _mode = 'websocket'
        _wsRetryBackoff = 1_000

        const uid = user?.user_guid ?? user?.id
        if (uid) callbacks.onOwnUserId?.(uid)

        stopPolling()

        if (opts.conversationId) {
          socket.emit('subscribe:channel', opts.conversationId, (ack: string) => {
            _log(`cv-claude-channels: subscribed to channel: ${ack}\n`)
          })
        }

        resolve()
      })

      const onMessageEvent = async (payload: {
        _id?: string
        status?: string
        channel_id?: string
        channel_ids?: string[]
        last_updated_at?: number
      }) => {
        const payloadChannel = payload?.channel_id ?? payload?.channel_ids?.[0] ?? 'unknown'
        _log(`cv-claude-channels: WS event (status=${payload?.status} channel=${payloadChannel}) raw=${JSON.stringify(payload)}\n`)
        if (payload?.status !== 'active') return

        if (opts.conversationId && payloadChannel !== 'unknown' && payloadChannel !== opts.conversationId) {
          _log(`cv-claude-channels: WS event skipped (wrong channel)\n`)
          return
        }

        await callbacks.onMessageActivity()
      }

      socket.on('message:created', onMessageEvent)
      socket.on('message:updated', onMessageEvent)

      socket.on('connect_error', (err: Error) => {
        _log(`cv-claude-channels: Socket.IO connect error: ${err.message}\n`)
        _wsSocket = null
        reject(err)
      })

      socket.on('disconnect', async (reason: string) => {
        if (_mode === 'shutdown') return
        _log(`cv-claude-channels: Socket.IO disconnected (${reason}) — falling back to polling\n`)
        _wsSocket = null
        _mode = 'polling'
        await callbacks.onMessageActivity()
        startPolling()
        scheduleWsReconnect()
      })
    })
  }

  return {
    get mode() { return _mode },

    async connect() {
      await callbacks.onMessageActivity()
      try {
        await connectWebSocket()
      } catch (err) {
        _log(`cv-claude-channels: WS initial connect failed (${err}) — falling back to polling\n`)
        _mode = 'polling'
        startPolling()
        scheduleWsReconnect()
      }
    },

    disconnect() {
      _mode = 'shutdown'
      if (_wsSocket) _wsSocket.disconnect()
      if (_wsRetryTimer) clearTimeout(_wsRetryTimer)
      if (_pollTimer) clearTimeout(_pollTimer)
    },
  }
}
