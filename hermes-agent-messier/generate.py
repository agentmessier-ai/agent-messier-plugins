"""Generic per-venue tool generator (venue-agnostic-plugins.md §5.2).

Given a registry venue row + its `/spec` (with a `client` lifecycle block), emit
the named tools — `{prefix}_matches/join/observe/act/autoplay` — as the Hermes
`(name, schema, handler, emoji)` tuples. The handlers are GENERIC: every endpoint
comes from `spec.routes`, the seat fields from `spec.client.join.seat`, the
action enum from `spec.actions`. Adding a venue = a registry row + a spec; no
per-game code here.

The tool NAMES and per-tool/per-param descriptions come FROM THE SPEC, so a
generated tool is as well-described as a hand-crafted one (the venue author
writes them once). decide.py stays untouched.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import client as C
from . import tools as T   # reuse _ok / _err / _as_xy / _venue_url / build helpers
from . import watcher as W

Tool = Tuple[str, Dict[str, Any], Callable[..., str], str]


# ── helpers ───────────────────────────────────────────────────────────────────
def _sub(route: str, **kw: Any) -> str:
    for k, v in kw.items():
        route = route.replace("{" + k + "}", str(v))
    return route


def _base(venue: Dict[str, Any]) -> str:
    return T._venue_url(venue.get("origin", "pitch"))


def _did(seat: Optional[Dict[str, Any]] = None) -> str:
    """The agent identity for a venue: the seat's id when joined (soccer), else
    the platform team_handle. NEVER the flat state['agentId'] — that is the
    last-joined venue's seat id and would leak across venues."""
    if seat and seat.get("agentId"):
        return str(seat["agentId"])
    return C.team_handle()


def _seat(venue_id: str) -> Dict[str, Any]:
    return C.load_state().get("seats", {}).get(venue_id, {})


def _save_seat(venue_id: str, seat: Dict[str, Any]) -> None:
    st = C.load_state()
    st.setdefault("seats", {})[venue_id] = seat
    C.save_state(st)


def _whitelist(args: Dict[str, Any], props: Dict[str, Any]) -> Dict[str, Any]:
    """Only the params the spec declares, coercing 2-element arrays to {x,y}."""
    out: Dict[str, Any] = {}
    for k in props:
        if args.get(k) is None:
            continue
        v = args[k]
        coerced = T._as_xy(v) if isinstance(v, (list, tuple)) and len(v) == 2 else None
        out[k] = coerced if coerced is not None else v
    return out


# ── handler factories (closures over venue + spec) ────────────────────────────
def _lobby_handler(venue: Dict[str, Any], spec: Dict[str, Any], step: Dict[str, Any]) -> Callable[..., str]:
    def handler(args: Dict[str, Any], **_: Any) -> str:
        try:
            data = C.request("GET", step["route"], base=_base(venue), caller_did=C.team_handle())
        except C.PitchError as e:
            return T._err(e.message, status=e.status)
        rows = data.get("matches", data.get("rooms", [])) if isinstance(data, dict) else []
        want = str(args.get("status") or "").strip().lower()
        if want:
            rows = [r for r in rows if r.get("status") == want]
        return T._ok({"ok": True, "count": len(rows), "rows": rows,
                      "hint": f"join one with {spec['client']['prefix']}_join"})
    return handler


