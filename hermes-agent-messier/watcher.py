"""Agent-agnostic autoplay watcher (see docs/design/agent-soccer-plugin-contract.md §5).

The hands-free play loop OpenClaw's watcher.ts provides — re-implemented for
Python hosts. Behaviour matches the contract: latest view, cadence-gated, one
decision at a time, reclaim-on-restart, stop when not playing (no LLM call =
no token spend). Implementation note: a Python host polls the one-shot team
view at `cadence_ms` rather than streaming the SSE — same latest-view-at-cadence
decisions, no stdlib SSE parsing.

Token discipline is built in: it only calls `complete` while a match is LIVE,
at most once per cadence, and never when paused/ended/stopped.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Optional

from . import client as C
from . import decide as D
from . import selfcheck as SC

# ── module-level controller (one autoplay loop per process) ──────────────────
_thread: Optional[threading.Thread] = None
_stop = threading.Event()
_complete: Optional[Callable[[List[Dict[str, str]]], str]] = None
_complete_structured: Optional[Callable[..., Any]] = None
_diagnose: Optional[Callable[..., Dict[str, Any]]] = None  # non-swallowing model probe (selfcheck)
_log: Callable[[str], None] = lambda m: None
_status: Dict[str, Any] = {"running": False, "lastDecision": None, "moves": 0, "matchId": None,
                           "venues": 0, "diagnosis": None}

# Venues the user has DELEGATED to the watcher (delegate=true venue on join, or
# <venue>_autoplay on). The loop drives ONLY these — every other seat is joined-
# but-manual (idle). Runtime-only (not persisted) so nothing auto-resumes on a
# restart: the user re-decides each session. This is the no-auto-play gate.
_play_venues: set = set()

# Runtime self-diagnosis: consecutive-failure counters + a transition guard so we
# probe (and log) only when health FLIPS, never every tick. Threshold is generous
# — a slow LLM legitimately misses a few ticks.
_FAIL_THRESHOLD = 3
_consec: Dict[str, int] = {"empty": 0, "net": 0}
_degraded = False


def configure(complete: Callable[[List[Dict[str, str]]], str], log: Callable[[str], None] = None,
              complete_structured: Optional[Callable[..., Any]] = None,
              diagnose: Optional[Callable[..., Dict[str, Any]]] = None) -> None:
    """Connector wires the host's LLM (and logger) into the core. Called once at
    plugin register; the watcher uses these when started. `complete_structured`
    is optional — when the host (and trust policy) provides it, the decision core
    prefers it for host-enforced JSON; otherwise it degrades to `complete`.
    `diagnose` is a NON-swallowing one-shot probe of the same host LLM, used by
    self-diagnosis so the real provider error surfaces (not a swallowed '')."""
    global _complete, _complete_structured, _diagnose, _log
    _complete = complete
    _complete_structured = complete_structured
    _diagnose = diagnose
    if log:
        _log = log


def is_running() -> bool:
    return _status["running"]


def status() -> Dict[str, Any]:
    return dict(_status)


def selfcheck(base: Optional[str] = None, spec: Optional[Dict[str, Any]] = None,
              venue_id: Optional[str] = None) -> Dict[str, Any]:
    """Run the full play-readiness preflight (server, venue, seat, primary model)
    and cache the result into status. Resolves the venue base + seat + spec from
    the active seats when not given, so it works both before a game (no seat → the
    seat check is n/a) and during one. Drives the on-demand `<venue>_selfcheck`
    tool and the watcher's start-up + transition checks."""
    seats = C.active_seats()
    seat = None
    if venue_id:
        seat = next((s for v, s in seats if v == venue_id), None)
    if seat is None and seats:
        venue_id, seat = seats[0]
    if base is None:
        base = _venue_base(seat.get("origin") if seat else None)
    if not isinstance(spec, dict) and seat and seat.get("id"):
        spec = _get_spec(base, venue_id or "?", seat["id"])
    diag = SC.preflight(base, diagnose_complete=_diagnose, spec=spec, seat=seat)
    _status["diagnosis"] = diag
    return diag


# ── per-venue spec cache (the self-instructable envelope) ─────────────────────
# Instructions are frozen PER GAME (server snapshot). Cache one spec per
# (venueId, matchId); the guard ladder (/matches/:id/spec → /spec → None) re-runs
# on every cache miss, so a network blip at game start self-heals on a later tick.
_specs: Dict[str, Dict[str, Any]] = {}  # venueId -> {"matchId": str, "spec": dict}


