import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  elicit,
  outcomeToBehavior,
  isAllowAlways,
  permissionRender,
  resolvePermission,
  type Outcome,
} from './elicit.ts'
import {
  registerPendingRequest,
  type ActionRequestEnvelope,
  type ActionResponsePayload,
} from './cv-api.ts'

// A test double for the cv-api transport. `post` records the envelope and hands
// back a fixed requestId; `register` uses the real registry so we can drive a
// response or a timeout through it.
function makeHarness(requestId = 'areq_test') {
  const posted: Array<{ channelId: string; envelope: ActionRequestEnvelope }> = []
  const post = vi.fn(async (channelId: string, envelope: ActionRequestEnvelope) => {
    posted.push({ channelId, envelope })
    return { requestId }
  })
  return { posted, post, register: registerPendingRequest, requestId }
}

describe('elicit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts an action_request envelope built from the request', async () => {
    const h = makeHarness()
    const promise = elicit(
      {
        channelId: 'chan_1',
        intent: 'permission',
        requestId: 'abcde',
        title: 'Claude wants to run Bash',
        body: 'rm -rf /tmp/x',
        render: permissionRender(),
      },
      { post: h.post, register: h.register, timeoutMs: 1000 },
    )

    // Let the post() microtask resolve so the envelope is recorded.
    await Promise.resolve()
    await Promise.resolve()

    expect(h.posted).toHaveLength(1)
    const env = h.posted[0].envelope
    expect(h.posted[0].channelId).toBe('chan_1')
    expect(env.type).toBe('action_request')
    expect(env.intent).toBe('permission')
    expect(env.title).toBe('Claude wants to run Bash')
    expect(env.render.presentation).toBe('permission')
    expect(env.render.options?.map(o => o.optionId)).toEqual(['allow_once', 'allow_always', 'reject_once'])
    expect(env.blocking).toBe(true)
    expect(env.expiresInSeconds).toBe(1)

    // Resolve so the promise settles and no timer leaks.
    h.register // already registered by elicit; deliver via the registry
    // Use the real registry to deliver the response keyed by requestId.
    const { deliverActionResponse } = await import('./cv-api.ts')
    deliverActionResponse({ requestId: h.requestId, outcome: 'declined' })
    await promise
  })

  it('resolves with the outcome when an action_response arrives', async () => {
    const h = makeHarness('areq_resolve')
    const promise = elicit(
      { channelId: 'c', intent: 'permission', title: 't', render: permissionRender() },
      { post: h.post, register: h.register, timeoutMs: 5000 },
    )
    await Promise.resolve()
    await Promise.resolve()

    const { deliverActionResponse } = await import('./cv-api.ts')
    deliverActionResponse({ requestId: 'areq_resolve', outcome: 'selected', optionId: 'allow_once' })

    const outcome = await promise
    expect(outcome).toEqual<Outcome>({ outcome: 'selected', optionId: 'allow_once', optionIds: undefined, data: null })
  })

  it('resolves with cancelled on timeout', async () => {
    const h = makeHarness('areq_timeout')
    const promise = elicit(
      { channelId: 'c', intent: 'permission', title: 't', render: permissionRender() },
      { post: h.post, register: h.register, timeoutMs: 1000 },
    )
    await Promise.resolve()
    await Promise.resolve()

    vi.advanceTimersByTime(1000)

    const outcome = await promise
    expect(outcome).toEqual<Outcome>({ outcome: 'cancelled' })
  })

  it('ignores a response that arrives after a timeout (double-resolve guard)', async () => {
    const h = makeHarness('areq_double')
    const promise = elicit(
      { channelId: 'c', intent: 'permission', title: 't', render: permissionRender() },
      { post: h.post, register: h.register, timeoutMs: 1000 },
    )
    await Promise.resolve()
    await Promise.resolve()

    vi.advanceTimersByTime(1000)
    const outcome = await promise
    expect(outcome.outcome).toBe('cancelled')

    // A late response after the timeout must not change the already-settled value
    // and must be a no-op (registry already cleared).
    const { deliverActionResponse, hasPendingRequest } = await import('./cv-api.ts')
    expect(hasPendingRequest('areq_double')).toBe(false)
    expect(() => deliverActionResponse({ requestId: 'areq_double', outcome: 'selected', optionId: 'allow_once' })).not.toThrow()
  })
})

