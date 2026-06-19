/**
 * permission-ui.ts
 *
 * Builds the interactive permission UI card that Carbon Voice renders for a
 * Claude Code tool-approval prompt. The card travels as a message attachment
 * with the MIME type `application/vnd.carbonvoice.agent-ui+json`; Carbon Voice
 * recognises that type and renders an interactive widget instead of plain text.
 *
 * This builder is the single source of truth for the `render` payload shape.
 * The same shape is reused by `elicit.ts` for the first-class
 * `action_request` envelope (`render` field), so the card the user sees and the
 * protocol request the agent posts stay in lockstep.
 */

export const AGENT_UI_MIME = 'application/vnd.carbonvoice.agent-ui+json'

// ACP PermissionOptionKind values (agentclientprotocol.com).
export type AcpOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface PermissionUiOption {
  optionId: string
  label: string
  kind: AcpOptionKind
}

export interface PermissionUiRender {
  kind: 'options'
  presentation: 'permission'
  options: PermissionUiOption[]
}

export interface PermissionUiPayload {
  type: 'agent_ui'
  intent: 'permission'
  requestId: string
  title: string
  body: string
  render: PermissionUiRender
}

export interface BuildPermissionUiParams {
  requestId: string
  toolName: string
  description: string
  /** Override the default allow/always/reject option set. */
  options?: PermissionUiOption[]
}

// The canonical permission option set. Mirrors ACP's request_permission options
// and the three reactions the legacy path used (allow / allow_always / deny).
export const DEFAULT_PERMISSION_OPTIONS: PermissionUiOption[] = [
  { optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', label: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', label: 'Reject', kind: 'reject_once' },
]

export function buildPermissionUiPayload(params: BuildPermissionUiParams): PermissionUiPayload {
  return {
    type: 'agent_ui',
    intent: 'permission',
    requestId: params.requestId,
    title: `Claude wants to run ${params.toolName}`,
    body: params.description,
    render: {
      kind: 'options',
      presentation: 'permission',
      options: params.options ?? DEFAULT_PERMISSION_OPTIONS,
    },
  }
}

/**
 * Builds the message attachment that carries the interactive permission card.
 * The attachment is a `link` whose body is the JSON payload encoded as a data
 * URL so it rides the existing message-attachment infrastructure unchanged.
 */
export function buildPermissionUiAttachment(params: BuildPermissionUiParams): {
  type: 'link'
  url: string
  mime_type: string
} {
  const payload = buildPermissionUiPayload(params)
  const json = JSON.stringify(payload)
  const url = `data:${AGENT_UI_MIME};base64,${Buffer.from(json, 'utf8').toString('base64')}`
  return { type: 'link', url, mime_type: AGENT_UI_MIME }
}
