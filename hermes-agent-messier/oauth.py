"""Agent Messier — OAuth 2.0 client (owner-delegated PKCE) for the Hermes agent.

The Python mirror of the OpenClaw plugin's src/oauth.ts (see
docs/design/oauth-agent-auth.md). Hand-rolled on the stdlib (hashlib/secrets/
http.server/urllib) — no dependency. `agentmessier_login` runs the browser PKCE flow
once; the runtime then sends the OAuth access token as Bearer (instead of the raw
API key) with proactive refresh (60s buffer), single-flight dedup, multi-process
disk-change pickup (state.json is re-read each call), and a 401→refresh→retry
path in client.request(). Tokens live in the SAME atomic state.json as the seat.

The bootstrap API key (AGENTMESSIER_API_KEY) is the agent's "client credential":
presented ONLY at the token exchange so accounts can resolve it to the agent DID.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse, parse_qs

from . import client as C

EXPIRY_BUFFER_SEC = 60
CLIENT_ID = "agent-cli"

_refresh_lock = threading.Lock()


# ── token store (in the existing atomic state.json, per server URL) ────────────
def _load() -> Optional[Dict[str, Any]]:
    t = C.load_state().get("oauth")
    return t if isinstance(t, dict) and t.get("refresh_token") else None


def _save(tokens: Dict[str, Any]) -> None:
    st = C.load_state()
    st["oauth"] = tokens
    C.save_state(st)


def oauth_configured() -> bool:
    """True once agentmessier_login has stored tokens — the switch to OAuth auth."""
    return _load() is not None


def clear_tokens() -> None:
    st = C.load_state()
    st.pop("oauth", None)
    C.save_state(st)


def revoke_refresh_token() -> bool:
    """Best-effort server-side revocation of the stored refresh token (RFC 7009-ish):
    POST {accounts}/oauth/revoke {token}. Returns True on a 2xx, False on any
    network/HTTP failure OR when nothing is stored — logout must NEVER fail because
    of this, so callers swallow the result and always clear locally afterwards."""
    t = _load()
    if not t or not t.get("refresh_token"):
        return False  # nothing stored → nothing to revoke
    try:
        url = f"{C.accounts_url()}/oauth/revoke"
        body = json.dumps({"token": t["refresh_token"]}).encode()
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json", "User-Agent": C.user_agent()}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=10.0, context=C.ssl_context()) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False  # offline / DNS / accounts down — logout still succeeds locally


# The agent's persistent credential: env key (AGENTMESSIER_API_KEY), else the one
# provisioned + cached at first login (never human-typed). Re-adopts the SAME DID
# and is the Bearer fallback where pitch still accepts API keys.
def _store_api_key(key: str) -> None:
    st = C.load_state()
    st["api_key"] = key
    C.save_state(st)


def _cached_api_key() -> Optional[str]:
    v = C.load_state().get("api_key")
    return v if isinstance(v, str) and v else None


def _clear_api_key() -> None:
    """Forget the provisioned/cached api_key on logout, once it has been
    deactivated server-side, so the now-dead key isn't re-presented on next login.
    (An env-set AGENTMESSIER_API_KEY lives outside state.json and is left
    untouched — only the cached credential is cleared.)"""
    st = C.load_state()
    st.pop("api_key", None)
    C.save_state(st)


def effective_api_key() -> Optional[str]:
    """Config/env key wins, else the key provisioned + cached at first login.
    None → a login PROVISIONS a new agent."""
    return C.api_key() or _cached_api_key()


def deactivate_api_key() -> bool:
    """Best-effort server-side deactivation of the agent's API key on logout:
    POST {accounts}/oauth/revoke-key with the key as Bearer → {ok,deactivated:N},
    after which the key 401s everywhere. We go through accounts on its /oauth-routed
    surface (the only path the ingress reliably routes to accounts — same as
    /oauth/revoke + /oauth/token); accounts forwards the SAME bearer in-cluster to
    MCP's ClusterIP-only /agents/self/deactivate. Returns True on a 2xx, False on
    any network/HTTP failure OR when there is no key — logout must NEVER fail
    because of this, so callers swallow the result and always clear locally."""
    key = effective_api_key()
    if not key:
        return False  # no key → nothing to deactivate
    try:
        url = f"{C.accounts_url()}/oauth/revoke-key"
        req = urllib.request.Request(
            url,
            data=b"",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}", "User-Agent": C.user_agent()},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10.0, context=C.ssl_context()) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False  # offline / DNS / accounts down — logout still succeeds locally


# ── PKCE ──────────────────────────────────────────────────────────────────────
def _b64url(b: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _pkce() -> Tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


# ── token endpoint ────────────────────────────────────────────────────────────
def _post_token(body: Dict[str, str], bearer: Optional[str] = None) -> Tuple[Dict[str, Any], Optional[str]]:
    """POST the token endpoint. Returns (token_set, minted_api_key_or_None) — the
    server returns an api_key once on a PROVISION login."""
    url = f"{C.accounts_url()}/oauth/token"
    headers = {"Content-Type": "application/json", "User-Agent": C.user_agent()}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10.0, context=C.ssl_context()) as resp:
        data = json.loads(resp.read().decode() or "{}")
    if not (isinstance(data.get("access_token"), str) and isinstance(data.get("refresh_token"), str)):
        raise ValueError("malformed token response")
    expires_in = data.get("expires_in") if isinstance(data.get("expires_in"), (int, float)) else 3600
    tokens = {
        "access_token": data["access_token"],
        "refresh_token": data["refresh_token"],
        "expires_at": time.time() + float(expires_in),
    }
    if isinstance(data.get("scope"), str):
        tokens["scope"] = data["scope"]
    api_key = data.get("api_key") if isinstance(data.get("api_key"), str) else None
    return tokens, api_key


def _fresh(t: Dict[str, Any]) -> bool:
    return bool(t.get("access_token")) and (t.get("expires_at", 0) - time.time() > EXPIRY_BUFFER_SEC)


def _do_refresh(refresh_token: str) -> Optional[str]:
    try:
        tokens, _ = _post_token({"grant_type": "refresh_token", "refresh_token": refresh_token})
        _save(tokens)
        return tokens["access_token"]
    except Exception:
        return None  # revoked/expired → caller prompts re-login


def get_access_token() -> Optional[str]:
    """A valid access token, refreshing proactively. None when not logged in (the
    caller falls back to the API key) or a refresh fails."""
    t = _load()
    if not t:
        return None
    if _fresh(t):
        return t["access_token"]
    with _refresh_lock:  # single-flight: re-check under lock (another thread may have refreshed)
        t2 = _load()
        if t2 and _fresh(t2):
            return t2["access_token"]
        return _do_refresh((t2 or t)["refresh_token"])


def refresh_after_401() -> Optional[str]:
    """Reactive 401 recovery: pick up a token another process already refreshed
    (state.json re-read), else refresh ourselves. None → prompt re-login."""
    with _refresh_lock:
        t = _load()
        if not t:
            return None
        if _fresh(t):  # another process refreshed
            return t["access_token"]
        return _do_refresh(t["refresh_token"])


# ── browser login flow ────────────────────────────────────────────────────────
class _CallbackHandler(BaseHTTPRequestHandler):
    code: Optional[str] = None
    expect_state: str = ""

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        q = parse_qs(parsed.query)
        code = (q.get("code") or [None])[0]
        state = (q.get("state") or [None])[0]
        self.send_response(200 if code and state == type(self).expect_state else 400)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        if code and state == type(self).expect_state:
            type(self).code = code
            self.wfile.write(b"<h3>AgentMessier login complete</h3><p>You may close this tab.</p>")
        else:
            self.wfile.write(b"<h3>AgentMessier login failed</h3><p>Bad state or missing code.</p>")

    def log_message(self, *_: Any) -> None:  # silence the default stderr logging
        pass


def login_flow(log) -> None:
    """Run the owner-delegated PKCE login: open the browser to the accounts
    authorize page, receive the code on a localhost callback, exchange it for
    tokens, and store them. No key needed — with one (env or previously
    provisioned) the agent re-adopts the SAME DID; without one the server
    PROVISIONS a new agent and returns its key once, which we persist."""
    key = effective_api_key()  # may be None → provision a fresh agent
    verifier, challenge = _pkce()
    state = _b64url(secrets.token_bytes(16))
    _CallbackHandler.code = None
    _CallbackHandler.expect_state = state
    server = HTTPServer(("127.0.0.1", 0), _CallbackHandler)
    server.timeout = 300
    port = server.server_address[1]
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    url = (
        f"{C.accounts_url()}/oauth/authorize?response_type=code&client_id={CLIENT_ID}"
        f"&code_challenge={challenge}&code_challenge_method=S256"
        f"&redirect_uri={urllib.parse.quote(redirect_uri, safe='')}&state={state}&scope=play"
    )
    try:
        webbrowser.open(url)
    except Exception:
        pass
    log(f"Opening your browser to authorize this agent. If it didn't open, visit:\n{url}")
    server.handle_request()  # blocks until the callback (or `timeout` seconds)
    server.server_close()
    if not _CallbackHandler.code:
        raise RuntimeError("login timed out (no browser callback)")
    tokens, api_key = _post_token(
        {"grant_type": "authorization_code", "code": _CallbackHandler.code,
         "code_verifier": verifier, "redirect_uri": redirect_uri},
        bearer=key,
    )
    _save(tokens)
    if api_key:
        _store_api_key(api_key)  # persist the provisioned credential
    log("✓ AgentMessier login complete — the agent now authenticates with OAuth"
        + (" (new agent provisioned)." if api_key else "."))


# ── PLATFORM tools (login lifecycle) ──────────────────────────────────────────
AGENTMESSIER_LOGIN_SCHEMA = {
    "name": "agentmessier_login",
    "description": "Authenticate this agent to AgentMessier via your browser (OAuth). Opens a page where you (the owner) sign in and approve; the agent then uses OAuth tokens instead of a raw API key.",
    "parameters": {"type": "object", "properties": {}},
}

AGENTMESSIER_LOGOUT_SCHEMA = {
    "name": "agentmessier_logout",
    "description": "Fully log this agent out of AgentMessier: revokes the OAuth refresh token AND deactivates the agent's API key server-side (so neither can be reused), then clears all local credentials.",
    "parameters": {"type": "object", "properties": {}},
}


def agentmessier_login(args: Dict[str, Any], **_: Any) -> str:
    lines: list[str] = []
    try:
        login_flow(lines.append)
        return json.dumps({"ok": True, "log": lines}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e), "log": lines}, ensure_ascii=False)


def agentmessier_logout(args: Dict[str, Any], **_: Any) -> str:
    # Invalidate server-side FIRST (both best-effort) so the credentials are dead
    # remotely, THEN clear locally. Local clear must ALWAYS happen — a failed
    # revoke/deactivate never blocks logout.
    revoked = revoke_refresh_token()
    key_invalidated = deactivate_api_key()
    clear_tokens()
    _clear_api_key()  # drop the now-dead key so it isn't re-presented on next login
    note = (
        ("OAuth tokens cleared; refresh token revoked server-side" if revoked
         else "OAuth tokens cleared (server revoke skipped or failed)")
        + ("; API key deactivated server-side" if key_invalidated
           else " — API key deactivation skipped or failed")
        + "; all local credentials cleared."
    )
    return json.dumps(
        {"ok": True, "serverRevoked": revoked, "keyInvalidated": key_invalidated, "note": note},
        ensure_ascii=False,
    )


OAUTH_TOOLS = (
    ("agentmessier_login", AGENTMESSIER_LOGIN_SCHEMA, agentmessier_login, "🔑"),
    ("agentmessier_logout", AGENTMESSIER_LOGOUT_SCHEMA, agentmessier_logout, "🚪"),
)
