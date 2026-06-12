"""Generic GSP decision core (self-instructable-observation.md §3).

Turns a per-tick view into per-player moves by asking an injected
``complete(messages) -> text`` LLM. ZERO game knowledge: the instructions, the
action vocabulary and the rendered situation all come FROM THE SERVER —
`spec.instructions` (frozen per match) + `view.summary`. The plugin only
concatenates, parses, and validates against the published enum, passing any
per-action params straight through (the server is the validator).

A static fallback (the pre-envelope soccer prompt) keeps the plugin playing
against old servers or through network loss — degraded, never dead.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import client as C

# STATIC FALLBACK — used only when no spec is available (old server / network
# loss). High-level verbs only; raw run/kick excluded (geometry is NaN-prone
# without server guidance).
ACTIONS = ["chase", "shoot", "dribble", "pass", "defend", "press", "cover", "idle"]
FALLBACK_INSTRUCTIONS = {
    "system": "You are a decisive soccer tactician. Output only JSON. Be fast.",
    "play": (
        "Choose ONE action per player from: " + ", ".join(ACTIONS) + ".\n"
        "Guidance: the ball-carrier should dribble or shoot if near the +x goal, else pass; "
        "others chase/press if we don't have it, or make space (cover) if we do."
    ),
    "output": (
        'Reply with ONLY a JSON object mapping each of your player ids to an action, '
        'optionally with a short shout. Example:\n'
        '{"moves":{"home-9":{"action":"shoot","say":"GOAL!"},"home-10":{"action":"chase"}}}'
    ),
}

Move = Tuple[str, str, str, Dict[str, Any]]  # (player_id, action, say, params)


def _fmt_player(p: Dict[str, Any]) -> str:
    pos = p.get("pos", {})
    ball = " [HAS BALL]" if p.get("hasBall") else ""
    return f"{p['id']} #{p.get('number','?')} at ({pos.get('x',0):.0f},{pos.get('y',0):.0f}){ball}"


def _render_fallback(view: Dict[str, Any]) -> str:
    """Plugin-side situation rendering — only for views without a server
    `summary` (pre-envelope servers)."""
    mine = view.get("mine", [])
    ball = view.get("ball", {})
    bp = ball.get("pos", {})
    owner = ball.get("owner")
    who_has = "us" if owner in {p["id"] for p in mine} else ("nobody (loose)" if not owner else "the opponent")
    opp = view.get("opponents", [])
    score = view.get("score", {})
    return (
        f"Live soccer. You attack +x. Score home {score.get('home',0)}-{score.get('away',0)} away; "
        f"you are {view.get('team','?')}. Ball at ({bp.get('x',0):.0f},{bp.get('y',0):.0f}), held by {who_has}.\n"
        f"Your players:\n  " + "\n  ".join(_fmt_player(p) for p in mine) + "\n"
        f"Opponents near: " + ", ".join(f"#{o.get('number','?')}({o['pos']['x']:.0f},{o['pos']['y']:.0f})" for o in opp[:4])
    )


def _instructions(spec: Optional[Dict[str, Any]]) -> Dict[str, str]:
    ins = (spec or {}).get("instructions")
    if isinstance(ins, dict) and all(isinstance(ins.get(k), str) and ins[k] for k in ("system", "play", "output")):
        return ins
    return FALLBACK_INSTRUCTIONS


def _enum(spec: Optional[Dict[str, Any]]) -> List[str]:
    enum = (spec or {}).get("actions", {}).get("enum")
    if isinstance(enum, list) and enum:
        return [str(a) for a in enum]
    return list(ACTIONS)


def build_messages(view: Dict[str, Any], spec: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    """Generic concat: instructions.system | strategy + situation + play + output.
    The situation is the server's `summary` when present (it owns the geometry);
    the plugin renders only as a fallback."""
    ins = _instructions(spec)
    situation = view.get("summary") or _render_fallback(view)
    standing = C.strategy()
    strat_block = (f"## Your manager's standing instructions\n{standing}\n\n" if standing else "")
    return [
        {"role": "system", "content": ins["system"]},
        {"role": "user", "content": strat_block + situation + "\n\n" + ins["play"] + "\n\n" + ins["output"]},
    ]


_RESERVED = {"action", "say"}


def parse_moves(text: str, my_ids: List[str], spec: Optional[Dict[str, Any]] = None) -> List[Move]:
    """Extract (player, action, say, params) from the LLM reply; tolerant of
    junk/markdown. Valid actions come from the spec's published enum; any other
    move keys pass through as params (server-side validation is authoritative)."""
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except Exception:
        return []
    moves_obj = data.get("moves", data) if isinstance(data, dict) else {}
    allowed = _enum(spec)
    out: List[Move] = []
    for pid in my_ids:
        move = moves_obj.get(pid)
        if not isinstance(move, dict):
            continue
        action = str(move.get("action", "")).strip().lower()
        if action not in allowed:
            continue
        say = str(move.get("say", "") or "")[:60]
        params = {k: v for k, v in move.items() if k not in _RESERVED}
        out.append((pid, action, say, params))
    return out


def decide(view: Dict[str, Any], complete: Callable[[List[Dict[str, str]]], str],
           spec: Optional[Dict[str, Any]] = None) -> List[Move]:
    """One decision: view → LLM → validated moves. `complete` is the connector's
    host-LLM call. Returns [] on any failure (the watcher just retries next tick)."""
    my_ids = [p["id"] for p in view.get("mine", [])]
    if not my_ids:
        return []
    try:
        text = complete(build_messages(view, spec))
    except Exception:
        return []
    return parse_moves(text or "", my_ids, spec)
