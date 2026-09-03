import { describe, it, expect } from 'vitest'
import {
  PERMISSION_REPLY_RE,
  parseVerdict,
  trimPreview,
  formatPermissionPrompt,
  findOpenRequest,
  sweepExpired,
  type PendingPermission,
} from './permission-relay.js'

const pending = (over: Partial<PendingPermission> = {}): PendingPermission => ({
  requestId: 'abcde',
  channelId: 'chan-1',
  toolName: 'Bash',
  expiresAt: 10_000,
  ...over,
})

describe('parseVerdict', () => {
  it('accepts every short and long form', () => {
    expect(parseVerdict('yes abcde')).toEqual({ verdict: 'allow', requestId: 'abcde' })
    expect(parseVerdict('y abcde')).toEqual({ verdict: 'allow', requestId: 'abcde' })
    expect(parseVerdict('no abcde')).toEqual({ verdict: 'deny', requestId: 'abcde' })
    expect(parseVerdict('n abcde')).toEqual({ verdict: 'deny', requestId: 'abcde' })
  })

  it('tolerates surrounding whitespace and autocorrect capitals', () => {
    expect(parseVerdict('  Yes ABCDE  ')).toEqual({ verdict: 'allow', requestId: 'abcde' })
    expect(parseVerdict('NO Abcde')).toEqual({ verdict: 'deny', requestId: 'abcde' })
  })

  it("rejects ids containing 'l', which Claude Code never issues", () => {
    expect(parseVerdict('yes ablde')).toBeNull()
  })

  it('rejects ids that are not exactly five letters', () => {
    expect(parseVerdict('yes abcd')).toBeNull()
    expect(parseVerdict('yes abcdef')).toBeNull()
    expect(parseVerdict('yes abc1e')).toBeNull()
  })

  it('rejects a verdict word with no id, so it falls through as chat', () => {
    expect(parseVerdict('yes')).toBeNull()
    expect(parseVerdict('approve it')).toBeNull()
  })

  it('rejects a verdict buried in a longer sentence', () => {
    expect(parseVerdict('I think yes abcde is right')).toBeNull()
  })

  it('exports a regex that is not sticky or global, so repeated use is safe', () => {
    expect(PERMISSION_REPLY_RE.global).toBe(false)
    expect(PERMISSION_REPLY_RE.sticky).toBe(false)
    expect(PERMISSION_REPLY_RE.test('yes abcde')).toBe(true)
    expect(PERMISSION_REPLY_RE.test('yes abcde')).toBe(true)
  })
})

describe('trimPreview', () => {
  it('leaves a short preview alone', () => {
    expect(trimPreview('rm -rf ./build', 400)).toBe('rm -rf ./build')
  })

  it('leaves a preview exactly at the limit alone', () => {
    const exact = 'x'.repeat(10)
    expect(trimPreview(exact, 10)).toBe(exact)
  })

  it('marks a truncated preview so the approver knows something is missing', () => {
    const out = trimPreview('x'.repeat(50), 10)
    expect(out.startsWith('x'.repeat(10))).toBe(true)
    expect(out).toContain('truncated for playback')
  })
})

