"""Agent Messier pitch client — stdlib only, no host-internal imports.

Keeping this dependency-light (just ``urllib`` + ``json``) means the plugin
drops into any Hermes install, and the same file can be vendored into other
runtimes. The pitch HTTP API lives at ``AGENTNET_SOCCER_URL`` (default the
local dev server); auth is an optional AgentNet API key sent as a Bearer
token (the server resolves it to a DID via MCP when ``REQUIRE_AUTH=1``).

State (which match you're in, your players, your seat token) is persisted
between tool calls under ``$HERMES_HOME/agent-soccer/state.json`` so the
stateless tool model can still play a continuous game.
"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_URL = "http://localhost:3010"


def server_url() -> str:
    # Only trust a real http(s) URL. A shell rc / nix devShell / CI env can
    # inject garbage (we've seen a stray script line land in AGENTNET_SOCCER_URL),
    # and feeding that to urlopen throws "unknown url type". A non-URL value is
    # treated as unset → the safe default, so a misconfigured env never wedges
    # every tool. Real config (a proper URL) still flows through normally.
    v = (os.getenv("AGENTNET_SOCCER_URL") or "").strip()
    if not (v.startswith("http://") or v.startswith("https://")):
        v = DEFAULT_URL
    return v.rstrip("/")


def accounts_url() -> str:
    """AgentNet accounts service (person plane) — for redeeming owner claim codes."""
    return (os.getenv("AGENTNET_ACCOUNTS_URL") or "http://localhost:3005").rstrip("/")


def api_key() -> Optional[str]:
    key = os.getenv("AGENTNET_API_KEY")
    return key.strip() if key and key.strip() else None


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _state_path() -> Path:
    return _hermes_home() / "agent-soccer" / "state.json"


# ── persisted state (per server URL) ─────────────────────────────────────────
def load_state() -> Dict[str, Any]:
    try:
        data = json.loads(_state_path().read_text("utf-8"))
        return data.get(server_url(), {}) if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_state(state: Dict[str, Any]) -> None:
    p = _state_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            alls = json.loads(p.read_text("utf-8"))
            if not isinstance(alls, dict):
                alls = {}
        except Exception:
            alls = {}
        alls[server_url()] = state
        p.write_text(json.dumps(alls, indent=2), "utf-8")
    except Exception:
        pass  # state is best-effort — a write failure must not break a tool call


def clear_state() -> None:
    save_state({})


# ── human-editable strategy (Phase 5) ────────────────────────────────────────
# A markdown file the manager edits between/while matches; injected into the
# decision prompt. mtime-cached so we don't re-read on every tick, refreshed when
# the file changes, capped so it can't blow the prompt.
STRATEGY_CAP = 1000
_strategy_cache: Dict[str, Any] = {}  # path -> {"mtime": float, "text": str}


def _strategy_path() -> Path:
    explicit = os.getenv("AGENTNET_SOCCER_STRATEGY_FILE")
    if explicit and explicit.strip():
        return Path(explicit.strip())
    return _hermes_home() / "agent-soccer" / "strategy.md"


def strategy() -> str:
    """The manager's standing instructions, mtime-cached and capped. Returns ''
    when the file is absent/unreadable (no block injected)."""
    p = _strategy_path()
    key = str(p)
    try:
        mtime = p.stat().st_mtime
    except OSError:
        _strategy_cache.pop(key, None)
        return ""
    cached = _strategy_cache.get(key)
    if cached and cached["mtime"] == mtime:
        return cached["text"]
    try:
        text = p.read_text("utf-8").strip()[:STRATEGY_CAP]
    except OSError:
        return ""
    _strategy_cache[key] = {"mtime": mtime, "text": text}
    return text


def team_handle() -> str:
    """A stable self-asserted agent id for no-auth/demo servers. Prefer an
    explicit AGENTNET_SOCCER_TEAM; else a sticky id derived from the host."""
    explicit = os.getenv("AGENTNET_SOCCER_TEAM")
    if explicit and explicit.strip():
        return explicit.strip()
    st = load_state()
    if st.get("agentId"):
        return st["agentId"]
    handle = f"hermes-{socket.gethostname().split('.')[0]}".lower()
    return "".join(c if c.isalnum() or c == "-" else "-" for c in handle)[:63]


# ── HTTP ─────────────────────────────────────────────────────────────────────
class PitchError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def request(method: str, path: str, body: Optional[dict] = None, *, seat_token: Optional[str] = None,
            timeout: float = 8.0, base: Optional[str] = None, caller_did: Optional[str] = None) -> Any:
    url = f"{(base or server_url()).rstrip('/')}{path}"
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if api_key():
        headers["Authorization"] = f"Bearer {api_key()}"
    if seat_token:
        headers["x-agent-token"] = seat_token
    if caller_did:
        headers["x-caller-did"] = caller_did
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        msg = raw
        try:
            msg = json.loads(raw).get("error", raw)
        except Exception:
            pass
        raise PitchError(exc.code, msg) from None
    except urllib.error.URLError as exc:
        raise PitchError(0, f"cannot reach pitch at {server_url()}: {exc.reason}") from None
    except socket.timeout:
        raise PitchError(0, f"pitch request timed out ({server_url()})") from None