def _reset_spec_cache() -> None:
    _specs.clear()


def _venue_base(origin: Optional[str]) -> str:
    """Resolve a seat's venue origin to its base URL (lazy import avoids an
    import cycle: generate already imports this module)."""
    from . import tools as T
    return T._venue_url(origin or "pitch")


def _get_spec(base: str, venue_id: str, match_id: str) -> Optional[Dict[str, Any]]:
    """A venue's spec snapshot, cached per (venue, match). Protection logic: cache
    miss → fetch the per-match snapshot from THIS venue's base; that failing →
    that venue's /spec; that failing → None (decide falls back to its static
    vocabulary). A None result is NOT cached, so the next tick retries — degraded,
    never permanently."""
    cached = _specs.get(venue_id)
    if cached and cached.get("matchId") == match_id:
        return cached.get("spec")
    for path in (f"/matches/{match_id}/spec", "/spec"):
        try:
            spec = C.request("GET", path, base=base)
        except C.PitchError:
            continue
        if isinstance(spec, dict) and spec.get("actions"):
            _specs[venue_id] = {"matchId": match_id, "spec": spec}
            return spec
    return None


def _routes(spec: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """The venue's endpoint templates (spec.routes) with a soccer-literal
    fallback when no spec is reachable — so the loop is endpoint-agnostic
    (it would drive a golf venue too) but never breaks offline."""
    r = (spec or {}).get("routes") if isinstance(spec, dict) else None
    return r or {
        "state": "/matches/{matchId}/agents/{did}/state",
        "observe": "/matches/{matchId}/agents/{did}/observe",
        "act": "/matches/{matchId}/players/{playerId}/action",
        "decision": "/matches/{matchId}/agents/{did}/decision",
    }


def _post_move(base: str, routes: Dict[str, str], match_id: str, pid: str, action: str,
               say: str, token: Optional[str], params: Optional[Dict[str, Any]], did: str) -> None:
    body: Dict[str, Any] = {"agentId": did, "type": action}
    if params:
        body.update(params)  # per-action params pass through; the server validates
    if say:
        body["say"] = say
    path = C.sub_route(routes["act"], matchId=match_id, did=did, playerId=pid)
    try:
        C.request("POST", path, body, base=base, seat_token=token, caller_did=did)
    except C.PitchError:
        pass  # one dropped move never stops the loop


def set_play(venue_id: str, on: bool) -> None:
    """Delegate (or un-delegate) a venue's seat to the watcher — the on/off switch
    the <venue>_autoplay tool and venue delegation flip. The loop drives a seat only
    while its venue is in this set."""
    if on:
        _play_venues.add(venue_id)
    else:
        _play_venues.discard(venue_id)


def is_playing(venue_id: str) -> bool:
    return venue_id in _play_venues


def _reclaim(venue_id: str, seat: Dict[str, Any], spec: Optional[Dict[str, Any]], base: str) -> bool:
    """Server restarted and forgot our seat — re-take the SAME room the user joined
    (the venue's seatRoute with the known matchId). Returns True on success. We NEVER
    quickmatch a NEW game here (no auto-join): if the room is gone, the caller idles
    the seat. A venue without a seatRoute can't be reclaimed → False (idle)."""
    did = seat.get("agentId") or C.team_handle()
    match_id = seat.get("id")
    join = ((spec or {}).get("client") or {}).get("join") if isinstance(spec, dict) else None
    seat_route = (join or {}).get("seatRoute")
    if not (match_id and seat_route):
        return False
    route = C.sub_route(seat_route, matchId=match_id)
    seat_map = (join or {}).get("seat") or {"id": "matchId", "token": "token", "controls": "playerIds"}
    body: Dict[str, Any] = {"agentId": did}
    ident = C.identity_defaults()
    if ident:
        body["identity"] = ident
    try:
        r = C.request("POST", route, body, base=base, caller_did=did)
    except C.PitchError:
        return False
    C.save_seat(venue_id, {**seat,
                           "id": r.get(seat_map["id"]) or match_id,
                           "token": r.get(seat_map["token"]) or seat.get("token"),
                           "controls": r.get(seat_map["controls"]) or seat.get("controls", []),
                           "agentId": r.get("did") or did})
    return True


# ── quick LLM health check ───────────────────────────────────────────────────
# One tiny timed probe through the SAME complete() decisions use, classified
# fast(<3s) / normal / slow so the USER hears up front whether their current model
# suits a 3s-cadence game — and which fast models to use when it doesn't.
# Cached (10 min): the probe is a real (cheap) LLM call.
_HEALTH_TTL_SEC = 600
_health: Optional[Dict[str, Any]] = None

_FAST_MODELS = "gpt-5-nano, gemini-2.5-flash-lite, deepseek-v4-flash"
_HEALTH_RECOMMENDATION = (
    "lower is better — under 3s is the best experience. Use a cheaper/faster model from "
    f"your provider (e.g. {_FAST_MODELS}), or pin one for decisions via "
    "auxiliary.agent_messier_decide in ~/.hermes/config.yaml"
)


def llm_health(force: bool = False) -> Dict[str, Any]:
    """Probe the decision LLM once and classify: fast (<5s), normal (<15s),
    slow (>=15s), or error (no reply). normal/slow/error carry a concrete
    recommendation. Result is cached for _HEALTH_TTL_SEC and mirrored into
    _status["llmHealth"] so the autoplay status tool shows it too."""
    global _health
    if _health and not force and (time.time() - _health.get("checkedAt", 0)) < _HEALTH_TTL_SEC:
        return dict(_health)
    if _complete is None:
        return {"state": "unknown", "seconds": None, "model": None,
                "recommendation": "host LLM not wired — autoplay cannot decide"}
    msgs = [{"role": "system", "content": "Reply with exactly: OK"},
            {"role": "user", "content": "health check"}]
    t0 = time.monotonic()
    try:
        text = _complete(msgs) or ""
    except Exception:
        text = ""
    secs = round(time.monotonic() - t0, 1)
    model = None
    try:
        model = C.last_model()
    except Exception:
        pass
    if not text.strip():
        state = "error"
    elif secs < 3:  # keeps up with the 3s decision cadence — the best experience
        state = "fast"
    elif secs < 15:
        state = "normal"
    else:
        state = "slow"
    rec = _HEALTH_RECOMMENDATION if state in ("normal", "slow", "error") else None
    _health = {"state": state, "seconds": secs, "model": model, "checkedAt": time.time(),
               **({"recommendation": rec} if rec else {})}
    _status["llmHealth"] = dict(_health)
    _log(f"[autoplay] model speed: {state.upper()} ({secs}s" + (f", {model}" if model else "") + ")"
         + (f" — {rec}" if rec else ""))
    return dict(_health)


def _note_failure(kind: str) -> None:
    """Count a play-blocking failure (empty reply / network). On crossing the
    threshold, flip to degraded ONCE — run the real preflight (so the diagnosis
    names the root cause) and log — never re-probing every tick while degraded."""
    global _degraded
    _consec[kind] = _consec.get(kind, 0) + 1
    if not _degraded and _consec[kind] >= _FAIL_THRESHOLD:
        _degraded = True
        try:
            diag = selfcheck()
        except Exception:
            diag = {"reason": kind}
        _log(f"[autoplay] ⚠ DEGRADED — {diag.get('reason') or kind}")


def _note_success() -> None:
    """A clean acted decision clears the failure state (recovery logged once)."""
    global _degraded
    _consec["empty"] = 0
    _consec["net"] = 0
    if _degraded:
        _degraded = False
        _status["diagnosis"] = {"state": "ok", "reason": None,
                                "primaryModel": (_status.get("diagnosis") or {}).get("primaryModel"),
                                "checkedAt": SC._now(), "checks": []}
        _log("[autoplay] ✓ recovered — playing normally")


def _play_seat(venue_id: str, seat: Dict[str, Any], cadence_ms: int) -> int:
    """Drive ONE venue's seat for a single tick: observe → decide → post. Returns
    the number of moves posted. Each call uses the seat's OWN venue base + spec +
    routes + did + token, so venues never cross-contaminate."""
    # Only drive seats the USER delegated (venue delegate=true on join, or
    # <venue>_autoplay on). A joined-but-manual venue sits idle here — the user
    # drives it with observe/play. Not delegated ⇒ long-running but silent.
    if venue_id not in _play_venues:
        return 0
    match_id = seat["id"]
    did = seat.get("agentId") or C.team_handle()
    token = seat.get("token")
    base = _venue_base(seat.get("origin"))
    spec = _get_spec(base, venue_id, match_id)  # per-game snapshot; ladder + retry inside
    routes = _routes(spec)
    try:
        obs_path = C.sub_route(routes.get("state") or routes["observe"], matchId=match_id, did=did)
        view = C.request("GET", obs_path, base=base, caller_did=did)
        _consec["net"] = 0  # a successful read proves the pitch is reachable
    except C.PitchError as e:
        if e.status == 404:
            # Server restart forgot our seat — reclaim the SAME room only. If it's
            # gone, idle (NO auto-join into a new game — the user decides to rejoin).
            if _reclaim(venue_id, seat, spec, base):
                _log(f"[autoplay] {venue_id}: reclaimed seat in {match_id} after restart")
            else:
                _log(f"[autoplay] {venue_id}: room {match_id} gone — idle (rejoin to play again)")
                set_play(venue_id, False)
        elif e.status == 0:
            _note_failure("net")  # pitch unreachable / timeout
        return 0

    phase = view.get("phase")
    if phase == "ended":
        # A finished match never resumes. Idle the seat — the user decides whether
        # to join again (NO auto re-seat into a new game).
        _log(f"[autoplay] {venue_id}: match {match_id} ended — idle (rejoin to play again)")
        D._reset_history()  # clear the per-match notebook on match end (Change 3)
        set_play(venue_id, False)
        return 0
    # A waiting room ticks only once both sides are filled; no point deciding.
    if not view.get("mine"):
        return 0

    # The view may omit matchId; stamp it so decide can key its per-match memory +
    # report (Change 2/3) off the seat's authoritative matchId.
    view.setdefault("matchId", match_id)
    moves = D.decide(view, _complete, spec, _complete_structured) if _complete else []
    for pid, action, say, params in moves:
        _post_move(base, routes, match_id, pid, action, say, token, params, did)
    # Report EVERY decision (acted or no_response) — best-effort (Change 2).
    if _complete:
        report = D.last_report()
        # Runtime self-diagnosis: a no_response (esp. an empty reply) is the
        # silent-failure signal; an acted decision is recovery.
        if report is not None:
            _note_failure("empty") if report.get("outcome") == "no_response" else _note_success()
        try:
            if report:
                if _degraded and _status.get("diagnosis"):
                    report["diagnosis"] = _status["diagnosis"]  # push → inspector banner
                C.report_decision(match_id, did, report, seat_token=token, base=base,
                                  decision_route=routes.get("decision"))
        except Exception:
            pass  # observability must never break the loop
    if moves:
        _log(f"[autoplay] {venue_id}: {len(moves)} moves in {match_id}")
    return len(moves)


def _loop(cadence_ms: int) -> None:
    _status["running"] = True
    try:
        while not _stop.is_set():
            seats = C.active_seats()  # EVERY seat-based venue, not just the last join
            if not seats:
                _stop.wait(2.0)
                continue
            total = 0
            last_match = None
            for venue_id, seat in seats:
                if _stop.is_set():
                    break
                try:
                    total += _play_seat(venue_id, seat, cadence_ms)
                    last_match = seat["id"]
                except Exception:
                    pass  # one venue's failure never stops the others
            _status.update(lastDecision=time.time(), moves=_status["moves"] + total,
                           matchId=last_match, venues=len(seats))
            _stop.wait(cadence_ms / 1000.0)
    finally:
        _status["running"] = False


def start(cadence_ms: int = 3000) -> bool:
    """Start hands-free play. Returns False if already running or unconfigured."""
    global _thread
    if _complete is None:
        return False
    if _thread and _thread.is_alive():
        return False
    _stop.clear()
    _thread = threading.Thread(target=_loop, args=(max(500, int(cadence_ms)),), daemon=True, name="agent-messier-autoplay")
    _thread.start()
    _log("[autoplay] started")
    # Preflight the dependencies up front (server, venue, seat, PRIMARY MODEL).
    # Keep-retry: we arm regardless, but surface readiness so a broken model /
    # unreachable pitch is visible immediately instead of after a silent loss.
    try:
        diag = selfcheck()
        if diag.get("state") == "degraded":
            _log(f"[autoplay] ⚠ preflight DEGRADED — {diag.get('reason')} (autoplay armed; will keep retrying)")
        else:
            _log(f"[autoplay] preflight ok — primary model {diag.get('primaryModel') or 'unverified'}")
    except Exception:
        pass
    return True


def stop() -> None:
    _stop.set()
    _log("[autoplay] stopped")
