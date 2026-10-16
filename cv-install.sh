#!/usr/bin/env bash
# Carbon Voice for Claude Code: connect a project folder.
#
# In Terminal, go to your project's folder and run:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/PhononX/cv-claude-channels/main/cv-install.sh)"
#
# It checks Claude Code (and offers to update it, since channel support changes quickly),
# installs or updates the cv-channel plugin, saves your Carbon Voice Agent Account's token in
# this folder, and writes ./cv-run.sh, which starts Claude here connected to Carbon Voice with
# the right options for your Claude plan. Nothing else in the project changes.
#
#   ./cv-run.sh            start Claude connected to Carbon Voice
#   ./cv-run.sh --update   update Claude Code, the plugin and cv-run.sh (runs this as --update)
#
# Safe to run again. Everything runs inside main(), called on the last line, so bash has read
# the whole file before anything runs, and child commands get </dev/null or </dev/tty so none
# of them can swallow the rest of the script under `curl | bash`.
set -euo pipefail

INSTALL_URL="https://raw.githubusercontent.com/PhononX/cv-claude-channels/main/cv-install.sh"
MARKETPLACE="PhononX/claude-plugins"
PLUGIN="cv-channel@carbonvoice"
CV_API="https://api.carbonvoice.app"
NODE_MIN=18

