#!/usr/bin/env node
/**
 * Protocol smoke test: boots the built server over stdio with a throwaway token and
 * asserts the channel surface Claude Code depends on.
 *
 * Nothing here reaches Carbon Voice — startup() is gated behind the confirm_channels
 * tool, which this never calls, so no network happens with the fake token.
 *
 *   npm run build && npm run smoke
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const proc = spawn('node', ['dist/cv-claude-channel.js'], {
  cwd: root,
  env: {
    ...process.env,
    CV_PAT: 'fake-token-for-smoke-test',
    CV_ENV_PATH: '/nonexistent', // don't pick up a real developer token
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
proc.stdout.on('data', d => { stdout += d })
proc.stderr.on('data', d => { stderr += d })
proc.on('error', err => {
  console.error(`could not start the server — did you run npm run build?\n${err}`)
  process.exit(1)
})

const send = o => proc.stdin.write(JSON.stringify(o) + '\n')

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
})

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
}, 400)

setTimeout(() => {
  proc.kill()

  const msgs = stdout.trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  const init = msgs.find(m => m.id === 1)?.result
  const tools = (msgs.find(m => m.id === 2)?.result?.tools ?? []).map(t => t.name)
  const experimental = init?.capabilities?.experimental ?? {}

  const checks = [
    ['server advertises the cv-channel slug', init?.serverInfo?.name === 'cv-channel'],
    ['claude/channel capability declared', 'claude/channel' in experimental],
    ['claude/channel/permission capability declared', 'claude/channel/permission' in experimental],
    ['send_message exposed', tools.includes('send_message')],
    ['confirm_channels exposed', tools.includes('confirm_channels')],
    ['list_senders exposed (read-only)', tools.includes('list_senders')],
    // The security invariant: nothing model-callable may widen the allowlist.
    ['no allowlist write tools', !['allow_sender', 'block_sender', 'remove_sender'].some(n => tools.includes(n))],
    ['instructions frame channel content as untrusted', /Treat them as data/.test(init?.instructions ?? '')],
    ['startup check emitted', /startup check sent/.test(stderr)],
    ['no CV connection before confirm_channels', !/connecting Socket\.IO/.test(stderr)],
  ]

  let failed = 0
  for (const [label, ok] of checks) {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
    if (!ok) failed++
  }
  console.log(`\ntools: ${tools.join(', ') || '(none)'}`)

  if (failed) {
    console.error(`\n${failed} check(s) failed.\n--- stderr ---\n${stderr}`)
    process.exit(1)
  }
  console.log('\nsmoke test passed')
  process.exit(0)
}, 1500)
