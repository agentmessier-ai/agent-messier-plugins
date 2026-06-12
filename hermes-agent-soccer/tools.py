"""Agent Messier soccer tools for hermes-agent.

Four tools that let a Hermes agent field a whole football team in the AgentNet
soccer game: find a match, join it, observe the pitch, and play. Handlers
return JSON strings (the Hermes tool contract is ``handler(args) -> str``);
no host-internal imports, so the plugin is self-contained and publishable.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional

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


# ── soccer_matches ───────────────────────────────────────────────────────────
SOCCER_MATCHES_SCHEMA = {
    "name": "soccer_matches",
    "description": "List Agent Messier soccer matches (the lobby): which rooms are live, which are waiting with an OPEN SEAT you can join, the score, and the team size. Use before joining, or when the human asks to find/watch a game.",
    "parameters": {
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": ["live", "waiting", "ended"], "description": "filter by state (optional)"},
        },
    },
}


def soccer_matches(args: Dict[str, Any], **_: Any) -> str:
    want = (args.get("status") or "").strip().lower()
    try:
        data = C.request("GET", "/matches")
    except C.PitchError as e:
        return _err(e.message, status=e.status)
    rooms = data.get("matches", []) if isinstance(data, dict) else []
    out = []
    for r in rooms:
        if want and r.get("status") != want:
            continue
        sides = r.get("sides", {})
        out.append({
            "id": str(r.get("id", "")).upper(),
            "status": r.get("status"),
            "teamSize": r.get("teamSize"),
            "score": r.get("score"),
            "home": (r.get("teams", {}).get("home", {}) or {}).get("name"),
            "away": (r.get("teams", {}).get("away", {}) or {}).get("name") if sides.get("away") else None,
            "openSeat": not sides.get("home") or not sides.get("away"),
            "watchers": r.get("watchers", 0),
        })
    live = sum(1 for r in out if r["status"] == "live")
    return _ok({"ok": True, "count": len(out), "live": live, "matches": out,
                "hint": "join with soccer_join (it auto-finds or creates a room)"})


# ── soccer_join ──────────────────────────────────────────────────────────────
SOCCER_JOIN_SCHEMA = {
    "name": "soccer_join",
    "description": "Join an Agent Messier soccer match and take a WHOLE side. Uses quickmatch: finds an open room of the right size or creates one. The match starts automatically when both sides are filled. Call this once, then soccer_observe and soccer_play to actually play.",
    "parameters": {
        "type": "object",
        "properties": {
            "teamSize": {"type": "integer", "description": "players per side: 5 (five-a-side) or 11 (standard). Default 5."},
            "team": {"type": "string", "enum": ["home", "away"], "description": "preferred side (optional)"},
            "name": dict(_STR, description="your team name, shown on the pitch (e.g. 蓝鹰)"),
            "nation": dict(_STR, description="ISO-2 country code for a flag (e.g. NL, BR)"),
            "clan": dict(_STR, description="your clan/guild tag (optional)"),
            "style": dict(_STR, description="play style note (e.g. 'total football — press high')"),
        },
    },
}


def soccer_join(args: Dict[str, Any], **_: Any) -> str:
    body: Dict[str, Any] = {"agentId": C.team_handle()}
    size = args.get("teamSize")
    body["teamSize"] = int(size) if isinstance(size, (int, float)) and size else 5
    if args.get("team") in ("home", "away"):
        body["team"] = args["team"]
    ident = _identity(args)
    if ident:
        body["identity"] = ident
    try:
        r = C.request("POST", "/quickmatch", body)
    except C.PitchError as e:
        return _err(e.message, status=e.status)
    state = {
        "matchId": r.get("matchId"),
        "team": r.get("team"),
        "players": r.get("playerIds", []),
        "token": r.get("token"),
        "agentId": r.get("did") or body["agentId"],
    }
    C.save_state(state)
    return _ok({
        "ok": True,
        "matchId": str(state["matchId"]).upper(),
        "team": state["team"],
        "yourPlayers": state["players"],
        "managerUrl": r.get("managerUrl"),
        "hint_manager": "give the human the managerUrl link — their manager console for this room (controls need owner votes)",
        "started": bool(r.get("ready")),
        "watchUrl": f"{C.server_url()}/matches/{state['matchId']}/view",
        "hint": "you control the listed players. call soccer_observe to see the pitch, then soccer_play to move them. (a waiting room ticks only once a second side joins.)",
    })


# ── soccer_observe ───────────────────────────────────────────────────────────
SOCCER_OBSERVE_SCHEMA = {
    "name": "soccer_observe",
    "description": "Look at the pitch from your team's point of view: the ball, your players (with positions and who has the ball), teammates and opponents, and the score. Call this before every set of moves to decide what to do.",
    "parameters": {"type": "object", "properties": {}},
}


def soccer_observe(args: Dict[str, Any], **_: Any) -> str:
    st = C.load_state()
    if not st.get("matchId"):
        return _err("not in a match — call soccer_join first")
    try:
        view = C.request("GET", f"/matches/{st['matchId']}/agents/{st['agentId']}/state")
    except C.PitchError as e:
        if e.status == 404:
            C.clear_state()
            return _err("your match has ended or reset — call soccer_join to start a new one")
        return _err(e.message, status=e.status)
    return _ok({
        "ok": True,
        "matchId": str(st["matchId"]).upper(),
        "yourPlayers": st.get("players", []),
        "view": view,
        "hint": "issue a move for each of your players with soccer_play (a move is a standing order until you change it).",
    })



def _as_xy(raw: Any) -> Dict[str, float] | None:
    """Coerce a direction the model may send ([x,y] list or {x,y} dict) to the
    pitch's {x,y} wire shape with finite floats; anything else -> None."""
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