bold=$'\033[1m'; dim=$'\033[2m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; cyan=$'\033[36m'; reset=$'\033[0m'
hl()   { printf '%s%s%s' "$bold$cyan" "$1" "$reset"; }   # something to type or choose
val()  { printf '%s%s%s' "$bold" "$1" "$reset"; }
step() { printf '\n%s▸ %s%s\n' "$bold" "$1" "$reset"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
info() { printf '  %s%s%s\n' "$dim" "$1" "$reset"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$1"; }
die()  { printf '\n%s✗ %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }
ask()  { local reply; read -r -p "$1 " reply </dev/tty || true; printf '%s' "$reply"; }
yes()  { case "$(ask "$1")" in [nN]*) return 1 ;; *) return 0 ;; esac; }   # default yes
no()   { case "$(ask "$1")" in [yY]*) return 1 ;; *) return 0 ;; esac; }   # default no
have() { command -v "$1" >/dev/null 2>&1; }
quiet() { "$@" </dev/null >>"$LOG" 2>&1; }
shown() { case "$1" in "$HOME") printf '~' ;; "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }

# json <file> <expression>: a value from a JSON file, by a JavaScript expression on `d`, or
# nothing. Node.js is needed by the plugin anyway, so it reads JSON here instead of jq.
json() {
  node -e '
    const fs = require("fs"); let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(0); }
    let v; try { v = new Function("d", "return (" + process.argv[2] + ")")(d); } catch (e) { process.exit(0); }
    if (v !== undefined && v !== null && v !== "") process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$2" </dev/null 2>/dev/null || true
}
version_ge() {  # version_ge <a> <b>: is version a at least b?
  local IFS=. i; local a=($1) b=($2)
  for i in 0 1 2; do
    if (( 10#${a[i]:-0} > 10#${b[i]:-0} )); then return 0; fi
    if (( 10#${a[i]:-0} < 10#${b[i]:-0} )); then return 1; fi
  done
  return 0
}
latest_version() {  # latest_version <npm package>: newest published version, or nothing
  curl -fsS --max-time 5 "https://registry.npmjs.org/$1/latest" -o "$WORK/latest.json" 2>>"$LOG" </dev/null || return 0
  json "$WORK/latest.json" 'd.version'
}
claude_version() { local v; v=$(claude --version </dev/null 2>/dev/null | head -1 || true); printf '%s' "${v%% *}"; }
node_ok() { have node && [[ "$(node -p 'process.versions.node.split(".")[0]' </dev/null 2>/dev/null || echo 0)" -ge $NODE_MIN ]]; }

# Claude sign-in, from `claude auth status` (JSON), checked without ANTHROPIC_API_KEY the way
# cv-run.sh starts Claude. Written to a file and read back: on macOS, output to a pipe can be
# cut off when Claude exits.
auth_refresh() { env -u ANTHROPIC_API_KEY claude auth status </dev/null >"$WORK/auth.json" 2>/dev/null || true; }
auth() { json "$WORK/auth.json" "d.$1"; }

plugins_refresh() { claude plugin list --json </dev/null >"$WORK/plugins.json" 2>/dev/null || printf '[]' >"$WORK/plugins.json"; }
# plugin_field <field>: of cv-channel installed for this user (not a project-only install).
plugin_field() {
  json "$WORK/plugins.json" "(d.filter(p => p.id === '$PLUGIN' && (p.scope === 'user' || p.scope === 'managed'))[0] || {}).$1"
}

# The token reaches curl on its standard input, never its arguments, so it can't show up in
# the process list. It's never printed or logged.
cv_whoami() {
  printf 'header = "Authorization: Bearer %s"\n' "$1" \
    | curl -sS -K - -o "$WORK/whoami.json" -w '%{http_code}' --max-time 20 "$CV_API/whoami" 2>>"$LOG" || true
}
cv_contact_name() {  # cv_contact_name <token> <user ID>: that user's name, or nothing
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$1" \
    | curl -sS -K - -o "$WORK/contact.json" --max-time 20 -X POST --data "{\"user_guids\":[\"$2\"]}" \
        "$CV_API/contacts" 2>>"$LOG" || true
  json "$WORK/contact.json" '(c => [c.first_name, c.last_name].filter(Boolean).join(" "))((Array.isArray(d) ? d[0] : (d.contacts || d.data || [])[0]) || {})'
}
# Reads the token into PAT, hidden, printing a • per character so a paste visibly lands.
read_token() {
  local c
  PAT=""
  printf '  Token (hidden): '
  while IFS= read -rsn1 c </dev/tty; do
    case "$c" in
      "") break ;;
      $'\177'|$'\b') if [[ -n "$PAT" ]]; then PAT=${PAT%?}; printf '\b \b'; fi ;;
      $'\033') read -rsn5 -t 1 c </dev/tty || true ;;   # a paste marker or arrow key
      *) PAT+=$c; printf '•' ;;
    esac
  done
  echo
}
saved() {  # saved <key>: an answer from .cv/setup.conf (key=value lines, read as text)
  local k v
  if [[ -f "$CV_DIR/setup.conf" ]]; then
    while IFS='=' read -r k v; do if [[ "$k" == "$1" ]]; then printf '%s' "$v"; return 0; fi; done < "$CV_DIR/setup.conf"
  fi
  return 0
}

# ---------- ./cv-run.sh ----------
# Written into the project. {{...}} are filled in by fill().
cv_run_template() {
cat <<'TEMPLATE'
#!/usr/bin/env bash
# Starts Claude Code in this folder, connected to Carbon Voice as {{AGENT_NAME}}.
# Written by cv-install.sh (https://github.com/PhononX/cv-claude-channels); --update rebuilds it.
#   ./cv-run.sh                    start Claude here, connected to Carbon Voice
#   ./cv-run.sh -- <options>       pass options to Claude, e.g. ./cv-run.sh -- --continue
#   ./cv-run.sh --update           update Claude Code, the Carbon Voice plugin and this script
#   ./cv-run.sh --background       keep running after the window closes (needs tmux);
#                                  run the same command again to reconnect
#   ./cv-run.sh --no-remote        don't show this session in the Claude app this time
#   ./cv-run.sh --reset-token      replace the saved Carbon Voice token
#   ./cv-run.sh --log on|off|show  log the Carbon Voice connection to .cv/channel.log
set -euo pipefail
cd "$(dirname "$0")"
BACKGROUND=0; RESET=0; REMOTE=({{REMOTE_ARGS}}); EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --background) BACKGROUND=1 ;;
    --reset-token) RESET=1 ;;
    --no-remote) REMOTE=() ;;
    --log)
      mkdir -p .cv && chmod 700 .cv
      case "${2:-show}" in
        on)  touch .cv/channel-log.on; echo "Logging is on from the next start, to .cv/channel.log." ;;
        off) rm -f .cv/channel-log.on; echo "Logging is off from the next start." ;;
        *)   if [[ -f .cv/channel.log ]]; then tail -n 40 .cv/channel.log; else echo "No log yet. Turn it on with ./cv-run.sh --log on, then start again."; fi ;;
      esac
      exit 0 ;;
    --update)
      SCRIPT=$(curl -fsSL {{INSTALL_URL}}) \
        || { echo "Couldn't download the update. Check your internet connection and try again."; exit 1; }
      exec /bin/bash -c "$SCRIPT" cv-install --update "$PWD" ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "Unknown option: $1. Run ./cv-run.sh --help to see the options."; exit 1 ;;
  esac
  shift
