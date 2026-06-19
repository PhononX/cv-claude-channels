import { describe, it, expect } from 'vitest'
import {
  buildPermissionUiPayload,
  buildPermissionUiAttachment,
  DEFAULT_PERMISSION_OPTIONS,
  AGENT_UI_MIME,
} from './permission-ui.ts'

describe('buildPermissionUiPayload', () => {
  it('builds a permission payload with the canonical allow/always/reject options', () => {
    const payload = buildPermissionUiPayload({
      requestId: 'abcde',
      toolName: 'Bash',
      description: 'rm -rf /tmp/x',
    })

    expect(payload).toMatchObject({
      type: 'agent_ui',
      intent: 'permission',
      requestId: 'abcde',
      title: 'Claude wants to run Bash',
      body: 'rm -rf /tmp/x',
    })
    expect(payload.render.presentation).toBe('permission')
    expect(payload.render.options).toEqual(DEFAULT_PERMISSION_OPTIONS)
    expect(payload.render.options.map(o => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once'])
  })

  it('honours a custom option set', () => {
    const payload = buildPermissionUiPayload({
      requestId: 'abcde',
      toolName: 'Write',
      description: 'write a file',
      options: [{ optionId: 'allow_once', label: 'OK', kind: 'allow_once' }],
    })
    expect(payload.render.options).toHaveLength(1)
    expect(payload.render.options[0].label).toBe('OK')
  })
})

describe('buildPermissionUiAttachment', () => {
  it('encodes the payload as an agent-ui data-URL link attachment', () => {
    const att = buildPermissionUiAttachment({
      requestId: 'abcde',
      toolName: 'Bash',
      description: 'ls',
    })
    expect(att.type).toBe('link')
    expect(att.mime_type).toBe(AGENT_UI_MIME)
    expect(att.url.startsWith(`data:${AGENT_UI_MIME};base64,`)).toBe(true)

    const base64 = att.url.split(',')[1]
    const decoded = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
    expect(decoded.intent).toBe('permission')
    expect(decoded.requestId).toBe('abcde')
  })
})
