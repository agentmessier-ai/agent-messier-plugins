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
        "others chase/press if we don't have it, or make space (cover) if we do.\n"
        "ACT EVERY TIME YOU ARE PROMPTED — re-issue a move for every player, even if the plan is "
        "unchanged. Orders hold until you change them, so if you go quiet your team freezes on stale "
        "orders. Never reply without moves."
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


def _structured_instructions(view: Dict[str, Any], spec: Optional[Dict[str, Any]] = None) -> str:
    """The `instructions` text for a structured call: the server's play+output
    guidance plus the manager's standing instructions. The system role is
    carried separately (`instructions.system` → `system_prompt`); the rendered
    situation is the structured `input`, kept distinct so the host can frame it."""
    ins = _instructions(spec)
    standing = C.strategy()
    strat_block = (f"## Your manager's standing instructions\n{standing}\n\n" if standing else "")
    return strat_block + ins["play"] + "\n\n" + ins["output"]


def _moves_schema(view: Dict[str, Any], spec: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """JSON schema for the decision: {"moves": {<playerId>: {action, say?, ...}}}.
    The action enum comes FROM THE SERVER (spec.actions.enum), defaulting to the
    static fallback list — so the schema is venue-driven, not plugin-hardcoded.
    `additionalProperties` stays open on a move so per-action params (dir, power,
    zone, …) pass through to the server, which is the authoritative validator."""
    move_schema: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": _enum(spec)},
            "say": {"type": "string"},
        },
        "required": ["action"],
        "additionalProperties": True,
    }
    my_ids = [p["id"] for p in view.get("mine", [])]
    moves: Dict[str, Any] = {"type": "object", "additionalProperties": move_schema}
    if my_ids:
        moves["properties"] = {pid: move_schema for pid in my_ids}
    return {
        "type": "object",
        "properties": {"moves": moves},
        "required": ["moves"],
        "additionalProperties": False,
    }


_RESERVED = {"action", "say"}


def parse_moves_obj(data: Any, my_ids: List[str], spec: Optional[Dict[str, Any]] = None) -> List[Move]:
    """Validate an ALREADY-PARSED decision object into (player, action, say,
    params). Accepts either the `{"moves":{...}}` envelope or a bare
    `{<playerId>:{...}}` map. Valid actions come from the spec's published enum;
    any other move keys pass through as params (server-side validation is
    authoritative). This is the shared validation step for both the structured
    path (parsed dict from the host) and the text path (`parse_moves`)."""
    moves_obj = data.get("moves", data) if isinstance(data, dict) else {}
    if not isinstance(moves_obj, dict):
        return []
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


def parse_moves(text: str, my_ids: List[str], spec: Optional[Dict[str, Any]] = None) -> List[Move]:
    """Extract (player, action, say, params) from a free-text LLM reply;
    tolerant of junk/markdown (whole body → first balanced block). Delegates the
    enum/param validation to `parse_moves_obj`."""
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except Exception:
        return []
    return parse_moves_obj(data, my_ids, spec)


# A structured-completion adapter: takes the rendered situation + system prompt +
# combined instructions + a JSON schema and returns the host's structured result.
# `parsed` is the decision dict when the host enforced JSON; `text` is the raw
# completion (always present) for the tolerant text-parse fallback.
StructuredResult = Any  # has `.parsed` (Optional[dict]) and `.text` (str)
CompleteStructured = Callable[..., StructuredResult]


def _decide_structured(view: Dict[str, Any], complete_structured: CompleteStructured,
                       my_ids: List[str], spec: Optional[Dict[str, Any]] = None) -> Optional[List[Move]]:
    """Structured decision path: ask the host to ENFORCE JSON (json_schema /
    json_mode), removing the reasoning-model 'empty/prose-wrapped JSON' parse
    fragility. Returns the validated moves, or None to signal 'structured path
    unusable — fall back' (host raised, trust-gated, or schema rejected). An
    empty list (valid call, no usable moves) is returned as [] (not None)."""
    situation = view.get("summary") or _render_fallback(view)
    ins = _instructions(spec)
    try:
        result = complete_structured(
            instructions=_structured_instructions(view, spec),
            input=[{"type": "text", "text": situation}],
            json_schema=_moves_schema(view, spec),
            schema_name="soccer_moves",
            system_prompt=ins["system"],
            max_tokens=500,
            timeout=30,
        )
    except Exception:
        return None  # trust-gated / unsupported / transport — let caller fall back
    parsed = getattr(result, "parsed", None)
    if isinstance(parsed, (dict, list)):
        return parse_moves_obj(parsed, my_ids, spec)
    # Host returned text (json_mode off, schema rejected, or model refused) —
    # tolerantly parse the raw completion rather than dropping the turn.
    return parse_moves(getattr(result, "text", "") or "", my_ids, spec)


def decide(view: Dict[str, Any], complete: Callable[[List[Dict[str, str]]], str],
           spec: Optional[Dict[str, Any]] = None,
           complete_structured: Optional[CompleteStructured] = None) -> List[Move]:
    """One decision: view → LLM → validated moves. Prefers the structured path
    (`complete_structured`, host-enforced JSON) when available; falls back to the
    free-text `complete` + tolerant `parse_moves` for old hosts, trust-gated
    structured access, or a rejected schema. Degraded, never dead. Returns [] on
    any failure (the watcher just retries next tick)."""
    my_ids = [p["id"] for p in view.get("mine", [])]
    if not my_ids:
        return []
    if complete_structured is not None:
        moves = _decide_structured(view, complete_structured, my_ids, spec)
        if moves is not None:
            return moves  # structured call succeeded (even if it yielded no moves)
    try:
        text = complete(build_messages(view, spec))
    except Exception:
        return []
    return parse_moves(text or "", my_ids, spec)