done
export PATH="$HOME/.local/bin:$PATH"
# Channels need your Claude plan sign-in, not an API key that happens to be set in the shell.
unset ANTHROPIC_API_KEY
CV_DIR="$PWD/.cv"
mkdir -p "$CV_DIR" && chmod 700 "$CV_DIR"
if [[ $RESET == 1 ]]; then rm -f "$CV_DIR/.env"; fi
if [[ ! -s "$CV_DIR/.env" ]]; then
  echo "Paste the Personal Access Token for your Carbon Voice Agent Account."
  echo "(It's hidden as you type and saved only in this folder.)"
  read -rsp "Token: " PAT; echo
  [[ -n "$PAT" ]] || { echo "No token entered."; exit 1; }
  (umask 077; printf 'CV_PAT=%s\n' "$PAT" > "$CV_DIR/.env"); unset PAT
fi
set -a; source "$CV_DIR/.env"; set +a
# This folder's own channel state, so it's its own agent with its own allowlist and cursor.
export CV_ENV_PATH="$CV_DIR/.env"
export CV_STATE_PATH="$CV_DIR/state.json"
export CV_ACCESS_PATH="$CV_DIR/access.json"
export CV_PENDING_PATH="$CV_DIR/pending.json"
export CV_ATTACHMENTS_DIR="$CV_DIR/attachments"
export CV_PROJECT_NAME="{{AGENT_NAME}}"
if [[ -e "$CV_DIR/channel-log.on" ]]; then
  export CV_LOG_FILE="$CV_DIR/channel.log"
  if [[ -f "$CV_LOG_FILE" && $(wc -c < "$CV_LOG_FILE") -gt 5000000 ]]; then mv -f "$CV_LOG_FILE" "$CV_LOG_FILE.1"; fi
fi
CMD=("{{CLAUDE_BIN}}" {{CHANNEL_ARGS}} ${REMOTE[@]+"${REMOTE[@]}"} ${EXTRA[@]+"${EXTRA[@]}"})
command -v "${CMD[0]}" >/dev/null 2>&1 || CMD[0]=claude

# Once a day, look for a newer Claude Code or Carbon Voice plugin (2 seconds at most, and
# quiet when offline).
UPDATES=""
if [[ -z "$(find "$CV_DIR/.update-check" -mtime -1 2>/dev/null)" ]] && command -v node >/dev/null 2>&1; then
  latest() { curl -fsS --max-time 2 "https://registry.npmjs.org/$1/latest" 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).version||"")}catch(e){}})' 2>/dev/null || true; }
  newer() { [[ -n "$2" && "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" == "$2" ]]; }
  HAVE_CLAUDE=$("${CMD[0]}" --version </dev/null 2>/dev/null | head -1 || true); HAVE_CLAUDE=${HAVE_CLAUDE%% *}
  HAVE_PLUGIN=$("${CMD[0]}" plugin list --json </dev/null 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const p=JSON.parse(s).find(p=>p.id==="cv-channel@carbonvoice");process.stdout.write((p&&p.version)||"")}catch(e){}})' 2>/dev/null || true)
  L_CLAUDE=$(latest @anthropic-ai/claude-code); L_PLUGIN=$(latest @carbonvoice/cv-claude-channel)
  if newer "$HAVE_CLAUDE" "$L_CLAUDE"; then UPDATES="Claude Code $L_CLAUDE (you have $HAVE_CLAUDE)"; fi
  if newer "$HAVE_PLUGIN" "$L_PLUGIN"; then UPDATES="${UPDATES:+$UPDATES, }the Carbon Voice plugin $L_PLUGIN (you have $HAVE_PLUGIN)"; fi
  if [[ -n "$L_CLAUDE$L_PLUGIN" ]]; then printf '%s\n' "$UPDATES" > "$CV_DIR/.update-check"; fi
