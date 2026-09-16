---
name: configure
description: Set up the Carbon Voice channel — save the Personal Access Token and show channel status. Use when the user pastes a Carbon Voice token, asks to configure or set up Carbon Voice, asks "how do I set this up" or "who can reach me", or asks why the channel is not connecting.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(cat *)
  - Bash(chmod *)
  - Bash(echo *)
---

# /cv-channel:configure — Carbon Voice channel setup

Saves the Carbon Voice Personal Access Token where the channel server looks for
it, so it never has to be written into `.mcp.json` (which usually gets
committed), and reports where setup currently stands.

**Resolve the state directory first:**

```bash
echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/cv"
```

Use the printed path as `<state-dir>` below. Honor `CV_ENV_PATH` and
`CV_ACCESS_PATH` if set — they override the individual files.

Arguments passed: `$ARGUMENTS`

## Dispatch on arguments

### A token was passed — save it

1. `mkdir -p <state-dir>`.
2. Write `<state-dir>/.env` containing `CV_PAT=<token>`, preserving any other
   lines already in the file.
3. `chmod 600` the file.
4. Confirm without echoing the token, then show the status view below.

**Never** echo the token back, and never write it anywhere else — not into
`.mcp.json`, project files, logs, or the conversation.

Anything that is not a token (`status`, `help`, junk) → show status.

### No args — status and next step

Read the state and report:

1. **Token** — is `CV_PAT` set in `<state-dir>/.env`? If so show it masked:
   first 6 characters then `...`. Note that an explicit `CV_PAT` in the
   environment overrides the file.
2. **Access** — read `<state-dir>/access.json` (missing = `dmPolicy: "pairing"`,
   empty lists). Show the policy, the allowlist count and IDs, and the number of
   unexpired codes in `<state-dir>/pending.json`.
3. **What next** — exactly one concrete step for the current state:
   - No token → *"Run `/cv-channel:configure <token>` with a Personal Access
     Token from Carbon Voice."*
   - Token set, nobody allowed, no pending codes → *"Restart Claude Code with
     the channel enabled, then message the channel from your other Carbon Voice
     account to get a pairing code."*
   - Codes pending → *"Run `/cv-channel:access pair \<code\>`."*
   - Someone allowed, policy still `pairing` → *"Ready. Consider
     `/cv-channel:access policy allowlist` to stop issuing new codes."*
   - Someone allowed, policy `allowlist` → *"Ready."*

## Two things that trip people up

Mention these when they match the user's situation — they look like bugs and
are not:

- **You cannot message the channel from the account whose token this is.** That
  account is the Claude side; its own messages are filtered out and nothing
  arrives, with no error. Solo setups need a second Carbon Voice account to
  message from.
- **The server exits when there is no token**, so `/mcp` showing the channel as
  failed *before* this skill has been run is expected.

## Optional settings

Read from the environment, not the `.env` file. Mention only if asked:

- `CV_CONVERSATION_ID` — scope the channel to one conversation.
- `CV_PROJECT_NAME` — the project name shown to a sender being paired.
- `CV_PAIRING_TTL_MS` — how long a pairing code lasts (default 10 minutes).
- `CV_PERMISSION_TTL_MS` — how long a relayed approval prompt stays answerable.
- `CV_LOG_FILE` — mirror the server log to a file.

## After configuring

The server reads the token at boot, so a new token needs a restart. See the
README for which startup flag your plan requires.
