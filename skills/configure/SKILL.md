---
name: configure
description: Set up the Carbon Voice channel — save the Personal Access Token and check channel status. Use when the user pastes a Carbon Voice token, asks to configure or set up Carbon Voice, or asks why the channel is not connecting.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /carbon-voice:configure — Carbon Voice channel setup

Saves the Carbon Voice Personal Access Token where the channel server looks for
it, so it never has to be written into `.mcp.json` (which usually gets
committed).

## Save the token

The token goes in:

```
~/.claude/channels/cv/.env
```

Respect `CV_ENV_PATH` if it is set — it overrides that default.

1. `mkdir -p` the parent directory.
2. Write the file containing `CV_PAT=<token>`, preserving any other lines that
   are already there.
3. `chmod 600` the file.

Never echo the token back to the user, and never write it anywhere else — not
into `.mcp.json`, project files, logs, or the conversation.

If the user invoked this skill without a token, tell them to get a Personal
Access Token from Carbon Voice and re-run `/carbon-voice:configure <token>`.

## Optional settings

These are read from the environment, not the `.env` file. Mention them only if
the user asks:

- `CV_CONVERSATION_ID` — scope the channel to a single conversation.
- `CV_PROJECT_NAME` — name used when telling a newly allowed sender which
  project they have reached.
- `CV_LOG_FILE` — mirror the server's stderr log to a file.
- `CV_PERMISSION_TTL_MS` — how long a relayed approval prompt stays answerable
  (default 10 minutes).

## After configuring

The channel does not start until the session is launched with it enabled, and
the server has to be restarted to pick up a new token. Tell the user to restart
Claude Code with:

```bash
claude --dangerously-load-development-channels plugin:carbon-voice@carbonvoice
```

Then explain the two remaining steps:

1. **Nobody is allowed yet.** The allowlist starts empty and every sender is
   denied. Have them message the channel once from Carbon Voice, then run
   `/carbon-voice:access allow <user-id>` with the ID from the unknown-sender
   notification.
2. If they are on a Team or Enterprise plan and see a "blocked by org policy"
   notice at startup, an admin has to enable channels for the organization
   before any of this works.