else
  UPDATES=$(cat "$CV_DIR/.update-check" 2>/dev/null || true)
fi

# Before Claude starts, say what to expect.
b=$'\033[1m'; c=$'\033[1;36m'; y=$'\033[33m'; r=$'\033[0m'
ALLOWED=$(node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((a.allowFrom||[]).length))}catch(e){process.stdout.write("0")}' "$CV_ACCESS_PATH" 2>/dev/null || echo 0)
echo
echo "${b}Starting Claude in this folder, connected to Carbon Voice as {{AGENT_NAME}}.${r}"
if [[ -n "$UPDATES" ]]; then echo "  ${y}Update available:${r} $UPDATES. Run ${c}./cv-run.sh --update${r} when you can."; fi
if [[ "$ALLOWED" -gt 0 ]]; then
  if [[ "$ALLOWED" == 1 ]]; then WHO="the account you've allowed"; else WHO="the $ALLOWED accounts you've allowed"; fi
  echo "  • Messages to {{AGENT_NAME}} in Carbon Voice from $WHO reach Claude here."
else
  echo "  • Nobody can message {{AGENT_NAME}} yet. Message it from your own Carbon Voice account; it replies"
  echo "    with a pairing code. Type ${c}/cv-channel:access pair <code>${r} here to let that account in."
fi
if [[ " ${CMD[*]} " == *" --dangerously-load-development-channels "* ]]; then
  echo "  • Claude warns about loading a development channel, because the Carbon Voice plugin isn't on"
  echo "    Anthropic's approved list yet. Choose ${c}\"I am using this for local development\"${r}."
fi
echo "  • Carbon Voice connects a few seconds after Claude starts. Claude's replies are spoken in Carbon Voice,"
echo "    and you can approve its requests there too, by reacting ✅ or ⛔."
if [[ $BACKGROUND == 1 ]]; then
  echo "  • It keeps running after you close this window. Run ${c}./cv-run.sh --background${r} again to come back."
else
  echo "  • Keep this window open: closing it disconnects. (${c}./cv-run.sh --background${r} keeps it running.)"
