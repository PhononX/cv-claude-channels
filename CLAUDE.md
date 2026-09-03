# cv-claude-channels — Development Guide

## What This Is

An MCP channel server that bridges **Carbon Voice conversations into Claude Code sessions**. When someone sends a voice message in Carbon Voice, Claude receives it in real-time and can reply back with text-to-speech. Also relays permission prompts so you can approve dangerous tool operations (Bash, Write, Edit) from anywhere via Carbon Voice.

Published as `@carbonvoice/cv-claude-channel` on npm, and installable as the `carbon-voice` plugin from the `carbonvoice` marketplace (the npm tarball *is* the plugin).

## Key Architecture

### Message Flow
1. **Inbound**: Messages arrive from Carbon Voice via WebSocket (primary) or polling (fallback).
2. **Deduplication**: Server-side reaction marker plus an in-memory cursor prevent duplicate processing.
3. **Sender gating**: Deny-by-default allowlist. Under `dmPolicy: "pairing"` an unknown sender is replied to in CV with a 6-character code and the operator runs `/carbon-voice:access pair <code>`; under `"allowlist"` they are dropped silently. Either way Claude is notified once per sender, and only the *operator* can act.
4. **Claude receives**: As a `<channel>` tag with `channel_id`, `sender_id`, `message_id`, `reply_to_id`. The `source` attribute is set by Claude Code from the server name — do not set `source` in `meta`.
5. **Claude replies**: Calls `send_message` with channel_id, reply_to_message_id, and text. CV auto-converts to audio.

### Permission Relay
1. Claude Code sends `notifications/claude/channel/permission_request` with `request_id`, `tool_name`, `description`, `input_preview`.
2. We format a prompt (`permission-relay.ts`) that includes **`input_preview`**, not just `description` — for Bash the description is often the bare constant `Run shell command`.
3. The prompt goes to the conversation that most recently spoke, provided that context is fresher than `CV_PERMISSION_CONTEXT_TTL_MS`.
4. The user reacts (✅ / 💯 / 👎) or replies `yes <id>` / `no <id>`.
5. We emit `notifications/claude/channel/permission` with `behavior: 'allow' | 'deny'`.

Only `allow` and `deny` exist on the wire. "Allow always" is ours: it adds the tool name to a session-only set (`state.allowAlwaysTools`) and sends `allow`.

### State Persistence
- **Cursor**: Last-checked timestamp on disk (`<config>/channels/cv/state.json`), debounced 5s.
- **Allowlist**: `<config>/channels/cv/access.json`. **Read-only to this server** — see below.
- **Pairing codes**: `<config>/channels/cv/pending.json`. **Server-owned**, read by the skill.
- **Token**: `<config>/channels/cv/.env`, written by `/carbon-voice:configure`.
- **Pending permissions**: In-memory, with a TTL sweep.

`<config>` is `CLAUDE_CONFIG_DIR` if set, else `~/.claude`. Server and skills
resolve it identically; individual files can be overridden with `CV_ACCESS_PATH`,
`CV_PENDING_PATH`, `CV_STATE_PATH`, `CV_ENV_PATH`, `CV_ATTACHMENTS_DIR`.

## Security Model

Three invariants worth not breaking:

1. **The server never writes the allowlist.** There is no MCP tool that can add a sender. Only `/carbon-voice:access` (a user-invocable skill that refuses channel-originated requests) writes `access.json`; the server reloads it on mtime change. This exists because inbound transcripts, forwarded messages, and attachment contents all reach Claude unfenced — if a tool could widen access, one crafted message could escalate. And allowlist membership is what authorizes permission approval.
2. **The server ignores its own reactions** when resolving permission verdicts, so its processed-marker reaction can never read as an approval.
3. **Pairing codes are a request, not a grant.** The server writes `pending.json`
   but never `access.json`, so issuing a code cannot widen access — only the
   operator typing `pair <code>` does. This split is why pairing does not
   weaken invariant 1.

`dmPolicy` migration: a fresh install (no `access.json`) defaults to `pairing`
so the first sender can be captured. An **existing** file with no `dmPolicy`
migrates to `allowlist` — upgrading must never open a door the operator did not
ask for.

