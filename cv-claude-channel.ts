#!/usr/bin/env node
/**
 * cv-claude-channel.ts
 * Carbon Voice → Claude Code channel server
 *
 * An MCP channel server that bridges Carbon Voice messages into a running
 * Claude Code session. Connects via WebSocket (primary) with polling fallback,
 * and lets Claude reply back into the originating CV conversation.
 *
 * SETUP — add to .mcp.json in your project root:
 * {
 *   "mcpServers": {
 *     "cv-claude-channel": {
 *       "command": "npx",
 *       "args": ["tsx", "./cv-claude-channel.ts"],
 *       "env": {
 *         "CV_PAT": "your-personal-access-token",
 *         "CV_CONVERSATION_ID": ""  // optional: scope to one conversation guid; omit to receive all
 *       }
 *     }
 *   }
 * }
 *
 * Then start Claude Code with:
 *   claude --dangerously-load-development-channels server:cv-claude-channel
 *
 * WebSocket is the primary transport (polling is the fallback).
 * Auth uses ?token=PAT query param — confirm with Russell if 401/4xxx close codes appear.
 * WS event envelope assumed: { event: "message.posted.to.channel", data: CVMessageEvent }
 * Polling fallback fires automatically on any WS failure and retries WS with backoff.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { io, Socket } from 'socket.io-client'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const CV_API_BASE = 'https://api.carbonvoice.app'

const PAT                  = process.env.CV_PAT ?? ''
const CONVERSATION_ID      = process.env.CV_CONVERSATION_ID ?? ''   // optional: scope to one conversation
const REACTION_ID          = process.env.CV_REACTION_ID ?? ''       // optional: pin a specific reaction ID
const SEEN_TTL_MS          = Number(process.env.CV_SEEN_TTL_MS ?? 5 * 60 * 1_000)
const POLL_INTERVAL_MS     = Number(process.env.CV_POLL_INTERVAL_MS  ?? 5_000)
const WS_RETRY_MAX_MS      = Number(process.env.CV_WS_RETRY_MAX_MS   ?? 30_000)
const STATE_PATH           = process.env.CV_STATE_PATH
  ?? path.join(os.homedir(), '.claude', 'channels', 'cv', `state${CONVERSATION_ID ? `-${CONVERSATION_ID}` : ''}.json`)
const ACCESS_PATH          = process.env.CV_ACCESS_PATH
  ?? path.join(os.homedir(), '.claude', 'channels', 'cv', 'access.json')
const PROJECT_NAME         = process.env.CV_PROJECT_NAME ?? 'this project'

if (!PAT) {
  process.stderr.write('cv-claude-channels: CV_PAT is required\n')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type Mode = 'connecting' | 'websocket' | 'polling' | 'shutdown'

interface Access {
  allowFrom: string[]    // approved sender IDs; empty = deny all
  blockedFrom: string[]  // permanently silenced sender IDs; no notification ever
}

interface State {
  mode: Mode
  lastSeenAt: string | null             // null = never fetched; set to now on first poll
  ownUserId: string                     // used to filter self-messages
  reactionId: string | null             // reaction to add on receipt; null until resolved
  wsSocket: Socket | null              // active Socket.IO connection, if any
  wsRetryBackoff: number                // current backoff in ms
  wsRetryTimer: ReturnType<typeof setTimeout> | null
  pollTimer: ReturnType<typeof setTimeout> | null
  recentlySeen: Map<string, number>     // message_id → expiry epoch ms
  lastSeenAtDirty: boolean              // pending disk write
  flushTimer: ReturnType<typeof setTimeout> | null
  lastCVContext: { channelId: string; replyToId: string } | null  // for permission relay
  access: Access                        // file-backed allowlist
  unknownSenderSeen: Set<string>        // senders already notified this session (avoid spam)
  pendingAllowContext: Map<string, { channelId: string; messageId: string }>  // context for allow confirmation
}

// Matches the actual CV REST API message shape
interface CVTimecode { t: string; s: number; e: number }

interface CVMessageEvent {
  message_id: string
  channel_ids: string[]
  creator_id: string
  text_models: Array<{ type: string; value: string; timecodes?: CVTimecode[] }>
  parent_message_id: string | null
  created_at: string
  is_text_message: boolean
  status: string
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

const state: State = {
  mode: 'connecting',
  lastSeenAt: null,
  ownUserId: process.env.CV_OWN_USER_ID ?? '',
  reactionId: REACTION_ID || 'acknowledged',
  wsSocket: null,
  wsRetryBackoff: 1_000,
  wsRetryTimer: null,
  pollTimer: null,
  recentlySeen: new Map<string, number>(),
  lastSeenAtDirty: false,
  flushTimer: null,
  lastCVContext: null,
  access: { allowFrom: [], blockedFrom: [] },
  unknownSenderSeen: new Set(),
  pendingAllowContext: new Map(),
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'Carbon Voice Claude Channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {}, // opt in to permission relay
      },
      tools: {},
    },
    instructions: `
You are receiving real-time messages from Carbon Voice conversations.

Each message arrives as a <channel> tag with these attributes:
  source="carbon-voice"
  channel_id       — the conversation to reply into
  message_id       — the message that was sent
  sender_id        — the user who sent it
  is_reply         — "true" if this was a reply to another message
  reply_to_id      — the message ID to thread your reply under
                     (use this, not message_id, when calling send_message)

The tag body is the transcript of what was said.

To reply, call the send_message tool with:
  channel_id       — from the <channel> tag
  reply_to_message_id — from reply_to_id in the <channel> tag
  text             — your response (Carbon Voice converts it to audio automatically)

Never reply to a reply — always use reply_to_id which already handles threading.

Permission prompts may arrive asking you to approve tool usage. Reply with
"yes <request_id>" or "no <request_id>" to grant or deny permission.
    `.trim(),
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// TOOL: send_message
// ─────────────────────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description:
        'Send a text reply into a Carbon Voice conversation. Carbon Voice ' +
        'automatically converts the text to audio and delivers it to all ' +
        'participants. Use channel_id and reply_to_message_id from the ' +
        '<channel> tag.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The conversation to send into (channel_id from the <channel> tag)',
          },
          reply_to_message_id: {
            type: 'string',
            description:
              'Thread the reply under this message ID (reply_to_id from the <channel> tag). ' +
              'CV does not support replying to replies — this value already handles threading.',
          },
          text: {
            type: 'string',
            description: "The text content of Claude's reply. CV converts it to audio.",
          },
        },
        required: ['channel_id', 'reply_to_message_id', 'text'],
      },
    },
    {
      name: 'allow_sender',
      description:
        'Add a Carbon Voice user ID to the persistent allowlist so their messages ' +
        'are forwarded to Claude. Use this when notified of an unknown sender attempting ' +
        'to connect. The change takes effect immediately and survives server restarts.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'The Carbon Voice user ID to add to the allowlist',
          },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'list_senders',
      description:
        'List all Carbon Voice user IDs on the allowlist and blocklist.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'remove_sender',
      description:
        'Remove a Carbon Voice user ID from the allowlist without blocking them. ' +
        'They will be treated as an unknown sender again — Claude will be notified ' +
        'if they message, and can re-allow them at that time.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'The Carbon Voice user ID to remove from the allowlist',
          },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'block_sender',
      description:
        'Permanently silence a Carbon Voice user ID. Blocked senders are dropped ' +
        'with no notification to Claude, even across server restarts. Use this to stop ' +
        'repeated unknown-sender alerts from someone who should never have access.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'The Carbon Voice user ID to block',
          },
        },
        required: ['user_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'send_message') {
    const { channel_id, reply_to_message_id, text } =
      req.params.arguments as {
        channel_id: string
        reply_to_message_id: string
        text: string
      }

    const unique_client_id = crypto.randomUUID()

    const res = await cvFetch('POST', '/v3/messages/start', {
      transcript: text,
      is_text_message: true,
      unique_client_id,
      is_streaming: false,
      channel_id,
      reply_to_message_id,
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`CV send_message failed ${res.status}: ${body}`)
    }

    const data = await res.json() as { message_id?: string; id?: string }
    const sent_id = data.message_id ?? data.id ?? '?'

    return {
      content: [{ type: 'text', text: `sent: ${sent_id}` }],
    }
  }

  if (req.params.name === 'allow_sender') {
    const { user_id } = req.params.arguments as { user_id: string }

    state.access.blockedFrom = state.access.blockedFrom.filter(id => id !== user_id)
    if (!state.access.allowFrom.includes(user_id)) {
      state.access.allowFrom.push(user_id)
    }
    await saveAccess()
    state.unknownSenderSeen.delete(user_id)
    process.stderr.write(`cv-claude-channels: added ${user_id} to allowlist\n`)

    const ctx = state.pendingAllowContext.get(user_id)
    state.pendingAllowContext.delete(user_id)
    if (ctx) {
      cvFetch('POST', '/v3/messages/start', {
        transcript: `You are now allowed to message Claude project \`${PROJECT_NAME}\` through this channel.`,
        is_text_message: true,
        unique_client_id: crypto.randomUUID(),
        is_streaming: false,
        channel_id: ctx.channelId,
        reply_to_message_id: ctx.messageId,
      }).catch(() => {})
    }

    return {
      content: [{ type: 'text', text: `${user_id} added to allowlist. Their messages will now be forwarded to Claude.` }],
    }
  }

  if (req.params.name === 'list_senders') {
    const allowed  = state.access.allowFrom.length  ? state.access.allowFrom.join(', ')  : '(none)'
    const blocked  = state.access.blockedFrom.length ? state.access.blockedFrom.join(', ') : '(none)'
    return {
      content: [{ type: 'text', text: `Allowed: ${allowed}\nBlocked: ${blocked}` }],
    }
  }

  if (req.params.name === 'remove_sender') {
    const { user_id } = req.params.arguments as { user_id: string }

    state.access.allowFrom = state.access.allowFrom.filter(id => id !== user_id)
    await saveAccess()
    state.unknownSenderSeen.delete(user_id)
    process.stderr.write(`cv-claude-channels: removed ${user_id} from allowlist\n`)

    return {
      content: [{ type: 'text', text: `${user_id} removed from allowlist. They will be treated as an unknown sender if they message again.` }],
    }
  }

  if (req.params.name === 'block_sender') {
    const { user_id } = req.params.arguments as { user_id: string }

    state.access.allowFrom = state.access.allowFrom.filter(id => id !== user_id)
    if (!state.access.blockedFrom.includes(user_id)) {
      state.access.blockedFrom.push(user_id)
    }
    await saveAccess()
    state.unknownSenderSeen.add(user_id)  // suppress in-session notification too
    process.stderr.write(`cv-claude-channels: blocked ${user_id}\n`)

    return {
      content: [{ type: 'text', text: `${user_id} blocked. Their messages will be silently dropped.` }],
    }
  }

  throw new Error(`Unknown tool: ${req.params.name}`)
})

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSION RELAY: forward Claude Code permission prompts to CV
// ─────────────────────────────────────────────────────────────────────────────

// Regex to match "yes <id>" or "no <id>" replies
// [a-km-z] is the ID alphabet Claude Code uses (lowercase, skips 'l')
// /i tolerates phone autocorrect; lowercase the capture before sending
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// Schema for permission request notifications from Claude Code
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(), // five lowercase letters
    tool_name: z.string(), // e.g. "Bash", "Write"
    description: z.string(), // human-readable summary
    input_preview: z.string(), // tool args as JSON, truncated
  }),
})

// Handler for permission requests from Claude Code
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // Don't relay permission requests for this server's own tools — approving
  // them via send_message creates an unresolvable loop.
  if (['send_message', 'list_senders', 'allow_sender', 'remove_sender', 'block_sender'].some(t => params.tool_name === t || params.tool_name.endsWith(`__${t}`))) return

  const ctx = state.lastCVContext
  if (!ctx) {
    process.stderr.write(`cv-claude-channels: permission request for ${params.tool_name} but no CV context to relay to\n`)
    return
  }

  const text =
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `Reply "yes ${params.request_id}" or "no ${params.request_id}" to grant or deny permission.`

  const unique_client_id = crypto.randomUUID()
  const res = await cvFetch('POST', '/v3/messages/start', {
    transcript: text,
    is_text_message: true,
    unique_client_id,
    is_streaming: false,
    channel_id: ctx.channelId,
    reply_to_message_id: ctx.replyToId,
  })

  if (!res.ok) {
    process.stderr.write(`cv-claude-channels: permission relay send failed ${res.status} for ${params.request_id}\n`)
  } else {
    process.stderr.write(`cv-claude-channels: permission request for ${params.tool_name} relayed to CV (request_id=${params.request_id})\n`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// CV API HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function cvFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${CV_API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PAT}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}


async function loadAccess() {
  try {
    const raw = await fs.readFile(ACCESS_PATH, 'utf8')
    const saved = JSON.parse(raw) as Partial<Access>
    state.access.allowFrom = Array.isArray(saved.allowFrom) ? saved.allowFrom : []
    state.access.blockedFrom = Array.isArray(saved.blockedFrom) ? saved.blockedFrom : []
    process.stderr.write(`cv-claude-channels: allowlist loaded (${state.access.allowFrom.length} allowed, ${state.access.blockedFrom.length} blocked)\n`)
  } catch {
    // first run — no access file yet; empty allowlist means deny all
    process.stderr.write('cv-claude-channels: no access file found — all senders denied until added\n')
  }
}

async function saveAccess() {
  try {
    await fs.mkdir(path.dirname(ACCESS_PATH), { recursive: true })
    await fs.writeFile(ACCESS_PATH, JSON.stringify(state.access, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (e) {
    process.stderr.write(`cv-claude-channels: failed to save access file: ${e}\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REACTIONS
// ─────────────────────────────────────────────────────────────────────────────

interface Reaction { id: string; name: string; code: string; reaction_tts: string; image_url: string }

async function loadReaction() {
  const res = await cvFetch('GET', '/reactions')
  if (!res.ok) {
    process.stderr.write(`cv-claude-channels: GET /reactions failed ${res.status}\n`)
    return
  }

  const reactions = await res.json() as Reaction[]
  if (!Array.isArray(reactions) || reactions.length === 0) {
    process.stderr.write('cv-claude-channels: no reactions available\n')
    return
  }

  // Always log available reactions so the user can pin one via CV_REACTION_ID
  process.stderr.write('cv-claude-channels: available reactions:\n')
  for (const r of reactions) {
    process.stderr.write(`  id=${r.id}  name="${r.name}"  code="${r.code}"\n`)
  }

  process.stderr.write(`cv-claude-channels: using reaction id=${state.reactionId}\n`)
}

async function addReaction(messageId: string) {
  if (!state.reactionId) return
  const res = await cvFetch('POST', `/reactions/${state.reactionId}/${messageId}`)
  if (!res.ok) {
    process.stderr.write(`cv-claude-channels: addReaction failed ${res.status} for ${messageId}\n`)
  }
}

async function markRead(channelId: string, messageId: string) {
  const res = await cvFetch(
    'DELETE',
    `/notifications/${channelId}/${messageId}?type=message&notification_removal_mode=hard`,
  )
  if (!res.ok) {
    process.stderr.write(`cv-claude-channels: markRead failed ${res.status} for ${messageId}\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP: identity + state restore
// ─────────────────────────────────────────────────────────────────────────────

async function startup() {
  // 1. Resolve own user ID (needed to filter self-messages)
  if (!state.ownUserId) {
    const res = await cvFetch('GET', '/whoami')
    if (!res.ok) throw new Error(`/whoami failed: ${res.status}`)
    const data = await res.json() as { user: { user_guid: string } }
    state.ownUserId = data.user.user_guid
    process.stderr.write(`cv-claude-channels: authenticated as ${state.ownUserId}\n`)
  }

  // 2. Load allowlist from disk
  await loadAccess()

  // 3. Resolve reaction ID
  await loadReaction()

  // 4. Restore cursor from disk
  await loadState()

  // 5. Connect
  await connectWithResilience()
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8')
    const saved = JSON.parse(raw) as { lastSeenAt?: string }
    if (saved.lastSeenAt) {
      state.lastSeenAt = saved.lastSeenAt
      process.stderr.write(`cv-claude-channels: resuming from ${state.lastSeenAt}\n`)
    }
  } catch {
    // first run — no state file yet
  }
}

async function flushState() {
  if (!state.lastSeenAtDirty || state.lastSeenAt === null) return
  try {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true })
    await fs.writeFile(
      STATE_PATH,
      JSON.stringify({ lastSeenAt: state.lastSeenAt }, null, 2),
      'utf8',
    )
    state.lastSeenAtDirty = false
  } catch (e) {
    process.stderr.write(`cv-claude-channels: failed to flush state: ${e}\n`)
  }
}

// Debounced flush — writes at most every 5 s during active streaming
function scheduleFlush() {
  if (state.flushTimer) return
  state.flushTimer = setTimeout(async () => {
    state.flushTimer = null
    await flushState()
  }, 5_000)
}

function advanceCursor(isoTimestamp: string) {
  state.lastSeenAt = isoTimestamp
  state.lastSeenAtDirty = true
  scheduleFlush()
}

// ─────────────────────────────────────────────────────────────────────────────
// DEDUPLICATION
// ─────────────────────────────────────────────────────────────────────────────


function isRecentlySeen(messageId: string): boolean {
  const expiry = state.recentlySeen.get(messageId)
  if (expiry === undefined) return false
  if (Date.now() > expiry) {
    state.recentlySeen.delete(messageId)
    return false
  }
  return true
}

function markSeen(messageId: string) {
  state.recentlySeen.set(messageId, Date.now() + SEEN_TTL_MS)
  // Prune expired entries periodically (every 100 insertions)
  if (state.recentlySeen.size % 100 === 0) {
    const now = Date.now()
    for (const [id, expiry] of state.recentlySeen) {
      if (now > expiry) state.recentlySeen.delete(id)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: process a message (shared by WS and polling paths)
// ─────────────────────────────────────────────────────────────────────────────

// Returns: true = delivered to Claude, false = filtered (skip, safe to advance cursor),
//          null = needs retry (do not advance cursor past this message)
async function processMessage(event: CVMessageEvent): Promise<boolean | null> {
  const channel_id = event.channel_ids[0] ?? ''

  // Filter self
  if (event.creator_id === state.ownUserId) return false

  // Blocked senders are dropped silently with no notification
  if (state.access.blockedFrom.includes(event.creator_id)) return false

  // Sender gating: deny all senders not in the allowlist
  if (!state.access.allowFrom.includes(event.creator_id)) {
    process.stderr.write(`cv-claude-channels: dropped message from unknown sender ${event.creator_id}\n`)
    // Notify Claude Code once per sender per session so the user can decide to allow them
    if (!state.unknownSenderSeen.has(event.creator_id)) {
      state.unknownSenderSeen.add(event.creator_id)
      state.pendingAllowContext.set(event.creator_id, { channelId: channel_id, messageId: event.message_id })
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content:
            `Unknown sender (userId: ${event.creator_id}) attempting to message through Carbon Voice.\n\n` +
            `To add them to the allowlist, call the allow_sender tool with this user ID.`,
          meta: {
            source: 'carbon-voice',
            event: 'unknown_sender',
            sender_id: event.creator_id,
          },
        },
      }).catch(() => {})

      if (state.access.allowFrom.length === 0) {
        cvFetch('POST', '/v3/messages/start', {
          transcript: 'Allow Sender list is currently empty. Go to Claude to approve senders.',
          is_text_message: true,
          unique_client_id: crypto.randomUUID(),
          is_streaming: false,
          channel_id: event.channel_ids[0],
          reply_to_message_id: event.message_id,
        }).catch(() => {})
      }
    }
    return false
  }

  // Deduplicate — only after confirming the message is ready
  if (isRecentlySeen(event.message_id)) return false

  // Transcript lives in timecodes[].t joined; value field is always empty
  const tm = event.text_models.find(
    m => m.type === 'transcript_with_timecode' || m.type === 'transcript',
  )
  const transcript = tm?.timecodes?.map(tc => tc.t).join(' ') || tm?.value || ''

  // Log what we see so field-name issues are visible in stderr
  process.stderr.write(
    `cv-claude-channels: message ${event.message_id} status=${event.status} transcript="${transcript.slice(0, 80)}"\n`,
  )

  // Not ready yet — let the next poll retry without marking seen
  if (!transcript) return null

  const reply_to_id = event.parent_message_id ?? event.message_id

  // Check for permission reply format (yes <id> or no <id>)
  const permMatch = PERMISSION_REPLY_RE.exec(transcript)
  if (permMatch) {
    const verdict = permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
    const requestId = permMatch[2].toLowerCase()
    process.stderr.write(`cv-claude-channels: permission verdict ${verdict} for request ${requestId}\n`)

    try {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: requestId,
          behavior: verdict,
        },
      })
    } catch (err) {
      process.stderr.write(`cv-claude-channels: permission notification failed for ${event.message_id}, will retry: ${err}\n`)
      return null
    }

    markSeen(event.message_id)
    await addReaction(event.message_id)
    await markRead(channel_id, event.message_id)
    return true // handled as verdict, don't also forward as chat
  }

  // Emit to Claude Code — only mark seen/acknowledged if it succeeds
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: transcript,
        meta: {
          source:        'carbon-voice',
          channel_id,
          message_id:    event.message_id,
          sender_id:     event.creator_id,
          is_reply:      event.parent_message_id ? 'true' : 'false',
          reply_to_id,
        },
      },
    })
    state.lastCVContext = { channelId: channel_id, replyToId: reply_to_id }
  } catch (err) {
    process.stderr.write(`cv-claude-channels: notification failed for ${event.message_id}, will retry: ${err}\n`)
    return null
  }

  markSeen(event.message_id)
  await addReaction(event.message_id)
  await markRead(channel_id, event.message_id)
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSED-MESSAGE CATCH-UP
// ─────────────────────────────────────────────────────────────────────────────

async function fetchMissedMessages() {
  const requestStartedAt = new Date().toISOString()

  if (!state.lastSeenAt) {
    // First run — skip history, start cursor from now
    process.stderr.write(`cv-claude-channels: first run, starting from ${requestStartedAt}\n`)
    advanceCursor(requestStartedAt)
    return
  }

  const recentBody = {
    date: state.lastSeenAt,
    direction: 'newer',
    limit: 100,
    use_last_updated: false,
    ...(CONVERSATION_ID ? { channel_id: CONVERSATION_ID } : {}),
  }
  process.stderr.write(`cv-claude-channels: POST /v3/messages/recent ${JSON.stringify(recentBody)}\n`)

  const res = await cvFetch('POST', '/v3/messages/recent', recentBody)

  if (!res.ok) {
    process.stderr.write(`cv-claude-channels: fetchMissedMessages ${res.status}\n`)
    return  // don't advance cursor — retry same window next poll
  }

  const data = await res.json() as CVMessageEvent[]
  const allMessages: CVMessageEvent[] = Array.isArray(data) ? data : []

  // Client-side guard: CV's recent endpoint may ignore channel_id filter
  let messages = allMessages
  if (CONVERSATION_ID) {
    messages = allMessages.filter(m => m.channel_ids.includes(CONVERSATION_ID))
    const dropped = allMessages.length - messages.length
    if (allMessages.length > 0) {
      process.stderr.write(
        `cv-claude-channels: /recents returned ${allMessages.length} msgs, ` +
        `${dropped} filtered (channels: ${[...new Set(allMessages.map(m => m.channel_ids[0]))].join(', ')})\n`,
      )
    }
  }

  messages.sort((a, b) => a.created_at.localeCompare(b.created_at))

  let processed = 0
  let firstRetryIdx: number | null = null

  for (let i = 0; i < messages.length; i++) {
    const result = await processMessage(messages[i])
    if (result === true) processed++
    else if (result === null && firstRetryIdx === null) firstRetryIdx = i
  }

  if (messages.length > 0) {
    process.stderr.write(
      `cv-claude-channels: emitted ${processed} new` +
      (firstRetryIdx !== null ? ', cursor held for retry' : '') +
      '\n',
    )
  }

  // Advance cursor to requestStartedAt only if every message was delivered or
  // filtered. If any message needs retry, leave the cursor unchanged so the
  // next poll re-fetches from the same window. Already-delivered messages are
  // protected from double-delivery by the markSeen dedup cache.
  if (firstRetryIdx === null) {
    advanceCursor(requestStartedAt)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET (primary mode)
// ─────────────────────────────────────────────────────────────────────────────

async function connectWebSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write(`cv-claude-channels: connecting Socket.IO to ${CV_API_BASE}\n`)

    const socket = io(CV_API_BASE, {
      auth: { authorization: `Bearer ${PAT}` },
      transports: ['websocket'],
      reconnection: false,  // we manage reconnection ourselves
    })

    state.wsSocket = socket

    socket.on('connected', (user: { user_guid?: string; id?: string }) => {
      process.stderr.write('cv-claude-channels: Socket.IO connected\n')
      state.mode = 'websocket'
      state.wsRetryBackoff = 1_000

      // Capture own user ID from the connected event if not already known
      const uid = user?.user_guid ?? user?.id
      if (uid && !state.ownUserId) state.ownUserId = uid

      stopPolling()

      // Subscribe to the specific conversation if configured
      if (CONVERSATION_ID) {
        socket.emit('subscribe:channel', CONVERSATION_ID, (ack: string) => {
          process.stderr.write(`cv-claude-channels: subscribed to channel: ${ack}\n`)
        })
      }

      resolve()
    })

    // message:created fires immediately (transcript not yet ready)
    // message:updated fires when transcription completes — trigger a fetch for both
    const onMessageEvent = async (payload: {
      _id?: string
      status?: string
      channel_id?: string
      channel_ids?: string[]
    }) => {
      const payloadChannel = payload?.channel_id ?? payload?.channel_ids?.[0] ?? 'unknown'
      process.stderr.write(`cv-claude-channels: WS event (status=${payload?.status} channel=${payloadChannel}) raw=${JSON.stringify(payload)}\n`)
      if (payload?.status !== 'active') return

      // Skip fetch if the event is for a different conversation
      if (CONVERSATION_ID && payloadChannel !== 'unknown' && payloadChannel !== CONVERSATION_ID) {
        process.stderr.write(`cv-claude-channels: WS event skipped (wrong channel)\n`)
        return
      }

      await fetchMissedMessages()
    }

    socket.on('message:created', onMessageEvent)
    socket.on('message:updated', onMessageEvent)

    socket.on('connect_error', (err: Error) => {
      process.stderr.write(`cv-claude-channels: Socket.IO connect error: ${err.message}\n`)
      state.wsSocket = null
      reject(err)
    })

    socket.on('disconnect', async (reason: string) => {
      if (state.mode === 'shutdown') return
      process.stderr.write(`cv-claude-channels: Socket.IO disconnected (${reason}) — falling back to polling\n`)
      state.wsSocket = null
      state.mode = 'polling'
      await fetchMissedMessages()
      startPolling()
      scheduleWsReconnect()
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET RECONNECT (runs in background while polling)
// ─────────────────────────────────────────────────────────────────────────────

function scheduleWsReconnect() {
  if (state.wsRetryTimer || state.mode === 'shutdown') return

  state.wsRetryTimer = setTimeout(async () => {
    state.wsRetryTimer = null
    if (state.mode === 'shutdown') return

    process.stderr.write(
      `cv-claude-channels: attempting WS reconnect (backoff ${state.wsRetryBackoff}ms)\n`,
    )

    try {
      // Catch up before switching back to WS
      await fetchMissedMessages()
      await connectWebSocket()
      // connectWebSocket resolves on 'open', which already calls stopPolling()
    } catch {
      // Backoff and try again
      state.wsRetryBackoff = Math.min(state.wsRetryBackoff * 2, WS_RETRY_MAX_MS)
      scheduleWsReconnect()
    }
  }, state.wsRetryBackoff)
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLING (fallback mode)
// ─────────────────────────────────────────────────────────────────────────────

function startPolling() {
  if (state.pollTimer) return
  process.stderr.write(`cv-claude-channels: polling every ${POLL_INTERVAL_MS}ms\n`)

  const tick = async () => {
    if (state.mode === 'shutdown' || state.mode === 'websocket') return
    await fetchMissedMessages()
    state.pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
  }

  state.pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer)
    state.pollTimer = null
    process.stderr.write('cv-claude-channels: polling stopped (WS reconnected)\n')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECT WITH RESILIENCE (initial startup)
// ─────────────────────────────────────────────────────────────────────────────

async function connectWithResilience() {
  // Always catch up on any missed messages before first connect
  await fetchMissedMessages()

  try {
    await connectWebSocket()
    // connectWebSocket resolves on 'open'; polling is stopped inside the open handler
  } catch (err) {
    process.stderr.write(`cv-claude-channels: WS initial connect failed (${err}) — falling back to polling\n`)
    state.mode = 'polling'
    startPolling()
    scheduleWsReconnect()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  process.stderr.write(`cv-claude-channels: ${signal} received, shutting down\n`)
  state.mode = 'shutdown'

  if (state.wsSocket)    state.wsSocket.disconnect()
  if (state.wsRetryTimer) clearTimeout(state.wsRetryTimer)
  if (state.pollTimer)   clearTimeout(state.pollTimer)
  if (state.flushTimer)  clearTimeout(state.flushTimer)

  // Flush cursor immediately
  state.lastSeenAtDirty = true
  await flushState()

  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
await startup()