fi
[[ ${#REMOTE[@]} -gt 0 ]] && echo "  • You can also watch this session in the Claude app, under Code."
[[ -n "${CV_LOG_FILE:-}" ]] && echo "  • Logging the connection to .cv/channel.log (./cv-run.sh --log off to stop)."
echo

if [[ $BACKGROUND == 1 ]]; then
  command -v tmux >/dev/null || { echo "tmux is not installed. Run without --background."; exit 1; }
  exec tmux new-session -A -s "cv-$(basename "$PWD")" "${CMD[@]}"
fi
exec "${CMD[@]}"
TEMPLATE
}
# fill <template file> <dest> KEY=value...: copies a template, replacing each {{KEY}} literally.
fill() {
  local src=$1 dst=$2 keys="" kv; shift 2
  local envs=()
  for kv in "$@"; do keys="$keys${kv%%=*} "; envs+=("FILL_$kv"); done
  env "${envs[@]}" FILL_KEYS="$keys" awk '
    BEGIN { n = split(ENVIRON["FILL_KEYS"], k, " ") }
    { for (i = 1; i <= n; i++) {
        p = "{{" k[i] "}}"; v = ENVIRON["FILL_" k[i]]; out = ""; s = $0
        while ((j = index(s, p)) > 0) { out = out substr(s, 1, j - 1) v; s = substr(s, j + length(p)) }
        $0 = out s }
      print }' "$src" > "$dst"
}

main() {
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
LOG="$HOME/.local/state/cv-install/install.log"; mkdir -p "${LOG%/*}"
printf '\n=== cv-install %s ===\n' "$(date)" >>"$LOG"

MODE=install; DIR=$PWD
if [[ "${1:-}" == --update ]]; then
  MODE=update; DIR=${2:-$PWD}
  [[ -d "$DIR" ]] || die "Run ./cv-run.sh --update from inside your project's folder."
  DIR=$(cd "$DIR" && pwd)
fi
CV_DIR="$DIR/.cv"
[[ "$DIR" != / ]] || die "Run this from inside your project's folder, not the top of the disk."
[[ -w "$DIR" ]] || die "Can't write to $(shown "$DIR"). Run this from a project folder you own."
if [[ -f "$DIR/cos/.version" ]]; then
  die "This folder is a Chief of Staff agent, which is already connected to Carbon Voice. Start it with ./start-cos.sh, or update it with ./update-cos.sh."
fi

# ---------- what's here, before changing anything ----------
have claude || die "Claude Code isn't installed. Install it first, then run this again:
    curl -fsSL https://claude.ai/install.sh | bash
  More at https://code.claude.com/docs"
node_ok || die "The Carbon Voice plugin needs Node.js $NODE_MIN or later, and $(have node && echo "this computer has $(node --version)" || echo "it isn't installed").
  Install it from https://nodejs.org (or, with Homebrew: brew install node), then run this again."
have curl || die "This needs curl, which isn't installed."

clear 2>/dev/null || true
if [[ $MODE == update ]]; then
  printf '%sCarbon Voice for Claude Code — update%s\n\n' "$bold" "$reset"
  echo "This updates Claude Code, the Carbon Voice plugin and ./cv-run.sh for $(val "$(shown "$DIR")")."
  echo "Your token and answers are kept."
else
  printf '%sCarbon Voice for Claude Code%s\n\n' "$bold" "$reset"
  echo "This connects Carbon Voice to the Claude Code project in $(val "$(shown "$DIR")"), so you can"
  echo "talk to Claude here through a Carbon Voice agent. It will:"
  echo "  1. Check Claude Code is up to date, and offer to update it."
  echo "  2. Install or update the Carbon Voice plugin (cv-channel)."
  echo "  3. Ask for your Carbon Voice Agent Account's token, and save it in this folder (.cv/)."
  echo "  4. Add ./cv-run.sh, which starts Claude here connected to Carbon Voice."
  echo "Nothing else in the project changes."
fi
echo
yes "Continue? [Y/n]" || { echo "No changes made."; exit 0; }

# ---------- 1. Claude Code ----------
step "Claude Code"
HAVE_V=$(claude_version); LATEST_V=$(latest_version @anthropic-ai/claude-code)
if [[ -n "$LATEST_V" && -n "$HAVE_V" ]] && version_ge "$HAVE_V" "$LATEST_V"; then
  ok "Up to date ($HAVE_V)"
else
  if [[ -n "$LATEST_V" ]]; then
    info "You have ${HAVE_V:-an unknown version}; the latest is $LATEST_V. Carbon Voice uses Claude Code's channels,"
    info "which are new and improving quickly, so the latest version works best."
  fi
  if [[ $MODE == update ]] || yes "  Update Claude Code now? [Y/n]"; then
    if claude update </dev/null >>"$LOG" 2>&1; then ok "Claude Code $(claude_version)"
    else warn "Couldn't update Claude Code (the details are in $(shown "$LOG")). Continuing with $HAVE_V."; fi
  else
    info "Kept $HAVE_V. Run ./cv-run.sh --update any time."
  fi
fi

# Channels need a Claude plan sign-in (Pro, Max, Team or Enterprise), not an API account.
auth_refresh
if [[ "$(auth loggedIn)" != true ]]; then
  echo "  Claude Code isn't signed in. Your browser will open so you can sign in with your Claude plan."
  claude auth login </dev/tty || true
  auth_refresh
  [[ "$(auth loggedIn)" == true ]] || die "Not signed in. Run this again to retry."
fi
case "$(auth authMethod)" in
  ""|claude.ai|oauth_token) ;;
  *) warn "Claude Code is signed in with an Anthropic API account. Carbon Voice needs your Claude plan:"
     info "in Claude, type /login and choose your Claude account, then run this again."
     yes "  Continue anyway? [Y/n]" || exit 0 ;;
esac
PLAN=$(auth subscriptionType); ACCOUNT="$(auth email)${PLAN:+ ($PLAN plan)}"
[[ "$PLAN" == free ]] && die "Carbon Voice needs a paid Claude plan (Pro, Max, Team or Enterprise)."
ok "Signed in${ACCOUNT:+ as $ACCOUNT}"

# ---------- 2. the plugin ----------
step "Carbon Voice plugin"
# Any "carbonvoice" marketplace that lists cv-channel will do (PhononX/claude-plugins, or this
# repo); only add one when there's none.
claude plugin marketplace list --json </dev/null >"$WORK/markets.json" 2>/dev/null || printf '[]' >"$WORK/markets.json"
if [[ -n "$(json "$WORK/markets.json" 'd.find(m => m.name === "carbonvoice") && "yes"')" ]]; then
  quiet claude plugin marketplace update carbonvoice || info "Couldn't refresh the Carbon Voice plugin list; using the one on this computer."
else
  quiet claude plugin marketplace add "$MARKETPLACE" \
    || die "Couldn't add the Carbon Voice plugins ($MARKETPLACE). Check your internet connection and run this again. The details are in $(shown "$LOG")."
fi
plugins_refresh
BEFORE=$(plugin_field version)
if [[ -z "$BEFORE" ]]; then
  quiet claude plugin install "$PLUGIN" --scope user || quiet claude plugin install "$PLUGIN" \
    || die "Couldn't install the Carbon Voice plugin. The details are in $(shown "$LOG"). In Claude you can also type: /plugin install $PLUGIN"
  plugins_refresh; ok "Installed ($(plugin_field version))"
else
  if [[ "$(plugin_field enabled)" == false ]]; then quiet claude plugin enable "$PLUGIN" && info "Turned it back on."; fi
  if quiet claude plugin update "$PLUGIN"; then
    plugins_refresh; AFTER=$(plugin_field version)
    if [[ -n "$AFTER" && "$AFTER" != "$BEFORE" ]]; then ok "Updated to $AFTER"; else ok "Up to date (${AFTER:-$BEFORE})"; fi
  else
    info "Couldn't check for updates; keeping $BEFORE. The details are in $(shown "$LOG")."
  fi
fi

# ---------- 3. the agent's token ----------
step "Your Carbon Voice agent"
mkdir -p "$CV_DIR"; chmod 700 "$CV_DIR"
PAT=""; AGENT_NAME=""
if [[ -s "$CV_DIR/.env" ]]; then
  if [[ $MODE == update ]] || { info "This folder already has a Carbon Voice token saved."; yes "  Keep it? [Y/n]"; }; then
    PAT=$(sed -n 's/^[[:space:]]*CV_PAT[[:space:]]*=[[:space:]]*//p' "$CV_DIR/.env" | head -1)
    case "$(cv_whoami "$PAT")" in
      200) AGENT_NAME=$(json "$WORK/whoami.json" '[d.user.first_name, d.user.last_name].filter(Boolean).join(" ")'); ok "Keeping the saved token${AGENT_NAME:+ for $AGENT_NAME}" ;;
      401|403) warn "The saved token doesn't work any more, so you'll need a new one."; PAT="" ;;
      *) ok "Keeping the saved token (couldn't reach Carbon Voice to check it)"; AGENT_NAME=$(saved AGENT_NAME) ;;
    esac
  fi