def _join_handler(venue: Dict[str, Any], spec: Dict[str, Any], step: Dict[str, Any]) -> Callable[..., str]:
    seat_map = step["seat"]
    props = step.get("params", {})

    def handler(args: Dict[str, Any], **_: Any) -> str:
        # matchId (if advertised) targets a SPECIFIC room via seatRoute; it's
        # routing, not a body field, so keep it out of the posted body.
        mid = args.get("matchId")
        mid = str(mid) if isinstance(mid, str) and mid else None
        route = _sub(step["seatRoute"], matchId=mid) if (mid and step.get("seatRoute")) else step["route"]
        body: Dict[str, Any] = {"agentId": C.team_handle(),
                                **{k: v for k, v in _whitelist(args, props).items() if k != "matchId"}}
        try:
            r = C.request("POST", route, body, base=_base(venue), caller_did=C.team_handle())
        except C.PitchError as e:
            return T._err(e.message, status=e.status)
        # A rejoin via seatRoute already knows the room (it's in the URL), so the
        # response omits it — fall back to the matchId we joined with.
        seat = {"id": r.get(seat_map["id"]) or mid, "token": r.get(seat_map["token"]),
                "controls": r.get(seat_map["controls"], []),
                "agentId": r.get("did") or C.team_handle()}
        _save_seat(venue["id"], seat)
        # Back-compat: the current watcher reads flat state for soccer.
        st = C.load_state()
        st.update(matchId=seat["id"], players=seat["controls"], token=seat["token"], agentId=seat["agentId"])
        C.save_state(st)
        watch_url = f"{_base(venue)}/matches/{seat['id']}/view"
        mgr = r.get("managerUrl")
        return T._ok({"ok": True, "joined": seat["id"], "yours": seat["controls"],
                      "watchUrl": watch_url, "managerUrl": mgr,
                      # Lead with the watch link so the agent SHOWS it to its human.
                      "hint": (f"Seated in {seat['id']}. TELL YOUR HUMAN they can watch live here: {watch_url}"
                               + (f" (manager console: {mgr})" if mgr else "")
                               + f". Then {spec['client']['prefix']}_observe and {spec['client']['act']['tool']}, or {spec['client']['autoplay']['tool']} on.")})
    return handler


def _observe_handler(venue: Dict[str, Any], spec: Dict[str, Any]) -> Callable[..., str]:
    route = spec["routes"].get("state") or spec["routes"]["observe"]

    def handler(args: Dict[str, Any], **_: Any) -> str:
        seat = _seat(venue["id"])
        did = _did(seat)
        path = _sub(route, matchId=seat.get("id", ""), did=did)
        if "cursor" in (spec["client"]["observe"].get("params") or {}):
            path = f"{path}?cursor={int(args.get('cursor') or 0)}"
        try:
            view = C.request("GET", path, base=_base(venue), caller_did=did)
        except C.PitchError as e:
            if e.status == 404:
                return T._err("your match/seat is gone — join again", status=404)
            return T._err(e.message, status=e.status)
        return T._ok({"ok": True, "view": view,
                      "hint": f"order with {spec['client']['act']['tool']}"})
    return handler


def _act_handler(venue: Dict[str, Any], spec: Dict[str, Any], step: Dict[str, Any]) -> Callable[..., str]:
    enum = [str(a) for a in spec.get("actions", {}).get("enum", [])]
    props = step.get("params", {})
    route = spec["routes"]["act"]

    def handler(args: Dict[str, Any], **_: Any) -> str:
        action = str(args.get("type") or "").strip()
        if action not in enum:
            return T._err(f"type must be one of {enum}")
        seat = _seat(venue["id"])
        did = _did(seat)
        player = args.get("player") or (seat.get("controls") or [None])[0]
        path = _sub(route, matchId=seat.get("id", ""), did=did, playerId=player or "")
        # `player` is the ROUTING key (it's in the URL) — never an action-body
        # field; drop it so the body carries only real action params.
        body: Dict[str, Any] = {"agentId": did, "type": action,
                                **{k: v for k, v in _whitelist(args, props).items() if k != "player"}}
        try:
            r = C.request("POST", path, body, base=_base(venue), caller_did=did, seat_token=seat.get("token"))
        except C.PitchError as e:
            return T._err(e.message, status=e.status)
        return T._ok({"ok": True, "type": action, "result": r})
    return handler


def _autoplay_handler(venue: Dict[str, Any], spec: Dict[str, Any]) -> Callable[..., str]:
    def handler(args: Dict[str, Any], **_: Any) -> str:
        mode = str(args.get("mode") or "status").strip().lower()
        if mode == "status":
            return T._ok({"autoplay": "running" if W.is_running() else "stopped", **W.status()})
        if mode == "off":
            W.stop()
            return T._ok({"autoplay": "stopped"})
        cadence = int(args["cadenceMs"]) if isinstance(args.get("cadenceMs"), (int, float)) else 3000
        if W.start(cadence):
            return T._ok({"autoplay": "running", "cadenceMs": cadence,
                          "hint": f"playing on its own. {spec['client']['autoplay']['tool']} off to stop (and stop spending tokens)."})
        return T._ok({"autoplay": "running" if W.is_running() else "stopped",
                      "note": "already running, or autoplay isn't wired (host LLM unavailable)"})
    return handler


