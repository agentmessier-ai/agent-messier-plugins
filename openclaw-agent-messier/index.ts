import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createSoccerTools, pitchClient, agentIdOf, type PluginCfg } from "./src/tools.js";
import { startObserveWatcher } from "./src/watcher.js";
import { session } from "./src/state.js";

export default function register(api: OpenClawPluginApi) {
  // 1. Tools: matchmaking (find/create/join — how a human gets their agent into
  //    a game by chatting) + play tools (tier chosen by config.mode).
  for (const tool of createSoccerTools(api)) {
    api.registerTool(tool as AnyAgentTool);
  }

  const cfg = (api.pluginConfig ?? {}) as PluginCfg;
  const sessionKey =
    cfg.sessionKey ??
    ((api.config.hooks as Record<string, unknown> | undefined)?.defaultSessionKey as string | undefined);

  let controller: AbortController | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;

  api.registerService({
    id: "agentnet-soccer-watcher",

    start: async (ctx) => {
      const agentId = agentIdOf(cfg);
      const client = pitchClient(cfg);

      // Join a room (taking a WHOLE side) and (re)start the observation loop.
      // Installed into shared state so the matchmaking tools can invoke it.
      session.joinAndWatch = async (matchId, team) => {
        const seat = await client.join(matchId, agentId, team);
        session.matchId = matchId;
        session.players = seat.playerIds;
        ctx.logger.info(`[agentnet-soccer] ${agentId} joined ${matchId} as ${seat.team} (${seat.playerIds.length} players)${seat.started ? " — match live" : " — waiting for opponent"}`);

        controller?.abort(); // leaving a previous room
        controller = new AbortController();
        let move = 0;
        // Fire-and-forget: the watcher runs until aborted or the gateway stops.
        void startObserveWatcher(
          { serverUrl: cfg.serverUrl, matchId, agentId, mode: cfg.mode, strategyFile: cfg.strategyFile },
          async (msg) => {
            if (!sessionKey) {
              ctx.logger.warn("[agentnet-soccer] no sessionKey configured; cannot deliver move prompts.");
              return;
            }
            // Fresh session per move: each prompt is a complete snapshot, so the
            // agent needs no history — keeps context from overflowing.
            const turn = move++;
            const idempotencyKey = `agentnet-soccer:${matchId}:${agentId}:${turn}`;
            const { runId } = await api.runtime.subagent.run({
              sessionKey: `${sessionKey}:${turn}`,
              message: msg,
              deliver: false,
              idempotencyKey,
            });
            await api.runtime.subagent.waitForRun({ runId, timeoutMs: 300_000 });
          },
          {
            signal: controller.signal,
            logger: ctx.logger,
            onReclaim: async () => {
              // Server restarted and forgot us — retake our seat in the room,
              // or (room gone entirely) quick-match into a fresh one.
              try {
                const again = await client.join(matchId, agentId, team);
                session.players = again.playerIds;
                ctx.logger.info(`[agentnet-soccer] re-joined ${matchId} as ${again.team} after server restart`);
              } catch (e) {
                if (!cfg.autoJoin) throw e;
                const q = await client.quickMatch(agentId, team ? { team } : {});
                ctx.logger.info(`[agentnet-soccer] room ${matchId} gone — quick-matched into ${q.matchId}`);
                if (q.matchId !== matchId) void session.joinAndWatch!(q.matchId, team);
              }
            },
          },
        );
        return seat;
      };

      // Startup seating: a pinned matchId joins that room; autoJoin quick-matches
      // (find-or-create, atomic server-side); otherwise idle until the human
      // asks the agent to find/create a game.
      try {
        if (cfg.matchId) await session.joinAndWatch(cfg.matchId, cfg.team);
        else if (cfg.autoJoin) {
          const q = await client.quickMatch(agentId, cfg.team ? { team: cfg.team } : {});
          await session.joinAndWatch(q.matchId, cfg.team);
        } else {
          ctx.logger.info("[agentnet-soccer] idle — ask me to join or create a game.");
        }
      } catch (e) { ctx.logger.error(`[agentnet-soccer] startup seating failed: ${String(e)}`); }

      // Seat poller: a human may seat this agent from a CHAT process (which has
      // no watcher). Watch the lobby for a seat held by our agentId and aim the
      // playing loop at it whenever it differs from what we're watching.
      const base = (cfg.serverUrl ?? "http://localhost:3010").replace(/\/$/, "");
      poller = setInterval(async () => {
        try {
          const res = await fetch(`${base}/matches`);
          if (!res.ok) return;
          const { matches } = (await res.json()) as { matches: { id: string; status: string; sides: { home: string | null; away: string | null } }[] };
          const seat = matches.find(r => r.status !== "ended" && (r.sides.home === agentId || r.sides.away === agentId));
          if (seat && seat.id !== session.matchId) {
            ctx.logger.info(`[agentnet-soccer] found my seat in ${seat.id} (taken via chat) — starting to play`);
            await session.joinAndWatch!(seat.id);
          }
        } catch { /* server down — the watcher's own backoff handles it */ }
      }, 10_000);
    },

    stop: async (ctx) => {
      ctx.logger.info("[agentnet-soccer] watcher stopping");
      if (poller) { clearInterval(poller); poller = null; }
      controller?.abort();
      controller = null;
      session.joinAndWatch = null;
      session.matchId = null;
    },
  });
}
