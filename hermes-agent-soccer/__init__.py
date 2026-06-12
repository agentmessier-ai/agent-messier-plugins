"""hermes-agent-soccer — the HERMES CONNECTOR for the Agent Messier soccer plugin.

This file is the only host-specific part (see
docs/design/agent-soccer-plugin-contract.md): it wires Hermes's plugin API to the
agent-agnostic core (client.py / tools.py / decide.py / watcher.py). The core is a
port of the same design as the OpenClaw (TypeScript) plugin — two languages, one
contract.

The connector does three things (§2 of the contract):
  1. register the core tools with Hermes (ctx.register_tool),
  2. provide the core a `complete(messages) -> text` via the host LLM (ctx.llm),
  3. host the watcher in the background (a daemon thread; tools.soccer_autoplay
     starts/stops it).

Config (env, or plugins.entries.hermes-agent-soccer.env in ~/.hermes/config.yaml):
  AGENTNET_SOCCER_URL       pitch base URL          (default http://localhost:3010)
  AGENTNET_API_KEY          AgentNet API key        (optional; REQUIRE_AUTH servers)
  AGENTNET_SOCCER_TEAM      your stable team handle (optional; else derived from host)
  AGENTNET_SOCCER_AUTOPLAY  "1"/"on" to auto-start hands-free play (default OFF —
                            a CLI user shouldn't burn model tokens unprompted)
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
    from .tools import TOOLS, check_available
    from . import watcher as W

    for name, schema, handler, emoji in TOOLS:
        ctx.register_tool(
            name=name,
            toolset="agent-soccer",
            schema=schema,
            handler=handler,
            check_fn=check_available,
            emoji=emoji,
        )

    # Wire the host LLM + logger into the agnostic watcher core.
    try:
        W.configure(complete=_make_complete(ctx), log=lambda m: logger.info(m))
    except Exception as e:  # ctx.llm unavailable in some contexts — tools still work, autoplay won't
        logger.debug("hermes-agent-soccer: host LLM not available for autoplay (%s)", e)

    # Opt-in hands-free play at startup (default OFF).
    if (os.getenv("AGENTNET_SOCCER_AUTOPLAY") or "").strip().lower() in {"1", "on", "true", "yes"}:
        cadence = int(os.getenv("AGENTNET_SOCCER_CADENCE_MS") or 3000)
        W.start(cadence)
        logger.info("hermes-agent-soccer: autoplay armed (cadence %dms)", cadence)

    logger.debug("hermes-agent-soccer: registered %d tools", len(TOOLS))
