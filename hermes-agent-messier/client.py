"""Agent Messier pitch client.

The pitch HTTP API lives at ``AGENTMESSIER_URL`` (default the local dev
server); auth is an optional AgentMessier API key sent as a Bearer token (the
server resolves it to a DID via MCP when ``REQUIRE_AUTH=1``).

State (which match you're in, your players, your seat token) is persisted
between tool calls under ``$HERMES_HOME/agent-messier/state.json`` so the
stateless tool model can still play a continuous game.

HTTP transport uses a shared ``httpx.Client`` (keep-alive, connection reuse)
so TLS handshakes are not repeated on every pitch POST.
"""

from __future__ import annotations

import json
import os
import platform
import re
import secrets
import ssl
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

DEFAULT_URL = "https://agent.agentmessier.com"

# Identify ourselves so a bot-filtering edge (e.g. Cloudflare in front of a
# staging host) doesn't 403 us on the generic "Python-urllib/x" User-Agent its
# managed rules block by default. httpx already sends its own non-generic UA;
# this is for the stdlib urllib call sites (oauth.py, tools.py) that would
# otherwise fall back to the blocked default.
USER_AGENT = "agent-messier-hermes"


def user_agent() -> str:
    return USER_AGENT

# Effective LLM (provider/model) of the most recent decision, set by the plugin
# after each completion and sent as x-agent-model — so the pitch records the
# model actually playing, reflecting a mid-match model switch.
_LAST_MODEL: Optional[str] = None


def set_last_model(model: Optional[str]) -> None:
    global _LAST_MODEL
    if model:
        _LAST_MODEL = str(model)[:80]


def last_model() -> Optional[str]:
    """The effective LLM (provider/model) of the most recent decision, or None."""
    return _LAST_MODEL


def server_url() -> str:
    # Only trust a real http(s) URL. A shell rc / nix devShell / CI env can
    # inject garbage (we've seen a stray script line land in AGENTMESSIER_URL),
    # and feeding that to urlopen throws "unknown url type". A non-URL value is
    # treated as unset → the safe default, so a misconfigured env never wedges
    # every tool. Real config (a proper URL) still flows through normally.
    v = (os.getenv("AGENTMESSIER_URL") or "").strip()
    if not (v.startswith("http://") or v.startswith("https://")):
        v = DEFAULT_URL
    return v.rstrip("/")


def accounts_url() -> str:
    """Accounts / person-plane service (OAuth login, owner claim codes). Defaults to
    the public platform host (DEFAULT_URL), NOT server_url() — deliberately, so a local
    dev running pitch on localhost still does its Google-OAuth round-trip against the
    real public accounts (Google needs a real redirect host). See
    test_accounts_url_default_ignores_local_pitch. To retarget login at an alternate
    venue (e.g. a staging host), set AGENTMESSIER_ACCOUNTS_URL explicitly alongside
    AGENTMESSIER_URL (e.g. both = https://staging.agentmessier.com)."""
    return (os.getenv("AGENTMESSIER_ACCOUNTS_URL") or DEFAULT_URL).rstrip("/")


def api_key() -> Optional[str]:
    key = os.getenv("AGENTMESSIER_API_KEY")
    return key.strip() if key and key.strip() else None


def client_cert() -> Optional[Tuple[str, str]]:
    """Optional TLS client certificate for a venue behind mutual-TLS (e.g. a
    Cloudflare-fronted staging host whose edge demands a client cert). Returns
    (cert_path, key_path) when BOTH AGENTMESSIER_CLIENT_CERT and
    AGENTMESSIER_CLIENT_KEY point at readable files, else None (the normal
    public host needs no client cert). A partial/broken config is treated as
    unset so a typo never wedges every request — same defensive stance as
    server_url()."""
    cert = (os.getenv("AGENTMESSIER_CLIENT_CERT") or "").strip()
    key = (os.getenv("AGENTMESSIER_CLIENT_KEY") or "").strip()
    if cert and key and os.path.isfile(cert) and os.path.isfile(key):
        return (cert, key)
    return None