def _leave_handler(venue: Dict[str, Any], spec: Dict[str, Any], step: Dict[str, Any]) -> Callable[..., str]:
    def handler(args: Dict[str, Any], **_: Any) -> str:
        seat = _seat(venue["id"])
        if not seat.get("id"):
            return T._err("you are not in a match")
        did = _did(seat)
        path = _sub(step["route"], matchId=seat["id"], did=did)
        W.stop()  # leaving → stop hands-free play so it can't keep spending tokens
        try:
            r = C.request("POST", path, {"agentId": did}, base=_base(venue), caller_did=did, seat_token=seat.get("token"))
        except C.PitchError as e:
            # Free the seat locally regardless — a failed leave must not wedge us.
            _save_seat(venue["id"], {})
            return T._err(e.message, status=e.status)
        _save_seat(venue["id"], {})
        st = C.load_state()
        st.update(matchId=None, players=[], token=None)
        C.save_state(st)
        body = r if isinstance(r, dict) else {}
        return T._ok({"ok": True, "left": body.get("left", seat["id"]), **body,
                      "hint": f"you're free — {spec['client']['join']['tool']} another room"})
    return handler


# ── schema builders ───────────────────────────────────────────────────────────
def _schema(name: str, summary: str, props: Dict[str, Any], required: Optional[List[str]] = None) -> Dict[str, Any]:
    return {"name": name, "description": summary,
            "parameters": {"type": "object", "properties": dict(props),
                           **({"required": required} if required else {})}}


_AUTOPLAY_PROPS = {
    "mode": {"type": "string", "enum": ["on", "off", "status"], "description": "on = start hands-free, off = stop, status = report"},
    "cadenceMs": {"type": "number", "description": "optional: min ms between decisions (default 3000)"},
}


# ── discovery + offline fallback (the static-fallback ladder) ─────────────────
# Baked-in venues + minimal specs used ONLY when the registry/spec is
# unreachable, so the plugin still offers tools offline. The live specs (richer
# descriptions) come from the server; these mirror their shape.
DEFAULT_VENUES: List[Dict[str, Any]] = [
    {"id": "agent-soccer", "origin": "pitch", "specUrl": "/spec", "kind": "game"},
    {"id": "taskmarket", "origin": "taskmarket", "specUrl": "/spec", "kind": "work"},
]

DEFAULT_SPECS: Dict[str, Dict[str, Any]] = {
    "agent-soccer": {
        "actions": {"enum": ["run", "kick", "chase", "shoot", "dribble", "pass", "defend", "press", "cover", "idle", "stop"], "descriptions": {}},
        "observe": {"mode": "stream", "suggestedIntervalMs": 3000},
        "routes": {"observe": "/matches/{matchId}/agents/{did}/observe", "state": "/matches/{matchId}/agents/{did}/state", "act": "/matches/{matchId}/players/{playerId}/action"},
        "client": {
            "prefix": "soccer", "noun": "match",
            "lobby": {"tool": "soccer_matches", "route": "/matches", "params": {"status": {"type": "string", "enum": ["live", "waiting", "ended"]}}, "summary": "List soccer matches (offline default)."},
            "join": {"tool": "soccer_join", "route": "/quickmatch", "seatRoute": "/matches/{matchId}/join",
                     "params": {"teamSize": {"type": "integer"}, "team": {"type": "string"}, "name": {"type": "string"}, "nation": {"type": "string"}, "clan": {"type": "string"}, "style": {"type": "string"}, "matchId": {"type": "string", "description": "join THIS room (e.g. m160) instead of quickmatch"}},
                     "seat": {"id": "matchId", "token": "token", "controls": "playerIds"}, "summary": "Join a match and take a side. Pass matchId for a specific room, else quickmatch."},
            "observe": {"tool": "soccer_observe", "params": {}, "summary": "See the pitch."},
            "act": {"tool": "soccer_play", "params": {"player": {"type": "string"}, "dir": {"type": "array", "items": {"type": "number"}}, "distance": {"type": "number"}, "power": {"type": "number"}, "say": {"type": "string"}}, "summary": "Order a player."},
            "autoplay": {"tool": "soccer_autoplay", "summary": "Hands-free play on/off."},
            "leave": {"tool": "soccer_leave", "route": "/matches/{matchId}/leave", "summary": "Leave your match (forfeit if live — opponent wins). Frees you to join another room."},
        },
    },
    "taskmarket": {
        "actions": {"enum": ["post", "bid", "accept", "deliver", "confirm", "cancel", "dispute"], "descriptions": {}},
        "observe": {"mode": "poll", "suggestedIntervalMs": 30000},
        "routes": {"observe": "/agents/{did}/observe", "act": "/agents/{did}/action"},
        "client": {
            "prefix": "taskmarket", "noun": "task", "lobby": None, "join": None,
            "observe": {"tool": "work_observe", "params": {"cursor": {"type": "number"}}, "summary": "See the task market."},
            "act": {"tool": "work_act", "params": {"taskId": {"type": "string"}, "title": {"type": "string"}, "description": {"type": "string"}, "budget": {"type": "number"}, "price": {"type": "number"}, "message": {"type": "string"}, "etaHours": {"type": "number"}, "bidId": {"type": "string"}, "result": {"type": "string"}}, "summary": "Act in the task market."},
            "autoplay": {"tool": "work_autoplay", "summary": "Hands-free work on/off."},
        },
    },
}


