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
import time
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

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


# ── per-match memory: a bounded rolling history (the "manager's notebook") ────
# Hermes `complete`/`complete_structured` are STATELESS, so to give the agent
# continuity across ticks we emulate "one session per match": a small ring of
# the last few turns (a short board summary + the orders it issued), injected
# into the next prompt. Keyed by matchId so a new game starts clean; capped in
# count (last N turns) AND in total injected length so it never bloats the
# prompt. Venue-agnostic — it carries only generic "here were your last orders",
# no game-specifics. Graceful: if anything is missing we just skip the block.
_HISTORY_TURNS = 3          # ring depth: remember the last N decisions
_HISTORY_CHARS = 600        # hard cap on the injected block's length
_history: Deque[Dict[str, str]] = deque(maxlen=_HISTORY_TURNS)
_history_match: Optional[str] = None


def _reset_history(match_id: Optional[str] = None) -> None:
    """Start a fresh notebook for a new match (or clear on match end)."""
    global _history, _history_match
    _history = deque(maxlen=_HISTORY_TURNS)
    _history_match = match_id


def _match_id_of(view: Dict[str, Any]) -> Optional[str]:
    return view.get("matchId") or view.get("match", {}).get("id") if isinstance(view, dict) else None


def _sync_history_match(view: Dict[str, Any]) -> None:
    """Reset the notebook when the matchId changes (new game → clean slate). A
    None matchId (view without one) leaves the current notebook untouched."""
    mid = _match_id_of(view)
    if mid is not None and mid != _history_match:
        _reset_history(mid)


def _summarize_moves(moves: List[Move]) -> str:
    """A compact one-line digest of the orders issued (player→action[zone])."""
    if not moves:
        return "(no orders)"
    bits = []
    for pid, action, _say, params in moves:
        zone = params.get("zone") if isinstance(params, dict) else None
        bits.append(f"{pid}:{action}" + (f"@{zone}" if zone else ""))
    return ", ".join(bits)


def _board_brief(view: Dict[str, Any]) -> str:
    """A tiny, venue-neutral snapshot of the board for the notebook entry —
    score + possession when present; falls back to the head of the summary."""
    score = view.get("score") if isinstance(view, dict) else None
    if isinstance(score, dict) and ("home" in score or "away" in score):
        return f"score {score.get('home', 0)}-{score.get('away', 0)}"
    summary = (view.get("summary") or "") if isinstance(view, dict) else ""
    return summary.strip().splitlines()[0][:80] if summary else "(board)"


def _record_turn(view: Dict[str, Any], moves: List[Move]) -> None:
    """Append this turn (brief board + the orders issued) to the notebook."""
    try:
        _history.append({"board": _board_brief(view), "orders": _summarize_moves(moves)})
    except Exception:
        pass  # the notebook is best-effort — never break a decision over it


def _history_block() -> str:
    """The compact 'Recent decisions' prompt block (length-capped), or '' when
    the notebook is empty / unavailable. Oldest-first so the latest is last."""
    try:
        if not _history:
            return ""
        lines = [f"- {t['board']} → {t['orders']}" for t in _history]
        block = "## Recent decisions (your last few orders)\n" + "\n".join(lines)
        return block[:_HISTORY_CHARS]
    except Exception:
        return ""


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
    recent = _history_block()
    recent_block = (recent + "\n\n" if recent else "")
    return [
        {"role": "system", "content": ins["system"]},
        {"role": "user", "content": strat_block + recent_block + situation + "\n\n" + ins["play"] + "\n\n" + ins["output"]},
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
                       my_ids: List[str], spec: Optional[Dict[str, Any]] = None,
                       ) -> Optional[Tuple[List[Move], str]]:
    """Structured decision path: ask the host to ENFORCE JSON (json_schema /
    json_mode), removing the reasoning-model 'empty/prose-wrapped JSON' parse
    fragility. Returns (validated moves, raw reply text), or None to signal
    'structured path unusable — fall back' (host raised, trust-gated, or schema
    rejected). An empty list (valid call, no usable moves) is returned as []."""
    situation = view.get("summary") or _render_fallback(view)
    recent = _history_block()
    input_text = (recent + "\n\n" + situation) if recent else situation
    ins = _instructions(spec)
    try:
        result = complete_structured(
            instructions=_structured_instructions(view, spec),
            input=[{"type": "text", "text": input_text}],
            json_schema=_moves_schema(view, spec),
            schema_name="soccer_moves",
            system_prompt=ins["system"],
            max_tokens=500,
            timeout=30,
        )
    except Exception:
        return None  # trust-gated / unsupported / transport — let caller fall back
    raw = getattr(result, "text", "") or ""
    parsed = getattr(result, "parsed", None)
    if isinstance(parsed, (dict, list)):
        if not raw:
            raw = json.dumps(parsed)  # surface the parsed object as the raw reply
        return parse_moves_obj(parsed, my_ids, spec), raw
    # Host returned text (json_mode off, schema rejected, or model refused) —
    # tolerantly parse the raw completion rather than dropping the turn.
    return parse_moves(raw, my_ids, spec), raw


