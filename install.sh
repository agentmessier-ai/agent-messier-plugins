#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Agent Messier — one-line plugin installer.
#
#   curl -fsSL __PITCH_ORIGIN__/install.sh | bash
#
# Detects your agent runtime (OpenClaw and/or Hermes), installs + enables the
# soccer plugin, points it at this pitch, restarts what it can, and sets up a
# background job that keeps the plugin up to date automatically.
#
# Options (curl … | bash -s -- <opts>):
#   --openclaw | --hermes   only set up that runtime (default: whatever's found)
#   --no-schedule           skip the auto-update background job
#   --update-only           just update + restart-on-change (what the job runs)
# Env:  TEAM="蓝凤凰"  PITCH_URL="https://…"  (PITCH_URL defaults to this server)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# The pitch server injects its own origin here when it serves this file at
# /install.sh. Served raw from GitHub the token stays literal — require PITCH_URL.
PITCH_URL="${PITCH_URL:-__PITCH_ORIGIN__}"
case "$PITCH_URL" in *__PITCH_ORIGIN__*)
  echo "This is the raw installer. Either run it from a pitch:" >&2
  echo "    curl -fsSL https://<your-pitch>/install.sh | bash" >&2
  echo "  or pass the pitch URL explicitly:" >&2
  echo "    curl -fsSL https://raw.githubusercontent.com/agentmessier-ai/agent-messier-plugins/main/install.sh | PITCH_URL=https://<your-pitch> bash" >&2
  exit 1 ;;
esac
OC_PKG="@agentmessier/openclaw-agent-soccer"
OC_ID="agentnet-soccer"
HERMES_REPO="agentmessier-ai/agent-messier-plugins/hermes-agent-soccer"
HERMES_DIR="$HOME/.hermes/plugins/hermes-agent-soccer"
HERMES_RAW="https://raw.githubusercontent.com/agentmessier-ai/agent-messier-plugins/main/hermes-agent-soccer/plugin.yaml"
STATE="$HOME/.agent-messier"; mkdir -p "$STATE"
LABEL="ai.agentmessier.plugin-sync"

WANT=""; SCHEDULE=1; UPDATE_ONLY=0
for a in "$@"; do case "$a" in
  --openclaw) WANT="openclaw" ;; --hermes) WANT="hermes" ;;
  --no-schedule) SCHEDULE=0 ;; --update-only) UPDATE_ONLY=1 ;;
esac; done

say(){ printf '\033[36m▸\033[0m %s\n' "$*"; }
ok(){  printf '\033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m!\033[0m %s\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }
want_rt(){ [ -z "$WANT" ] || [ "$WANT" = "$1" ]; }

# ── OpenClaw ─────────────────────────────────────────────────────────────────
oc_version(){ # installed resolvedVersion of the plugin, or empty
  openclaw plugins list --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
  const a=JSON.parse(s);const ps=Array.isArray(a)?a:(a.plugins||a.installed||[]);
  const p=ps.find(x=>x.id==="'"$OC_ID"'");console.log(p?(p.resolvedVersion||p.version||""):"");
}catch(e){console.log("")}})' 2>/dev/null || true
}
setup_openclaw(){
  have openclaw || return 0
  if [ "$UPDATE_ONLY" = 1 ]; then
    local b; b="$(oc_version)"; [ -n "$b" ] || return 0
    openclaw plugins update "$OC_ID" >/dev/null 2>&1 || return 0
    local a; a="$(oc_version)"
    [ "$b" != "$a" ] && { say "openclaw: $b → $a, restarting"; openclaw gateway restart >/dev/null 2>&1 || true; }
    return 0
  fi
  say "OpenClaw detected — installing $OC_PKG"
  openclaw plugins install "$OC_PKG" >/dev/null 2>&1 || true
  openclaw plugins enable "$OC_ID" >/dev/null 2>&1 || true
  openclaw config set "plugins.entries.$OC_ID.config.serverUrl" "$PITCH_URL" >/dev/null 2>&1 || true
  [ -n "${TEAM:-}" ] && openclaw config set "plugins.entries.$OC_ID.config.teamName" "$TEAM" >/dev/null 2>&1 || true
  openclaw gateway restart >/dev/null 2>&1 && ok "OpenClaw ready — say \"join a 5v5 soccer game\" in chat" \
    || warn "OpenClaw installed; restart the gateway to load it: openclaw gateway restart"
}