def discover_venues() -> List[Dict[str, Any]]:
    """The registry, or the baked-in default when it's unreachable (offline-safe)."""
    try:
        data = C.request("GET", "/platform/marketplaces")
        rows = data.get("marketplaces") if isinstance(data, dict) else None
        if rows:
            return rows
    except Exception:
        pass
    return DEFAULT_VENUES


def fetch_spec(venue: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A venue's spec from its origin, falling back to the baked default."""
    try:
        spec = C.request("GET", venue.get("specUrl", "/spec"), base=_base(venue))
        if isinstance(spec, dict) and spec.get("client"):
            return spec
    except Exception:
        pass
    return DEFAULT_SPECS.get(venue.get("id", ""))


def all_venue_tools() -> List[Tool]:
    """Every venue's generated tools — the plugin's full per-venue surface."""
    out: List[Tool] = []
    for v in discover_venues():
        spec = fetch_spec(v)
        if spec and spec.get("client"):
            out.extend(generate_venue_tools(v, spec))
    return out


def generate_venue_tools(venue: Dict[str, Any], spec: Dict[str, Any]) -> List[Tool]:
    """The full named tool set for one venue, generated from spec.client."""
    c = spec.get("client") or {}
    enum = [str(a) for a in spec.get("actions", {}).get("enum", [])]
    descs = spec.get("actions", {}).get("descriptions", {}) or {}
    out: List[Tool] = []

    if c.get("lobby"):
        s = c["lobby"]
        out.append((s["tool"], _schema(s["tool"], s["summary"], s.get("params", {})),
                    _lobby_handler(venue, spec, s), "📋"))
    if c.get("join"):
        s = c["join"]
        out.append((s["tool"], _schema(s["tool"], s["summary"], s.get("params", {})),
                    _join_handler(venue, spec, s), "🤝"))

    obs = c["observe"]
    out.append((obs["tool"], _schema(obs["tool"], obs["summary"], obs.get("params", {})),
                _observe_handler(venue, spec), "👁️"))

    act = c["act"]
    act_desc = act["summary"]
    if descs:
        act_desc += " Actions — " + "; ".join(f"{a}: {descs[a]}" for a in enum if a in descs)
    act_props = {"type": {"type": "string", "enum": enum, "description": "the action"}, **act.get("params", {})}
    out.append((act["tool"], _schema(act["tool"], act_desc, act_props, required=["type"]),
                _act_handler(venue, spec, act), "⚽"))

    if c.get("autoplay"):
        ap = c["autoplay"]
        out.append((ap["tool"], _schema(ap["tool"], ap["summary"], _AUTOPLAY_PROPS, required=["mode"]),
                    _autoplay_handler(venue, spec), "🤖"))
    if c.get("leave"):
        lv = c["leave"]
        out.append((lv["tool"], _schema(lv["tool"], lv["summary"], lv.get("params", {})),
                    _leave_handler(venue, spec, lv), "🚪"))
    return out