fi
if [[ -z "$PAT" ]]; then
  echo "  In Carbon Voice, create a Personal Agent Account for this project (it's who you'll talk to),"
  echo "  and copy its Personal Access Token. Message it from your own account, not from the agent's."
  for try in 1 2 3 4; do
    read_token
    PAT="${PAT#"${PAT%%[![:space:]]*}"}"; PAT="${PAT%"${PAT##*[![:space:]]}"}"
    if [[ -z "$PAT" ]]; then info "Nothing was pasted. Copy the token in Carbon Voice, then paste it here."; continue; fi
    if [[ "$PAT" == *[[:space:]\"\\]* ]]; then info "That doesn't look like a token. Copy just the token and paste it again."; PAT=""; continue; fi
    info "Got ${#PAT} characters. Checking with Carbon Voice..."
    case "$(cv_whoami "$PAT")" in
      200) ;;
      401|403) info "That token didn't work. Copy the Agent Account's Personal Access Token again and paste it."; PAT=""; continue ;;
      *) die "Couldn't reach Carbon Voice to check the token. Check your internet connection and run this again." ;;
    esac
    if [[ -z "$(json "$WORK/whoami.json" 'd.user.user_guid')" ]]; then info "That token didn't work. Copy it again and paste it."; PAT=""; continue; fi
    AGENT_NAME=$(json "$WORK/whoami.json" '[d.user.first_name, d.user.last_name].filter(Boolean).join(" ")')
    break
  done
  [[ -n "$PAT" ]] || die "No working token. Run this again when you have your Agent Account's token."
  (umask 077; printf 'CV_PAT=%s\n' "$PAT" > "$CV_DIR/.env"); chmod 600 "$CV_DIR/.env"
  ok "Token saved for ${AGENT_NAME:-your agent}"
fi
AGENT_NAME=${AGENT_NAME:-$(saved AGENT_NAME)}; AGENT_NAME=${AGENT_NAME:-$(basename "$DIR")}

# Let whoever created the Agent Account (created_by in /whoami) message it without a pairing
# code, if they say so. Anyone else pairs, which is approved at the terminal.
OWNER_ALLOWED=""; ALLOW_CREATOR=$(saved ALLOW_CREATOR)
CREATOR=$(json "$WORK/whoami.json" 'd.user.created_by')
if [[ -n "$CREATOR" && -n "$PAT" && "$CREATOR" != "$(json "$WORK/whoami.json" 'd.user.user_guid')" ]]; then
  if [[ -n "$(json "$CV_DIR/access.json" "(d.allowFrom || []).includes('$CREATOR') && 'yes'")" ]]; then
    OWNER_ALLOWED=1
  elif [[ "$ALLOW_CREATOR" != 0 || $MODE == install ]]; then
    NAME=$(cv_contact_name "$PAT" "$CREATOR")
    if [[ -n "$NAME" ]]; then Q="  $NAME created this Agent Account. Let $NAME message $AGENT_NAME without a pairing code? [Y/n]"
    else Q="  This Agent Account was created by the Carbon Voice account $CREATOR. Is that you? If so, it can skip pairing. [Y/n]"; fi
    if yes "$Q"; then
      node -e '
        const fs = require("fs"), f = process.argv[1], id = process.argv[2]; let a = {};
        try { a = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { a = { dmPolicy: "allowlist", allowFrom: [], blockedFrom: [] }; }
        if ((a.blockedFrom || []).includes(id)) process.exit(3);
        a.allowFrom = [...new Set([...(a.allowFrom || []), id])];
        fs.writeFileSync(f, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
      ' "$CV_DIR/access.json" "$CREATOR" </dev/null && { OWNER_ALLOWED=1; ALLOW_CREATOR=1; } \
        || warn "That account is blocked from messaging this agent, so it was left that way."
    else
      ALLOW_CREATOR=0
    fi
  fi
fi
PAT=""; unset PAT

# ---------- 4. ./cv-run.sh ----------
step "This project"
# Team and Enterprise plans load the channel with --channels (an admin allows the plugin);
# Pro and Max load it as a development channel, which Claude Code confirms at each start.
case "$PLAN" in
  team|enterprise) TEAM=1 ;;
  pro|max) TEAM=0 ;;
  *) TEAM=$(saved TEAM); if [[ -z "$TEAM" ]]; then if no "  Is your Claude plan Team or Enterprise? [y/N]"; then TEAM=0; else TEAM=1; fi; fi ;;