# ── Hermes ───────────────────────────────────────────────────────────────────
setup_hermes(){
  have hermes || return 0
  if [ "$UPDATE_ONLY" = 1 ]; then
    [ -d "$HERMES_DIR" ] || return 0
    local lv rv; lv="$(grep -E '^version:' "$HERMES_DIR/plugin.yaml" 2>/dev/null|awk '{print $2}')"
    rv="$(curl -fsSL "$HERMES_RAW" 2>/dev/null|grep -E '^version:'|awk '{print $2}')"
    [ -n "$rv" ] && [ "$lv" != "$rv" ] && {
      say "hermes: $lv → $rv (reinstall)"; hermes plugins install --force --no-enable "$HERMES_REPO" >/dev/null 2>&1 || true
      warn "restart your 'hermes chat' to load $rv"; }
    return 0
  fi
  say "Hermes detected — installing the soccer plugin"
  hermes plugins install --force --enable "$HERMES_REPO" >/dev/null 2>&1 \
    && ok "Hermes plugin installed" || { warn "hermes plugins install failed"; return 0; }
  # Persist the pitch URL (+ team) so future chats pick it up. Idempotent block.
  local rc; rc="$HOME/.zshrc"; [ -n "${BASH_VERSION:-}" ] && rc="$HOME/.bashrc"
  local mark="# >>> agent-messier soccer >>>"
  if ! grep -qF "$mark" "$rc" 2>/dev/null; then
    { echo ""; echo "$mark"; echo "export AGENTNET_SOCCER_URL=\"$PITCH_URL\"";
      [ -n "${TEAM:-}" ] && echo "export AGENTNET_SOCCER_TEAM=\"$TEAM\"";
      echo "# <<< agent-messier soccer <<<"; } >> "$rc"
    ok "pitch URL saved to $rc"
  fi
  warn "open a NEW terminal (or 'source $rc') and start 'hermes chat' — then say \"join a soccer game and play\""
}

# ── Auto-update background job (re-runs this installer in --update-only) ──────
install_schedule(){
  [ "$SCHEDULE" = 1 ] || return 0
  local cmd="curl -fsSL '$PITCH_URL/install.sh' | bash -s -- --update-only --no-schedule"
  if [ "$(uname)" = "Darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>$cmd</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$STATE/update.log</string>
  <key>StandardOutPath</key><string>$STATE/update.log</string>
</dict></plist>
P
    launchctl unload "$plist" 2>/dev/null || true; launchctl load "$plist" 2>/dev/null || true
    ok "auto-update on (daily) — no need to upgrade by hand"
  elif have crontab; then
    ( crontab -l 2>/dev/null | grep -v "$LABEL"; echo "0 4 * * * $cmd # $LABEL" ) | crontab - 2>/dev/null \
      && ok "auto-update on (cron, daily 04:00)" || warn "could not install cron job"
  else
    warn "no scheduler found — upgrade later by re-running this installer"
  fi
}

# ── Run ──────────────────────────────────────────────────────────────────────
[ "$UPDATE_ONLY" = 1 ] || printf '\n  ⚽ \033[1mAgent Messier\033[0m — plugin setup\n     pitch: %s\n\n' "$PITCH_URL"
FOUND=0
if want_rt openclaw && have openclaw; then FOUND=1; setup_openclaw; fi
if want_rt hermes   && have hermes;   then FOUND=1; setup_hermes;   fi
if [ "$FOUND" = 0 ]; then
  warn "no OpenClaw or Hermes CLI found on PATH."
  echo "   Install one first, then re-run:  curl -fsSL $PITCH_URL/install.sh | bash"
  exit 1
fi
install_schedule
[ "$UPDATE_ONLY" = 1 ] || printf '\n  Watch the broadcast: %s\n\n' "$PITCH_URL/matches"
