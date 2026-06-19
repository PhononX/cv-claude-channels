/**
 * elicit.ts
 *
 * The single agent boundary for the Agent ↔ Client Interaction Protocol.
 *
 * `elicit(request)` posts a first-class `action_request` to cv-api, registers a
 * per-requestId promise, arms a timeout, and resolves when the correlated
 * `action_response` arrives over the socket. It presents Style-A ergonomics
 * (`await`) but resolves off a socket event (closer to Style B — no long-lived
 * HTTP). See the spec §8: "Start with A, design for B."
 *
 * The MCP relay code reads linearly:
 *   const outcome = await elicit(req)
 *   notify Claude Code with outcomeToBehavior(outcome)
 */

import {
  postActionRequest,
  registerPendingRequest,
  type ActionRequestEnvelope,
  type ActionRequestOption,
  type ActionRequestRender,
  type ActionResponsePayload,
} from './cv-api.js'
import { DEFAULT_PERMISSION_OPTIONS, type PermissionUiOption } from './permission-ui.js'

export type ElicitOutcomeKind = 'selected' | 'submitted' | 'declined' | 'cancelled'

export interface Outcome {
  outcome: ElicitOutcomeKind
  optionId?: string
  optionIds?: string[]
  data?: Record<string, unknown> | null
}

export interface ElicitRequest {
  channelId: string
  intent: 'permission' | 'choice' | 'form'
  /** Request id to correlate with (Claude Code's request_id for permissions). */
  requestId?: string
  title: string
  body?: string
  render: ActionRequestRender
  runId?: string
  expiresInSeconds?: number
  agent?: { id: string; name: string; avatarUrl?: string }
  metadata?: Record<string, unknown>
}

export interface ElicitOptions {
  timeoutMs?: number
  /** Injectable for testing; defaults to the live cv-api transport. */
  post?: typeof postActionRequest
  register?: typeof registerPendingRequest
}

const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

// MCP/ACP behavior the channel notifies Claude Code with.
export type PermissionBehavior = 'allow' | 'deny'

/**
 * Map a protocol Outcome onto the Claude Code permission `behavior`.
 *
 * ACP ↔ ours mapping (spec §6.3, §13):
 *   outcome 'selected' + optionId 'allow_once' | 'allow_always' → 'allow'
 *   outcome 'selected' + optionId 'reject_once' | 'reject_always' → 'deny'
 *   outcome 'submitted'                                          → 'allow'
 *   outcome 'declined'                                           → 'deny'
 *   outcome 'cancelled' (timeout / dismiss / abort)             → 'deny' (safe default)
 */
export function outcomeToBehavior(outcome: Outcome): PermissionBehavior {
  switch (outcome.outcome) {
    case 'selected':
      if (outcome.optionId === 'allow_once' || outcome.optionId === 'allow_always') return 'allow'
      if (outcome.optionId === 'reject_once' || outcome.optionId === 'reject_always') return 'deny'
      // Unknown optionId on a permission select — deny is the safe default.
      return 'deny'
    case 'submitted':
      return 'allow'
    case 'declined':
      return 'deny'
    case 'cancelled':
    default:
      return 'deny'
  }
}

/** True when the resolved option means "always allow" for the rest of the session. */
export function isAllowAlways(outcome: Outcome): boolean {
  return outcome.outcome === 'selected' && outcome.optionId === 'allow_always'
}

export interface PermissionRelayParams {
  channelId: string
  requestId: string
  toolName: string
  description: string
  replyToId?: string
  timeoutMs?: number
}

export interface PermissionRelayResult {
  behavior: PermissionBehavior
  allowAlways: boolean
  outcome: Outcome
}

/**
 * Orchestrate a single permission turn over the protocol: elicit the outcome,
 * map it to a Claude Code `behavior`, and report whether the user chose
 * "always allow". The MCP handler calls this and then sends the notification.
 *
 * `elicitFn` is injectable so the handler refactor can be unit-tested with a
 * stubbed elicit; it defaults to the live `elicit`.
 */
export async function resolvePermission(
  params: PermissionRelayParams,
  elicitFn: typeof elicit = elicit,
): Promise<PermissionRelayResult> {
  const outcome = await elicitFn(
    {
      channelId: params.channelId,
      intent: 'permission',
      requestId: params.requestId,
      title: `Claude wants to run ${params.toolName}`,
      body: params.description,
      render: permissionRender(),
      metadata: { toolName: params.toolName, replyToId: params.replyToId },
    },
    { timeoutMs: params.timeoutMs },
  )
  return {
    behavior: outcomeToBehavior(outcome),
    allowAlways: isAllowAlways(outcome),
    outcome,
  }
}

/** Build the permission `render` payload from the canonical option set. */
export function permissionRender(options: PermissionUiOption[] = DEFAULT_PERMISSION_OPTIONS): ActionRequestRender {
  return {
    kind: 'options',
    presentation: 'permission',
    options: options.map((o): ActionRequestOption => ({ optionId: o.optionId, label: o.label, kind: o.kind })),
  }
}

/**
 * Post an action_request and await the correlated outcome.
 * Resolves `{ outcome: 'cancelled' }` on timeout (graceful degradation, spec §9).
 * Never rejects on a missing/late/duplicate response — the registry no-ops those.
 */
export async function elicit(req: ElicitRequest, opts: ElicitOptions = {}): Promise<Outcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const post = opts.post ?? postActionRequest
  const register = opts.register ?? registerPendingRequest

  const envelope: ActionRequestEnvelope = {
    type: 'action_request',
    channelId: req.channelId,
    intent: req.intent,
    title: req.title,
    body: req.body,
    render: req.render,
    runId: req.runId,
    agent: req.agent,
    blocking: true,
    expiresInSeconds: req.expiresInSeconds ?? Math.ceil(timeoutMs / 1000),
    metadata: req.metadata,
  }

  const { requestId } = await post(req.channelId, envelope)

  return new Promise<Outcome>((resolve) => {
    let settled = false
    let unregister: () => void = () => {}

    const settle = (outcome: Outcome) => {
      if (settled) return // double-resolve guard (timeout vs. response race)
      settled = true
      unregister()
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      settle({ outcome: 'cancelled' })
    }, timeoutMs)

    unregister = register(
      requestId,
      (payload: ActionResponsePayload) => {
        settle({
          outcome: payload.outcome,
          optionId: payload.optionId,
          optionIds: payload.optionIds,
          data: payload.data ?? null,
        })
      },
      () => settle({ outcome: 'cancelled' }),
      timer,
    )
  })
}