esac
if [[ $TEAM == 1 ]]; then
  CHANNEL_ARGS="--channels plugin:$PLUGIN"
  if [[ $MODE == install ]]; then
    info "On Team and Enterprise plans, an admin must turn on channels (channelsEnabled) and allow"
    info "the Carbon Voice plugin (allowedChannelPlugins) before Claude can connect."
  fi
else
  CHANNEL_ARGS="--dangerously-load-development-channels plugin:$PLUGIN"
fi
REMOTE=$(saved REMOTE); REMOTE_ARGS=""
if version_ge "$(claude_version)" 2.1.51; then
  if [[ -z "$REMOTE" ]]; then
    echo "  These sessions can also appear in the Claude app (Code tab), so you can watch them from your phone."
    if yes "  Show them in the Claude app? [Y/n]"; then REMOTE=1; else REMOTE=0; fi
  fi
  [[ $REMOTE == 1 ]] && REMOTE_ARGS="--remote-control"
fi
SCRIPT_NAME=$(printf '%s' "$AGENT_NAME" | tr -d '"$`\\')
cv_run_template > "$WORK/cv-run.template"
fill "$WORK/cv-run.template" "$WORK/cv-run.sh" AGENT_NAME="$SCRIPT_NAME" CLAUDE_BIN="$(command -v claude)" \
  CHANNEL_ARGS="$CHANNEL_ARGS" REMOTE_ARGS="$REMOTE_ARGS" INSTALL_URL="$INSTALL_URL"
