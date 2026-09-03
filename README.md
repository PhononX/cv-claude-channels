# Carbon Voice Claude Channel for Claude Code

[![npm version](https://badge.fury.io/js/@carbonvoice%2fcv-claude-channel.svg)](https://www.npmjs.com/package/@carbonvoice/cv-claude-channel)

A Claude Code channel that bridges Carbon Voice conversations into a running Claude Code session. Send a voice message, Claude does the work on your machine, and the reply comes back as audio.

If your computer is offline, messages queue and are delivered when the connection is restored.

## Features

- **Real-time message delivery** via WebSocket (primary) with polling fallback
- **Two-way communication** — Claude replies back into Carbon Voice conversations
- **Sender gating** — deny-by-default allowlist, managed from the terminal only
- **Permission relay** — approve or deny `Bash`/`Write`/`Edit` prompts from your phone
- **Attachments** — files sent in Carbon Voice are downloaded for Claude to read
- **Deduplication** and **state persistence** — resumes from the last-seen cursor

## Setup

### Before you start: you need two Carbon Voice accounts

The Personal Access Token identifies the **Claude side** of the conversation. Messages from that account are treated as Claude's own and are ignored, so **you cannot message the channel from the account whose token you used** — nothing will arrive, and there is no error.

So either:

- **Team use (the normal case).** Use your own token. Colleagues message you in Carbon Voice, Claude does the work on your machine and replies in your conversation.
- **Solo use.** Create a second Carbon Voice account to act as the bot, use *its* token, and message it from your personal account.

### Steps

1. **Get a Personal Access Token** from Carbon Voice, for whichever account is the Claude side.

2. **Install the plugin.**

   ```
   /plugin marketplace add PhononX/cv-claude-channel
   /plugin install carbon-voice@carbonvoice
   ```

   Choose the **user** scope so it works across projects. If the summary says `Run /reload-plugins to activate.`, run that.

3. **Save the token.**

   ```
   /carbon-voice:configure <your-personal-access-token>
   ```

   Until you do this the channel's MCP server has no token and exits — `/mcp` showing it as failed before this step is expected, not a bug.

4. **Restart with the channel enabled.** See the table below for the flag your plan needs.

5. **Allow yourself.** Every sender is denied by default, so the first message is *supposed* to be dropped. Send one voice message from your other account. Claude reports the sender ID; then run:

   ```
   /carbon-voice:access allow <user-id>
   ```

   That takes effect on the next message — no restart. Message again and it reaches Claude.

Allowing someone lets them send messages Claude acts on **and** approve relayed tool prompts like `Bash` and `Write`. Only allow people you trust with that.

### Troubleshooting the first run

| Symptom | Cause |
| --- | --- |
| Nothing arrives, no error | You messaged from the token's own account. Use a different one. |
| `/mcp` shows the server failed | No token yet — run `/carbon-voice:configure`. |
| Messages dropped, Claude mentions an unknown sender | Working as intended. Allow the ID (step 5). |
| Startup says "blocked by org policy" | Your organization has not enabled channels; no flag gets around it. |
| Channel never connects, but the server is healthy | You started Claude without the channel flag, so the channel isn't registered. |

### Who can run it, and how

Channels are in research preview, and which flag you need depends on your plan:

| You are | Command | Prerequisites |
| --- | --- | --- |
| Pro/Max, no organization | `claude --dangerously-load-development-channels plugin:carbon-voice@carbonvoice` | none |
| Team/Enterprise | `claude --channels plugin:carbon-voice@carbonvoice` | admin sets **both** `channelsEnabled` and `allowedChannelPlugins` |

Two things worth knowing before you file a bug:

- **`channelsEnabled` is off by default on Team and Enterprise plans**, and it blocks the development flag too. If you are in an organization and see "blocked by org policy" at startup, no flag will get you around it — an admin has to enable channels first.
- This plugin is not on Anthropic's curated channel allowlist, so `--channels` alone will not load it outside an organization that has allowlisted it. That is expected, not a misconfiguration.

For an admin, the managed-settings entry is:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "carbonvoice", "plugin": "carbon-voice" }
  ]
}
```

### Without the plugin

The bare MCP server still works and is supported for one more release. Add it to `.mcp.json`:

```json
{
  "mcpServers": {
    "cv-claude-channel": {
      "command": "npx",
      "args": ["@carbonvoice/cv-claude-channel"],
      "env": { "CV_PAT": "your-personal-access-token" }
    }
  }
}
```

and start with `claude --dangerously-load-development-channels server:cv-claude-channel`. New installs should prefer the plugin — `/carbon-voice:configure` keeps your token out of `.mcp.json`, which usually gets committed.

## Configuration

The Personal Access Token is the only required setting. `/carbon-voice:configure` writes it to `~/.claude/channels/cv/.env` (mode 0600); an explicit `CV_PAT` in the environment takes precedence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CV_PAT` | — | Personal Access Token. Required unless set via `/carbon-voice:configure`. |
| `CV_ENV_PATH` | `~/.claude/channels/cv/.env` | Where the token file lives |
| `CV_CONVERSATION_ID` | all | Scope to a single conversation |
| `CV_PROJECT_NAME` | `this project` | Project name shown to a newly allowed sender |
| `CV_ACCESS_PATH` | `~/.claude/channels/cv/access.json` | Allowlist file |
| `CV_STATE_PATH` | `~/.claude/channels/cv/state.json` | Cursor file |
| `CV_ATTACHMENTS_DIR` | `~/.claude/channels/cv/attachments` | Downloaded attachments |
| `CV_POLL_INTERVAL_MS` | `5000` | Polling interval when WebSocket is down |
| `CV_WS_RETRY_MAX_MS` | `30000` | Max WebSocket retry backoff |
| `CV_ATTACHMENT_TIMEOUT_MS` | `600000` | How long to wait for a pending upload |
| `CV_ATTACHMENT_NUDGE_MS` | `120000` | When to nudge about a slow upload |
| `CV_OWN_USER_ID` | resolved via API | Skip the identity lookup at startup |
| `CV_PERMISSION_TTL_MS` | `600000` | How long a relayed approval prompt stays answerable |
| `CV_PERMISSION_CONTEXT_TTL_MS` | `600000` | How stale the target conversation may be before a prompt is not relayed |
| `CV_PERMISSION_PREVIEW_MAX` | `400` | Characters of tool input shown in a relayed prompt |
| `CV_REACTION_ID` | 👀 | Emoji used as the processed marker |
| `CV_PERMISSION_ALLOW_REACTION` | ✅ | Emoji meaning "allow once" |
| `CV_PERMISSION_ALLOW_ALWAYS_REACTION` | 💯 | Emoji meaning "allow for this session" |
| `CV_PERMISSION_DENY_REACTION` | ⛔ | Emoji meaning "deny" |
| `CV_LOG_FILE` | stderr only | Mirror the log to a file |