# ── the per-decision report (Change 2: report every decision to the pitch) ────
# `decide` builds this from what it already has; the watcher reads `last_report()`
# and POSTs it to /matches/:id/agents/:agentId/decision (acted AND no_response).
_last_report: Optional[Dict[str, Any]] = None


def last_report() -> Optional[Dict[str, Any]]:
    return _last_report


def _build_report(view: Dict[str, Any], spec: Optional[Dict[str, Any]],
                  moves: List[Move], raw_text: str, latency_ms: int,
                  prompt_user: str, prompt_system: str) -> Dict[str, Any]:
    """Assemble the decision report wire body. outcome=acted when moves非空 else
    no_response (with a reason). moves are reshaped to the report contract
    {playerId, action, zone?, say?} — zone is lifted out of the passthrough
    params. Best-effort fields (rawText/latency/model) ride along."""
    acted = bool(moves)
    out_moves = []
    for pid, action, say, params in moves:
        m: Dict[str, Any] = {"playerId": pid, "action": action}
        if isinstance(params, dict) and params.get("zone") is not None:
            m["zone"] = params["zone"]
        if say:
            m["say"] = say
        out_moves.append(m)
    report: Dict[str, Any] = {
        "tick": view.get("tick", 0),
        "clock": view.get("clock", 0),
        "prompt": {"system": prompt_system, "user": prompt_user},
        "outcome": "acted" if acted else "no_response",
        "moves": out_moves,
        "rawText": raw_text,
        "latencyMs": latency_ms,
        "model": C.last_model(),
    }
    if not acted:
        report["reason"] = "empty reply" if not (raw_text or "").strip() else "no valid moves parsed"
    return report


def decide(view: Dict[str, Any], complete: Callable[[List[Dict[str, str]]], str],
           spec: Optional[Dict[str, Any]] = None,
           complete_structured: Optional[CompleteStructured] = None) -> List[Move]:
    """One decision: view → LLM → validated moves. Prefers the structured path
    (`complete_structured`, host-enforced JSON) when available; falls back to the
    free-text `complete` + tolerant `parse_moves` for old hosts, trust-gated
    structured access, or a rejected schema. Degraded, never dead. Returns [] on
    any failure (the watcher just retries next tick).

    Side effects (per-match memory + observability): resets the rolling history
    on a matchId change, injects it into the prompt (via build_messages /
    structured input), records this turn into it, and builds a decision report
    (acted OR no_response) the watcher reads via `last_report()`."""
    global _last_report
    _last_report = None
    my_ids = [p["id"] for p in view.get("mine", [])]
    if not my_ids:
        return []
    _sync_history_match(view)  # new match → fresh notebook (Change 3)

    ins = _instructions(spec)
    prompt_system = ins["system"]
    moves: List[Move] = []
    raw_text = ""
    started = time.monotonic()

    structured_ok = False
    if complete_structured is not None:
        result = _decide_structured(view, complete_structured, my_ids, spec)
        if result is not None:
            moves, raw_text = result  # structured succeeded (even if no moves)
            structured_ok = True
    if not structured_ok:
        # text path: no structured adapter, or structured raised / was unusable
        try:
            msgs = build_messages(view, spec)
            raw_text = complete(msgs) or ""
            moves = parse_moves(raw_text, my_ids, spec)
        except Exception:
            raw_text = raw_text or ""
            moves = []

    latency_ms = int((time.monotonic() - started) * 1000)
    prompt_user = build_messages(view, spec)[1]["content"]
    try:
        _last_report = _build_report(view, spec, moves, raw_text, latency_ms, prompt_user, prompt_system)
    except Exception:
        _last_report = None
    _record_turn(view, moves)  # append this turn to the notebook (Change 3)
    return moves
