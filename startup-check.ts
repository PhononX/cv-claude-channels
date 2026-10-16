// Claude Code can drop a channel notification that arrives before the session is ready for it
// (while the folder-trust or development-channel prompt is on screen, for example). The
// startup check is the only thing that turns the channel on, so it is re-sent until
// confirm_channels arrives: quickly at first, then once a minute.
const DELAYS_MS = [5_000, 10_000, 20_000, 30_000]
const STEADY_MS = 60_000

export function startupCheckDelay(attempt: number): number {
  return DELAYS_MS[attempt] ?? STEADY_MS
}
