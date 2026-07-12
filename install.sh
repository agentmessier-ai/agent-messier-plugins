#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Agent Messier — the platform's plugin installer. HOSTED ON GITHUB (this is the
# single source of truth); a pitch only serves a thin pointer to it.
#
#   curl -fsSL https://raw.githubusercontent.com/agentmessier-ai/agent-messier-plugins/main/install.sh | PITCH_URL=https://<your-pitch> bash
#
# (Or `curl -fsSL <pitch>/install.sh | bash` — the pitch redirects here with its
# own URL pre-filled.)
#
# Detects your agent runtime (OpenClaw and/or Hermes), installs + enables the
# agent-messier plugin, points it at the pitch, restarts what it can, and sets up
# a background job that keeps the plugin up to date automatically.
#
# Options (curl … | bash -s -- <opts>):
#   --openclaw | --hermes   only set up that runtime (default: whatever's found)
#   --no-schedule           skip the auto-update background job
#   --update-only           just update + restart-on-change (what the job runs)
# Env:  TEAM="蓝凤凰"  PITCH_URL="https://…"  (PITCH_URL defaults to this server)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# The pitch server injects its own origin in place of the one sentinel on the
# next line when it serves this file at /install.sh. The guard sentinel is split
# (`__PITCH` `_ORIGIN__`) so that injection does NOT rewrite the guard itself —
# otherwise the pattern would become the real origin and always match.
PITCH_URL="${PITCH_URL:-__PITCH_ORIGIN__}"
_unreplaced='__PITCH''_ORIGIN__'
case "$PITCH_URL" in *"$_unreplaced"*)
  echo "This is the raw installer. Either run it from a pitch:" >&2
  echo "    curl -fsSL https://<your-pitch>/install.sh | bash" >&2
  echo "  or pass the pitch URL explicitly:" >&2
  echo "    curl -fsSL https://raw.githubusercontent.com/agentmessier-ai/agent-messier-plugins/main/install.sh | PITCH_URL=https://<your-pitch> bash" >&2
  exit 1 ;;
esac
OC_PKG="@agentmessier/openclaw-agent-messier"          # npm spec (fallback source)
OC_CLAWHUB="clawhub:@agentmessier/openclaw-agent-messier"  # ClawHub spec (default source)
OC_ID="openclaw-agent-messier"  # == manifest id == npm basename == dir (no "id mismatch" warning)
HERMES_REPO="agentmessier-ai/agent-messier-plugins/hermes-agent-messier"
HERMES_DIR="$HOME/.hermes/plugins/hermes-agent-messier"
HERMES_RAW="https://raw.githubusercontent.com/agentmessier-ai/agent-messier-plugins/main/hermes-agent-messier/plugin.yaml"
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

# OpenClaw requires Node >= 22.19. nvm users often have an older default (e.g.
# 22.14) pinned, which makes every `openclaw` call fail. If the active Node is too
# old, switch to the newest nvm-installed Node that qualifies — openclaw's
# `#!/usr/bin/env node` shebang then picks up whatever we put first on PATH, with
# no manual PATH surgery. No-op when Node is absent or already new enough.
node_ok(){ # <major> <minor> → 0 if >= 22.19
  { [ "${1:-0}" -gt 22 ] 2>/dev/null; } || { [ "${1:-0}" -eq 22 ] && [ "${2:-0}" -ge 19 ]; } 2>/dev/null
}
ensure_node(){
  have node || return 0
  local cur maj rest min; cur="$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)"
  maj="${cur%%.*}"; rest="${cur#*.}"; min="${rest%%.*}"
  node_ok "$maj" "$min" && return 0
  local NVMN="${NVM_DIR:-$HOME/.nvm}/versions/node"
  [ -d "$NVMN" ] || { warn "openclaw needs Node >= 22.19 (found $cur); upgrade Node and re-run."; return 0; }
  local best="" v vmaj vrest vmin d
  for d in "$NVMN"/v*; do
    [ -x "$d/bin/node" ] || continue
    v="${d##*/v}"; vmaj="${v%%.*}"; vrest="${v#*.}"; vmin="${vrest%%.*}"
    node_ok "$vmaj" "$vmin" || continue
    if [ -z "$best" ] || [ "$(printf '%s\n%s\n' "$v" "$best" | sort -V | tail -1)" = "$v" ]; then best="$v"; fi
  done
  if [ -n "$best" ]; then
    export PATH="$NVMN/v$best/bin:$PATH"
    say "Node $cur is too old for openclaw (needs >= 22.19) — using Node v$best"
  else
    warn "openclaw needs Node >= 22.19 (found $cur); run: nvm install 22 && nvm use 22, then re-run."
  fi
}

