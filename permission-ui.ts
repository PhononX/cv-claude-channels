import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { type FileAttachment } from './cv-api.js'

// MIME type the Flutter client uses to classify an interactive agent-UI payload
// (carbon-voice-flutter: packages/cv_domain/lib/agent_ui — kAgentUiMimeType). A
// dedicated vendor type is required because client view-type detection is
// mime-first and never sees the JSON body.
export const AGENT_UI_MIME = 'application/vnd.carbonvoice.agent-ui+json'

// Build the cv_agent_ui permission-card payload, write it to a temp file, and
// return it as a file attachment to ride alongside the prose permission message.
// Each action carries the reaction id the card applies to the host message — the
// same ids checkPendingPermissions() polls — so the round-trip needs no extra
// server support. Returns null when no reaction ids are resolved (the card would
// have no way to answer), in which case we fall back to text + manual reactions.
export async function buildPermissionUiAttachment(
  params: { request_id: string; tool_name: string; description: string; input_preview: string },
  reactionIds: { allow: string | null; allowAlways: string | null; deny: string | null },
): Promise<FileAttachment | null> {
  const actions = [
    reactionIds.allow       ? { id: 'allow',        label: 'Allow once',   style: 'primary',     reaction: reactionIds.allow } : null,
    reactionIds.allowAlways ? { id: 'allow_always', label: 'Always allow',  style: 'secondary',   reaction: reactionIds.allowAlways } : null,
    reactionIds.deny        ? { id: 'deny',         label: 'Deny',         style: 'destructive', reaction: reactionIds.deny } : null,
  ].filter((a): a is NonNullable<typeof a> => a !== null)
  if (actions.length === 0) return null

  const payload = {
    cv_agent_ui: '1',
    type: 'permission_request',
    request_id: params.request_id,
    title: `Claude wants to run ${params.tool_name}`,
    description: params.description,
    preview: params.input_preview,
    actions,
  }

  const file = path.join(os.tmpdir(), `cv-agent-ui-${params.request_id}-${Date.now()}.json`)
  await fs.writeFile(file, JSON.stringify(payload), 'utf8')
  return { type: 'file', path: file, filename: 'permission.json', mime_type: AGENT_UI_MIME }
}
