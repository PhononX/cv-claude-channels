/**
 * activity-signals.ts
 * Ephemeral "thinking"/"tool_call" activity indicator for a CV conversation.
 *
 * The channel server can't see Claude's think/tool loop directly — it observes a
 * few edges: handing a message to Claude (→ thinking), a permission request for a
 * gated tool (→ tool_call), and send_message (→ stop). The signal has no
 * server-side TTL, so we re-POST on an interval while a turn is "in flight".
 *
 * Lifecycle rule (mirrors cv-agents' ActivityLease, PhononX/cv-agents#6):
 * **"absence of renewal = stopped"**. A turn ends the instant Claude stops
 * producing observable activity — which is NOT only the send_message edge. A turn
 * that replies another way, produces no send_message, errors/aborts, or blocks on
 * a permission prompt nobody answers must ALSO clear the dot. Claude Code sends the
 * channel no turn-completion event (its channel protocol only carries `channel`,
 * `permission`, and `permission_request`), so renewal is bounded two ways:
 *   - IDLE: the heartbeat stops itself after `idleMs` with no fresh edge, letting
 *     the client's ttl clear the dot within seconds of the turn going quiet. This
 *     is the fix for the stuck "thinking" dot (CV-13959): correctness lives in the
 *     ttl, and we stop renewing rather than heartbeating on until the hard cap.
 *   - MAX:  an absolute per-turn cap (carried across supersede) bounds a runaway
 *     turn that keeps generating edges so the dot can't outlive the turn either.
 *
 * Extracted from cv-claude-channel.ts so the lifecycle is testable without booting
 * the MCP server (same reason permission-relay.ts is its own module).
 */

import type { SignalType } from './cv-api.js'

export const SIGNAL_BEAT_MS     = 1_500   // re-post cadence (contract: every 1-2s)
export const SIGNAL_TTL_MS      = 4_000   // client-side expiry hint while heartbeating
export const SIGNAL_STOP_TTL_MS = 500     // ttl on the final "clear" beat (server min)
// How long the heartbeat keeps renewing with no fresh edge before it clears itself.
// This is the turn-end fallback for every path that never calls stopSignal (no
// send_message, error/abort, ignored permission). Kept comfortably above the gaps
// between observable edges so a live turn stays lit; env-overridable like the other
// timeouts.
export const SIGNAL_IDLE_MS     = Number(process.env.CV_SIGNAL_IDLE_MS ?? 15_000)
// Absolute safety cap: even a turn that keeps generating edges clears after this.
export const SIGNAL_MAX_MS      = Number(process.env.CV_SIGNAL_MAX_MS ?? 180_000)

export interface SignalSender {
  (params: {
    conversationId: string
    signalType: SignalType
    body?: string
    ttlMs?: number
  }): Promise<unknown>
}

export interface ActivitySignals {
  /** Start (or supersede) the activity indicator for a channel and heartbeat it. */
  startSignal(channelId: string, signalType: SignalType, body?: string): void
  /** Clear the indicator now (fires a min-ttl beat so the dot drops in ~0.5s). */
  stopSignal(channelId: string): void
  /** Clear every live indicator (used on shutdown). */
  stopAllSignals(): void
}

/**
 * Build an ActivitySignals bound to a `sendSignal` implementation. The sender is
 * injected so tests can drive the lifecycle with a stub and fake timers.
 */
export function createActivitySignals(deps: {
  sendSignal: SignalSender
  idleMs?: number
  maxMs?: number
}): ActivitySignals {
  const { sendSignal } = deps
  const idleMs = deps.idleMs ?? SIGNAL_IDLE_MS
  const maxMs  = deps.maxMs  ?? SIGNAL_MAX_MS

  const signalBeats = new Map<string, {
    beat: ReturnType<typeof setInterval>
    idle: ReturnType<typeof setTimeout>
    cap: ReturnType<typeof setTimeout>
    signalType: SignalType
    body?: string
  }>()

  function stopSignal(channelId: string): void {
    const entry = signalBeats.get(channelId)
    if (!entry) return
    clearInterval(entry.beat)
    clearTimeout(entry.idle)
    clearTimeout(entry.cap)
    signalBeats.delete(channelId)
    // The endpoint has no explicit "clear" — a client keeps the indicator alive for
    // the last signal's ttl_ms. Send one final beat of the same type with the
    // minimum ttl so the dot clears in ~0.5s instead of coasting out the full window.
    sendSignal({ conversationId: channelId, signalType: entry.signalType, body: entry.body, ttlMs: SIGNAL_STOP_TTL_MS }).catch(() => {})
  }

  function startSignal(channelId: string, signalType: SignalType, body?: string): void {
    const existing = signalBeats.get(channelId)
    // Carry the absolute cap across a supersede (thinking → tool_call → …) so it
    // measures the whole turn — only the first signal of a turn arms it. A fresh
    // turn (no live entry) arms a new one.
    const cap = existing?.cap ?? (() => {
      const t = setTimeout(() => stopSignal(channelId), maxMs)
      t.unref?.()
      return t
    })()
    // Replace the heartbeat and idle timer for the new phase, leaving the cap intact.
    if (existing) {
      clearInterval(existing.beat)
      clearTimeout(existing.idle)
    }
    const tick = () => { sendSignal({ conversationId: channelId, signalType, body, ttlMs: SIGNAL_TTL_MS }).catch(() => {}) }
    tick()
    const beat = setInterval(tick, SIGNAL_BEAT_MS)
    // Absence of renewal = stopped: with no fresh edge inside the idle window, stop
    // heartbeating and let the client's ttl clear the dot. Every startSignal (a real
    // observed edge) re-arms this; the blind beat ticks deliberately do not.
    const idle = setTimeout(() => stopSignal(channelId), idleMs)
    beat.unref?.()
    idle.unref?.()
    signalBeats.set(channelId, { beat, idle, cap, signalType, body })
  }

  function stopAllSignals(): void {
    for (const channelId of [...signalBeats.keys()]) stopSignal(channelId)
  }

  return { startSignal, stopSignal, stopAllSignals }
}
