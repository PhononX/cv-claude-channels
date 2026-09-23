import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createActivitySignals,
  SIGNAL_BEAT_MS,
  SIGNAL_TTL_MS,
  SIGNAL_STOP_TTL_MS,
  type SignalSender,
} from './activity-signals.js'

// Deterministic test window: idle (turn-end fallback) well under the absolute cap
// so the two bounds are distinguishable, and both clear multiples of the beat.
const IDLE_MS = 8_000
const MAX_MS  = 40_000

type Sent = { conversationId: string; signalType: string; body?: string; ttlMs?: number }

function harness() {
  const sent: Sent[] = []
  const sendSignal: SignalSender = vi.fn((p: Sent) => {
    sent.push(p)
    return Promise.resolve()
  })
  const signals = createActivitySignals({ sendSignal, idleMs: IDLE_MS, maxMs: MAX_MS })
  const clearBeats = () => sent.filter(s => s.ttlMs === SIGNAL_STOP_TTL_MS)
  const heartbeats = () => sent.filter(s => s.ttlMs === SIGNAL_TTL_MS)
  return { sent, signals, clearBeats, heartbeats }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('startSignal heartbeat', () => {
  it('emits an immediate beat and then re-posts on the beat interval', () => {
    const { signals, sent, heartbeats } = harness()

    signals.startSignal('chan', 'thinking')
    expect(heartbeats()).toHaveLength(1)
    expect(sent[0]).toMatchObject({ conversationId: 'chan', signalType: 'thinking', ttlMs: SIGNAL_TTL_MS })

    vi.advanceTimersByTime(SIGNAL_BEAT_MS)
    expect(heartbeats()).toHaveLength(2)
    vi.advanceTimersByTime(SIGNAL_BEAT_MS)
    expect(heartbeats()).toHaveLength(3)
  })
})

describe('CV-13959: a turn that ends WITHOUT send_message still clears the dot', () => {
  it('stops heartbeating after the idle window and fires one min-ttl clear beat', () => {
    const { signals, clearBeats, heartbeats, sent } = harness()

    // Message handed to Claude → "thinking". Claude then ends its turn some other
    // way (no reply, terminal-only answer, error/abort): stopSignal is never called.
    signals.startSignal('chan', 'thinking')

    // Just before the idle window: still heartbeating, no clear beat yet.
    vi.advanceTimersByTime(IDLE_MS - 1)
    const beatsBeforeIdle = heartbeats().length
    expect(beatsBeforeIdle).toBeGreaterThan(1)
    expect(clearBeats()).toHaveLength(0)

    // Crossing the idle window: the heartbeat stops itself and emits exactly one
    // min-ttl clear beat so the client drops the dot in ~0.5s.
    vi.advanceTimersByTime(2)
    expect(clearBeats()).toHaveLength(1)
    expect(clearBeats()[0]).toMatchObject({ signalType: 'thinking', ttlMs: SIGNAL_STOP_TTL_MS })

    // And the heartbeat is truly gone — no further posts of any kind, even long
    // past the old 3-minute cap.
    const totalAfterClear = sent.length
    vi.advanceTimersByTime(SIGNAL_BEAT_MS * 200)
    expect(sent.length).toBe(totalAfterClear)
  })
})

describe('renewal keeps the dot alive; blind ticks do not reset the idle window', () => {
  it('a fresh edge (thinking → tool_call) re-arms idle without a spurious clear beat', () => {
    const { signals, clearBeats } = harness()

    signals.startSignal('chan', 'thinking')
    vi.advanceTimersByTime(IDLE_MS - 1_000) // near idle, but a new edge arrives

    // Supersede to tool_call — this is an observed edge, so it re-arms the idle
    // window. It must NOT emit a clear beat (no flicker between phases).
    signals.startSignal('chan', 'tool_call', 'Bash')
    expect(clearBeats()).toHaveLength(0)

    // The old idle deadline would have fired here; because it was re-armed, the
    // dot is still alive.
    vi.advanceTimersByTime(2_000)
    expect(clearBeats()).toHaveLength(0)

    // No further edges → the dot clears one idle window after the LAST edge.
    vi.advanceTimersByTime(IDLE_MS)
    expect(clearBeats()).toHaveLength(1)
    expect(clearBeats()[0]).toMatchObject({ signalType: 'tool_call', ttlMs: SIGNAL_STOP_TTL_MS })
  })
})

describe('stopSignal (the send_message reply path)', () => {
  it('clears immediately with a min-ttl beat and halts the heartbeat', () => {
    const { signals, clearBeats, sent } = harness()

    signals.startSignal('chan', 'thinking')
    vi.advanceTimersByTime(SIGNAL_BEAT_MS * 2)

    signals.stopSignal('chan')
    expect(clearBeats()).toHaveLength(1)
    expect(clearBeats()[0]).toMatchObject({ ttlMs: SIGNAL_STOP_TTL_MS })

    const total = sent.length
    vi.advanceTimersByTime(SIGNAL_BEAT_MS * 50)
    expect(sent.length).toBe(total)
  })

  it('is a no-op for a channel with no live signal', () => {
    const { signals, sent } = harness()
    signals.stopSignal('nobody')
    expect(sent).toHaveLength(0)
  })
})

describe('absolute cap is carried across supersede', () => {
  it('a turn that keeps superseding still clears by the max cap, not indefinitely', () => {
    const { signals, clearBeats } = harness()

    signals.startSignal('chan', 'thinking') // arms the cap at t=0 for MAX_MS

    // Keep superseding every 7s (< IDLE_MS) so the idle window never fires; only the
    // absolute cap can end this turn.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(7_000)
      signals.startSignal('chan', 'tool_call', 'loop')
    } // now at t=35_000, idle re-armed, cap still due at 40_000

    vi.advanceTimersByTime(4_000) // t=39_000, before the cap
    expect(clearBeats()).toHaveLength(0)

    vi.advanceTimersByTime(2_000) // t=41_000, past the cap
    expect(clearBeats()).toHaveLength(1)
  })
})

describe('stopAllSignals', () => {
  it('clears every live channel', () => {
    const { signals, clearBeats } = harness()
    signals.startSignal('a', 'thinking')
    signals.startSignal('b', 'tool_call', 'Bash')
    signals.stopAllSignals()
    expect(clearBeats()).toHaveLength(2)
    expect(new Set(clearBeats().map(c => c.conversationId))).toEqual(new Set(['a', 'b']))
  })
})