If you add a tool, ask whether an inbound message could talk Claude into calling it.

## Development Setup

```bash
npm install
npm start              # run against the TS source (requires a token)
npm run build          # compile to dist/
npm test               # vitest
npm run test:watch     # watch mode
```

### The reliable dev loop: the bare server

Put the entry in **user-level `~/.claude.json`** with an absolute path (not the
project `.mcp.json`, which is now the plugin's own file):

```json
{ "mcpServers": { "cv-claude-channel": {
  "command": "npx",
  "args": ["tsx", "/abs/path/to/cv-claude-channels/cv-claude-channel.ts"],
  "env": { "CV_PAT": "..." }
} } }
```

```bash
claude --dangerously-load-development-channels server:cv-claude-channel
```

No build, no marketplace, and it exercises every server behavior.

### Loading the plugin itself — unresolved

```bash
npm run build                      # the plugin's .mcp.json runs dist/
claude plugin validate . --strict  # this works
```

`claude --plugin-dir . plugin list --json` reports the id as
`carbon-voice@inline`, but passing `plugin:carbon-voice@inline` to
`--dangerously-load-development-channels` was **reported failing** with "plugin
not installed", and `@carbonvoice` only resolves once the npm package is
published. The dev flag may not accept a session-scoped plugin from the
synthetic `inline` marketplace at all. Until this is settled, use the bare
server above.

Related unresolved packaging problem: `dist/` is gitignored, so a **git**-sourced
plugin has no compiled output for `.mcp.json` to run, while the **npm** source
has `dist/` but may arrive without `node_modules`. Neither source type is
verified end-to-end yet. Options if it needs solving: commit `dist/`, or have
`.mcp.json` run the TypeScript source via `tsx`.

### Environment Variables

`CV_PAT` is the only required setting, and `/carbon-voice:configure` can supply it instead. See the table in `README.md` for the full list — it is the canonical reference. Notable ones when working on the permission relay:

- `CV_PERMISSION_TTL_MS` (600000): how long a relayed prompt stays answerable.
- `CV_PERMISSION_CONTEXT_TTL_MS` (600000): how stale the target conversation may be before we decline to relay at all.
- `CV_PERMISSION_PREVIEW_MAX` (400): characters of `input_preview` included, trimmed for playback.
- `CV_LOG_FILE`: mirror stderr to a file. Essential for debugging the relay.

## Code Layout

- **cv-claude-channel.ts** (main): MCP server setup, message loop, permission relay, sender gating, state persistence.
- **permission-relay.ts**: pure helpers — verdict parsing, prompt formatting, pending-request bookkeeping. Extracted so it is testable without booting the server.
- **permission-relay.test.ts**: tests for the above.
- **cv-api.ts** / **cv-api.test.ts**: CV API client wrapper.
- **.claude-plugin/plugin.json**: plugin manifest.
- **.claude-plugin/marketplace.json**: marketplace catalog; points at the npm package.
- **.mcp.json**: plugin-supplied server config. **Committed** — `--plugin-dir .` and `claude plugin validate` both need it, and the npm tarball is the plugin. Because the plugin root is also the repo root, opening this repo in Claude Code will offer it as a *project* MCP server, where `${CLAUDE_PLUGIN_ROOT}` doesn't expand and the entry fails. Decline it; use `--plugin-dir .` to test the real thing. Claude Code does **not** read `.mcp.json.local` — for a bare-server dev loop put the entry in user-level `~/.claude.json` with an absolute path instead. **Upgrading from before 0.2.0: back up your local `.mcp.json` first.** It used to be gitignored, and git silently overwrites an ignored file when a commit starts tracking it — pulling will destroy your dev config with no warning or conflict.
- **skills/access/SKILL.md**: `/carbon-voice:access`.
- **skills/configure/SKILL.md**: `/carbon-voice:configure`.
- **package.json**: Node >= 18, ESM. The `files` allowlist controls the tarball; there is deliberately no `.npmignore`.

`tsconfig.json` only lists `cv-claude-channel.ts` in `include` — everything else is pulled in transitively. Test files are not typechecked by `tsc`; run `npx tsc --noEmit` to check the server.

## Key Concepts

### Reaction IDs
Permission verdicts round-trip via reactions: each of allow / allow-always / deny maps to a reaction ID resolved at startup from a name, code, or ID. Resolution happens inside `startup()`, which is gated behind `confirm_channels`, so the IDs are `null` until the channel is confirmed — the prompt only advertises the emoji once they resolve, and otherwise offers just the text fallback.

The processed marker and the "allow once" reaction default to the same reaction (`acknowledged`). They are only ever compared against different messages and the server ignores its own reactions, but the server logs a warning if they collide.

### Deduplication
A reaction on the source message is the durable processed marker (survives restarts); the cursor bounds what gets fetched. If the same message arrives twice, the marker drops the duplicate.

### Offline Fallback
If WebSocket drops, the client polls `/v3/messages/recent` with backoff and resumes from the last-seen cursor when the connection restores.

## Testing

```bash
npm test                 # unit tests (vitest)
npm run build && npm run smoke   # protocol smoke test against the built server
```

`scripts/smoke.mjs` boots `dist/cv-claude-channel.js` over stdio with a throwaway
token and asserts the channel surface: both capabilities declared, the server name
is the `carbon-voice` slug, the tool list is exactly the three read-only/send tools,
the instructions carry the untrusted-content framing, and **no allowlist write tool
exists**. It reaches no network — `startup()` is gated behind `confirm_channels`,
which the script never calls. Run it before publishing; it catches the whole class
of breakage that unit tests can't see.

Coverage:
- `permission-relay.test.ts`: verdict parsing (including IDs containing `l`, which Claude Code never issues), prompt formatting (that `input_preview` is present, redaction markers survive, reactions are only advertised when resolved), and pending-request expiry.
- `cv-api.test.ts`: attachment parsing, path resolution, bulk URL resolution.

The main server file is not directly testable — it connects on import. Extract pure logic into a module rather than adding side-effect-free seams to it.

## Common Workflows

### Running Locally Against cv-api
The API base is the hardcoded `CV_API_BASE` constant at the top of `cv-api.ts` —
it is **not** an environment variable on this branch. Edit it to point at a local
cv-api, and don't commit that change.

### Debugging the Permission Flow
Set `CV_LOG_FILE` and watch it. The relay logs: the request arriving, whether context was stale, the CV message ID it was relayed to, reaction polling per pending message, the verdict, and expiry. A verdict for an unknown or expired ID is logged and then forwarded as ordinary chat.

### Publishing
```bash
npm publish   # prepublishOnly runs the build
```

Bump `version` in **three** places, they must agree: `package.json`, `.claude-plugin/plugin.json`, and the `version` in the `Server` constructor. The marketplace entry's `version` should track it too.

## Known Limitations

- **No typing indicator** (CV API doesn't support it).
- **Permission prompts go to the last conversation that spoke.** Claude Code doesn't say which conversation triggered the work, so there is no way to attribute it precisely; the context TTL limits the blast radius.
- **"Allow always" is per-tool, not per-argument.** Approving it for `Bash` covers any command for the rest of the session. The prompt says so explicitly.
- **Not on the Anthropic channel allowlist**, so `--channels` alone won't load it outside an org that allowlisted it. See the install matrix in `README.md`.
- **MCP protocol revision `2026-07-28`** cannot carry channel messages. No published SDK speaks it yet; only reachable via `MCP_PROTOCOL_NEGOTIATION=auto`.

## Integration with Broader Carbon Voice Stack

- **carbon-voice-flutter**: renders CV messages, reactions, and attachments.
- **cv-api**: backend serving messages, reactions, share links, sender data.
- **Claude Code**: the host — calls MCP tools, receives channel tags, relays permission prompts.

## Style & Conventions

- **No git worktrees** in this project; work on branches in the root.
- **Small commits**: refactors, features, and fixes are one commit each.
- **Type safety**: TypeScript strict mode. Zod for schema validation. Make fields optional in notification schemas — a validation failure on the relay path silently drops the whole notification.
- **Imports**: ES modules only, with `.js` specifiers (NodeNext), in tests too.
- **Comments**: minimal. Only explain *why*, not *what*.
