"""Agent play-readiness self-diagnosis.

Before (and during) a game the watcher must answer one question: *can this agent
actually play?* That needs four live dependencies — the pitch SERVER is up, the
VENUE is speakable (a usable spec), the SEAT/auth is valid, and the primary MODEL
produces output. When any of these silently fails the agent degrades into a wall
of empty "no_response" decisions (the m471 incident). This module verifies each
one and returns a structured `diagnosis` the watcher surfaces (status + logs) and
pushes to the pitch (rides the decision report → inspector banner).

Pure-ish: HTTP via `client.request`, no globals. The MODEL check uses a
NON-swallowing probe (`diagnose_complete`) so the real provider error
(e.g. "unknown provider 'openai'") reaches the user instead of being eaten.
"""
from __future__ import annotations

import datetime
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import client as C

# Probe the host LLM WITHOUT swallowing failures. Returns
# {"ok", "text", "model", "provider", "error"}. Wired in __init__.
DiagnoseComplete = Callable[..., Dict[str, Any]]

# The spec manifest shape this plugin understands. A server advertising a
# different major shape means the wire contract moved under us.
KNOWN_SPEC_VERSION = 1


def _now() -> str:
    try:
        return datetime.datetime.now(datetime.timezone.utc).isoformat()
    except Exception:
        return ""


def _check_server(base: str) -> Dict[str, Any]:
    """Cheapest liveness probe — GET /health (unauth, in-memory on the server)."""
    try:
        data = C.request("GET", "/health", base=base)
        ok = isinstance(data, dict) and data.get("ok") is True
        return {"name": "server", "ok": bool(ok),
                "detail": "GET /health 200" if ok else "GET /health: unexpected response"}
    except C.PitchError as e:
        return {"name": "server", "ok": False, "detail": (e.message or f"status {e.status}")[:200]}


def _try_fetch_spec(base: str) -> Optional[Dict[str, Any]]:
    try:
        spec = C.request("GET", "/spec", base=base)
        return spec if isinstance(spec, dict) else None
    except C.PitchError:
        return None


def _check_venue(spec: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The venue is speakable iff its spec advertises routes + actions at a
    compatible specVersion (so the loop knows where to act and what's legal)."""
    if not isinstance(spec, dict) or not spec.get("routes") or not spec.get("actions"):
        return {"name": "venue", "ok": False, "detail": "no usable spec (routes/actions missing)"}
    sv = spec.get("specVersion")
    if sv is not None and sv != KNOWN_SPEC_VERSION:
        return {"name": "venue", "ok": False,
                "detail": f"incompatible specVersion {sv} (expected {KNOWN_SPEC_VERSION})"}
    return {"name": "venue", "ok": True, "detail": f"spec v{sv} rules{spec.get('rulesVersion')}"}


def _check_seat(base: str, spec: Optional[Dict[str, Any]], seat: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The seat/auth is valid iff the authed state read succeeds. Not-yet-seated
    is n/a (not a failure — the agent simply isn't in a game yet)."""
    if not seat or not seat.get("id"):
        return {"name": "seat", "ok": True, "detail": "n/a — not seated"}
    routes = spec.get("routes") if isinstance(spec, dict) else None
    tpl = (routes or {}).get("state") or (routes or {}).get("observe") or "/matches/{matchId}/agents/{did}/state"
    did = seat.get("agentId") or C.team_handle()
    path = C.sub_route(tpl, matchId=seat["id"], did=did)
    try:
        C.request("GET", path, base=base, seat_token=seat.get("token"), caller_did=did)
        return {"name": "seat", "ok": True, "detail": "state 200"}
    except C.PitchError as e:
        if e.status == 404:
            return {"name": "seat", "ok": False, "detail": "seat/match gone (404)"}
        if e.status == 401:
            return {"name": "seat", "ok": False, "detail": "bad/missing seat token (401)"}
        return {"name": "seat", "ok": False, "detail": (e.message or f"status {e.status}")[:160]}


def _check_model(diagnose_complete: Optional[DiagnoseComplete]) -> Tuple[Dict[str, Any], Optional[str]]:
    """The PRIMARY model must produce non-empty output. This is the check that
    catches a misrouted/undefined provider — it exercises the SAME completion the
    watcher plays with, and reports the raw provider error, not a swallowed ''."""
    if diagnose_complete is None:
        return {"name": "model", "ok": True, "detail": "n/a — model probe not wired"}, None
    try:
        r = diagnose_complete([{"role": "user", "content": "Reply with the single word: OK"}], 16)
    except Exception as e:  # the probe itself blew up
        return {"name": "model", "ok": False, "detail": f"error: {str(e)[:160]}"}, None
    prov, mdl = r.get("provider"), r.get("model")
    primary = (f"{prov}/{mdl}" if prov and mdl else (mdl or prov)) or None
    suffix = f" (primary={primary})" if primary else ""
    if r.get("error"):
        return {"name": "model", "ok": False, "detail": f"error: {str(r['error'])[:160]}{suffix}"}, primary
    if not (r.get("text") or "").strip():
        return {"name": "model", "ok": False, "detail": f"empty reply{suffix}"}, primary
    return {"name": "model", "ok": True, "detail": f"replied ({primary or 'model'})"}, primary


def preflight(base: str, *, diagnose_complete: Optional[DiagnoseComplete] = None,
              spec: Optional[Dict[str, Any]] = None,
              seat: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Run all four checks against `base` and return the shared diagnosis contract:
    {state, reason, primaryModel, checkedAt, checks[]}. `state` is degraded iff any
    non-n/a check fails; `reason` is the first failure's detail."""
    if not isinstance(spec, dict):
        spec = _try_fetch_spec(base)
    model_check, primary = _check_model(diagnose_complete)
    checks: List[Dict[str, Any]] = [
        _check_server(base),
        _check_venue(spec),
        _check_seat(base, spec, seat),
        model_check,
    ]
    degraded = [c for c in checks if not c["ok"]]
    return {
        "state": "degraded" if degraded else "ok",
        "reason": degraded[0]["detail"] if degraded else None,
        "primaryModel": primary,
        "checkedAt": _now(),
        "checks": checks,
    }
