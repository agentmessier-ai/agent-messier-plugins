"""hermes-agent-messier — the HERMES CONNECTOR for the Agent Messier platform.

This file is the only host-specific part (see
docs/design/agent-soccer-plugin-contract.md + venue-agnostic-plugins.md): it
wires Hermes's plugin API to the venue-agnostic core (client.py / generate.py /
decide.py / watcher.py). Tools are GENERATED per venue from the marketplace
registry — soccer, taskmarket, and any future venue — plus two platform tools
(venues, agentmessier_claim). The OpenClaw (TS) plugin is the same design.

The connector does three things:
  1. discover venues + register their generated tools (generate.all_venue_tools),
  2. provide the core a `complete(messages) -> text` via the host LLM (ctx.llm),
  3. host the watcher (a daemon thread; the generated {venue}_autoplay tool
     starts/stops it).

Config (env, or plugins.entries.hermes-agent-messier.env in ~/.hermes/config.yaml):
  AGENTMESSIER_URL       pitch / platform base URL (default https://agent.agentmessier.com)
  AGENTMESSIER_ACCOUNTS_URL     accounts base URL (OAuth login, owner claim; default = AGENTMESSIER_URL host)
  AGENTMESSIER_TASKMARKET_URL   taskmarket base URL       (default http://localhost:3030)
  AGENTMESSIER_API_KEY          AgentMessier API key          (optional; REQUIRE_AUTH servers)
  AGENTMESSIER_CLIENT_CERT/AGENTMESSIER_CLIENT_KEY  paths to a TLS client cert+key
                         for a venue behind mutual-TLS (e.g. a Cloudflare-fronted staging
                         host). Both must point at readable files or both are ignored.
  AGENTMESSIER_TEAM      your stable team handle   (optional; else derived from host)
  AGENTMESSIER_NAME/NATION/CLAN/STYLE  team identity (optional; OpenClaw's teamName/nation/clan/style); per-call join args win
  AGENTMESSIER_AUTOPLAY  hands-free play at load — default ON (like OpenClaw); set off/0 to disable
  AGENTMESSIER_CADENCE_MS min ms between autoplay decisions (default 3000)
  AGENTMESSIER_AUX_LLM   route decisions through a plugin-registered AUXILIARY TASK
                         (default ON — set 0/off to force the legacy ctx.llm path).
                         See _make_complete_aux for why this exists.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

# Auxiliary-task key for decision completions (AGENTMESSIER_AUX_LLM=on).
# Users can pin a provider/model/extra_body for decisions independent of their
# chat model under `auxiliary.agent_messier_decide` in ~/.hermes/config.yaml
# (also visible in `hermes model → Configure auxiliary models`).
AUX_TASK_KEY = "agent_messier_decide"


def _aux_llm_enabled() -> bool:
    """AGENTMESSIER_AUX_LLM toggle — default ON (fast decisions out of the box;
    set 0/off to force the legacy ctx.llm bridge path)."""
    v = (os.getenv("AGENTMESSIER_AUX_LLM") or "on").strip().lower()
    return v not in {"0", "off", "false", "no"}


# Per-provider "don't think during a game move" knobs, keyed by the hermes
# provider name (providers.<name> in config.yaml; aliases included). Verified
# against each provider's docs 2026-07-03:
#  - deepseek / kimi (moonshot, K2.5+ defaults thinking ON) / glm (zhipu):
#    `thinking: {type: disabled}` via extra_body.
#  - qwen (dashscope / alibaba): `enable_thinking: false` via extra_body.
#  - gemini (google, OpenAI-compat surface): `reasoning_effort: "none"`
#    (maps to thinking budget 0; 2.5-flash honors it, pro clamps to its min).
#  - openai / openai-api: MODEL-dependent — see _OPENAI_REASONING_FLOOR below.
#  - anthropic/claude: DELIBERATELY empty — thinking is opt-in on the Messages
#    API (off unless explicitly enabled), nothing to disable.
# Unknown providers get NOTHING (safe default: never send a knob a provider
# might reject). A user-set auxiliary.agent_messier_decide.extra_body always
# wins — see _decide_extra_body.
_THINKING_OFF_BY_PROVIDER = {
    "deepseek": {"thinking": {"type": "disabled"}},
    "kimi": {"thinking": {"type": "disabled"}},
    "moonshot": {"thinking": {"type": "disabled"}},
    "glm": {"thinking": {"type": "disabled"}},
    "zhipu": {"thinking": {"type": "disabled"}},
    "zai": {"thinking": {"type": "disabled"}},
    "qwen": {"enable_thinking": False},
    "dashscope": {"enable_thinking": False},
    "alibaba": {"enable_thinking": False},
    "gemini": {"reasoning_effort": "none"},
    "google": {"reasoning_effort": "none"},
    "anthropic": {},
    "claude": {},
}

# OpenAI is the one provider where the knob is MODEL-specific, so the floor is
# enumerated per family (first prefix match wins — order matters). Sources:
# the reasoning guide ("supported values are model-dependent"), the gpt-5.1 and
# gpt-5.5 model pages, and Azure's reasoning-model matrix, checked 2026-07-03:
#  - gpt-5.<x> (5.1/5.2/5.5…): supports "none" — introduced in 5.1 as the
#    replacement for "minimal". 5.1 even defaults to none, but 5.5 defaults
#    back to MEDIUM, so we always send it explicitly.
#  - gpt-5-chat*: chat-tuned NON-reasoning variant — rejects the param entirely.
#  - gpt-5 / gpt-5-mini / gpt-5-nano: floor is "minimal" ("none" not accepted).
#  - o1-mini: does not support reasoning_effort AT ALL (Azure matrix: "all
#    reasoning models except o1-mini").
#  - o1 / o3 / o3-mini / o4-mini: floor is "low" (no minimal, no none).
#  - everything else (gpt-4o, gpt-4.1, …): non-reasoning — any reasoning param
#    is a 400; send nothing.
_OPENAI_PROVIDERS = {"openai", "openai-api"}
_OPENAI_REASONING_FLOOR = [
    ("gpt-5.", "none"),
    ("gpt-5-chat", None),
    ("gpt-5", "minimal"),
    ("o1-mini", None),
    ("o1", "low"),
    ("o3", "low"),
    ("o4", "low"),
]


def _openai_knob(model) -> dict | None:
    m = str(model or "").strip().lower()
    for prefix, effort in _OPENAI_REASONING_FLOOR:
        if m.startswith(prefix):
            return {"reasoning_effort": effort} if effort else None
    return None  # unknown / non-reasoning openai model → send nothing


def _thinking_off_for(config) -> dict | None:
    """Pure resolver: given the RAW host config dict, return the extra_body the
    decision call should carry, or None to send nothing.

    Precedence (user always wins):
      1. auxiliary.<AUX_TASK_KEY>.extra_body set by the USER → None (their
         config flows through the task layer untouched; we add nothing).
      2. openai/openai-api → the MODEL-specific reasoning floor
         (_OPENAI_REASONING_FLOOR — "none"/"minimal"/"low"/nothing by family).
      3. else the provider's entry in _THINKING_OFF_BY_PROVIDER, or None for
         unknown providers (never send a knob a provider might reject).

    Provider/model = the task's pinned values when set (and not "auto"), else
    the main model config — mirroring the host's own task resolution, so the
    knob matches the provider+model that will actually serve the call."""
    if not isinstance(config, dict):
        return None
    aux = config.get("auxiliary") or {}
    task_cfg = aux.get(AUX_TASK_KEY) if isinstance(aux, dict) else None
    task_cfg = task_cfg if isinstance(task_cfg, dict) else {}
    if isinstance(task_cfg.get("extra_body"), dict):
        return None  # user configured the task's extra_body — theirs, verbatim
    model_cfg = config.get("model") if isinstance(config.get("model"), dict) else {}
    provider = str(task_cfg.get("provider") or "").strip().lower()
    if not provider or provider == "auto":
        provider = str(model_cfg.get("provider") or "").strip().lower()
    if provider in _OPENAI_PROVIDERS:
        model = task_cfg.get("model") or model_cfg.get("default") or model_cfg.get("model")
        return _openai_knob(model)
    knob = _THINKING_OFF_BY_PROVIDER.get(provider)
    return dict(knob) if knob else None


def _decide_extra_body() -> dict | None:
    """The per-call extra_body for a decision: provider-aware thinking-off knob,
    unless the user configured the task's extra_body themselves. Reads only the
    host's own (non-secret) config via the same loader the host's task
    resolution uses; any failure → None (send nothing — always safe)."""
    try:
        from hermes_cli.config import load_config
        return _thinking_off_for(load_config())
    except Exception:
        return None


def _make_complete(ctx):
    """Adapt the host LLM to the core's `complete(messages) -> text` contract.
    Uses the user's active model/auth (ctx.llm) — no provider keys here. A
    model/provider override is possible only if the user allows it via
    plugins.entries.hermes-agent-messier.llm.* (fail-closed by the host)."""
    def complete(messages):
        result = ctx.llm.complete(messages, max_tokens=500, timeout=30)
        # Capture the EFFECTIVE model that produced this decision (provider/model
        # from the completion result) → sent as x-agent-model on the next move,
        # so the pitch records the model actually playing (mid-match switch aware).
        try:
            from . import client as _C
            prov, mdl = getattr(result, "provider", None), getattr(result, "model", None)
            if mdl:
                _C.set_last_model(f"{prov}/{mdl}" if prov else str(mdl))
        except Exception:
            pass
        return getattr(result, "text", "") or ""
    return complete


def _make_complete_aux(fallback):
    """OPT-IN (AGENTMESSIER_AUX_LLM=on): route decisions through the plugin's
    registered auxiliary task instead of ctx.llm.

    WHY: the ctx.llm bridge passes task=None into the host's call_llm, so the
    user's `providers.<name>.extra_body` (e.g. `thinking: {type: disabled}`)
    is never applied to plugin completions. On hybrid thinking models
    (deepseek-v4-flash) every decision then runs with extended thinking ON —
    thousands of hidden reasoning tokens, 13–113s/move vs 2–6s for the host's
    own conversation loop on the SAME model (measured 2026-07-03). An
    auxiliary task is the host's sanctioned fix: `auxiliary.<key>` user config
    wins over anything the plugin does, and `provider: auto` resolves to the
    user's MAIN provider+model — same model, same host-owned credentials (this
    plugin never touches keys), thinking off by default.

    The thinking-off knob is PROVIDER-SHAPED and computed per call
    (_decide_extra_body): deepseek/kimi/glm say `thinking:{type:disabled}`,
    qwen says `enable_thinking:false`, gemini says `reasoning_effort:"none"`,
    openai/anthropic deliberately get nothing. A user-set
    auxiliary.<key>.extra_body suppresses the knob entirely — theirs, verbatim.

    Degraded, never dead: ANY failure (older host without auxiliary-task
    support, import error, transport error, empty reply) falls back to the
    plain ctx.llm path — exactly the default behavior."""
    def complete(messages):
        try:
            # Host-internal, in-process import — the same module ctx.llm's own
            # bridge routes through; credentials stay entirely host-side.
            from agent.auxiliary_client import call_llm
            extra = _decide_extra_body()
            resp = call_llm(task=AUX_TASK_KEY, messages=messages, max_tokens=500, timeout=30,
                            **({"extra_body": extra} if extra else {}))
            choices = getattr(resp, "choices", None) or []
            text = (getattr(getattr(choices[0], "message", None), "content", "") or "") if choices else ""
            if text.strip():
                try:
                    from . import client as _C
                    mdl = getattr(resp, "model", None)
                    if mdl:
                        _C.set_last_model(str(mdl))
                except Exception:
                    pass
                return text
            logger.debug("hermes-agent-messier: auxiliary-task LLM returned empty — falling back to ctx.llm")
        except Exception as e:
            logger.debug("hermes-agent-messier: auxiliary-task LLM failed (%s) — falling back to ctx.llm", e)
        return fallback(messages)
    return complete


def _make_diagnose_complete(ctx):
    """A NON-swallowing one-shot probe of the SAME host LLM the play loop uses —
    for self-diagnosis. Unlike `_make_complete` (which eats errors so one bad turn
    never stops play), this returns the raw outcome {ok,text,model,provider,error}
    so the diagnosis can report WHY the model isn't producing output (e.g. an
    undefined provider) instead of a swallowed empty string."""
    def diagnose(messages, max_tokens=16):
        try:
            result = ctx.llm.complete(messages, max_tokens=max_tokens, timeout=20)
        except Exception as e:
            return {"ok": False, "text": "", "model": None, "provider": None, "error": str(e)}
        text = getattr(result, "text", "") or ""
        return {"ok": bool(text.strip()), "text": text,
                "model": getattr(result, "model", None),
                "provider": getattr(result, "provider", None), "error": None}
    return diagnose


def _make_complete_structured(ctx):
    """Adapt the host's structured-output API to the core's `complete_structured`
    contract, when the host exposes it. Like `_make_complete`, it uses the user's
    active model/auth (ctx.llm) — no provider keys here. Returns None when the
    host has no `complete_structured` (older host); per-call trust-gating
    (plugins.entries.<id>.llm.*) is handled by the core, which falls back to the
    plain `complete` path if the structured call raises."""
    structured = getattr(getattr(ctx, "llm", None), "complete_structured", None)
    if not callable(structured):
        return None

    def complete_structured(**kwargs):
        result = structured(**kwargs)
        # Same effective-model capture as the text path → x-agent-model on the
        # next move reflects the model that actually produced this decision.
        try:
            from . import client as _C
            prov, mdl = getattr(result, "provider", None), getattr(result, "model", None)
            if mdl:
                _C.set_last_model(f"{prov}/{mdl}" if prov else str(mdl))
        except Exception:
            pass
        return result
    return complete_structured


def register(ctx) -> None:
    """Called once by the Hermes plugin loader. Imports are done here (not at
    module top level) so this file is import-safe outside a package context."""
    from . import generate as G
    from . import tools as T
    from .tools import PLATFORM_TOOLS, check_available
    from .oauth import OAUTH_TOOLS
    from . import watcher as W

    # Generate the per-venue tool surface from the marketplace registry (each
    # venue's /spec). Offline-safe: discovery + spec fetch fall back to baked-in
    # defaults. A new venue (golf, …) appears here with zero plugin code.
    try:
        venue_tools = G.all_venue_tools()
    except Exception as e:  # never let discovery break registration
        logger.debug("hermes-agent-messier: venue discovery failed (%s)", e)
        venue_tools = []

    for name, schema, handler, emoji in (*venue_tools, *PLATFORM_TOOLS, *OAUTH_TOOLS):
        ctx.register_tool(
            name=name,
            toolset="agent-messier",
            schema=schema,
            handler=handler,
            check_fn=check_available,
            emoji=emoji,
        )

    # Wire the host LLM + logger into the agnostic watcher core.
    #
    # Two decision paths, chosen by AGENTMESSIER_AUX_LLM (default OFF = the
    # long-standing ctx.llm wiring, byte-for-byte unchanged):
    #  - OFF: ctx.llm complete + structured, as always.
    #  - ON:  the plugin registers an auxiliary task (thinking disabled by
    #         default; user config at auxiliary.agent_messier_decide wins) and
    #         decisions route through it — see _make_complete_aux. Structured
    #         is deliberately NOT passed then: decide() prefers structured, and
    #         structured runs through the ctx.llm bridge this mode exists to
    #         avoid; the text path's tolerant parse_moves takes over.
    try:
        aux_on = _aux_llm_enabled()
        if aux_on:
            reg = getattr(ctx, "register_auxiliary_task", None)
            if callable(reg):
                try:
                    reg(key=AUX_TASK_KEY,
                        display_name="Agent Messier decisions",
                        description="per-move venue decisions (soccer etc.) — thinking off by default",
                        # No static extra_body default: the thinking-off knob is
                        # provider-shaped and computed PER CALL (_decide_extra_body) —
                        # one static shape here would be wrong for every provider
                        # that isn't deepseek (and 400 on strict APIs like OpenAI).
                        defaults={"timeout": 30})
                    logger.info("hermes-agent-messier: decisions via auxiliary task %r (AGENTMESSIER_AUX_LLM=on)", AUX_TASK_KEY)
                except Exception as e:
                    logger.info("hermes-agent-messier: auxiliary task registration failed (%s) — using ctx.llm", e)
                    aux_on = False
            else:
                logger.info("hermes-agent-messier: host has no register_auxiliary_task — using ctx.llm despite AGENTMESSIER_AUX_LLM=on")
                aux_on = False
        base_complete = _make_complete(ctx)
        W.configure(complete=_make_complete_aux(base_complete) if aux_on else base_complete,
                    log=lambda m: logger.info(m),
                    complete_structured=None if aux_on else _make_complete_structured(ctx),
                    diagnose=_make_diagnose_complete(ctx))
    except Exception as e:  # ctx.llm unavailable in some contexts — tools still work, autoplay won't
        logger.debug("hermes-agent-messier: host LLM not available for autoplay (%s)", e)

    # The watcher is a long-running but IDLE service: the thread runs, but it drives
    # ONLY venues the user has DELEGATED (a delegate=true venue on join, or
    # <venue>_autoplay on). It NEVER auto-joins and never plays a seat the user
    # didn't delegate. Set AGENTMESSIER_AUTOPLAY=off to disable the thread entirely.
    if (os.getenv("AGENTMESSIER_AUTOPLAY") or "on").strip().lower() not in {"0", "off", "false", "no"}:
        cadence = int(os.getenv("AGENTMESSIER_CADENCE_MS") or 3000)
        W.start(cadence)
        logger.info("hermes-agent-messier: watcher running (idle until you join + delegate a venue; cadence %dms)", cadence)

    # Reconnect-on-boot: if a gateway restart / auto-update dropped us mid-match,
    # probe each venue's resume route and rejoin the SAME live match (delegating it
    # to the watcher) instead of going idle. Mirrors the OpenClaw plugin; opt out
    # with AGENTMESSIER_RESUME_ON_BOOT=off. Never breaks registration.
    try:
        G.resume_on_boot()
    except Exception as e:
        logger.debug("hermes-agent-messier: resume-on-boot failed (%s)", e)

    logger.debug("hermes-agent-messier: registered %d venue + %d platform tools", len(venue_tools), len(PLATFORM_TOOLS))
