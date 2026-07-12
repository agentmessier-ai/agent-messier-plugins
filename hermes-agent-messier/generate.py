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

import logging
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import client as C
from . import tools as T   # reuse _ok / _err / _as_xy / _venue_url / build helpers
from . import watcher as W

logger = logging.getLogger(__name__)

Tool = Tuple[str, Dict[str, Any], Callable[..., str], str]

# Route templating lives in client.sub_route (one place, reused everywhere).
_sub = C.sub_route


# ── helpers ───────────────────────────────────────────────────────────────────
def _safe(name: str, fn: Callable[..., str]) -> Callable[..., str]:
    """Last-resort guard around a tool handler: handlers map PitchError to _err
    themselves, but an UNEXPECTED error (odd server shape → KeyError/TypeError)
    must return a clean error string, not throw into the host agent loop."""
    def wrapped(args: Dict[str, Any], **kw: Any) -> str:
        try:
            return fn(args, **kw)
        except Exception as e:  # noqa: BLE001 — deliberate catch-all at the tool edge
            logger.debug("tool %s failed: %s", name, e)
            return T._err(f"{name} failed: {e}")
    return wrapped


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
    return C.load_seat(venue_id)


def _save_seat(venue_id: str, seat: Dict[str, Any]) -> None:
    C.save_seat(venue_id, seat)


def _watch_extra(venue: Dict[str, Any], seat: Dict[str, Any]) -> Dict[str, Any]:
    """While the watcher is auto-playing THIS venue, every play-related result also
    carries the watch link. An agentic host (the hermes chat loop) chains
    join→observe→play and reports only its LAST tool result, ignoring hints to stop
    — so the link rides on whatever result the turn ends on, not just join's. No-op
    when the seat isn't delegated (manual play needs no nag)."""
    if not (seat.get("id") and W.is_playing(venue["id"])):
        return {}
    watch_url = f"{_base(venue)}/matches/{seat['id']}/view"
    return {"watchUrl": watch_url,
            "watchHint": f"The watcher is auto-playing this match — TELL YOUR HUMAN they can watch live here: {watch_url}"}


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
        jt = spec["client"]["join"]["tool"]
        # Empty lobby is NOT a dead end: join with no matchId quickmatches
        # (find-or-CREATE), so say so — else the model reads "0 rooms" as "can't play".
        hint = (f"no open rooms — call {jt} (omit matchId) to quickmatch: it CREATES a room and seats you"
                if not rows else f"join one with {jt} (or omit matchId to quickmatch a fresh one)")
        return T._ok({"ok": True, "count": len(rows), "rows": rows, "hint": hint})
    return handler


def _join_failed(e: C.PitchError) -> str:
    """A join failure must be UNMISTAKABLE so the agent never narrates a fabricated
    success (ok:false + started:false + a blunt 'MATCH NOT STARTED' message). On 401 the
    agent's credentials are dead — tell the human to re-authenticate, don't fake a match."""
    msg = f"MATCH NOT STARTED — {e.message}"
    if e.status == 401:
        msg += (". Your agent credentials are invalid — re-authenticate (run the login / "
                "authorize flow) before retrying. Do NOT report the match as started.")
    return T._err(msg, status=e.status, started=False)


