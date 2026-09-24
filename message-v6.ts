import type { CVAttachment, CVMessageEvent, CVReactionSummary, CVSharedMessage } from './cv-api.js'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES — cv-api MessageV6 (src/message/dto/v6/MessageV6.dto.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface MessageV6TimeCode { t: string; s: number; e: number }

export interface MessageV6Content {
  id?: string
  transcript?: string
  ai_summary?: string
  time_codes?: MessageV6TimeCode[]
  language?: string
  is_original_language?: boolean
  url?: string
  presigned_url?: string | null
  streaming_url?: string
  duration_ms?: number
}

export interface MessageV6Attachment {
  id: string
  creator_id?: string
  created_at?: string
  type: string
  url: string
  filename?: string | null
  mime_type?: string | null
  length_in_bytes?: number | null
  status?: string | null
  percent_complete?: number | null
}

export interface MessageV6 {
  id: string
  type?: string
  kind?: string
  created_at: string
  updated_at: string
  deleted_at?: string
  conversation_id?: string
  workspace_id?: string
  creator_id: string
  status: string
  // The parent id for a reply, or the message's own id otherwise.
  thread_id: string
  attachments?: MessageV6Attachment[]
  share_link_id?: string
  content?: MessageV6Content
  reaction_summary?: CVReactionSummary
  tagged_user_ids?: string[]
  ai_response_ids?: Array<{ id: string; prompt_id: string }>
}

export interface MessageV6Page {
  data: MessageV6[]
  has_more: boolean
  next_cursor: string | null
}

export interface MessageShareLinkV6 {
  share_type: string
  created_by: string
  end_access_at?: number | null
  revoked_at?: number | null
  has_channel_access?: boolean
  shared_message?: MessageV6
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISER
// ─────────────────────────────────────────────────────────────────────────────

// Socket.IO events still carry the legacy shape and both sources share one
// processing path, so v6 payloads are normalised to it at the fetch boundary.
export function mapV6ToEvent(m: MessageV6): CVMessageEvent {
  const content = m.content
  const transcript = content?.transcript?.trim()
    || (content?.time_codes ?? []).map(tc => tc.t).join(' ').trim()

  const text_models: CVMessageEvent['text_models'] = []
  if (transcript) text_models.push({ type: 'transcript', value: transcript })
  if (content?.ai_summary) text_models.push({ type: 'summary', value: content.ai_summary })

  // streaming_url is a live-ingest endpoint, not a playable file.
  const audioUrl = content?.presigned_url || content?.url
  const audio_models = audioUrl ? [{ url: audioUrl, duration_ms: content?.duration_ms }] : []

  return {
    message_id: m.id,
    channel_ids: m.conversation_id ? [m.conversation_id] : [],
    workspace_ids: m.workspace_id ? [m.workspace_id] : [],
    creator_id: m.creator_id,
    created_at: m.created_at,
    last_updated_at: m.updated_at,
    text_models,
    audio_models,
    attachments: (m.attachments ?? []).map(mapV6Attachment),
    parent_message_id: m.thread_id && m.thread_id !== m.id ? m.thread_id : null,
    share_link_id: m.share_link_id ?? null,
    is_text_message: m.kind === 'text',
    status: m.status,
    reaction_summary: m.reaction_summary,
  }
}

export function mapV6ToSharedMessage(m: MessageV6): CVSharedMessage {
  const event = mapV6ToEvent(m)
  return {
    message_id: event.message_id,
    creator_id: event.creator_id,
    channel_ids: event.channel_ids,
    workspace_ids: event.workspace_ids,
    text_models: event.text_models,
    attachments: event.attachments,
    duration_ms: m.content?.duration_ms,
    created_at: event.created_at,
  }
}

function mapV6Attachment(a: MessageV6Attachment): CVAttachment {
  return {
    _id: a.id,
    creator_id: a.creator_id,
    created_at: a.created_at,
    type: a.type as CVAttachment['type'],
    link: a.url,
    filename: a.filename ?? undefined,
    mime_type: a.mime_type ?? undefined,
    length_in_bytes: a.length_in_bytes ?? undefined,
    status: a.status ?? undefined,
    percent_complete: a.percent_complete ?? undefined,
  }
}
