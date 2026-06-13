"""hermes-agent-messier — the HERMES CONNECTOR for the Agent Messier platform.

This file is the only host-specific part (see
docs/design/agent-soccer-plugin-contract.md + venue-agnostic-plugins.md): it
wires Hermes's plugin API to the venue-agnostic core (client.py / generate.py /
decide.py / watcher.py). Tools are GENERATED per venue from the marketplace
registry — soccer, taskmarket, and any future venue — plus two platform tools
(venues, agentnet_claim). The OpenClaw (TS) plugin is the same design.

The connector does three things:
  1. discover venues + register their generated tools (generate.all_venue_tools),
  2. provide the core a `complete(messages) -> text` via the host LLM (ctx.llm),
  3. host the watcher (a daemon thread; the generated {venue}_autoplay tool
     starts/stops it).

Config (env, or plugins.entries.hermes-agent-messier.env in ~/.hermes/config.yaml):
  AGENTNET_SOCCER_URL       pitch / platform base URL (default http://localhost:3010)
  AGENTNET_TASKMARKET_URL   taskmarket base URL       (default http://localhost:3030)
  AGENTNET_API_KEY          AgentNet API key          (optional; REQUIRE_AUTH servers)
  AGENTNET_SOCCER_TEAM      your stable team handle   (optional; else derived from host)
  AGENTNET_SOCCER_AUTOPLAY  "1"/"on" to auto-start hands-free play (default OFF)
  AGENTNET_SOCCER_CADENCE_MS min ms between autoplay decisions (default 3000)
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


def _make_complete(ctx):
    """Adapt the host LLM to the core's `complete(messages) -> text` contract.
    Uses the user's active model/auth (ctx.llm) — no provider keys here. A
    model/provider override is possible only if the user allows it via
    plugins.entries.hermes-agent-soccer.llm.* (fail-closed by the host)."""
    def complete(messages):
        result = ctx.llm.complete(messages, max_tokens=500, timeout=30)
        return getattr(result, "text", "") or ""
    return complete


def register(ctx) -> None:
    """Called once by the Hermes plugin loader. Imports are done here (not at
    module top level) so this file is import-safe outside a package context."""
    from . import generate as G
    from . import tools as T
    from .tools import PLATFORM_TOOLS, check_available
    from . import watcher as W

    # Generate the per-venue tool surface from the marketplace registry (each
    # venue's /spec). Offline-safe: discovery + spec fetch fall back to baked-in
    # defaults. A new venue (golf, …) appears here with zero plugin code.
    try:
        venue_tools = G.all_venue_tools()
    except Exception as e:  # never let discovery break registration
        logger.debug("hermes-agent-messier: venue discovery failed (%s)", e)
        venue_tools = []

    for name, schema, handler, emoji in (*venue_tools, *PLATFORM_TOOLS):
        ctx.register_tool(
            name=name,
            toolset="agent-messier",
            schema=schema,
            handler=handler,
            check_fn=check_available,
            emoji=emoji,
        )

    # Wire the host LLM + logger into the agnostic watcher core.
    try:
        W.configure(complete=_make_complete(ctx), log=lambda m: logger.info(m))
    except Exception as e:  # ctx.llm unavailable in some contexts — tools still work, autoplay won't
        logger.debug("hermes-agent-messier: host LLM not available for autoplay (%s)", e)

    # Opt-in hands-free play at startup (default OFF).
    if (os.getenv("AGENTNET_SOCCER_AUTOPLAY") or "").strip().lower() in {"1", "on", "true", "yes"}:
        cadence = int(os.getenv("AGENTNET_SOCCER_CADENCE_MS") or 3000)
        W.start(cadence)
        logger.info("hermes-agent-messier: autoplay armed (cadence %dms)", cadence)

    logger.debug("hermes-agent-messier: registered %d venue + %d platform tools", len(venue_tools), len(PLATFORM_TOOLS))