def ssl_context() -> Optional["ssl.SSLContext"]:
    """SSLContext presenting the client cert for the stdlib urllib call sites
    (oauth.py, tools.py) — httpx has its own cert= param. None when no client
    cert is configured, so urlopen uses its default context unchanged."""
    pair = client_cert()
    if pair is None:
        return None
    ctx = ssl.create_default_context()
    ctx.load_cert_chain(certfile=pair[0], keyfile=pair[1])
    return ctx


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))


def _state_path() -> Path:
    return _hermes_home() / "agent-messier" / "state.json"


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
        # Atomic write: a crash / disk-full mid-write must never leave a truncated
        # state.json. Write a uniquely-named temp file in the SAME dir, flush+fsync,
        # then os.replace() (atomic rename on POSIX + Windows when same filesystem).
        fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".state-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(alls, indent=2))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, p)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception:
        pass  # state is best-effort — a write failure must not break a tool call


def clear_state() -> None:
    save_state({})


# ── per-venue seats ───────────────────────────────────────────────────────────
# Each venue keeps its OWN seat (match id, seat token, controlled players, seat
# did, origin) under state["seats"][venueId]. This is the authoritative seat
# store — the autoplay loop and every generated tool read it per venue, so two
# venues never clobber each other (the old flat matchId/token were single-venue).
def load_seat(venue_id: str) -> Dict[str, Any]:
    seat = load_state().get("seats", {}).get(venue_id, {})
    return seat if isinstance(seat, dict) else {}


def save_seat(venue_id: str, seat: Dict[str, Any]) -> None:
    st = load_state()
    st.setdefault("seats", {})[venue_id] = seat
    save_state(st)


def active_seats() -> List[Tuple[str, Dict[str, Any]]]:
    """Every venue seat with a live match + controlled players — the seat-based
    games the autoplay loop should drive. Seatless venues (the work market) never
    create such a seat, so they are naturally excluded."""
    seats = load_state().get("seats", {})
    return [(vid, s) for vid, s in seats.items()
            if isinstance(s, dict) and s.get("id") and s.get("controls")]


# ── human-editable strategy (Phase 5) ────────────────────────────────────────
# A markdown file the manager edits between/while matches; injected into the
# decision prompt. mtime-cached so we don't re-read on every tick, refreshed when
# the file changes, capped so it can't blow the prompt.
STRATEGY_CAP = 1000
_strategy_cache: Dict[str, Any] = {}  # path -> {"mtime": float, "text": str}


# A broken installer can write a shell command (its own error string) into an
# env value instead of printing it — e.g. AGENTMESSIER_NAME=echo "Install one
# first, then re-run: curl …/install.sh | bash". Reject anything that looks like a
# leaked shell fragment so a corrupt ~/.hermes/.env can't poison the team name or
# strategy path; the plugin then self-heals to its safe default (no .env edit
# needed — this ships via the plugin-update pipeline).
# A broken installer corrupted ~/.hermes/.env by writing consecutive lines of its
# own SHELL SOURCE as values (AGENTMESSIER_NATION=exit 1, CLAN=fi, NAME=echo
# "Install one first…", API_KEY=if [ "$FOUND" = 0 ]; then …). Reject anything that
# looks like shell — metacharacters, a `[ … ]` test, a leading shell keyword /
# installer function — so the plugin self-heals to its safe default regardless of
# the .env garbage.
_SHELL_JUNK = re.compile(
    r'''[`$|;"\n]'''                                                       # shell metacharacters
    r'''|install\.sh'''
    r'''|^\s*\['''                                                         # a `[ "$x" = 0 ]` test line
    r'''|\b(curl|wget|sudo|bash|sh)\b'''
    r'''|^\s*(echo|if|fi|then|else|elif|do|done|for|while|case|esac'''
    r'''|exit|return|local|export|function|warn|say|ok)\b''',              # shell keywords / installer funcs
    re.IGNORECASE,
)


def _clean_env(name: str) -> Optional[str]:
    """An env value, stripped — or None if unset/blank or a leaked shell fragment."""
    v = os.getenv(name)
    if not v:
        return None
    v = v.strip()
    if not v or _SHELL_JUNK.search(v):
        return None
    return v


