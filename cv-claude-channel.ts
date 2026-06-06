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
 *         "CV_CONVERSATION_ID": "",      // optional: scope to one conversation guid; omit to receive all
 *         "CV_ATTACHMENTS_DIR": ""       // optional: folder for downloaded attachments; defaults to ~/.claude/channels/cv/attachments
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
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  init as initApi,
  whoami, getReactions, addReaction, markRead,
  sendMessage, getRecentMessages, getShareLink, attachmentFromString,
  downloadAttachmentsToDir,
  createConnection,
  type CVConnection,
  type CVMessageEvent,
  type CVAttachment,
} from './cv-api.js'

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const PAT                  = process.env.CV_PAT ?? ''
const CONVERSATION_ID      = process.env.CV_CONVERSATION_ID ?? ''   // optional: scope to one conversation
const REACTION_ID          = process.env.CV_REACTION_ID ?? ''       // optional: pin a specific reaction ID
const POLL_INTERVAL_MS          = Number(process.env.CV_POLL_INTERVAL_MS           ?? 5_000)
const WS_RETRY_MAX_MS           = Number(process.env.CV_WS_RETRY_MAX_MS            ?? 30_000)
const ATTACHMENT_TIMEOUT_MS     = Number(process.env.CV_ATTACHMENT_TIMEOUT_MS      ?? 600_000)
const ATTACHMENT_NUDGE_MS       = Number(process.env.CV_ATTACHMENT_NUDGE_MS        ?? 120_000)
const PERMISSION_ALLOW_REACTION        = process.env.CV_PERMISSION_ALLOW_REACTION        ?? 'acknowledged'
const PERMISSION_ALLOW_ALWAYS_REACTION = process.env.CV_PERMISSION_ALLOW_ALWAYS_REACTION ?? 'affirmative'
const PERMISSION_DENY_REACTION         = process.env.CV_PERMISSION_DENY_REACTION         ?? 'negative'
const STATE_PATH           = process.env.CV_STATE_PATH
  ?? path.join(os.homedir(), '.claude', 'channels', 'cv', `state${CONVERSATION_ID ? `-${CONVERSATION_ID}` : ''}.json`)
const ACCESS_PATH          = process.env.CV_ACCESS_PATH
  ?? path.join(os.homedir(), '.claude', 'channels', 'cv', 'access.json')
const ATTACHMENTS_DIR      = process.env.CV_ATTACHMENTS_DIR
  ?? path.join(os.homedir(), '.claude', 'channels', 'cv', 'attachments')
const PROJECT_NAME         = process.env.CV_PROJECT_NAME ?? 'this project'
const LOG_FILE             = process.env.CV_LOG_FILE ?? ''

const timestamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '')
const log = LOG_FILE
  ? (msg: string) => {
      const stamped = msg.replace(/^(cv-claude-channels: )/, `$1[${timestamp()}] `)
      fs.appendFile(LOG_FILE, stamped).catch(() => {})
      process.stderr.write(stamped)
    }
  : (msg: string) => process.stderr.write(msg.replace(/^(cv-claude-channels: )/, `$1[${timestamp()}] `))

if (!PAT) {
  log('cv-claude-channels: CV_PAT is required\n')
  process.exit(1)
}

initApi({ pat: PAT, log })

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface Access {
  allowFrom: string[]    // approved sender IDs; empty = deny all
  blockedFrom: string[]  // permanently silenced sender IDs; no notification ever
}

interface State {
  lastCheckedAt: string | null             // null = never fetched; set to now on first poll
  ownUserId: string                     // used to filter self-messages
  reactionId: string | null             // reaction to add on receipt; null until resolved
  fetchInFlight: boolean                 // coalescing guard: fetch currently running
  fetchQueued: boolean                   // coalescing guard: another fetch waiting
  lastCheckedAtDirty: boolean              // pending disk write
  flushTimer: ReturnType<typeof setTimeout> | null
  lastCVContext: { channelId: string; replyToId: string } | null  // for permission relay
  access: Access                        // file-backed allowlist
  unknownSenderSeen: Set<string>        // senders already notified this session (avoid spam)
  pendingAllowContext: Map<string, { channelId: string; messageId: string }>  // context for allow confirmation
  pendingAttachments: Map<string, { channelId: string; replyToId: string; senderId: string; deadline: number; nudgeAt: number; nudgeSent: boolean; filenames: string[] }>
  attachmentFollowUpSent: Set<string>  // message IDs for which attachment follow-up has been sent
  pendingPermissionMessages: Map<string, { requestId: string; channelId: string; toolName: string }>  // cvMessageId → permission request
  allowAlwaysTools: Set<string>           // tools auto-approved for this session
  permissionReactionIds: { allow: string | null; allowAlways: string | null; deny: string | null }
  cvStarted: boolean                    // true once startup() has been called
}


// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

const state: State = {
  lastCheckedAt: null,
  ownUserId: process.env.CV_OWN_USER_ID ?? '',
  reactionId: REACTION_ID || 'acknowledged',
  fetchInFlight: false,
  fetchQueued: false,
  lastCheckedAtDirty: false,
  flushTimer: null,
  lastCVContext: null,
  access: { allowFrom: [], blockedFrom: [] },
  unknownSenderSeen: new Set(),
  pendingAllowContext: new Map(),
  pendingAttachments: new Map(),
  attachmentFollowUpSent: new Set(),
  pendingPermissionMessages: new Map(),
  allowAlwaysTools: new Set(),
  permissionReactionIds: { allow: null, allowAlways: null, deny: null },
  cvStarted: false,
}

let connection: CVConnection | null = null

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

The tag body is the transcript of what was said. If the message includes
attachments, they appear after the transcript in the body, formatted as:

  Attachments:
  - filename (mime_type): /absolute/local/path

Attachment files have been downloaded to a local directory. Use the Read tool
to access them (e.g. to view an image, parse a document, or read a file).

If the message is a forward, the body begins with:
  [Forwarded message from <original_sender_id>]
  <original transcript>

  [Forwarded by <forwarder_id>]
  <forwarder's comment, if any>

To reply, call the send_message tool with:
  channel_id       — from the <channel> tag
  reply_to_message_id — from reply_to_id in the <channel> tag
  text             — your response (Carbon Voice converts it to audio automatically)

Never reply to a reply — always use reply_to_id which already handles threading.

Permission prompts may arrive asking you to approve tool usage. Reply with
"yes <request_id>" or "no <request_id>" to grant or deny permission.

IMPORTANT — Startup check: when a <channel> tag has event="startup_check" in its
attributes, you MUST immediately call the confirm_channels tool (no arguments needed).
Do not send any text response. Do not call send_message. Only call confirm_channels.
This is required to activate the Carbon Voice connection.
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
        '<channel> tag. Optionally include attachments (links or files).',
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
          attachments: {
            type: 'array',
            description:
              'Optional list of attachments. Each item is either a URL (https://...) ' +
              'or an absolute local file path. URLs are attached as links; local files are uploaded automatically.',
            items: {
              type: 'string',
            },
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
    {
      name: 'confirm_channels',
      description:
        'Activates the Carbon Voice connection. Call this at startup when prompted, ' +
        'or manually to connect at any time.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'send_message') {
    const { channel_id, reply_to_message_id, text, attachments } =
      req.params.arguments as {
        channel_id: string
        reply_to_message_id: string
        text: string
        attachments?: string[]
      }

    const sent_id = await sendMessage({
      conversationId: channel_id,
      threadId: reply_to_message_id,
      transcript: text,
      attachments: attachments?.map(attachmentFromString),
    })

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
    log(`cv-claude-channels: added ${user_id} to allowlist\n`)

    const ctx = state.pendingAllowContext.get(user_id)
    state.pendingAllowContext.delete(user_id)
    if (ctx) {
      sendMessage({
        conversationId: ctx.channelId,
        threadId: ctx.messageId,
        transcript: `You are now allowed to message Claude project \`${PROJECT_NAME}\` through this channel.`,
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
    log(`cv-claude-channels: removed ${user_id} from allowlist\n`)

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
    log(`cv-claude-channels: blocked ${user_id}\n`)

    return {
      content: [{ type: 'text', text: `${user_id} blocked. Their messages will be silently dropped.` }],
    }
  }

  if (req.params.name === 'confirm_channels') {
    if (state.cvStarted) {
      return { content: [{ type: 'text', text: 'Carbon Voice already connected.' }] }
    }
    state.cvStarted = true
    log('cv-claude-channels: confirm_channels called — connecting to Carbon Voice\n')
    startup().catch(err => log(`cv-claude-channels: startup error: ${err}\n`))
    return { content: [{ type: 'text', text: 'Channels confirmed and active.' }] }
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
  if (['send_message', 'list_senders', 'allow_sender', 'remove_sender', 'block_sender', 'confirm_channels'].some(t => params.tool_name === t || params.tool_name.endsWith(`__${t}`))) return

  // Auto-approve tools the user has already said "always allow" to this session
  if (state.allowAlwaysTools.has(params.tool_name)) {
    log(`cv-claude-channels: auto-approving ${params.tool_name} (allow_always in session)\n`)
    try {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: params.request_id, behavior: 'allow' },
      })
      log(`cv-claude-channels: auto-approve confirmed to Claude for ${params.tool_name} (request_id=${params.request_id})\n`)
    } catch (err) {
      log(`cv-claude-channels: auto-approve notification failed for ${params.request_id}: ${err}\n`)
    }
    return
  }

  const ctx = state.lastCVContext
  if (!ctx) {
    log(`cv-claude-channels: permission request for ${params.tool_name} but no CV context to relay to\n`)
    return
  }

  const text =
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `✅ = allow once. 💯 = always allow. 👎 = deny. ` +
    `Or reply "yes ${params.request_id}" or "no ${params.request_id}".`

  try {
    const cvMessageId = await sendMessage({
      conversationId: ctx.channelId,
      threadId: ctx.replyToId,
      transcript: text,
    })
    state.pendingPermissionMessages.set(cvMessageId, {
      requestId: params.request_id,
      channelId: ctx.channelId,
      toolName: params.tool_name,
    })
    log(`cv-claude-channels: permission request for ${params.tool_name} relayed to CV (request_id=${params.request_id} cvMessageId=${cvMessageId})\n`)
  } catch (err) {
    log(`cv-claude-channels: permission relay send failed for ${params.request_id}: ${err}\n`)
  }
})


