# Agent ↔ Client Interaction Protocol — cv-claude-channels (agent) Implementation Plan

**Date:** 2026-06-18
**Branch:** `agent-interaction-protocol`
**Repo:** cv-claude-channels (TypeScript MCP integration bridging Claude Code ↔ cv-api)
**Spec (source of truth):** `agent-client-interaction-protocol.md` v0.1
**Cross-repo master plan:** carbon-voice-flutter `docs/plans/agent-interaction-protocol-plan.md`
**Scope of this doc:** ONLY the agent integration — introduce `elicit(request) -> outcome` and make
the permission turn actually suspend/resume over the new protocol. cv-api and the Flutter client
have their own plans on their own `agent-interaction-protocol` branches.

---

## Overview

Today the integration is **fire-and-forget + poll**: it posts a permission prompt to cv-api, stores
the request in an in-memory `pendingPermissionMessages` map, and a 5s poll scans `reaction_summary`
for a verdict (or matches a `yes/no <id>` text reply) before notifying Claude Code. There is **no
correlated, awaitable suspend** — the actual block lives in Claude Code's MCP permission broker.

This plan introduces a single boundary — `elicit(request) -> outcome` — that **posts a first-class
`action_request` to cv-api and awaits the correlated `action_response`** (delivered over the socket
the integration already holds), replacing the reaction-polling round-trip. The MCP relay code reads
linearly: `const outcome = await elicit(req)` → notify Claude Code.

## Current State Analysis

- **Entry/loop:** `cv-claude-channel.ts` self-executes (shebang); MCP over stdio, cv-api connection
  in `cv-api.ts` `createConnection()`. Primary transport = socket.io (`message:created`/`updated`
  → `onMessageActivity` → `fetchMissedMessages`), REST poll fallback (`CV_POLL_INTERVAL_MS`, 5s).
- **Permission request handler:** `cv-claude-channel.ts` registers `PermissionRequestSchema`
  (`notifications/claude/channel/permission_request`) and sends back
  `notifications/claude/channel/permission { request_id, behavior }`. Handler builds the UI card via
  `buildPermissionUiAttachment()` (`permission-ui.ts`, MIME `application/vnd.carbonvoice.agent-ui+json`),
  posts via `sendMessage()` (`cv-api.ts` → `POST /v5/messages/text`), stores
  `state.pendingPermissionMessages.set(cvMessageId, { requestId, channelId, toolName })`.
- **Response detection (to be replaced):** `checkPendingPermissions(messages)` scans
  `reaction_summary.top_user_reactions` against `state.permissionReactionIds` (allow/allowAlways/deny,
  resolved at startup by `loadReaction()`); text-reply path matches `PERMISSION_REPLY_RE`
  (`/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`) in `processMessage()`. Called every poll from
  `fetchMissedMessagesOnce()`.
- **cv-api client:** `cvFetch(method, endpoint, body)` (Bearer PAT, `CV_API_BASE`); socket.io
  `io(CV_API_BASE, { auth: { authorization: Bearer }, transports:['websocket'] })`; listeners
  `message:created` / `message:updated`.
- **State:** all in-memory except `lastCheckedAt` (STATE_PATH) and access lists (ACCESS_PATH).
  `pendingPermissionMessages` is **lost on restart**; there are **no timeouts** on pending requests.
- **Tests/build:** vitest (`permission-ui.test.ts`, `cv-api.test.ts`); dev `tsx`, build `tsc`;
  local MCP via `.mcp.json`.

### Key discoveries
- The UI-card builder (`permission-ui.ts`) is **reused unchanged** — only the response path moves
  from reactions to the endpoint, and the request can additionally be a first-class envelope.
- The socket connection already exists, so awaiting an `action_response` event is a natural, lower-
  latency replacement for the 5s reaction poll (no held-open HTTP).
- Reaction IDs the card embeds (`state.permissionReactionIds`) map directly to ACP option `kind`s.

## Desired End State

- An `elicit(request)` function that: builds/sends the `action_request`, registers a per-`requestId`
  `Promise<Outcome>`, enforces a timeout, resolves when the `action_response` arrives over the
  socket, and returns the `outcome`.
- The MCP permission handler calls `await elicit(...)` and notifies Claude Code with the mapped
  `behavior`. The reaction-polling path (`checkPendingPermissions`) is removed from the hot loop.
- Restart-safety improved by the durable server record (the agent can re-query via
  `GET …/action-requests/:id` on reconnect); in-memory promise loss on restart is acceptable for v1
  (Claude Code retries/times out).

Verify: a Claude Code permission request renders a card in the app, a tap resolves it, and Claude
Code proceeds — with no reaction involved.

## What We're NOT Doing

- **Not** changing Claude Code's MCP permission contract (`permission_request` / `permission`
  notifications stay).
- **Not** implementing Style B durable checkpointing in the agent (the `elicit()` interface is the
  seam; the v1 mechanism is event-resolved in-memory promise + timeout).
- **Not** adding `choice` / `form` *emission* from this integration in v1 (Claude Code only sends
  tool-permission requests). The `elicit()` contract is general enough to carry them later.
- **Not** removing the legacy prose + reaction fallback until the cutover (master plan Appendix A).

## Implementation Approach

`elicit()` presents Style-A ergonomics (`await`) but resolves off a socket event (closer to Style B,
no long-lived HTTP). Keep the legacy reaction/text-reply path behind a feature flag during rollout so
non-updated clients still work, then delete it.

---

## Phase 1: cv-api client — request + response transport