describe('outcomeToBehavior mapping', () => {
  const cases: Array<[Outcome, 'allow' | 'deny']> = [
    [{ outcome: 'selected', optionId: 'allow_once' }, 'allow'],
    [{ outcome: 'selected', optionId: 'allow_always' }, 'allow'],
    [{ outcome: 'selected', optionId: 'reject_once' }, 'deny'],
    [{ outcome: 'selected', optionId: 'reject_always' }, 'deny'],
    [{ outcome: 'selected', optionId: 'mystery' }, 'deny'],
    [{ outcome: 'submitted' }, 'allow'],
    [{ outcome: 'declined' }, 'deny'],
    [{ outcome: 'cancelled' }, 'deny'],
  ]

  it.each(cases)('%o → %s', (outcome, expected) => {
    expect(outcomeToBehavior(outcome)).toBe(expected)
  })
})

// Mirrors how the MCP permission handler consumes resolvePermission with a
// stubbed elicit — the handler itself lives in the self-executing channel
// module, so we test its orchestration through this seam.
describe('resolvePermission (handler refactor seam)', () => {
  it('builds a permission request from the tool name and maps allow_once → allow', async () => {
    const stubElicit = vi.fn(async () => ({ outcome: 'selected', optionId: 'allow_once' } as Outcome))
    const result = await resolvePermission(
      { channelId: 'chan_1', requestId: 'abcde', toolName: 'Bash', description: 'ls', replyToId: 'msg_1' },
      stubElicit as unknown as typeof elicit,
    )

    expect(result.behavior).toBe('allow')
    expect(result.allowAlways).toBe(false)
    const [req] = stubElicit.mock.calls[0]
    expect(req.intent).toBe('permission')
    expect(req.requestId).toBe('abcde')
    expect(req.title).toBe('Claude wants to run Bash')
    expect(req.metadata).toMatchObject({ toolName: 'Bash', replyToId: 'msg_1' })
  })

  it('flags allow_always so the handler can cache the tool for the session', async () => {
    const stubElicit = vi.fn(async () => ({ outcome: 'selected', optionId: 'allow_always' } as Outcome))
    const result = await resolvePermission(
      { channelId: 'c', requestId: 'r', toolName: 'Write', description: 'x' },
      stubElicit as unknown as typeof elicit,
    )
    expect(result.behavior).toBe('allow')
    expect(result.allowAlways).toBe(true)
  })

  it('maps a cancelled (timeout) outcome to deny', async () => {
    const stubElicit = vi.fn(async () => ({ outcome: 'cancelled' } as Outcome))
    const result = await resolvePermission(
      { channelId: 'c', requestId: 'r', toolName: 'Bash', description: 'x' },
      stubElicit as unknown as typeof elicit,
    )
    expect(result.behavior).toBe('deny')
    expect(result.allowAlways).toBe(false)
  })

  it('maps a reject outcome to deny', async () => {
    const stubElicit = vi.fn(async () => ({ outcome: 'selected', optionId: 'reject_once' } as Outcome))
    const result = await resolvePermission(
      { channelId: 'c', requestId: 'r', toolName: 'Bash', description: 'x' },
      stubElicit as unknown as typeof elicit,
    )
    expect(result.behavior).toBe('deny')
  })
})

describe('isAllowAlways', () => {
  it('is true only for selected + allow_always', () => {
    expect(isAllowAlways({ outcome: 'selected', optionId: 'allow_always' })).toBe(true)
    expect(isAllowAlways({ outcome: 'selected', optionId: 'allow_once' })).toBe(false)
    expect(isAllowAlways({ outcome: 'declined' })).toBe(false)
    expect(isAllowAlways({ outcome: 'cancelled' })).toBe(false)
  })
})