def _join_handler(venue: Dict[str, Any], spec: Dict[str, Any], step: Dict[str, Any]) -> Callable[..., str]:
    seat_map = step["seat"]
    props = step.get("params", {})

    def handler(args: Dict[str, Any], **_: Any) -> str:
        # matchId (if advertised) targets a SPECIFIC room via seatRoute; it's
        # routing, not a body field, so keep it out of the posted body.
        mid = args.get("matchId")
        mid = str(mid) if isinstance(mid, str) and mid else None
        route = _sub(step["seatRoute"], matchId=mid) if (mid and step.get("seatRoute")) else step["route"]
        # Team identity (name/nation/clan/style) comes per-call OR from install
        # env (C.identity_defaults), per-call winning. The pitch reads it as a
        # NESTED `identity` object — flat fields are dropped — so collapse the
        # advertised identity params under `identity`. Only keys the spec declares
        # are touched, so a venue without them is unaffected (stays generic).
        _ident_keys = ("name", "nation", "clan", "style")
        env_ident = {k: v for k, v in C.identity_defaults().items() if k in props}
        merged = {**env_ident, **_whitelist(args, props)}
        body: Dict[str, Any] = {
            "agentId": C.team_handle(),
            **{k: v for k, v in merged.items() if k != "matchId" and k not in _ident_keys},
        }
        ident = T._identity(merged)
        if ident:
            body["identity"] = ident
        try:
            r = C.request("POST", route, body, base=_base(venue), caller_did=C.team_handle())
        except C.PitchError as e:
            # A targeted seatRoute join to a room that isn't live (404) means the
            # caller passed a stale/ended matchId. Don't dead-end the agent: retry as
            # a fresh quickmatch (the route WITHOUT a matchId, which creates + seats),
            # so "start a game" always works even after a previous match ended. `body`
            # already excludes matchId, so it's a clean quickmatch payload.
            if mid and step.get("seatRoute") and e.status == 404:
                try:
                    r = C.request("POST", step["route"], body, base=_base(venue), caller_did=C.team_handle())
                except C.PitchError as e2:
                    return _join_failed(e2)
            else:
                return _join_failed(e)
        # A rejoin via seatRoute already knows the room (it's in the URL), so the
        # response omits it — fall back to the matchId we joined with. `origin` +
        # `teamSize` are stored so the autoplay loop can drive (and reclaim) THIS
        # venue's seat without any flat/global state.
        seat = {"id": r.get(seat_map["id"]) or mid, "token": r.get(seat_map["token"]),
                "controls": r.get(seat_map["controls"], []),
                "agentId": r.get("did") or C.team_handle(),
                "origin": venue.get("origin", "pitch")}
        # Defensive: a 2xx that yields no usable match id is NOT a real join — never
        # report success, and never save a phantom seat.
        if not seat["id"]:
            return T._err("MATCH NOT STARTED — server accepted the request but returned no match id", started=False)
        if args.get("teamSize"):
            seat["teamSize"] = args["teamSize"]
        _save_seat(venue["id"], seat)
        # Venue-gated delegation: only a delegate=true venue hands the seat to the
        # watcher on join. Soccer (delegate=false) seats you MANUAL — you drive, or
        # run <venue>_autoplay on. Joining never implies play unless the venue says so.
        delegated = bool(((spec.get("client") or {}).get("autoplay") or {}).get("delegate"))
        if delegated:
            W.start()                       # bring the long-running watcher thread up (idempotent)
            W.set_play(venue["id"], True)   # then hand THIS venue's seat to it
        watch_url = f"{_base(venue)}/matches/{seat['id']}/view"
        ap_tool = (spec["client"].get("autoplay") or {}).get("tool")
        next_hint = (f". Now the watcher is playing it — {ap_tool} off to take over manually."
                     if delegated else
                     f". Then {spec['client']['prefix']}_observe and {spec['client']['act']['tool']}"
                     + (f", or {ap_tool} on for hands-free play." if ap_tool else "."))
        card = _status_card(seat["id"], watch_url, autoplay=delegated)
        return T._ok({"ok": True, "started": True, "joined": seat["id"], "yours": seat["controls"],
                      "watchUrl": watch_url, "delegated": delegated,
                      "hint": card + "\n(Then" + next_hint[1:] + ")"})
    return handler


def _observe_handler(venue: Dict[str, Any], spec: Dict[str, Any]) -> Callable[..., str]:
    route = spec["routes"].get("state") or spec["routes"].get("observe") or ""

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
                      "hint": f"order with {spec['client']['act']['tool']}",
                      **_watch_extra(venue, seat)})
    return handler