async function loadAccess() {
  try {
    const raw = await fs.readFile(ACCESS_PATH, 'utf8')
    const saved = JSON.parse(raw) as Partial<Access>
    state.access.allowFrom = Array.isArray(saved.allowFrom) ? saved.allowFrom : []
    state.access.blockedFrom = Array.isArray(saved.blockedFrom) ? saved.blockedFrom : []
    log(`cv-claude-channels: allowlist loaded (${state.access.allowFrom.length} allowed, ${state.access.blockedFrom.length} blocked)\n`)
  } catch {
    // first run — no access file yet; empty allowlist means deny all
    log('cv-claude-channels: no access file found — all senders denied until added\n')
  }
}

async function saveAccess() {
  try {
    await fs.mkdir(path.dirname(ACCESS_PATH), { recursive: true })
    await fs.writeFile(ACCESS_PATH, JSON.stringify(state.access, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (e) {
    log(`cv-claude-channels: failed to save access file: ${e}\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REACTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function loadReaction() {
  const reactions = await getReactions()
  if (reactions.length === 0) {
    log('cv-claude-channels: no reactions available\n')
    return
  }

  log('cv-claude-channels: available reactions:\n')
  for (const r of reactions) {
    log(`  id=${r.id}  name="${r.name}"  code="${r.code}"\n`)
  }

  // Resolve code/name → actual UUID if the configured value isn't already a known ID.
  // top_user_reactions stores the UUID, so the check in isProcessed must compare UUIDs.
  if (state.reactionId) {
    const byId = reactions.find(r => r.id === state.reactionId)
    if (!byId) {
      const byCode = reactions.find(
        r => r.code === state.reactionId || r.name.toLowerCase() === state.reactionId!.toLowerCase(),
      )
      if (byCode) {
        log(`cv-claude-channels: resolved reaction "${state.reactionId}" → id="${byCode.id}"\n`)
        state.reactionId = byCode.id
      } else {
        log(`cv-claude-channels: WARNING: reaction "${state.reactionId}" not found — isProcessed checks will always miss\n`)
      }
    }
  }

  log(`cv-claude-channels: using reaction id=${state.reactionId}\n`)

  // Resolve the three permission-approval reaction IDs
  const resolvePermReaction = (nameOrId: string): string | null => {
    const byId = reactions.find(r => r.id === nameOrId)
    if (byId) return byId.id
    const byCode = reactions.find(
      r => r.code === nameOrId || r.name.toLowerCase() === nameOrId.toLowerCase(),
    )
    if (byCode) {
      log(`cv-claude-channels: resolved permission reaction "${nameOrId}" → id="${byCode.id}"\n`)
      return byCode.id
    }
    log(`cv-claude-channels: WARNING: permission reaction "${nameOrId}" not found\n`)
    return null
  }

  state.permissionReactionIds = {
    allow:      resolvePermReaction(PERMISSION_ALLOW_REACTION),
    allowAlways: resolvePermReaction(PERMISSION_ALLOW_ALWAYS_REACTION),
    deny:       resolvePermReaction(PERMISSION_DENY_REACTION),
  }
  log(`cv-claude-channels: permission reactions: allow=${state.permissionReactionIds.allow} allowAlways=${state.permissionReactionIds.allowAlways} deny=${state.permissionReactionIds.deny}\n`)
}

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP: identity + state restore
// ─────────────────────────────────────────────────────────────────────────────

async function startup() {
  // 1. Resolve own user ID (needed to filter self-messages)
  if (!state.ownUserId) {
    state.ownUserId = await whoami()
    log(`cv-claude-channels: authenticated as ${state.ownUserId}\n`)
  }

  // 2. Load allowlist from disk
  await loadAccess()

  // 3. Resolve reaction ID
  await loadReaction()

  // 4. Restore cursor from disk
  await loadState()

  // 5. Connect
  connection = createConnection(
    { conversationId: CONVERSATION_ID, pollIntervalMs: POLL_INTERVAL_MS, wsRetryMaxMs: WS_RETRY_MAX_MS },
    {
      onMessageActivity: fetchMissedMessages,
      onOwnUserId: (uid) => { if (!state.ownUserId) state.ownUserId = uid },
    },
  )
  await connection.connect()
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8')
    const saved = JSON.parse(raw) as { lastCheckedAt?: string; lastSeenAt?: string }
    const cursor = saved.lastCheckedAt ?? saved.lastSeenAt
    if (cursor) {
      state.lastCheckedAt = cursor
      log(`cv-claude-channels: resuming from ${state.lastCheckedAt}\n`)
    }
  } catch {
    // first run — no state file yet
  }
}

async function flushState() {
  if (!state.lastCheckedAtDirty || state.lastCheckedAt === null) return
  try {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true })
    await fs.writeFile(
      STATE_PATH,
      JSON.stringify({ lastCheckedAt: state.lastCheckedAt }, null, 2),
      'utf8',
    )
    state.lastCheckedAtDirty = false
  } catch (e) {
    log(`cv-claude-channels: failed to flush state: ${e}\n`)
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

function updateCursor(isoTimestamp: string) {
  log(`cv-claude-channels: updateCursor ${state.lastCheckedAt} → ${isoTimestamp}\n`)
  state.lastCheckedAt = isoTimestamp
  state.lastCheckedAtDirty = true
  scheduleFlush()
}

// ─────────────────────────────────────────────────────────────────────────────
// DEDUPLICATION
// ─────────────────────────────────────────────────────────────────────────────

// The reaction is our sole processed marker — it lives on the server and survives restarts.
function isProcessed(event: CVMessageEvent): boolean {
  if (!state.reactionId) return false
  return event.reaction_summary?.top_user_reactions?.some(
    r => r.user_id === state.ownUserId && r.reaction_id === state.reactionId,
  ) ?? false
}

async function markProcessed(event: CVMessageEvent): Promise<void> {
  if (isProcessed(event)) {
    log(`cv-claude-channels: WARNING double-process on ${event.message_id} — reaction already present, skipping addReaction\n`)
    return
  }
  if (state.reactionId) await addReaction(state.reactionId, event.message_id)
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
    log(`cv-claude-channels: dropped message from unknown sender ${event.creator_id}\n`)
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
        sendMessage({
          conversationId: event.channel_ids[0],
          threadId: event.message_id,
          transcript: 'Allow Sender list is currently empty. Go to Claude to approve senders.',
        }).catch(() => {})
      }
    }
    return false
  }

  // Reaction is our server-side processed marker — survives restarts
  if (isProcessed(event)) return false

  // Transcript lives in timecodes[].t joined; value field is always empty
  const tm = event.text_models.find(
    m => m.type === 'transcript_with_timecode' || m.type === 'transcript',
  )
  const transcript = tm?.timecodes?.map(tc => tc.t).join(' ') || tm?.value || ''

  // Log what we see so field-name issues are visible in stderr
  log(
    `cv-claude-channels: message ${event.message_id} status=${event.status} transcript="${transcript.slice(0, 80)}"\n`,
  )

  // Terminal statuses will never produce a transcript — skip them
  if (!transcript && (event.status === 'canceled' || event.status === 'deleted')) return false

  const hasAttachments = (event.attachments?.length ?? 0) > 0

  // Not ready yet — let the next poll retry without marking seen
  // Exceptions: attachment-only and forwarded messages have no transcript and never will
  if (!transcript && !hasAttachments && !event.share_link_id) return null

  const attachments: CVAttachment[] = event.attachments ?? []

  if (attachments.length > 0) {
    log(`cv-claude-channels: message ${event.message_id} has ${attachments.length} attachment(s): ${JSON.stringify(attachments.map(a => ({ _id: a._id, type: a.type, filename: a.filename, mime_type: a.mime_type, status: a.status })))}\n`)
  }

  // Download uploaded file attachments to a local directory for Claude to read directly.
  const localPaths = await downloadAttachmentsToDir(
    attachments,
    path.join(ATTACHMENTS_DIR, event.message_id),
  ).catch((err: unknown) => {
    log(`cv-claude-channels: failed to download attachments for ${event.message_id}: ${err}\n`)
    return new Map<string, string>()
  })

  const hasPendingUploads = attachments.some(
    a => a.type === 'file' && (a.status === 'Initializing' || a.status === 'Uploading'),
  )

  const attachmentLines = attachments
    .map(a => {
      if (a.type === 'file' && (a.status === 'Initializing' || a.status === 'Uploading')) {
        const label = a.filename ?? a.mime_type ?? 'file'
        return `- ${label}: (uploading — follow-up will arrive when ready)`
      }
      if (a.type === 'file' && a.status === 'Failed') {
        const label = a.filename ?? a.mime_type ?? 'file'
        return `- ${label}: (upload failed)`
      }
      const ref = a.type === 'file' ? localPaths.get(a._id) : a.link
      if (!ref) return null
      const label = a.filename ? `${a.filename} (${a.mime_type ?? a.type})` : (a.mime_type ?? a.type)
      return `- ${label}: ${ref}`
    })
    .filter((line): line is string => line !== null)

  // Resolve forwarded message content if this is a forward
  let forwardedSection = ''
  if (event.share_link_id) {
    const shareLink = await getShareLink(event.share_link_id).catch(err => {
      log(`cv-claude-channels: getShareLink failed for ${event.share_link_id}: ${err}\n`)
      return null
    })
    if (shareLink?.shared_message) {
      const sm = shareLink.shared_message
      const smTm = sm.text_models.find(
        m => m.type === 'transcript_with_timecode' || m.type === 'transcript',
      )
      const smTranscript = smTm?.timecodes?.map(tc => tc.t).join(' ') || smTm?.value || ''
      forwardedSection =
        `[Forwarded message from ${sm.creator_id}]\n` +
        (smTranscript || '(no transcript)')
    } else {
      log(`cv-claude-channels: share-link lookup yielded no content for ${event.message_id}, will retry\n`)
      return null
    }
  }

  const body = forwardedSection
    ? (transcript
        ? `${forwardedSection}\n\n[Forwarded by ${event.creator_id}]\n${transcript}`
        : forwardedSection)
    : (transcript || '(no transcript)')
  const content = attachmentLines.length > 0
    ? `${body}\n\nAttachments:\n${attachmentLines.join('\n')}`
    : body

  const reply_to_id = event.parent_message_id ?? event.message_id

  // Check for permission reply format (yes <id> or no <id>)
  const permMatch = PERMISSION_REPLY_RE.exec(transcript)
  if (permMatch) {
    const verdict = permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
    const requestId = permMatch[2].toLowerCase()
    log(`cv-claude-channels: permission verdict ${verdict} for request ${requestId}\n`)

    try {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: requestId,
          behavior: verdict,
        },
      })
    } catch (err) {
      log(`cv-claude-channels: permission notification failed for ${event.message_id}, will retry: ${err}\n`)
      return null
    }

    for (const [cvMsgId, pending] of state.pendingPermissionMessages) {
      if (pending.requestId === requestId) {
        state.pendingPermissionMessages.delete(cvMsgId)
        break
      }
    }

    await markProcessed(event)
    await markRead(channel_id, event.message_id)
    return true // handled as verdict, don't also forward as chat
  }

  // Emit to Claude Code — only mark seen/acknowledged if it succeeds
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
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
    // Mark messages whose attachments were fully delivered inline so the follow-up
    // scanner doesn't re-send them.
    if (localPaths.size > 0 && !hasPendingUploads) {
      state.attachmentFollowUpSent.add(event.message_id)
    }

    if (hasPendingUploads) {
      const now = Date.now()
      const filenames = attachments
        .filter(a => a.type === 'file' && (a.status === 'Initializing' || a.status === 'Uploading'))
        .map(a => a.filename ?? a.mime_type ?? 'file')
      state.pendingAttachments.set(event.message_id, {
        channelId: channel_id,
        replyToId: reply_to_id,
        senderId: event.creator_id,
        deadline: now + ATTACHMENT_TIMEOUT_MS,
        nudgeAt: now + ATTACHMENT_NUDGE_MS,
        nudgeSent: false,
        filenames,
      })
      log(`cv-claude-channels: registered ${event.message_id} for attachment follow-up (deadline ${ATTACHMENT_TIMEOUT_MS}ms)\n`)
    }
  } catch (err) {
    log(`cv-claude-channels: notification failed for ${event.message_id}, will retry: ${err}\n`)
    return null
  }

  await markProcessed(event)
  await markRead(channel_id, event.message_id)
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSION REACTION APPROVALS
// ─────────────────────────────────────────────────────────────────────────────


async function checkPendingPermissions(messages: CVMessageEvent[]): Promise<void> {
  if (state.pendingPermissionMessages.size === 0) return

  const pendingIds = [...state.pendingPermissionMessages.keys()]
  log(`cv-claude-channels: checkPendingPermissions: ${pendingIds.length} pending=${JSON.stringify(pendingIds)}, batch size=${messages.length}\n`)

  const matched = messages.filter(m => state.pendingPermissionMessages.has(m.message_id))
  log(`cv-claude-channels: checkPendingPermissions: ${matched.length} matched in batch (${matched.map(m => m.message_id).join(', ')})\n`)
  for (const m of matched) {
    log(`cv-claude-channels: checkPendingPermissions: message ${m.message_id} reactions=${JSON.stringify(m.reaction_summary?.top_user_reactions)}\n`)
  }

  const { allow, allowAlways, deny } = state.permissionReactionIds

  for (const msg of messages) {
    const pending = state.pendingPermissionMessages.get(msg.message_id)
    if (!pending) continue

    const reactions = msg.reaction_summary?.top_user_reactions ?? []
    for (const rxn of reactions) {
      if (!state.access.allowFrom.includes(rxn.user_id)) continue

      let behavior: string | null = null
      if (allow && rxn.reaction_id === allow) behavior = 'allow'
      else if (allowAlways && rxn.reaction_id === allowAlways) behavior = 'allow_always'
      else if (deny && rxn.reaction_id === deny) behavior = 'deny'

      if (!behavior) continue

      log(`cv-claude-channels: permission verdict via reaction: ${behavior} for request ${pending.requestId} (from ${rxn.user_id})\n`)

      if (behavior === 'allow_always') {
        state.allowAlwaysTools.add(pending.toolName)
        log(`cv-claude-channels: ${pending.toolName} added to session allow_always list\n`)
      }

      try {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: pending.requestId, behavior: behavior === 'allow_always' ? 'allow' : behavior },
        })
        state.pendingPermissionMessages.delete(msg.message_id)
      } catch (err) {
        log(`cv-claude-channels: permission reaction notification failed for ${pending.requestId}: ${err}\n`)
      }
      break
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTACHMENT FOLLOW-UP
// ─────────────────────────────────────────────────────────────────────────────

async function checkPendingAttachments(polledMessages: CVMessageEvent[]): Promise<void> {
  const now = Date.now()

  // Build a lookup of updated messages from this poll batch
  const updatedById = new Map(polledMessages.map(m => [m.message_id, m]))

  for (const [messageId, pending] of state.pendingAttachments) {
    const updated = updatedById.get(messageId)
    const timedOut = now >= pending.deadline

    const attachments = updated?.attachments ?? []
    const fileAttachments = attachments.filter(a => a.type === 'file')
    const stillPending = updated
      ? fileAttachments.some(a => a.status === 'Initializing' || a.status === 'Uploading')
      : true  // not in this batch yet, assume still pending

    // Send nudge if we've been waiting more than nudge threshold and haven't nudged yet
    if (!pending.nudgeSent && now >= pending.nudgeAt && stillPending && !timedOut) {
      const names = pending.filenames.join(', ')
      log(`cv-claude-channels: sending nudge for pending attachment(s) on ${messageId}\n`)
      sendMessage({
        conversationId: pending.channelId,
        threadId: pending.replyToId,
        transcript: `Still waiting on ${names} to finish uploading.`,
      }).catch(err => log(`cv-claude-channels: nudge send failed for ${messageId}: ${err}\n`))
      pending.nudgeSent = true
    }

    // Not resolved and not yet expired — keep waiting
    if (stillPending && !timedOut) continue

    state.pendingAttachments.delete(messageId)

    // Download any uploaded files locally
    const localPaths = await downloadAttachmentsToDir(
      fileAttachments,
      path.join(ATTACHMENTS_DIR, messageId),
    ).catch((err: unknown) => {
      log(`cv-claude-channels: follow-up download failed for ${messageId}: ${err}\n`)
      return new Map<string, string>()
    })

    const lines = fileAttachments.map(a => {
      if (a.status === 'Uploaded') {
        const localPath = localPaths.get(a._id)
        if (localPath) {
          const label = a.filename ? `${a.filename} (${a.mime_type ?? a.type})` : (a.mime_type ?? a.type)
          return `- ${label}: ${localPath}`
        }
      }
      const label = a.filename ?? a.mime_type ?? 'file'
      return `- ${label}: (upload ${timedOut && a.status !== 'Uploaded' ? 'timed out' : 'failed'})`
    })

    if (lines.length === 0) continue

    log(`cv-claude-channels: sending attachment follow-up for ${messageId} (timedOut=${timedOut})\n`)

    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `Attachment follow-up:\n${lines.join('\n')}`,
          meta: {
            source:               'carbon-voice',
            channel_id:           pending.channelId,
            message_id:           messageId,
            sender_id:            pending.senderId,
            is_reply:             'true',
            reply_to_id:          pending.replyToId,
            is_attachment_followup: 'true',
          },
        },
      })
      state.attachmentFollowUpSent.add(messageId)
    } catch (err) {
      log(`cv-claude-channels: attachment follow-up notification failed for ${messageId}: ${err}\n`)
      // Re-register with original deadline so we retry on the next poll
      state.pendingAttachments.set(messageId, pending)
    }
  }

  // Second pass: catch messages that were processed with no attachments but later had
  // attachments added (Carbon Voice adds the attachment to the message after the fact).
  for (const event of polledMessages) {
    if (!isProcessed(event)) continue
    if (state.attachmentFollowUpSent.has(event.message_id)) continue
    if (state.pendingAttachments.has(event.message_id)) continue  // already tracked above

    const uploadedFiles = (event.attachments ?? []).filter(
      a => a.type === 'file' && a.status === 'Uploaded',
    )
    if (uploadedFiles.length === 0) continue

    state.attachmentFollowUpSent.add(event.message_id)
    log(`cv-claude-channels: post-processed attachment(s) found for ${event.message_id}, sending follow-up\n`)

    const localPaths = await downloadAttachmentsToDir(
      uploadedFiles,
      path.join(ATTACHMENTS_DIR, event.message_id),
    ).catch((err: unknown) => {
      log(`cv-claude-channels: follow-up download failed for ${event.message_id}: ${err}\n`)
      return new Map<string, string>()
    })

    const lines = uploadedFiles.map(a => {
      const localPath = localPaths.get(a._id)
      const label = a.filename ? `${a.filename} (${a.mime_type ?? a.type})` : (a.mime_type ?? a.type)
      return localPath ? `- ${label}: ${localPath}` : `- ${label}: (download unavailable)`
    })

    const channel_id = event.channel_ids[0] ?? ''
    const reply_to_id = event.parent_message_id ?? event.message_id

    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `Attachment follow-up:\n${lines.join('\n')}`,
          meta: {
            source:                 'carbon-voice',
            channel_id,
            message_id:             event.message_id,
            sender_id:              event.creator_id,
            is_reply:               'true',
            reply_to_id,
            is_attachment_followup: 'true',
          },
        },
      })
    } catch (err) {
      log(`cv-claude-channels: post-processed follow-up failed for ${event.message_id}: ${err}\n`)
      state.attachmentFollowUpSent.delete(event.message_id)  // retry next poll
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSED-MESSAGE CATCH-UP
// ─────────────────────────────────────────────────────────────────────────────

async function fetchMissedMessages() {
  if (state.fetchInFlight) {
    state.fetchQueued = true
    return
  }
  state.fetchInFlight = true
  try {
    await fetchMissedMessagesOnce()
    while (state.fetchQueued) {
      state.fetchQueued = false
      await fetchMissedMessagesOnce()
    }
  } finally {
    state.fetchInFlight = false
  }
}

async function fetchMissedMessagesOnce() {
  const requestStartedAt = new Date().toISOString()

  if (!state.lastCheckedAt) {
    // First run — skip history, start cursor from now
    log(`cv-claude-channels: first run, starting from ${requestStartedAt}\n`)
    updateCursor(requestStartedAt)
    return
  }

  const result = await getRecentMessages({
    date: state.lastCheckedAt,
    direction: 'newer',
    limit: 100,
    use_last_updated: true,
    ...(CONVERSATION_ID ? { channel_id: CONVERSATION_ID } : {}),
  })

  if (!result.ok) {
    log(`cv-claude-channels: fetchMissedMessages ${result.status}\n`)
    return  // don't advance cursor — retry same window next poll
  }

  const allMessages = result.messages

  // Client-side guard: CV's recent endpoint may ignore channel_id filter
  let messages = allMessages
  if (CONVERSATION_ID) {
    messages = allMessages.filter(m => m.channel_ids.includes(CONVERSATION_ID))
    const dropped = allMessages.length - messages.length
    if (allMessages.length > 0) {
      log(
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
    log(
      `cv-claude-channels: emitted ${processed} new` +
      (firstRetryIdx !== null ? ', cursor held for retry' : '') +
      '\n',
    )
  }

  await checkPendingPermissions(allMessages)
  await checkPendingAttachments(messages)

  // Advance cursor as far as possible:
  // - No retries: advance to requestStartedAt (current time).
  // - Some retries: advance to just before the first stuck message so the
  //   next fetch only re-fetches the stuck message onward — not the whole
  //   window. Already-delivered messages in that window are deduped by markProcessed.
  // - First message stuck: leave cursor unchanged so the stuck message is retried.
  if (firstRetryIdx === null) {
    updateCursor(requestStartedAt)
  } else if (firstRetryIdx > 0) {
    updateCursor(messages[firstRetryIdx - 1].created_at)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  log(`cv-claude-channels: ${signal} received, shutting down\n`)
  connection?.disconnect()

  if (state.flushTimer)  clearTimeout(state.flushTimer)

  // Flush cursor immediately
  state.lastCheckedAtDirty = true
  await flushState()

  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())

// Wait for the MCP initialize handshake to complete before sending notifications.
// _clientCapabilities is set during initialize; polling until it's defined (even {})
// ensures Claude Code is ready to receive channel notifications.
await new Promise<void>(resolve => {
  const check = () => {
    if (mcp.getClientCapabilities() !== undefined) { resolve(); return }
    setTimeout(check, 50)
  }
  setTimeout(check, 50)
})
log(`cv-claude-channels: MCP handshake complete, client=${JSON.stringify(mcp.getClientVersion())}\n`)

try {
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: `STARTUP CHECK: Call the confirm_channels tool to activate Carbon Voice channels.`,
      meta: { source: 'carbon-voice', event: 'startup_check' },
    },
  })
  log(`cv-claude-channels: startup check sent — waiting for confirm_channels tool call\n`)
} catch (err) {
  log(`cv-claude-channels: startup notification failed — passive mode: ${err}\n`)
}
