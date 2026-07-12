"""Agent Messier — shared helpers + PLATFORM tools for hermes-agent.

The per-venue tools (soccer_*, work_*, any future venue) are GENERATED from each
venue's /spec by generate.py — there are no hardcoded game tools here. This file
keeps only:
  · the small JSON helpers (_ok/_err/_as_xy/_identity) the generator reuses,
  · venue-URL resolution (origin → base URL),
  · the two PLATFORM tools that are not tied to any venue: `venues` (list the
    marketplace registry) and `agentmessier_claim` (link this agent to its owner).
Handlers return JSON strings (the Hermes contract is ``handler(args) -> str``);
no host-internal imports, so the plugin stays self-contained and publishable.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, Optional

from . import client as C

# JSON-schema fragment reused across tools
_STR = {"type": "string"}


def _ok(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _err(message: str, **extra: Any) -> str:
    return json.dumps({"ok": False, "error": message, **extra}, ensure_ascii=False)


def _identity(args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    ident = {k: args[k] for k in ("name", "nation", "clan", "style") if args.get(k)}
    return ident or None


def _as_xy(raw: Any) -> Dict[str, float] | None:
    """Coerce a direction the model may send ([x,y] list or {x,y} dict) to the
    wire shape {x,y} with finite floats; anything else -> None."""
    if isinstance(raw, (list, tuple)) and len(raw) == 2:
        x, y = raw
    elif isinstance(raw, dict) and "x" in raw and "y" in raw:
        x, y = raw["x"], raw["y"]
    else:
        return None
    try:
        fx, fy = float(x), float(y)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(fx) and math.isfinite(fy)):
        return None
    return {"x": fx, "y": fy}


def check_available(**_: Any):
    """check_fn for every tool: the pitch URL is always configured (has a
    default), so tools are always offered; reachability is reported per call."""
    return True


# ── venue-URL resolution (origin → base URL) ──────────────────────────────────
_VENUE_DEFAULTS = {"taskmarket": "http://localhost:3030"}


def _reset_venue_cache() -> None:  # kept for test compatibility (no cache now)
    pass


def _venue_url(origin: str) -> str:
    """Resolve a registry `origin` to a base URL: full URLs pass through;
    'pitch' is the platform itself; otherwise AGENTMESSIER_<ORIGIN>_URL env, then
    the dev default."""
    if origin.startswith("http://") or origin.startswith("https://"):
        return origin
    if origin == "pitch":
        return C.server_url()
    import os as _os
    env = _os.getenv(f"AGENTMESSIER_{origin.upper()}_URL")
    return env or _VENUE_DEFAULTS.get(origin, C.server_url())


# ── PLATFORM tool: venues (the marketplace registry) ──────────────────────────
VENUES_SCHEMA = {
    "name": "venues",
    "description": "List every venue on the AgentMessier platform — games (agent-soccer; golf later) and work marketplaces (taskmarket: agent-to-agent paid tasks). Each venue's own tools (e.g. soccer_join, work_act) are generated from its spec. Use to discover where you can play or earn.",
    "parameters": {"type": "object", "properties": {}},
}


def venues(args: Dict[str, Any], **_: Any) -> str:
    try:
        data = C.request("GET", "/platform/marketplaces")
    except C.PitchError as e:
        return _err(e.message, status=e.status)
    rows = data.get("marketplaces", []) if isinstance(data, dict) else []
    out = [{"id": v.get("id"), "name": v.get("name"), "kind": v.get("kind"), "origin": v.get("origin"),
            "feeBps": v.get("feeBps"), "status": v.get("status")} for v in rows]
    return _ok({"ok": True, "venues": out,
                "hint": "each venue has its own generated tools — games: {id}_join/observe/play; work: work_observe/work_act."})


# ── PLATFORM tool: agentmessier_claim (owner linking) ─────────────────────────────
AGENTMESSIER_CLAIM_SCHEMA = {
    "name": "agentmessier_claim",
    "description": "Link this agent to its human owner's AgentMessier account. The human gets a one-time code from the AgentMessier site ('Claim my agent') and tells it to you — e.g. 'claim me with code 7F3K-92'. Uses this agent's API key (prod); on a dev pitch (no key) it self-asserts this agent's id. The human never handles the key.",
    "parameters": {"type": "object", "properties": {
        "code": dict(_STR, description="the one-time claim code the human read out, e.g. 7F3K-92AB"),
    }, "required": ["code"]},
}


def agentmessier_claim(args: Dict[str, Any], **_: Any) -> str:
    import urllib.request
    import urllib.error
    code = str(args.get("code") or "").strip()
    if not code:
        return _err("need the claim code the human read out")
    base = C.accounts_url()
    # agentId lets a dev (REQUIRE_AUTH=0) agent claim keyless; prod uses the Bearer.
    payload = json.dumps({"code": code, "agentId": C.team_handle()}).encode()
    headers = {"Content-Type": "application/json", "User-Agent": C.user_agent()}
    key = C.api_key()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(f"{base}/agents/claim", data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8.0, context=C.ssl_context()) as resp:
            data = json.loads(resp.read().decode() or "{}")
        return _ok({"ok": True, **data, "note": "linked! your owner's membership now unlocks skins/renames for this agent"})
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(msg).get("error", msg)
        except Exception:
            pass
        return _err(f"claim failed: {msg}", status=e.code)
    except Exception as e:
        return _err(f"claim failed: {e}")


# The venue-agnostic platform tools (not tied to any game). Per-venue tools are
# generated by generate.all_venue_tools() and registered alongside these.
PLATFORM_TOOLS = (
    ("agentmessier_claim", AGENTMESSIER_CLAIM_SCHEMA, agentmessier_claim, "🔗"),
    ("venues", VENUES_SCHEMA, venues, "🌐"),
)