def _act_handler(venue: Dict[str, Any], spec: Dict[str, Any], step: Dict[str, Any], batch: bool) -> Callable[..., str]:
    enum = [str(a) for a in spec.get("actions", {}).get("enum", [])]
    props = step.get("params", {})
    route = spec["routes"].get("act") or ""

    def post_one(m: Dict[str, Any], seat: Dict[str, Any], did: str) -> Dict[str, Any]:
        action = str(m.get("type") or "").strip()
        if action not in enum:
            return {"player": m.get("player"), "error": f"type must be one of {enum}"}
        player = m.get("player") or (seat.get("controls") or [None])[0]
        path = _sub(route, matchId=seat.get("id", ""), did=did, playerId=player or "")
        # `player` is the ROUTING key (it's in the URL) — never an action-body field.
        body: Dict[str, Any] = {"agentId": did, "type": action,
                                **{k: v for k, v in _whitelist(m, props).items() if k != "player"}}
        try:
            C.request("POST", path, body, base=_base(venue), caller_did=did, seat_token=seat.get("token"))
            return {"player": player, "type": action}
        except C.PitchError as e:
            return {"player": player, "error": e.message}

    def handler(args: Dict[str, Any], **_: Any) -> str:
        seat = _seat(venue["id"])
        did = _did(seat)
        if batch:
            # Games seat a WHOLE side — one call orders EVERY player you control,
            # so a (possibly small) model never has to remember to fire N calls.
            moves = args.get("moves") or []
            if not isinstance(moves, list) or not moves:
                return T._err("pass moves=[{player, type, …}] — one entry per player you control")
            return T._ok({"ok": True, "applied": [post_one(m, seat, did) for m in moves],
                          **_watch_extra(venue, seat)})
        # Seatless venue (work market): a single action.
        out = post_one(args, seat, did)
        return T._err(out["error"]) if "error" in out else T._ok({"ok": True, **out, **_watch_extra(venue, seat)})
    return handler