if [[ -e "$DIR/cv-run.sh" ]] && ! cmp -s "$WORK/cv-run.sh" "$DIR/cv-run.sh"; then cp "$DIR/cv-run.sh" "$DIR/cv-run.sh.bak"; fi
mv "$WORK/cv-run.sh" "$DIR/cv-run.sh"; chmod +x "$DIR/cv-run.sh"
rm -f "$CV_DIR/.update-check"
ok "./cv-run.sh starts Claude here, connected to Carbon Voice"
# In this project only, and only for you (.claude/settings.local.json isn't shared): Carbon
# Voice's own tools run without asking, and Claude can't read or change the token.
mkdir -p "$DIR/.claude"
if node -e '
    const fs = require("fs"), f = process.argv[1]; let s = {};
    try { if (fs.existsSync(f) && fs.statSync(f).size) s = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { process.exit(2); }
    s.permissions = s.permissions || {};
    const add = (k, v) => { s.permissions[k] = [...new Set([...(s.permissions[k] || []), ...v])]; };
    add("allow", ["mcp__plugin_cv-channel_cv-channel__confirm_channels", "mcp__plugin_cv-channel_cv-channel__send_message",
                  "mcp__plugin_cv-channel_cv-channel__list_senders"]);
    add("deny", ["Read(./.cv/.env)", "Edit(./.cv/**)", "Write(./.cv/**)"]);
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  ' "$DIR/.claude/settings.local.json" </dev/null; then
  ok "Claude can use Carbon Voice here without asking each time, and can't read the token"
else
  warn "Couldn't read .claude/settings.local.json, so it was left as it was. Claude will ask before using Carbon Voice."
fi
if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 </dev/null || [[ -f "$DIR/.gitignore" ]]; then
  touch "$DIR/.gitignore"
  grep -qxF '.cv/' "$DIR/.gitignore" || printf '\n# Carbon Voice token and channel state (cv-install.sh)\n.cv/\n' >> "$DIR/.gitignore"
  ok ".cv/ is in .gitignore, so the token stays out of git"
fi
{
  echo "# Answers to cv-install.sh, reused by ./cv-run.sh --update. You can edit them (1 = yes, 0 = no)."
  echo "AGENT_NAME=$AGENT_NAME"
  echo "TEAM=$TEAM"
  echo "REMOTE=${REMOTE:-0}"
  if [[ -n "$ALLOW_CREATOR" ]]; then echo "ALLOW_CREATOR=$ALLOW_CREATOR"; fi
} > "$CV_DIR/setup.conf"

# ---------- done ----------
if [[ $MODE == update ]]; then
  step "Up to date."
  echo "  If Claude is running here, restart it to use the update: type /exit, then run ./cv-run.sh."
  echo
  return 0
fi
step "Carbon Voice is connected to this project."
printf '  %-20s %s\n' "Carbon Voice agent:" "$(val "$AGENT_NAME")"
printf '  %-20s %s\n' "Who can message it:" "$([ -n "$OWNER_ALLOWED" ] && echo "${green}your Carbon Voice account$reset" || echo "${yellow}nobody yet: you'll pair your account with a code$reset")"
printf '  %-20s %s\n' "Start it with:" "$(hl ./cv-run.sh)  (or $(hl "./cv-run.sh -- --continue") to pick up where you left off)"
printf '  %-20s %s\n' "Update with:" "$(hl "./cv-run.sh --update")"
echo
if [[ -t 0 ]]; then
  ask "  Press Return to start Claude now, or Ctrl+C to start it later." >/dev/null
  cd "$DIR"; rm -rf "$WORK"; trap - EXIT
  exec ./cv-run.sh </dev/tty
fi
echo "  To start it: $(hl "cd $(shown "$DIR") && ./cv-run.sh")"
echo
}

main "$@"