> These take a single emoji (any emoji, not just the curated set) or a legacy curated slug, which is normalized to its emoji. The four defaults are deliberately distinct, and the server warns at startup if the marker collides with an approval emoji or if a value is not a single emoji.

## Usage

### Receiving messages

```
<channel source="plugin:carbon-voice:carbon-voice" channel_id="..." message_id="..." sender_id="..." is_reply="false" reply_to_id="...">
  transcript of what was said
</channel>
```

### Replying

Claude calls `send_message` with `channel_id`, `reply_to_message_id`, and `text`. Carbon Voice converts the text to audio.

### Permission prompts

When Claude needs approval for a tool, the prompt is relayed to Carbon Voice:

```
Claude wants to run Bash: Delete the build directory

{"command":"rm -rf ./build"}

✅ = allow once. 💯 = allow Bash for the rest of this session, whatever the arguments. ⛔ = deny.
Or reply "yes abcde" or "no abcde".
```

React, or reply `yes <id>` / `no <id>`. The local terminal dialog stays open the whole time — whichever answer arrives first wins.

The prompt shows the tool's actual arguments, not just Claude's description, because for `Bash` the description is often the bare string `Run shell command`. Long values are truncated for playback, and Claude Code masks recognizable credentials as `[REDACTED]` before the server ever sees them. Note that masking can hide key *names* as well as values, so a displayed key may not match the real input.

A relayed prompt expires after `CV_PERMISSION_TTL_MS` and can no longer be answered from Carbon Voice; the terminal dialog is unaffected.

## Security

### Sender gating

**Every sender is denied by default.** Unauthorized messages are dropped silently.

Access is managed from the terminal with `/carbon-voice:access`:

```
/carbon-voice:access list
/carbon-voice:access allow <user-id>
/carbon-voice:access remove <user-id>
/carbon-voice:access block <user-id>
/carbon-voice:access unblock <user-id>
```

Allowlist changes are **only** made this way. The channel server reads
`access.json` and never writes it, and it exposes no tool that can widen access
— so no inbound message, forwarded message, or attachment can talk Claude into
allowlisting anyone. The skill itself refuses requests that arrived over the
channel. Edits take effect on the next inbound message, without a restart.

When an unknown sender messages, Claude is told once per session so it can pass the ID along to you. Acting on it is your call, at the terminal.

If the allowlist is completely empty, the sender gets one reply in Carbon Voice: *"Allow Sender list is currently empty. Go to Claude to approve senders."*

### What allowing someone grants

An allowlisted sender can send messages Claude acts on **and** can approve or deny relayed tool-use prompts, including `Bash`, `Write`, and `Edit`. Only allow people you would trust with that. This is why the allowlist is deliberately awkward to change.

## Development

```bash
npm install
npm start          # run against the TypeScript source
npm run build      # compile to dist/
npm test           # vitest
npm run smoke      # protocol smoke test (needs a build first; hits no network)
```

Test the plugin without publishing:

```bash
npm run build
claude --plugin-dir . --dangerously-load-development-channels plugin:carbon-voice@inline
claude plugin validate . --strict
```

### Publishing

```bash
npm publish
```

`prepublishOnly` runs the build. The published tarball is an installable plugin as well as an MCP server — the `.claude-plugin/`, `.mcp.json`, and `skills/` entries are what the marketplace `npm` source resolves.

## Requirements

- Node.js >= 18
- A Carbon Voice account with a Personal Access Token
- Claude Code with channels available on your plan (see the table above)

### Known incompatibility

Claude Code does not register a channel server that negotiates MCP protocol revision `2026-07-28`. No published `@modelcontextprotocol/sdk` speaks that revision yet, and it is only reachable if you set `MCP_PROTOCOL_NEGOTIATION=auto`. If a future SDK adds it and the channel stops registering, leave that variable unset or set it to `legacy`.

## License

MIT

## Support

- GitHub Issues: https://github.com/PhononX/cv-claude-channel/issues
- Carbon Voice API: https://api.carbonvoice.app

## Acknowledgments

Built following the [Claude Code Channels specification](https://code.claude.com/docs/en/channels-reference).