def _strategy_path() -> Path:
    explicit = _clean_env("AGENTMESSIER_STRATEGY_FILE")
    if explicit:
        return Path(explicit)
    return _hermes_home() / "agent-messier" / "strategy.md"


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
    """A stable self-asserted PLATFORM agent id for no-auth/demo servers. Prefer
    an explicit AGENTMESSIER_TEAM; else a sticky random id persisted under its
    OWN state key. Deliberately NOT derived from the hostname — the machine name
    must never leave the host (only OS + version travel, via x-agent-os). Kept
    separate from per-venue seat dids (state["seats"][v]["agentId"]) so a join
    can't overwrite the platform handle (the old flat "agentId" did exactly that,
    leaking the last venue's seat did across venues)."""
    explicit = os.getenv("AGENTMESSIER_TEAM")
    if explicit and explicit.strip():
        return explicit.strip()
    st = load_state()
    if st.get("handle"):
        return st["handle"]
    handle = f"hermes-{uuid.uuid4().hex[:12]}"
    st["handle"] = handle
    save_state(st)  # persist so the handle is sticky across calls/restarts
    return handle


def identity_defaults() -> Dict[str, str]:
    """Team identity (name/nation/clan/style) set once at install via env — the
    counterpart to the OpenClaw plugin's team/clan/nation/style config fields.
    Per-call soccer_join args override these; unset keys are omitted. The pitch
    reads identity as a NESTED object, which the join/quickmatch paths build."""
    env = {
        "name": _clean_env("AGENTMESSIER_NAME"),
        "nation": _clean_env("AGENTMESSIER_NATION"),
        "clan": _clean_env("AGENTMESSIER_CLAN"),
        "style": _clean_env("AGENTMESSIER_STYLE"),
    }
    return {k: v for k, v in env.items() if v}


def _plugin_version() -> str:
    """The plugin version from plugin.yaml — the single source the publish
    pipeline bumps — read once at import. Sent in x-agent-runtime so the pitch
    records WHICH plugin version holds a seat (otherwise the update signal is
    invisible at runtime). Falls back to 'dev' if the manifest isn't readable."""
    try:
        for line in (Path(__file__).resolve().parent / "plugin.yaml").read_text("utf-8").splitlines():
            if line.startswith("version:"):
                return line.split(":", 1)[1].strip() or "dev"
    except OSError:
        pass
    return "dev"


PLUGIN_VERSION = _plugin_version()

# Agent host OS + version — sent as x-agent-os so the pitch records the platform
# (NOT the machine name; platform.platform() carries os/version/arch only, never
# the hostname). Computed once (static per host); the robust cross-OS one-liner
# (Windows-safe — Hermes runs natively on Windows).
AGENT_OS = platform.platform()


# ── HTTP ─────────────────────────────────────────────────────────────────────
class PitchError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def sub_route(route: str, **vars: Any) -> str:
    """Fill {name} placeholders in a route template — the ONE substitution helper
    used across the plugin (generate / watcher / selfcheck / report_decision), so
    the {matchId}/{did}/{playerId} logic lives in exactly one place."""
    for k, v in vars.items():
        route = route.replace("{" + k + "}", str(v))
    return route


_http: Optional[httpx.Client] = None
_http_cert: Optional[Tuple[str, str]] = None  # cert the live client was built with


def _get_http() -> httpx.Client:
    global _http, _http_cert
    cert = client_cert()
    # Rebuild if the cert config changed since the client was built. This is
    # NOT just an optimization: the plugin fires HTTP at import (venue
    # discovery) which can build the client BEFORE the host has loaded
    # ~/.hermes/.env into os.environ — that first client would be cert-less
    # and, cached for the process lifetime, would 403 forever against an
    # mTLS venue. Re-checking the cert per call lets the client self-heal
    # the moment the cert env becomes visible.
    if _http is not None and cert != _http_cert:
        try:
            _http.close()
        except Exception:
            pass
        _http = None
    if _http is None:
        # cert= presents the client certificate on every request when the venue
        # is mTLS-gated (cert is None for the normal public host, so httpx
        # behaves exactly as before).
        _http = httpx.Client(timeout=8.0, cert=cert)
        _http_cert = cert
    return _http


