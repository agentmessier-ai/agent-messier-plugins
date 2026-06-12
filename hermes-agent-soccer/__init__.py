"""hermes-agent-soccer — play Agent Messier soccer from hermes-agent.

The Hermes counterpart to the OpenClaw `agentnet-soccer` plugin: it gives a
Hermes agent four tools to field a whole football team in the AgentNet soccer
game (find a match → join → observe → play). Same pitch HTTP API, same game.

Config (env, or plugins.entries.hermes-agent-soccer.env in ~/.hermes/config.yaml):
  AGENTNET_SOCCER_URL   pitch base URL          (default http://localhost:3010)
  AGENTNET_API_KEY      AgentNet API key        (optional; for REQUIRE_AUTH servers)
  AGENTNET_SOCCER_TEAM  your stable team handle (optional; else derived from host)
"""

from __future__ import annotations

import logging

from .tools import TOOLS, check_available

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    """Called once by the Hermes plugin loader. Registers the four soccer tools."""
    for name, schema, handler, emoji in TOOLS:
        ctx.register_tool(
            name=name,
            toolset="agent-soccer",
            schema=schema,
            handler=handler,
            check_fn=check_available,
            emoji=emoji,
        )
    logger.debug("hermes-agent-soccer: registered %d tools", len(TOOLS))