def _status_card(match_id: str, watch_url: str, *, autoplay: bool,
                 cadence_ms: int = None, health: Dict[str, Any] = None,
                 score: Dict[str, int] = None, clock_sec: int = None,
                 you: str = None, opponent: str = None) -> str:
    """A FIXED-FORMAT status card the chat agent must print to its human
    VERBATIM. Free-text hints get summarized away by the harness (observed:
    the LLM-health line and even the match clock were dropped or relayed as
    a meaningless "Time: 13 seconds") — so the human-facing lines live in one
    canonical block with an explicit do-not-summarize instruction, and the
    agent-facing guidance stays OUTSIDE the block."""
    lines = ["┏━━ AGENT MESSIER ━━━━━━━━━━━━━━"]
    vs = f" · {you} vs {opponent}" if you and opponent else ""
    lines.append(f"┃ ⚽ match {match_id}{vs}")
    if score is not None and clock_sec is not None:
        mm, ss = divmod(max(0, int(clock_sec)), 60)
        lines.append(f"┃ 🔢 score {score.get('home', 0)}–{score.get('away', 0)} · match clock {mm:02d}:{ss:02d}")
    if health and health.get("state"):
        h = f"┃ ⚡ model speed: {str(health['state']).upper()} ({health.get('seconds')}s"
        h += f", {health['model']})" if health.get("model") else ")"
        lines.append(h)
        if health.get("recommendation"):
            lines.append(f"┃ ⚠ {health['recommendation']}")
    if autoplay:
        lines.append(f"┃ ▶ autoplay ON — one decision every {int((cadence_ms or 3000) / 1000)}s")
    lines.append(f"┃ 📺 watch live: {watch_url}")
    lines.append("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    block = "\n".join(lines)
    return ("SHOW YOUR HUMAN THE CARD BELOW EXACTLY AS-IS — every line between "
            "┏ and ┗, verbatim: do NOT summarize, reword, translate, or drop lines.\n"
            + block)


def _autoplay_handler(venue: Dict[str, Any], spec: Dict[str, Any]) -> Callable[..., str]:
    """Per-venue hands-free toggle. ON delegates THIS venue's seat to the watcher
    (you must have joined first); OFF un-delegates it (the seat stays — you can
    drive manually). The watcher is a long-running idle service; this just flips
    whether it drives this venue."""
    vid = venue["id"]

    def handler(args: Dict[str, Any], **_: Any) -> str:
        mode = str(args.get("mode") or "status").strip().lower()
        if mode == "status":
            return T._ok({"autoplay": "playing" if W.is_playing(vid) else "idle", **W.status()})
        if mode == "off":
            W.set_play(vid, False)  # stop driving this venue; seat retained for manual play
            return T._ok({"autoplay": "idle", "note": "watcher stopped for this venue; your seat is kept — observe/play to drive manually"})
        # mode == "on": you must be seated first (no auto-join here).
        seat = _seat(vid)
        if not seat.get("id"):
            return T._err(f"join a match first with {spec['client']['join']['tool']}, then {spec['client']['autoplay']['tool']} on")
        cadence = int(args["cadenceMs"]) if isinstance(args.get("cadenceMs"), (int, float)) else 3000
        W.start(cadence)        # ensure the long-running thread is up (idempotent)
        W.set_play(vid, True)   # delegate THIS venue to it
        # Quick LLM health check AT the moment hands-free play begins — one tiny
        # timed probe (cached 10 min) so the human hears "fast/normal/slow" and,
        # when not fast, WHICH models to use instead — before a slow model quietly
        # ruins the match (a thinking/timing-out model looks healthy otherwise).
        health = {}
        try:
            health = W.llm_health()
        except Exception:
            pass
        # Best-effort snapshot for the card (score / match clock / team names) —
        # a failed observe just leaves those lines off; never blocks the toggle.
        score = clock_sec = you = opp = None
        try:
            _route = spec["routes"].get("state") or spec["routes"].get("observe") or ""
            _view = C.request("GET", _sub(_route, matchId=seat.get("id", ""), did=_did(seat)),
                              base=_base(venue), caller_did=_did(seat))
            score, clock_sec = _view.get("score"), _view.get("clock")
            ident = _view.get("identity") or {}
            you = (ident.get("you") or {}).get("name")
            opp = (ident.get("opponent") or {}).get("name")
        except Exception:
            pass
        watch_url = f"{_base(venue)}/matches/{seat['id']}/view"
        card = _status_card(seat["id"], watch_url, autoplay=True, cadence_ms=cadence,
                            health=health, score=score, clock_sec=clock_sec, you=you, opponent=opp)
        return T._ok({"autoplay": "playing", "cadenceMs": cadence, "watchUrl": watch_url,
                      **({"llmHealth": health} if health else {}),
                      "hint": (card + f"\n(Then: {spec['client']['autoplay']['tool']} off stops play and token spend.)")})
    return handler


def _selfcheck_handler(venue: Dict[str, Any], spec: Dict[str, Any]) -> Callable[..., str]:
    """Run play-readiness diagnosis on demand — server, venue, seat, and the
    PRIMARY MODEL — and return per-check pass/fail. Lets the human (via the chat
    agent) answer "why isn't it playing?" even when the autoplay model is the
    broken one (this tool runs in the interactive agent's working context)."""
    def handler(args: Dict[str, Any], **_: Any) -> str:
        base = T._venue_url(venue.get("origin") or "pitch")
        diag = W.selfcheck(base=base, spec=spec, venue_id=venue.get("id"))
        return T._ok({"ok": True, "diagnosis": diag})
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
            "join": {"tool": "soccer_join", "route": "/quickmatch", "seatRoute": "/matches/{matchId}/join", "resumeRoute": "/quickmatch/resume",
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
    """The venue registry, or the baked-in default when unreachable (offline-safe).
    A short timeout keeps a slow/down server from stalling plugin load. Rows MAY
    carry an inlined `spec` (the batch endpoint), so `fetch_spec` needs no extra
    per-venue round-trip."""
    try:
        data = C.request("GET", "/platform/marketplaces?withSpecs=1", timeout=3.0)
        rows = data.get("marketplaces") if isinstance(data, dict) else None
        if rows:
            return rows
    except Exception as e:
        logger.debug("venue discovery failed (%s) — using baked defaults", e)
    return DEFAULT_VENUES


def fetch_spec(venue: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A venue's spec: the spec INLINED by discovery if present (no extra call —
    the batch path), else fetched from its origin (short timeout), else the baked
    default. Never raises."""
    inlined = venue.get("spec")
    if isinstance(inlined, dict) and inlined.get("client"):
        return inlined
    try:
        spec = C.request("GET", venue.get("specUrl", "/spec"), base=_base(venue), timeout=3.0)
        if isinstance(spec, dict) and spec.get("client"):
            return spec
    except Exception as e:
        logger.debug("spec fetch for %s failed (%s) — using baked default", venue.get("id"), e)
    return DEFAULT_SPECS.get(venue.get("id", ""))


def resume_venue(venue: Dict[str, Any], spec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Reconnect-on-boot probe (resume-only). Ask the venue's resume route "am I
    already seated in a LIVE match?" WITHOUT creating one. On a live seat: persist
    it (so the watcher drives the SAME match) and return it; otherwise return None
    (server said {matchId:null}, no resume support, or the venue isn't joinable) so
    boot falls through to today's idle behavior unchanged. The resume route is
    client.join.resumeRoute, defaulting to `<join>/resume`. Auth/identity match the
    join path (team_handle + api-key/oauth) — the server only returns a seat token
    to the caller who already owns it. Never raises."""
    join = (spec.get("client") or {}).get("join") if isinstance(spec, dict) else None
    if not join:
        return None  # not a joinable venue → nothing to resume
    seat_map = join.get("seat") or {"id": "matchId", "token": "token", "controls": "playerIds"}
    route = join.get("resumeRoute") or (join.get("route", "").rstrip("/") + "/resume")
    if not route or route == "/resume":
        return None
    did = C.team_handle()
    try:
        r = C.request("POST", route, {"agentId": did}, base=_base(venue), caller_did=did)
    except C.PitchError:
        # Any error (e.g. a 404 on a server that predates resume) → "no seat".
        return None
    if not isinstance(r, dict) or r.get(seat_map["id"]) is None:
        return None  # {matchId:null} → not seated anywhere
    seat = {"id": r.get(seat_map["id"]), "token": r.get(seat_map["token"]),
            "controls": r.get(seat_map["controls"], []),
            "agentId": r.get("did") or did,
            "origin": venue.get("origin", "pitch")}
    if not seat["id"]:
        return None
    _save_seat(venue["id"], seat)
    return seat


def resume_on_boot() -> None:
    """On plugin load, probe each venue's resume route and, if the server still has
    us seated in a live match, hydrate the seat + DELEGATE it to the watcher so the
    SAME match resumes — instead of going idle after a gateway restart / auto-update.
    Mirrors the OpenClaw (TS) plugin's resume-on-boot. Opt out with
    AGENTMESSIER_RESUME_ON_BOOT=off. Best-effort: never breaks registration."""
    if (os.getenv("AGENTMESSIER_RESUME_ON_BOOT") or "on").strip().lower() in {"0", "off", "false", "no"}:
        return
    try:
        from . import watcher as W
    except Exception:
        return
    for v in discover_venues():
        try:
            spec = fetch_spec(v)
            if not (spec and spec.get("client")):
                continue
            seat = resume_venue(v, spec)
            if seat and seat.get("id"):
                W.start()                      # bring the watcher thread up (idempotent)
                W.set_play(v["id"], True)      # delegate the resumed seat → it plays the SAME match
                logger.info("hermes-agent-messier: resumed live match %s in %s after restart", seat["id"], v["id"])
        except Exception as e:  # one bad venue must never break boot
            logger.debug("resume-on-boot probe for %s failed: %s", v.get("id"), e)


def all_venue_tools() -> List[Tool]:
    """Every venue's generated tools. Per-venue isolation: one malformed venue or
    spec is skipped (and logged), never taking down the whole tool surface."""
    out: List[Tool] = []
    for v in discover_venues():
        try:
            spec = fetch_spec(v)
            if spec and spec.get("client"):
                out.extend(generate_venue_tools(v, spec))
        except Exception as e:  # one bad venue must never kill the others
            logger.debug("skipping venue %s: %s", v.get("id"), e)
    return _dedup(out)  # cross-venue tool-name collision → keep the first


# ── tool assembly (data-driven: one ordered builder per lifecycle step) ───────
def _simple_tool(venue: Dict[str, Any], spec: Dict[str, Any], step: Dict[str, Any],
                 handler: Callable[..., str], emoji: str) -> Tool:
    """The uniform shape shared by lobby/join/observe/leave: spec-named tool,
    params straight from the step, the handler wrapped in the _safe edge-guard."""
    name = step["tool"]
    return (name, _schema(name, step.get("summary", ""), step.get("params", {})), _safe(name, handler), emoji)


def _act_schema(step: Dict[str, Any], enum: List[str], descs: Dict[str, Any], batch: bool) -> Dict[str, Any]:
    """The act tool's input form — BATCH (moves[] over a whole side, for games) or
    a single action (seatless work). Extracted so the assembler just places it."""
    desc = step.get("summary", "")
    if descs:
        desc += " Actions — " + "; ".join(f"{a}: {descs[a]}" for a in enum if a in descs)
    extra = {k: v for k, v in step.get("params", {}).items() if k != "player"}
    if batch:
        item = {"type": "object", "required": ["player", "type"],
                "properties": {"player": {"type": "string", "description": "your player id, e.g. home-9"},
                               "type": {"type": "string", "enum": enum, "description": "the action"}, **extra}}
        desc += " Set actions for ALL players you control in ONE call: moves=[{player, type, …}], one per player."
        return _schema(step["tool"], desc, {"moves": {"type": "array", "description": "one entry per player you control", "items": item}}, required=["moves"])
    return _schema(step["tool"], desc, {"type": {"type": "string", "enum": enum, "description": "the action"}, **extra}, required=["type"])


def _build_lobby(venue: Dict[str, Any], spec: Dict[str, Any], c: Dict[str, Any]) -> Optional[Tool]:
    s = c.get("lobby")
    return _simple_tool(venue, spec, s, _lobby_handler(venue, spec, s), "📋") if s else None


def _build_join(venue: Dict[str, Any], spec: Dict[str, Any], c: Dict[str, Any]) -> Optional[Tool]:
    s = c.get("join")
    return _simple_tool(venue, spec, s, _join_handler(venue, spec, s), "🤝") if s else None


def _build_observe(venue: Dict[str, Any], spec: Dict[str, Any], c: Dict[str, Any]) -> Optional[Tool]:
    s = c.get("observe")
    if not s or not (spec["routes"].get("state") or spec["routes"].get("observe")):
        return None  # no readable state route → an observe tool would be dead
    return _simple_tool(venue, spec, s, _observe_handler(venue, spec), "👁️")


def _build_act(venue: Dict[str, Any], spec: Dict[str, Any], c: Dict[str, Any]) -> Optional[Tool]:
    s = c.get("act")
    if not s or not spec["routes"].get("act"):
        return None
    enum = [str(a) for a in spec.get("actions", {}).get("enum", [])]
    descs = spec.get("actions", {}).get("descriptions", {}) or {}
    # A game seats a whole side (join.seat.controls) → batch; seatless work → single.
    batch = bool(((c.get("join") or {}).get("seat") or {}).get("controls"))
    return (s["tool"], _act_schema(s, enum, descs, batch), _safe(s["tool"], _act_handler(venue, spec, s, batch)), "⚽")


def _build_autoplay(venue: Dict[str, Any], spec: Dict[str, Any], c: Dict[str, Any]) -> Optional[Tool]:
    s = c.get("autoplay")
    if not s:
        return None
    return (s["tool"], _schema(s["tool"], s.get("summary", ""), _AUTOPLAY_PROPS, required=["mode"]),
            _safe(s["tool"], _autoplay_handler(venue, spec)), "🤖")


def _build_selfcheck(venue: Dict[str, Any], spec: Dict[str, Any], c: Dict[str, Any]) -> Optional[Tool]:
    # Synthesized (NOT a spec step), so a new sport needs no server change. Decoupled
    # from autoplay: any PLAYABLE venue (autoplay OR a joinable seat) gets it.
    if not (c.get("prefix") and (c.get("autoplay") or c.get("join"))):
        return None
    name = f"{c['prefix']}_selfcheck"
    return (name, _schema(name, "Diagnose play-readiness: pitch server, venue spec, your seat, and the primary model.", {}),
            _safe(name, _selfcheck_handler(venue, spec)), "🩺")


def _build_leave(venue: Dict[str, Any], spec: Dict[str, Any], c: Dict[str, Any]) -> Optional[Tool]:
    s = c.get("leave")
    return _simple_tool(venue, spec, s, _leave_handler(venue, spec, s), "🚪") if s else None


# Ordered lifecycle — the emission order IS the agent-facing tool order. Adding a
# step = one builder + one row here; no new branches in generate_venue_tools.
_BUILDERS = [_build_lobby, _build_join, _build_observe, _build_act, _build_autoplay, _build_selfcheck, _build_leave]


def _dedup(tools: List[Tool]) -> List[Tool]:
    """Drop duplicate tool names (a venue prefix collision or a dup registry row),
    keeping the first — registering two tools under one name is a host error."""
    seen: set = set()
    out: List[Tool] = []
    for t in tools:
        if t[0] in seen:
            logger.debug("dropping duplicate tool %s", t[0])
            continue
        seen.add(t[0])
        out.append(t)
    return out


def generate_venue_tools(venue: Dict[str, Any], spec: Dict[str, Any]) -> List[Tool]:
    """The full named tool set for one venue, generated from spec.client by running
    each ordered builder. A spec with no client block or no routes yields nothing
    (rather than crashing the whole surface)."""
    c = spec.get("client") or {}
    if not c or not isinstance(spec.get("routes"), dict):
        logger.debug("venue %s: spec missing client/routes — skipped", venue.get("id"))
        return []
    return _dedup([t for t in (b(venue, spec, c) for b in _BUILDERS) if t])