def request(method: str, path: str, body: Optional[dict] = None, *, seat_token: Optional[str] = None,
            timeout: float = 8.0, base: Optional[str] = None, caller_did: Optional[str] = None,
            extra_headers: Optional[Dict[str, str]] = None) -> Any:
    url = f"{(base or server_url()).rstrip('/')}{path}"
    headers: Dict[str, str] = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    # Identity: prefer the OAuth access token (proactively refreshed); fall back to
    # the static API key for un-migrated deployments. Lazy import avoids an import
    # cycle (oauth imports this module). The seat token (x-agent-token) is separate.
    access = None
    try:
        from . import oauth as _oauth
        access = _oauth.get_access_token()
    except Exception:
        access = None
    if access:
        headers["Authorization"] = f"Bearer {access}"
    else:
        # Config/env key, or the key provisioned + cached at first login.
        _key = None
        try:
            from . import oauth as _oauth
            _key = _oauth.effective_api_key()
        except Exception:
            _key = api_key()
        if _key:
            headers["Authorization"] = f"Bearer {_key}"
    if seat_token:
        headers["x-agent-token"] = seat_token
    if caller_did:
        headers["x-caller-did"] = caller_did
    if _LAST_MODEL:
        headers["x-agent-model"] = _LAST_MODEL
    headers["x-agent-runtime"] = f"hermes-plugin/agent-messier@{PLUGIN_VERSION}"
    headers["x-agent-os"] = AGENT_OS
    if extra_headers:  # e.g. x-manager-key for the governance extras — merged last
        headers.update(extra_headers)
    try:
        headers["traceparent"] = f"00-{secrets.token_hex(16)}-{secrets.token_hex(8)}-01"
    except Exception:
        pass

    def _send(hdrs: Dict[str, str]) -> Any:
        resp = _get_http().request(method, url, json=body, headers=hdrs, timeout=timeout)
        resp.raise_for_status()
        return resp.json() if resp.content else {}

    try:
        return _send(headers)
    except httpx.HTTPStatusError as exc:
        # Reactive 401 recovery: refresh once and retry (only when we used OAuth).
        if exc.response.status_code == 401 and access:
            try:
                from . import oauth as _oauth
                fresh = _oauth.refresh_after_401()
            except Exception:
                fresh = None
            if fresh:
                headers["Authorization"] = f"Bearer {fresh}"
                try:
                    return _send(headers)
                except httpx.HTTPStatusError as exc2:
                    exc = exc2
                except httpx.RequestError:
                    raise PitchError(0, f"cannot reach pitch at {server_url()}") from None
        raw = exc.response.text
        msg = raw
        try:
            msg = exc.response.json().get("error", raw)
        except Exception:
            pass
        raise PitchError(exc.response.status_code, msg) from None
    except httpx.RequestError as exc:
        raise PitchError(0, f"cannot reach pitch at {server_url()}: {exc}") from None


# ── decision observability (Change 2) ────────────────────────────────────────
def report_decision(match_id: str, agent_id: str, report: Dict[str, Any], *,
                    seat_token: Optional[str] = None, base: Optional[str] = None,
                    decision_route: Optional[str] = None) -> None:
    """Best-effort POST of a per-decision report to the venue. The endpoint is
    SPEC-DRIVEN (`decision_route` = spec.routes.decision) with a soccer-literal
    fallback — nothing hardcoded, so a new venue (golf, …) reports to its own
    decision endpoint. Authed exactly like the action POST (x-agent-token seat
    token / AGENTMESSIER_API_KEY bearer); `base` targets the seat's own venue
    (defaults to the pitch). Fired for BOTH acted and no_response turns; a failure
    here must never break the play loop."""
    if not (match_id and agent_id and isinstance(report, dict)):
        return
    tpl = decision_route or "/matches/{matchId}/agents/{did}/decision"
    path = sub_route(tpl, matchId=match_id, did=agent_id, agentId=agent_id)
    try:
        request("POST", path, report, seat_token=seat_token, base=base, caller_did=agent_id)
    except PitchError:
        pass  # observability is non-essential — a dropped report never stops play
