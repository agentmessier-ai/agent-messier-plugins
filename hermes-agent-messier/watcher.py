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

# ── module-level controller (one autoplay loop per process) ──────────────────
_thread: Optional[threading.Thread] = None
_stop = threading.Event()
_complete: Optional[Callable[[List[Dict[str, str]]], str]] = None
_log: Callable[[str], None] = lambda m: None
_status: Dict[str, Any] = {"running": False, "lastDecision": None, "moves": 0, "matchId": None}


def configure(complete: Callable[[List[Dict[str, str]]], str], log: Callable[[str], None] = None) -> None:
    """Connector wires the host's LLM (and logger) into the core. Called once at
    plugin register; the watcher uses these when started."""
    global _complete, _log
    _complete = complete
    if log:
        _log = log


def is_running() -> bool:
    return _status["running"]


def status() -> Dict[str, Any]:
    return dict(_status)


# ── per-match spec cache (the self-instructable envelope) ────────────────────
# Instructions are frozen PER GAME (server snapshot). Cache one spec per
# matchId; the guard ladder (/matches/:id/spec → /spec → None) re-runs on every
# cache miss, so a network blip at game start self-heals on a later tick.
_spec: Optional[Dict[str, Any]] = None
_spec_match: Optional[str] = None


def _reset_spec_cache() -> None:
    global _spec, _spec_match
    _spec, _spec_match = None, None


def _get_spec(match_id: str) -> Optional[Dict[str, Any]]:
    """The match's spec snapshot, cached per game. Protection logic: cache miss
    → fetch the per-match snapshot; that failing → server-current /spec; that
    failing → None (decide falls back to its static vocabulary). A None result
    is NOT cached, so the next tick retries — degraded, never permanently."""
    global _spec, _spec_match
    if _spec is not None and _spec_match == match_id:
        return _spec
    for path in (f"/matches/{match_id}/spec", "/spec"):
        try:
            spec = C.request("GET", path)
        except C.PitchError:
            continue
        if isinstance(spec, dict) and spec.get("actions"):
            _spec, _spec_match = spec, match_id
            return _spec
    return None


def _post_move(match_id: str, pid: str, action: str, say: str, token: Optional[str],
               params: Optional[Dict[str, Any]] = None) -> None:
    body: Dict[str, Any] = {"agentId": C.team_handle(), "type": action}
    if params:
        body.update(params)  # per-action params pass through; the server validates
    if say:
        body["say"] = say
    try:
        C.request("POST", f"/matches/{match_id}/players/{pid}/action", body, seat_token=token)
    except C.PitchError:
        pass  # one dropped move never stops the loop


def _loop(cadence_ms: int) -> None:
    _status["running"] = True
    backoff = 1.0
    try:
        while not _stop.is_set():
            st = C.load_state()
            match_id = st.get("matchId")
            agent_id = st.get("agentId") or C.team_handle()
            token = st.get("token")
            if not match_id:
                _stop.wait(2.0)
                continue
            try:
                view = C.request("GET", f"/matches/{match_id}/agents/{agent_id}/state")
                backoff = 1.0
            except C.PitchError as e:
                if e.status == 404:
                    # Server forgot us (restart) or match gone — try to re-take the seat.
                    _log("[autoplay] seat lost — re-joining")
                    try:
                        r = C.request("POST", "/quickmatch", {"agentId": agent_id, "teamSize": st.get("teamSize", 5)})
                        st.update(matchId=r.get("matchId"), players=r.get("playerIds", []),
                                  token=r.get("token"), agentId=r.get("did") or agent_id)
                        C.save_state(st)
                    except C.PitchError:
                        pass
                    _stop.wait(min(backoff, 10.0)); backoff *= 2
                    continue
                _stop.wait(min(backoff, 10.0)); backoff *= 2
                continue

            phase = view.get("phase")
            if phase == "ended":
                _log("[autoplay] match ended — pausing (no decisions)")
                _stop.wait(3.0)
                continue
            # A waiting room ticks only once both sides are filled; no point deciding.
            if not view.get("mine"):
                _stop.wait(cadence_ms / 1000.0)
                continue

            spec = _get_spec(match_id)  # per-game snapshot; ladder + retry inside
            moves = D.decide(view, _complete, spec) if _complete else []
            for pid, action, say, params in moves:
                _post_move(match_id, pid, action, say, token, params)
            _status.update(lastDecision=time.time(), moves=_status["moves"] + len(moves), matchId=match_id)
            if moves:
                _log(f"[autoplay] {len(moves)} moves in {match_id}")
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
    _thread = threading.Thread(target=_loop, args=(max(500, int(cadence_ms)),), daemon=True, name="agent-soccer-autoplay")
    _thread.start()
    _log("[autoplay] started")
    return True


def stop() -> None:
    _stop.set()
    _log("[autoplay] stopped")
