import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { buildPermissionUiAttachment, AGENT_UI_MIME } from './permission-ui.ts'
import { type FileAttachment } from './cv-api.ts'

// ─────────────────────────────────────────────────────────────────────────────
// buildPermissionUiAttachment
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPermissionUiAttachment', () => {
  const params = {
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'Run a shell command',
    input_preview: '{"command":"ls -la"}',
  }

  // Track every temp file the function writes so we can clean them up.
  const writtenFiles: string[] = []

  afterEach(async () => {
    await Promise.all(
      writtenFiles.splice(0).map((f) => fs.rm(f, { force: true })),
    )
  })

  async function readPayload(att: FileAttachment): Promise<any> {
    writtenFiles.push(att.path)
    return JSON.parse(await fs.readFile(att.path, 'utf8'))
  }

  it('returns a FileAttachment with the agent-ui mime, filename, and file type when all reaction ids are set', async () => {
    const result = await buildPermissionUiAttachment(params, {
      allow: 'r-allow',
      allowAlways: 'r-always',
      deny: 'r-deny',
    })

    expect(result).not.toBeNull()
    expect(result).toMatchObject<Partial<FileAttachment>>({
      type: 'file',
      filename: 'permission.json',
      mime_type: AGENT_UI_MIME,
    })
    expect(result!.mime_type).toBe('application/vnd.carbonvoice.agent-ui+json')

    const payload = await readPayload(result!)
    expect(payload).toMatchObject({
      cv_agent_ui: '1',
      type: 'permission_request',
      request_id: 'abcde',
      title: 'Claude wants to run Bash',
      description: 'Run a shell command',
      preview: '{"command":"ls -la"}',
    })
    expect(payload.actions).toHaveLength(3)
    expect(payload.actions).toEqual([
      { id: 'allow',        label: 'Allow once',  style: 'primary',     reaction: 'r-allow' },
      { id: 'allow_always', label: 'Always allow', style: 'secondary',   reaction: 'r-always' },
      { id: 'deny',         label: 'Deny',        style: 'destructive', reaction: 'r-deny' },
    ])
  })

  it('includes only the set reaction ids, preserving order (allow only)', async () => {
    const result = await buildPermissionUiAttachment(params, {
      allow: 'r-allow',
      allowAlways: null,
      deny: null,
    })

    expect(result).not.toBeNull()
    const payload = await readPayload(result!)
    expect(payload.actions).toHaveLength(1)
    expect(payload.actions).toEqual([
      { id: 'allow', label: 'Allow once', style: 'primary', reaction: 'r-allow' },
    ])
  })

  it('includes only the set reaction ids, preserving order (allowAlways + deny, no allow)', async () => {
    const result = await buildPermissionUiAttachment(params, {
      allow: null,
      allowAlways: 'r-always',
      deny: 'r-deny',
    })

    expect(result).not.toBeNull()
    const payload = await readPayload(result!)
    expect(payload.actions).toHaveLength(2)
    expect(payload.actions).toEqual([
      { id: 'allow_always', label: 'Always allow', style: 'secondary',   reaction: 'r-always' },
      { id: 'deny',         label: 'Deny',        style: 'destructive', reaction: 'r-deny' },
    ])
  })

  it('returns null and writes no file when no reaction ids are set', async () => {
    const result = await buildPermissionUiAttachment(params, {
      allow: null,
      allowAlways: null,
      deny: null,
    })
    expect(result).toBeNull()
  })

  it('maps each action reaction to the passed reaction id', async () => {
    const reactionIds = {
      allow: 'react-1',
      allowAlways: 'react-2',
      deny: 'react-3',
    }
    const result = await buildPermissionUiAttachment(params, reactionIds)

    expect(result).not.toBeNull()
    const payload = await readPayload(result!)
    const byId = Object.fromEntries(
      payload.actions.map((a: { id: string; reaction: string }) => [a.id, a.reaction]),
    )
    expect(byId.allow).toBe(reactionIds.allow)
    expect(byId.allow_always).toBe(reactionIds.allowAlways)
    expect(byId.deny).toBe(reactionIds.deny)
  })
})