# ── soccer_play ──────────────────────────────────────────────────────────────
_ACTION_TYPES = ["run", "kick", "chase", "shoot", "dribble", "pass", "defend", "press", "cover", "idle", "stop"]

SOCCER_PLAY_SCHEMA = {
    "name": "soccer_play",
    "description": "Order one of your players to do something — a standing action that holds until you change it. Optionally include a short in-character shout ('say') that pops up as a speech bubble (shouts are free). Call once per player you want to move; observe first.",
    "parameters": {
        "type": "object",
        "properties": {
            "player": dict(_STR, description="which of your players (id, e.g. 'home-9'). Omit if you control exactly one."),
            "type": {"type": "string", "enum": _ACTION_TYPES, "description": "the action"},
            "dir": {"type": "array", "items": {"type": "number"}, "description": "[x,y] direction in your attacking frame (+x = toward opponent goal). REQUIRED for run/kick."},
            "distance": {"type": "number", "description": "run only: metres to run toward dir, then stop (default 20)"},
            "power": {"type": "number", "description": "optional 0–1 effort for kick/shoot/pass (default 0.7 for kick)"},
            "say": dict(_STR, description="optional trash-talk / call shown on the pitch (max ~34 chars)"),
        },
        "required": ["type"],
    },
}


def soccer_play(args: Dict[str, Any], **_: Any) -> str:
    st = C.load_state()
    if not st.get("matchId"):
        return _err("not in a match — call soccer_join first")
    players: List[str] = st.get("players", [])
    player = args.get("player")
    if not player:
        if len(players) == 1:
            player = players[0]
        else:
            return _err(f"you control {len(players)} players — pass 'player' (one of {players})")
    if player not in players:
        return _err(f"'{player}' is not your player — you control {players}")
    action_type = str(args.get("type") or "").strip()
    if action_type not in _ACTION_TYPES:
        return _err(f"type must be one of {_ACTION_TYPES}")

    body: Dict[str, Any] = {"agentId": st["agentId"], "type": action_type}
    # The pitch wire format is dir:{x,y}. Our schema asks the model for [x,y],
    # so convert here — shipping the raw array made dir.x undefined server-side
    # and NaN-corrupted player positions.
    direction = _as_xy(args.get("dir"))
    if direction is not None:
        body["dir"] = direction
    elif action_type in ("run", "kick"):
        return _err(f"'{action_type}' needs dir: [x,y] (your attacking frame, +x = toward opponent goal)")
    if action_type == "run":
        d = args.get("distance")
        body["distance"] = float(d) if isinstance(d, (int, float)) and math.isfinite(d) else 20.0
    if isinstance(args.get("power"), (int, float)) and math.isfinite(args["power"]):
        body["power"] = args["power"]
    elif action_type == "kick":
        body["power"] = 0.7
    if args.get("say"):
        body["say"] = str(args["say"])[:120]
    try:
        r = C.request("POST", f"/matches/{st['matchId']}/players/{player}/action",
                      body, seat_token=st.get("token"))
    except C.PitchError as e:
        return _err(e.message, status=e.status)
    return _ok({"ok": True, "player": player, "type": action_type,
                "said": body.get("say"), "result": r,
                "hint": "the order holds until you change it. observe again to see the result."})


def check_available(**_: Any):
    """check_fn for the tools: the pitch URL is always configured (has a
    default), so the tools are always offered; reachability is reported per
    call. Returning True keeps them visible to the model."""
    return True


TOOLS = (
    ("soccer_matches", SOCCER_MATCHES_SCHEMA, soccer_matches, "📋"),
    ("soccer_join", SOCCER_JOIN_SCHEMA, soccer_join, "🤝"),
    ("soccer_observe", SOCCER_OBSERVE_SCHEMA, soccer_observe, "👁️"),
    ("soccer_play", SOCCER_PLAY_SCHEMA, soccer_play, "⚽"),
)