### Changes Required (`cv-api.ts`)
1. `postActionRequest(channelId, envelope) -> { requestId }` → `POST /channels/{channelId}/action-requests` (Bearer PAT). Envelope = spec `ActionRequest` (intent `permission`, `render` options with ACP `kind`s, `agent`, `title`/`body`, `blocking`, `expiresInSeconds`).
2. A module-level `pendingRequests: Map<requestId, { resolve, reject, timer }>` registry.
3. In `createConnection()`, add a socket listener `socket.on('action_response', payload => { ... resolve pendingRequests.get(payload.requestId) ... })`.
4. `getActionRequest(channelId, requestId)` → `GET …/action-requests/{id}` for reconnect recovery.

### Success Criteria
#### Automated Verification
- [ ] `npm run build`; `npm test`
- [ ] Unit test (vitest, mocked fetch/socket): `postActionRequest` hits the right URL/body; an injected `action_response` resolves the matching promise; a non-matching id is ignored.
#### Manual Verification
- [ ] Against a local cv-api on the matching branch, a posted request returns a `requestId` and an answer arrives as an `action_response` event.

---

## Phase 2: `elicit()` interface

### Changes Required
**File:** `elicit.ts` (new). `async function elicit(req, { timeoutMs = 300_000 }): Promise<Outcome>`:
- build the envelope (reuse `buildPermissionUiAttachment` payload shape for `render`),
- `postActionRequest`, register the promise, arm `setTimeout`/`AbortController` → resolve `{ outcome: 'cancelled' }` on timeout,
- resolve on the socket `action_response`,
- return `{ outcome, optionId?, optionIds?, data? }`.
Map ACP ↔ ours: `outcome 'selected' + optionId 'allow_once'|'allow_always' → behavior 'allow'`;
`'reject_once' / outcome 'declined' → 'deny'`; `'cancelled' → 'deny'` (safe default) or per-policy.

### Success Criteria
#### Automated Verification
- [ ] Unit tests: resolve-on-response, timeout→cancelled, double-resolve ignored, mapping table correct.
#### Manual Verification
- [ ] `elicit()` returns the correct outcome for allow/always/deny in a live round-trip.

---

## Phase 3: Refactor the MCP permission handler

### Changes Required (`cv-claude-channel.ts`)
- In the `permission_request` handler, replace the manual `sendMessage` + `pendingPermissionMessages.set` block with:
  ```ts
  const outcome = await elicit({ channelId: ctx.channelId, intent: 'permission',
    requestId: params.request_id, title, render: optionsFromReactionIds(state.permissionReactionIds),
    runId, expiresInSeconds });
  await mcp.notification({ method: 'notifications/claude/channel/permission',
    params: { request_id: params.request_id, behavior: outcomeToBehavior(outcome) } });
  ```
- Keep auto-approve for `state.allowAlwaysTools` and the self-tool skip.
- **Remove** `checkPendingPermissions()` from `fetchMissedMessagesOnce()` (behind the rollout flag).
- Retire `state.pendingPermissionMessages` once the flag is on (the registry lives in `cv-api.ts`).
- Keep the `PERMISSION_REPLY_RE` text-reply path as an additional resolver routed into the same
  registry (so power users can still type `yes <id>`), or drop it if the server handles text replies.

### Success Criteria
#### Automated Verification
- [ ] `npm run build`; existing tests still green.
- [ ] Lint clean.
#### Manual Verification
- [ ] Claude Code → permission request → card in app → tap → Claude Code proceeds, **no reaction used**.
- [ ] Timeout: ignoring the card eventually denies/cancels and Claude Code degrades gracefully.

---

## Phase 4: Rollout flag + legacy bridge

### Changes Required
- `CV_PROTOCOL_MODE` env (`legacy` | `protocol`, default `legacy` initially). `legacy` keeps today's
  attachment + reaction polling; `protocol` uses `elicit()`. Lets us ship without breaking older
  Flutter clients (master plan Appendix A). Flip to `protocol` once the Flutter branch ships.
- In `protocol` mode, still post the legacy prose text as a non-interactive fallback line if desired
  (optional; the server-rendered feed message is primary).

### Success Criteria
#### Automated Verification
- [ ] Both modes covered by tests; default mode documented.
#### Manual Verification
- [ ] In `legacy` mode behavior is unchanged; in `protocol` mode the endpoint round-trip drives it.

---

## Testing Strategy
- **Unit (vitest):** `cv-api.ts` request/response transport (mocked fetch + socket), `elicit()`
  resolve/timeout/mapping, handler refactor with a stubbed `elicit`.
- **Manual:** live round-trip against local cv-api + Flutter on matching branches; allow/always/deny
  + timeout; restart mid-pending (agent re-queries via `getActionRequest`).

## Migration Notes
The `package-lock.json` change and untracked `.codex/` / `AGENTS.md` / `CLAUDE.md` currently in the
working tree are pre-existing and unrelated — keep them out of any protocol commit. Legacy mode is
the default until the Flutter client ships; cutover is a single env flip + later deletion of
`checkPendingPermissions` and `pendingPermissionMessages`.

## References
- Spec: `agent-client-interaction-protocol.md` (§8 suspend/resume + `elicit`, §6 contracts, §13 ACP interop).
- Master plan: carbon-voice-flutter `docs/plans/agent-interaction-protocol-plan.md`.
- Code to refactor: `cv-claude-channel.ts` (permission handler, `checkPendingPermissions`,
  `fetchMissedMessagesOnce`, `state.pendingPermissionMessages`, `PERMISSION_REPLY_RE`),
  `cv-api.ts` (`cvFetch`, `createConnection`, socket listeners), `permission-ui.ts` (reused).

## Open items (cross-team, from master plan)
- A/B sign-off — v1 = event-resolved in-memory promise (this plan).
- Whether the server also handles `yes/no <id>` text replies, or the agent keeps that resolver.
- `runId` / agent-identity source for the envelope (Fred).