describe('formatPermissionPrompt', () => {
  const base = {
    toolName: 'Bash',
    description: 'Delete the build directory',
    inputPreview: '{"command":"rm -rf ./build"}',
    requestId: 'abcde',
    allowEmoji: ['✅'],
    allowAlwaysEmoji: ['💯'],
    denyEmoji: ['⛔', '👎'],
    previewMax: 400,
  }

  it('includes the tool arguments, not just the description', () => {
    // The whole point of the fix: for Bash, description is often "Run shell command".
    expect(formatPermissionPrompt(base)).toContain('rm -rf ./build')
  })

  it('still shows the command when the description carries no detail', () => {
    const out = formatPermissionPrompt({ ...base, description: 'Run shell command' })
    expect(out).toContain('rm -rf ./build')
  })

  it('says so explicitly when there is no description at all', () => {
    const out = formatPermissionPrompt({ ...base, description: '' })
    expect(out).toContain('(no description given)')
    expect(out).toContain('rm -rf ./build')
  })

  it('always offers the text fallback with the request id', () => {
    expect(formatPermissionPrompt(base)).toContain('"yes abcde"')
    expect(formatPermissionPrompt(base)).toContain('"no abcde"')
  })

  it('names the exact emoji the verdict poller matches', () => {
    const out = formatPermissionPrompt(base)
    expect(out).toContain('✅ = allow once')
  })

  it('names every accepted glyph, not just the first', () => {
    // The poller honours both ⛔ and 👎, so the prompt must not advertise only one.
    expect(formatPermissionPrompt(base)).toContain('⛔ or 👎 = deny')
  })

  it('reflects custom emoji rather than hardcoding the defaults', () => {
    // Prompt and poller read the same config, so they cannot drift apart.
    const out = formatPermissionPrompt({ ...base, allowEmoji: ['🟢'], denyEmoji: ['🔴'] })
    expect(out).toContain('🟢 = allow once')
    expect(out).toContain('🔴 = deny')
    expect(out).not.toContain('✅')
  })

  it('names the tool in the allow-always label, since the scope is the whole tool', () => {
    expect(formatPermissionPrompt(base)).toContain('allow Bash for the rest of this session')
  })

  it('omits the preview block entirely when there is no preview', () => {
    const out = formatPermissionPrompt({ ...base, inputPreview: '' })
    expect(out).not.toContain('\n\n\n')
    expect(out).toContain('Delete the build directory')
  })

  it('passes Claude Code redaction and elision markers through verbatim', () => {
    const out = formatPermissionPrompt({
      ...base,
      inputPreview: '{"token":"[REDACTED]","blob":"(value unserializable)","x":"⋯ 40 code points elided ⋯"}',
    })
    expect(out).toContain('[REDACTED]')
    expect(out).toContain('(value unserializable)')
    expect(out).toContain('⋯ 40 code points elided ⋯')
  })

  it('truncates an oversized preview rather than reading it all aloud', () => {
    const out = formatPermissionPrompt({ ...base, inputPreview: 'y'.repeat(5000), previewMax: 100 })
    expect(out).toContain('truncated for playback')
    expect(out.length).toBeLessThan(500)
  })
})

describe('findOpenRequest', () => {
  it('finds an open request by id', () => {
    const map = new Map([['cv-1', pending()]])
    expect(findOpenRequest(map, 'abcde', 5_000)).toBe('cv-1')
  })

  it('rejects an id we never relayed, so a guess cannot approve anything', () => {
    const map = new Map([['cv-1', pending()]])
    expect(findOpenRequest(map, 'zzzzz', 5_000)).toBeNull()
  })

  it('rejects an expired request even though the id matches', () => {
    const map = new Map([['cv-1', pending({ expiresAt: 1_000 })]])
    expect(findOpenRequest(map, 'abcde', 5_000)).toBeNull()
  })

  it('treats the expiry instant itself as expired', () => {
    const map = new Map([['cv-1', pending({ expiresAt: 5_000 })]])
    expect(findOpenRequest(map, 'abcde', 5_000)).toBeNull()
  })

  it('returns null on an empty map', () => {
    expect(findOpenRequest(new Map(), 'abcde', 5_000)).toBeNull()
  })

  it('picks the unexpired entry when an id was relayed more than once', () => {
    const map = new Map([
      ['cv-1', pending({ expiresAt: 1_000 })],
      ['cv-2', pending({ expiresAt: 9_000 })],
    ])
    expect(findOpenRequest(map, 'abcde', 5_000)).toBe('cv-2')
  })
})

describe('sweepExpired', () => {
  it('removes expired entries and reports them', () => {
    const map = new Map([
      ['cv-1', pending({ requestId: 'aaaaa', expiresAt: 1_000 })],
      ['cv-2', pending({ requestId: 'bbbbb', expiresAt: 9_000 })],
    ])
    const expired = sweepExpired(map, 5_000)
    expect(expired.map(e => e.requestId)).toEqual(['aaaaa'])
    expect([...map.keys()]).toEqual(['cv-2'])
  })

  it('is a no-op when nothing has expired', () => {
    const map = new Map([['cv-1', pending({ expiresAt: 9_000 })]])
    expect(sweepExpired(map, 5_000)).toEqual([])
    expect(map.size).toBe(1)
  })

  it('is a no-op on an empty map', () => {
    const map = new Map<string, PendingPermission>()
    expect(sweepExpired(map, 5_000)).toEqual([])
    expect(map.size).toBe(0)
  })

  it('leaves the map empty when everything has expired', () => {
    const map = new Map([
      ['cv-1', pending({ expiresAt: 1_000 })],
      ['cv-2', pending({ expiresAt: 2_000 })],
    ])
    expect(sweepExpired(map, 5_000)).toHaveLength(2)
    expect(map.size).toBe(0)
  })
})
