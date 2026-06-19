# cv-claude-channels — Development Guide

## What This Is

An MCP server that bridges **Carbon Voice conversations into Claude Code sessions**. When someone sends a voice message in Carbon Voice, Claude receives it in real-time and can reply back with text-to-speech. Also relays permission prompts so you can approve dangerous tool operations (Bash, Write, Edit) from anywhere via Carbon Voice.

Published as `@carbonvoice/cv-claude-channel` on npm.

## Key Architecture

### Message Flow
1. **Inbound**: Messages arrive from Carbon Voice via WebSocket (primary) or polling (fallback).
2. **Deduplication**: In-memory cache with TTL (default 5m) prevents duplicate processing.
3. **Sender gating**: Allowlist-by-default — unknown senders trigger a notification for you to allow.
4. **Claude receives**: As a `<channel>` tag with `source="carbon-voice"`, `channel_id`, `sender_id`, `message_id`, `reply_to_id`.
5. **Claude replies**: Calls `send_message` tool with channel_id, reply_to_message_id, and text. CV auto-converts to audio.

### Permission Relay
When Claude needs approval for dangerous tools:
1. Permission request arrives as a notification.
2. **CV-13261 addition**: Now builds a `cv_agent_ui` permission card (Flutter interactive UI) and attaches it to the permission message.
3. User reacts or types approval in Carbon Voice.
4. Reaction ID is polled to complete the permission check.
5. Falls back to text (`yes`/`no`) if card fails or reaction IDs are unavailable.

### State Persistence
- **Cursor**: Last-seen message timestamp saved to disk (`~/.claude/channels/cv/state.json`).
- **Allowlist**: Sender allowlist/blocklist persisted to disk, survives restarts.
- **Dedup cache**: In-memory only, clears on restart (intentional — errors are rare and bouncing is low-cost).

## Current Work (CV-13261)

**Branch**: `CV-13261-agent-ui-permission-attachment`

**Goal**: Attach an interactive permission-card to permission prompts so users can tap approve/deny in Carbon Voice instead of typing `yes abcde`.

**Changes**:
- Extracted `buildPermissionUiAttachment()` function into dedicated `permission-ui.ts` module (was inline in `cv-claude-channel.ts`).
- Moved `AGENT_UI_MIME` constant to the same module.
- Added `permission-ui.test.ts` for the UI builder.
- `cv-claude-channel.ts` now imports the function and passes reaction IDs resolved from pending permissions.

**Status**: Refactor complete, tests added, awaiting review/testing.

## Development Setup

```bash
npm install
npm start              # Run locally (requires CV_PAT env var)
npm run build          # Compile TypeScript
npm test               # Run vitest
npm test:watch        # Watch mode
```

### Environment Variables
- `CV_PAT` (required): Personal Access Token from Carbon Voice.
- `CV_API_BASE` (optional): Override API endpoint (default: `https://api.carbonvoice.app`). Useful for local testing.
- `CV_CONVERSATION_ID` (optional): Filter to a specific conversation.
- `CV_REACTION_ID` (optional): Auto-add reaction on message receipt.
- `CV_SEEN_TTL_MS` (optional): Dedup TTL, milliseconds (default: 300000 = 5 min).
- `CV_POLL_INTERVAL_MS` (optional): Polling interval, milliseconds (default: 5000).
- `CV_WS_RETRY_MAX_MS` (optional): Max WebSocket backoff, milliseconds (default: 30000).
- `CV_STATE_PATH` (optional): Path to state file (default: `~/.claude/channels/cv/state.json`).

## Code Layout

- **cv-claude-channel.ts** (main): MCP server setup, message loop, permission relay, sender gating, state persistence.
- **permission-ui.ts**: Builds the `cv_agent_ui` permission-card payload (JSON with actions, metadata).
- **permission-ui.test.ts**: Tests the card builder.
- **cv-api.ts**: CV API client wrapper (types, auth, message/permission endpoints).
- **package.json**: Node.js target: >= 18.0.0. Type: module (ES modules).

## Key Concepts

### Reaction IDs
The permission card uses **reaction IDs** to round-trip the user's decision (allow, allow-always, deny) back to Claude without extra server machinery. Each action in the card carries the reaction ID that corresponds to its meaning. User taps button → adds reaction → we poll for it → check its existence.

### Deduplication
Messages are keyed by `(channel_id, message_id, sender_id)` with a TTL. If the same message arrives twice within the window, we drop the duplicate. Useful when WebSocket + polling overlap.

### Offline Fallback
If WebSocket drops, the client switches to polling the `/v3/messages/recent` endpoint. Polling includes a 5-second backoff. When connection restores, we resume from the last-seen cursor.

### Sender Allowlist
All senders denied by default. Calling `allow_sender(user_id)` adds them to the allowlist. Calling `block_sender(user_id)` adds them to a blocklist (overrides allowlist). Both are persisted and survive restarts.

## Testing

```bash
npm test
```

Tests use **vitest**. Current coverage:
- `permission-ui.test.ts`: Verifies the permission card builder creates valid payloads with correct action metadata.

Run `npm test:watch` to re-run on file changes.

## Commits & History

- **b9e33fe**: Make CV_API_BASE configurable for local testing.
- **403dccc**: CV-13261: attach cv_agent_ui permission card to permission messages.
- **cd3ab21**: Merge PR #1 (add-attachment-support from PhononX).
- **bdb5c11**: Add tests.

## Common Workflows

### Running Locally Against cv-api
```bash
CV_PAT=your-token CV_API_BASE=http://localhost:3000 npm start
```

### Debugging Permission Flow
Add logs in `checkPendingPermissions()` to watch for reaction polling. Each reaction ID is tied to a specific action (allow, deny, allow-always).

### Publishing to npm
```bash
npm run build
npm publish
```

Requires npm login and access to `@carbonvoice` org.

## Known Limitations

- **No typing indicator** yet (CV API doesn't support it).
- **Reactions are the only callback mechanism** for permissions — if the user doesn't react, the permission times out.
- **Dedup cache is in-memory** — if the server crashes and restarts, a message that arrived just before the crash might get reprocessed. Low risk because messages are idempotent.

## Integration with Broader Carbon Voice Stack

- **carbon-voice-flutter**: Receives permission cards and other agent-UI payloads via the custom MIME type (`application/vnd.carbonvoice.agent-ui+json`). Renders them as interactive cards.
- **cv-api**: Backend serving messages, permissions, reactions, sender lists.
- **Claude Code**: The host — calls MCP tools, receives channel tags, approves tool use.

See `/Users/cristian/.claude/CLAUDE.md` for repo map and broader context.

## Style & Conventions

- **No git worktrees** in this project; work on branches in the root.
- **Small commits**: Refactors, features, and fixes are one commit each.
- **Type safety**: TypeScript strict mode. Zod for schema validation.
- **Imports**: ES modules only (`import`/`export`, no CommonJS).
- **Comments**: Minimal. Only explain *why*, not *what*. Naming should make the code self-documenting.
