# Carbon Voice Claude Channel for Claude Code

[![npm version](https://badge.fury.io/js/@carbonvoice%2fcv-claude-channel.svg)](https://www.npmjs.com/package/@carbonvoice/cv-claude-channel)

A Claude Code channel server that bridges Carbon Voice conversations into Claude Code sessions. Receive real-time voice messages and reply back with text-to-speech.

If computer is offline, messages will be queued and delivered when connection is restored.

## Features

- **Real-time message delivery** via WebSocket (primary) with polling fallback
- **Two-way communication** - Claude can reply back into Carbon Voice conversations
- **Sender gating** - Restrict which users can send messages (optional)
- **Permission relay** - Forward tool approval prompts to Carbon Voice for remote approval
- **Deduplication** - Automatic message deduplication with TTL
- **State persistence** - Resumes from last seen timestamp after restart
- **Reaction support** - Auto-acknowledge messages with configurable reactions

## Installation

### Option 1: Using npx (recommended)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cv-claude-channel": {
      "command": "npx",
      "args": ["@carbonvoice/cv-claude-channel"],
      "env": {
        "CV_PAT": "your-personal-access-token"
      }
    }
  }
}
```

### Option 2: Local installation

Install globally:

```bash
npm install -g @carbonvoice/cv-claude-channel
```

Then configure `.mcp.json`:

```json
{
  "mcpServers": {
    "cv-claude-channel": {
      "command": "cv-claude-channel",
      "env": {
        "CV_PAT": "your-personal-access-token"
      }
    }
  }
}
```

### Option 3: Development setup

Clone and run locally:

```bash
git clone https://github.com/PhononX/cv-claude-channel
cd cv-claude-channel
npm install
npm start
```

## Configuration

### Required Environment Variables

- `CV_PAT` - Your Carbon Voice Personal Access Token

### Optional Environment Variables

- `CV_CONVERSATION_ID` - Scope to a specific conversation (omit to receive all)
- `CV_REACTION_ID` - Specific reaction ID to add on message receipt
- `CV_SEEN_TTL_MS` - Deduplication TTL in milliseconds (default: 5 minutes)
- `CV_POLL_INTERVAL_MS` - Polling interval in milliseconds (default: 5 seconds)
- `CV_WS_RETRY_MAX_MS` - Max WebSocket retry backoff in milliseconds (default: 30 seconds)
- `CV_STATE_PATH` - Path to state file (default: `~/.claude/channels/cv/state.json`)

## Usage

Start Claude Code with the channel enabled:

```bash
claude --dangerously-load-development-channels server:cv-claude-channel
```

### Receiving Messages

When a message arrives in Carbon Voice, it appears in Claude Code as:

```
<channel source="carbon-voice" channel_id="..." message_id="..." sender_id="..." is_reply="false" reply_to_id="...">
  transcript of what was said
</channel>
```

### Replying

Ask Claude to reply, and it will call the `send_message` tool with:
- `channel_id` - The conversation to send into
- `reply_to_message_id` - The message to thread under
- `text` - Claude's response (converted to audio automatically)

### Permission Prompts

When Claude needs approval for dangerous tools (Bash, Write, Edit), you'll receive a prompt in Carbon Voice:

```
Claude wants to run Bash: <description>

Reply "yes abcde" or "no abcde" to grant or deny permission.
```

Reply with `yes <request_id>` or `no <request_id>` to approve or deny.

## Security

### Sender Gating

All senders are denied by default. Use the `allow_sender` and `block_sender` tools at runtime to manage access. The allowlist is persisted to disk and survives server restarts. Unauthorized messages are dropped silently (no feedback to sender) to prevent prompt injection.

If the allowlist is completely empty and someone messages in, they'll receive a reply in Carbon Voice: *"Allow Sender list is currently empty. Go to Claude to approve senders."*

**Adding a sender**

When an unknown user tries to send a message, Claude receives a notification:

```
Unknown sender attempting to message through Carbon Voice.
Sender ID: <user-id>

To add them to the allowlist, call the allow_sender tool with this user ID.
```

Ask Claude to allow them:

> Allow sender \<user-id\>

Claude will call `allow_sender` with that user ID. Their messages will be forwarded immediately and on all future sessions.

**Blocking a sender**

Ask Claude to block them:

> Block sender \<user-id\>

Claude will call `block_sender`. That user will be permanently silenced, even if they were previously allowed.

### Permission Relay

Permission relay is enabled by default. When Claude requires tool approval, the prompt is forwarded to Carbon Voice for remote approval. This allows you to approve dangerous operations from anywhere.

## Development

### Building

```bash
npm run build
```

### Publishing

```bash
npm publish
```

## Architecture

- **WebSocket mode** (primary): Real-time message delivery via Socket.IO
- **Polling mode** (fallback): Polls `/v3/messages/recent` endpoint
- **Auto-reconnect**: Automatically switches between modes with backoff
- **State persistence**: Saves cursor to disk for resumption after restart
- **Deduplication**: In-memory cache with configurable TTL

## Requirements

- Node.js >= 18.0.0
- Carbon Voice account with Personal Access Token
- Claude Code with MCP support

## License

MIT

## Support

- GitHub Issues: https://github.com/PhononX/cv-claude-channel/issues
- Carbon Voice API: https://api.carbonvoice.app

## Acknowledgments

Built following the [Claude Code Channels specification](https://code.claude.com/docs/en/channels-reference).