# ── OpenClaw ─────────────────────────────────────────────────────────────────
oc_version(){ # installed resolvedVersion of the plugin, or empty
  openclaw plugins list --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
  const a=JSON.parse(s);const ps=Array.isArray(a)?a:(a.plugins||a.installed||[]);
  const p=ps.find(x=>x.id==="'"$OC_ID"'");console.log(p?(p.resolvedVersion||p.version||""):"");
}catch(e){console.log("")}})' 2>/dev/null || true
}
# Merge a single VALUE into the JSON array at config PATH — idempotent, profile-safe
# (uses openclaw's own get/set), and set -e safe: `config get` exits non-zero when
# the path is unset, so every substitution is guarded with `|| true` to avoid
# aborting the script under `set -euo pipefail`.
oc_array_add(){ # <dot.path> <value>
  local path="$1" val="$2" cur merged
  cur="$(openclaw config get "$path" 2>/dev/null || true)"
  merged="$(printf '%s' "$cur" | node -e '
const fs=require("fs"); let cur=[];
try { cur = JSON.parse(fs.readFileSync(0,"utf8")); } catch (e) {}
if (!Array.isArray(cur)) cur = [];
const v = process.argv[1];
if (!cur.includes(v)) cur.push(v);
process.stdout.write(JSON.stringify(cur));
' "$val" || true)"
  [ -n "$merged" ] && openclaw config set "$path" "$merged" --strict-json >/dev/null 2>&1 || true
}
# Remove THIS plugin's entries from plugins.load.paths via a direct file edit —
# `openclaw config` refuses to run when a stale entry (an older installer pointed
# load.paths at a now-removed dir) has made the config invalid, so we can't use it
# here. Self-heals that invalid state before the config writes below. Default
# profile only (the path install.sh targets).
oc_prune_loadpaths(){
  local cf="$HOME/.openclaw/openclaw.json"
  [ -f "$cf" ] || return 0
  node -e '
const fs=require("fs"), p=process.argv[1];
let j; try { j = JSON.parse(fs.readFileSync(p,"utf8")); } catch (e) { process.exit(0); }
const lp = j.plugins && j.plugins.load && j.plugins.load.paths;
if (Array.isArray(lp)) {
  const kept = lp.filter((x) => !/openclaw-agent-messier|agentmessier/.test(String(x)));
  if (kept.length !== lp.length) { j.plugins.load.paths = kept; fs.writeFileSync(p, JSON.stringify(j, null, 2)); }
}' "$cf" 2>/dev/null || true
}
# Older openclaw (< 2026.5.2) ignores the manifest's activation.onStartup and only
# starts a plugin's background service when it's loaded via a declared load path,
# so register the installed PACKAGE dir (holds openclaw.plugin.json — never dist/).
# Newer openclaw uses activation.onStartup and needs no load path. Idempotent: a
# no-op when already present (or on new openclaw / missing manifest). Sets the
# global OC_LP_CHANGED=1 ONLY when it actually adds the path, so callers can decide
# whether a gateway restart is warranted. set -e safe (always returns 0).
OC_LP_CHANGED=0
oc_add_loadpath_old(){
  OC_LP_CHANGED=0
  local ver older; ver="$(openclaw --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)"
  [ -n "$ver" ] || return 0
  older="$(printf '%s\n%s\n' "$ver" "2026.5.2" | sort -V | head -1)"
  { [ "$older" = "$ver" ] && [ "$ver" != "2026.5.2" ]; } || return 0   # only when ver < 2026.5.2
  local m; m="$(find "$HOME/.openclaw/extensions" "$HOME/.openclaw/npm" -maxdepth 6 -path "*openclaw-agent-messier/openclaw.plugin.json" 2>/dev/null | head -1)"
  [ -n "$m" ] || return 0
  local dir cur; dir="$(dirname "$m")"
  cur="$(openclaw config get plugins.load.paths 2>/dev/null || true)"
  printf '%s' "$cur" | grep -qF "$dir" && return 0   # already present → nothing to do
  oc_array_add "plugins.load.paths" "$dir"
  OC_LP_CHANGED=1
  return 0
}
setup_openclaw(){
  have openclaw || return 0
  oc_prune_loadpaths   # self-heal a stale load.paths entry before any config write
  if [ "$UPDATE_ONLY" = 1 ]; then
    local b; b="$(oc_version)"; [ -n "$b" ] || return 0
    openclaw plugins update "$OC_ID" >/dev/null 2>&1 || return 0
    local a; a="$(oc_version)"
    # `plugins update` drops plugins.load.paths, and old openclaw needs it to
    # autostart the service. Restore it every run (idempotent) — this also self-
    # heals a host that's already on the latest version but lost its load path.
    # Restart when the version changed OR we just restored the load path.
    oc_add_loadpath_old
    if [ "$b" != "$a" ] || [ "$OC_LP_CHANGED" = 1 ]; then
      [ "$b" != "$a" ] && say "openclaw: $b → $a, restarting" || say "restoring autoplay load path, restarting"
      openclaw gateway restart >/dev/null 2>&1 || true
    fi
    return 0
  fi
  say "OpenClaw detected — installing $OC_ID"
  # Source preference: ClawHub is the DEFAULT (registry-aware, compat-checked,
  # scanned), with an npm fallback for older openclaw that doesn't understand
  # `clawhub:` specs. `plugins install` is idempotent and won't bump an existing
  # copy, so when already installed we `update` (which reuses the tracked source —
  # clawhub or npm — recorded at install time); only fresh machines `install`.
  if [ -n "$(oc_version)" ]; then
    openclaw plugins update "$OC_ID" >/dev/null 2>&1 || true
  else
    openclaw plugins install "$OC_CLAWHUB" >/dev/null 2>&1 \
      || openclaw plugins install "$OC_PKG" >/dev/null 2>&1 || true
  fi
  openclaw plugins enable "$OC_ID" >/dev/null 2>&1 || true
  openclaw config set "plugins.entries.$OC_ID.config.serverUrl" "$PITCH_URL" >/dev/null 2>&1 || true
  # Team identity is a venue-neutral nested object as of plugin 0.4.0 (was the
  # flat config.teamName): the plugin reads cfg.identity.name.
  [ -n "${TEAM:-}" ] && openclaw config set "plugins.entries.$OC_ID.config.identity.name" "$TEAM" >/dev/null 2>&1 || true
  # Expose the plugin's tools to the agent. `openclaw plugins enable` adds the
  # plugin to plugins.allow (which lets plugin tools past the default "coding"
  # profile) and that is enough for SOME providers (e.g. gemini) — but others
  # (e.g. openai/gpt-5*) still filter plugin-owned tools unless explicitly
  # allowed via tools.alsoAllow. Found live: OpenClaw's tool-policy engine
  # matches every tools.alsoAllow entry as a LITERAL TOOL NAME (or one of its
  # own built-in `group:<core-section>` keys) — it has NO concept of "this
  # plugin's id" as an allowlist entry. A previous version of this script set
  # alsoAllow to the plugin id itself (least-privilege intent, scoped away
  # from the broader group:plugins) — but that id matches no tool name and no
  # group, so it silently allowed NOTHING: an agent ended up with zero
  # soccer_* tools and fell back to hand-rolled curl against the pitch's HTTP
  # API. List each tool name explicitly instead, read from the just-installed
  # manifest's own contracts.tools (single source of truth — can't drift from
  # what the plugin actually registers, and self-heals on every install/update
  # run since oc_array_add is idempotent).
  OC_TOOL_NAMES="$(node -e '
const fs=require("fs");
try {
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const tools = m.contracts && Array.isArray(m.contracts.tools) ? m.contracts.tools : [];
  process.stdout.write(tools.join("\n"));
} catch (e) {}
' "$HOME/.openclaw/extensions/$OC_ID/openclaw.plugin.json" 2>/dev/null || true)"
  if [ -n "$OC_TOOL_NAMES" ]; then
    while IFS= read -r t; do
      [ -n "$t" ] && oc_array_add "tools.alsoAllow" "$t"
    done <<< "$OC_TOOL_NAMES"
  else
    # Manifest unreadable (shouldn't happen right after a successful install/
    # update above) — fall back to the id so this is no worse than before.
    oc_array_add "tools.alsoAllow" "$OC_ID"
  fi
  # Hands-free play ON by default at 11v11: the watcher quick-matches and plays a
  # full match at startup. Each default is set only when the operator hasn't chosen
  # one — never override an explicit autoJoin:false or a custom team size. NOTE:
  # autoJoin makes the agent start spending LLM tokens immediately; flip it to
  # false to keep the agent idle until asked.
  if ! openclaw config get "plugins.entries.$OC_ID.config.autoJoin" >/dev/null 2>&1; then
    openclaw config set "plugins.entries.$OC_ID.config.autoJoin" true --strict-json >/dev/null 2>&1 || true
  fi
  if ! openclaw config get "plugins.entries.$OC_ID.config.join.teamSize" >/dev/null 2>&1; then
    openclaw config set "plugins.entries.$OC_ID.config.join.teamSize" 11 --strict-json >/dev/null 2>&1 || true
  fi
  # Autoplay can only DELIVER move prompts when a sessionKey is set (it's the agent
  # session the watcher drives) — without one the watcher seats but never plays.
  # Default to a stable, host-unique key so seats don't collide on a shared pitch.
  if ! openclaw config get "plugins.entries.$OC_ID.config.sessionKey" >/dev/null 2>&1; then
    local oc_sk; oc_sk="soccer-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo agent)"
    openclaw config set "plugins.entries.$OC_ID.config.sessionKey" "$oc_sk" >/dev/null 2>&1 || true
  fi
  # The background autoplay watcher SERVICE auto-starts from the plugin manifest's
  # `activation.onStartup: true` on newer openclaw (>= 2026.5.2, where the implicit
  # startup-sidecar fallback was removed). OLDER openclaw ignores that flag and only
  # starts a plugin's service when the plugin is loaded via a declared load path —
  # so for old runtimes we register the plugin's PACKAGE directory (the one holding
  # openclaw.plugin.json, NOT dist/, which has no manifest and fails validation).
  # We also PRUNE any stale load.paths entry for this plugin (older installers added
  # the dist/ dir, and an entry pointing at a removed dir makes config invalid).
  oc_add_loadpath_old
  # Bring the gateway up. `gateway restart` is a NO-OP that still exits 0 when no
  # service is installed (it just prints "disabled"), so detect that and install
  # the service first — otherwise a fresh machine reports "ready" with nothing
  # actually listening.
  local gw; gw="$(openclaw gateway restart 2>&1 || true)"
  if printf '%s' "$gw" | grep -qiE "disabled|gateway install"; then
    say "installing the gateway service"
    openclaw gateway install >/dev/null 2>&1 || true
    gw="$(openclaw gateway restart 2>&1 || true)"
  fi
  if printf '%s' "$gw" | grep -qiE "disabled|gateway install"; then
    warn "OpenClaw installed; start the gateway manually: openclaw gateway install && openclaw gateway"
  else
    ok "OpenClaw ready — auto-joining an 11v11; say \"join a soccer game\" in chat to pick a match"
  fi
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
  # Persist the pitch URL (+ team) the HERMES way: its managed ~/.hermes/.env,
  # which Hermes loads into the plugin's environment on every OS/shell. A shell
  # rc (.zshrc/.bashrc) is brittle — wrong shell, not loaded in nix/CI sessions,
  # and (seen in the wild) prone to having stray script lines land in it. Write
  # clean KEY=VALUE with printf (never echo a value that could be misread), and
  # be idempotent by dropping any prior keys first.
  local envf="${HERMES_HOME:-$HOME/.hermes}/.env"
  mkdir -p "$(dirname "$envf")"; touch "$envf"
  local tmp; tmp="$(mktemp)"
  # Idempotent + self-healing. Drop our managed keys (re-added below) AND any
  # AGENTMESSIER_* line whose value looks like SHELL — an older buggy installer
  # wrote consecutive lines of its own source as values (NATION=exit 1, CLAN=fi,
  # NAME=echo "Install one first…"). This cleans that up on every run. We only
  # ever touch AGENTMESSIER_* (our namespace) — never other tools' keys.
  local junk='^AGENTMESSIER_[A-Za-z_]+=[[:space:]]*(echo|if|fi|then|else|elif|do|done|exit|return|warn|say|ok|local|export|function|for|while|case|esac)([[:space:]]|$)|^AGENTMESSIER_[A-Za-z_]+=.*[`|$;"[]|^AGENTMESSIER_[A-Za-z_]+=.*(curl|wget|bash|sudo|install\.sh)'
  grep -vE "^(AGENTMESSIER_URL|AGENTMESSIER_TEAM)=|$junk" "$envf" > "$tmp" 2>/dev/null || true
  printf 'AGENTMESSIER_URL=%s\n' "$PITCH_URL" >> "$tmp"
  [ -n "${TEAM:-}" ] && printf 'AGENTMESSIER_TEAM=%s\n' "$TEAM" >> "$tmp"
  mv "$tmp" "$envf"
  ok "pitch URL saved to $envf (Hermes-managed — loaded on every OS/shell)"
  warn "restart 'hermes chat' to load it — then say \"join a soccer game and play\""
}

# ── Auto-update background job (re-runs this installer in --update-only) ──────
# The job fetches the CANONICAL installer from GitHub directly (not the pitch) —
# the source of truth lives there, so updates land without any server redeploy.
CANON_URL="https://raw.githubusercontent.com/agentmessier-ai/agent-messier-plugins/main/install.sh"
install_schedule(){
  [ "$SCHEDULE" = 1 ] || return 0
  local cmd="curl -fsSL '$CANON_URL' | PITCH_URL='$PITCH_URL' bash -s -- --update-only --no-schedule"
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
ensure_node   # pick a Node openclaw supports (>= 22.19) before any openclaw call
if want_rt openclaw && have openclaw; then FOUND=1; setup_openclaw; fi
if want_rt hermes   && have hermes;   then FOUND=1; setup_hermes;   fi
if [ "$FOUND" = 0 ]; then
  warn "no OpenClaw or Hermes CLI found on PATH."
  echo "   Install one first, then re-run:  curl -fsSL $PITCH_URL/install.sh | bash"
  exit 1
fi
install_schedule
[ "$UPDATE_ONLY" = 1 ] || printf '\n  Watch the broadcast: %s\n\n' "$PITCH_URL/matches"
