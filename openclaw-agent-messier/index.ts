import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { memberTools, venuesTool, agentIdOf, identityOf, venueUrl, type PluginCfg } from "./src/tools.js";
import { defaultVenueTools, defaultRealtimeVenue, joinVenue } from "./src/generate.js";
import { startObserveWatcher } from "./src/watcher.js";
import { session } from "./src/state.js";
import { runAutoplayTurn, postDecisionReport, STRICT_JSON_DIRECTIVE } from "./src/decide.js";

/** A lobby row is "ours" if it references our agentId anywhere (soccer puts it in
 *  sides.home/away; a generic venue may shape it differently). Deep, shape-blind. */
function referencesAgent(value: unknown, agentId: string): boolean {
  if (value === agentId) return true;
  if (Array.isArray(value)) return value.some((v) => referencesAgent(v, agentId));
  if (value && typeof value === "object") return Object.values(value).some((v) => referencesAgent(v, agentId));
  return false;
}
const ENDED = new Set(["ended", "finished", "completed", "done", "cancelled", "canceled"]);

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginCfg;

  // 1. Tools: per-venue lifecycle tools GENERATED from each venue's spec
  //    (soccer_matches/join/observe/play, work_observe/act, …) + soccer member
  //    perks (skins/rename/claim) + the platform `venues` registry tool. A new
  //    venue appears here from its spec with zero plugin code.
  for (const tool of [...defaultVenueTools(cfg), ...memberTools(cfg), venuesTool(cfg)]) {
    api.registerTool(tool as AnyAgentTool);
  }

  // Capture the EFFECTIVE model of each decision from the gateway's llm_output
  // hook (the provider/model of the call that just ran). vfetch sends it as
  // x-agent-model, so the pitch records the model actually PLAYING — reflecting
  // a mid-match /model switch, not a static configured default.
  api.registerHook("llm_output", ((event: { provider?: string; model?: string }) => {
    if (event?.model) session.lastModel = event.provider ? `${event.provider}/${event.model}` : event.model;
  }) as Parameters<typeof api.registerHook>[1]);

  // 2. Autoplay watcher. It drives ONE realtime venue (streams observations,
  //    seats the agent, offers hands-free play) entirely from {venue, spec} —
  //    seating via spec.client.join, observe/act endpoints via spec.routes, the
  //    move prompt naming spec.client.act.tool. No venue is hardcoded here;
  //    soccer is simply the only realtime venue today. Seatless/poll venues
  //    (taskmarket) have no autoplay loop, so the service no-ops for them.
  const realtime = defaultRealtimeVenue();
  if (!realtime) return;
  const { venue, spec } = realtime;
  const label = venue.id;
  const actTool = spec.client!.act.tool;
  const lobbyRoute = spec.client?.lobby?.route;
  const roomIdField = spec.client?.join?.seat.id ?? "id";
  const base = venueUrl(venue.origin, cfg);

  const sessionKey =
    cfg.sessionKey ??
    ((api.config.hooks as Record<string, unknown> | undefined)?.defaultSessionKey as string | undefined);

  let controller: AbortController | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  // The per-match session key currently in play. We persist ONE session per match
  // (so the agent accumulates its own decision history); on LEAVING a match we
  // delete it so a new match starts fresh and stale transcripts don't pile up.
  let activeSessionKey: string | null = null;

  api.registerService({
    id: `agentnet-${venue.id}-watcher`,

    start: async (ctx) => {
      const agentId = agentIdOf(cfg);
      // Config-derived join body. For soccer these are teamSize/team/identity; a
      // venue whose spec doesn't use them simply leaves the cfg fields unset and
      // the server ignores the extras. joinVenue itself stays venue-agnostic.
      const joinExtra = (): Record<string, unknown> => ({ teamSize: cfg.teamSize, team: cfg.team, identity: identityOf(cfg) });

      // Seat into a room (matchId omitted = quickmatch find-or-create) and
      // (re)start the observation loop. Installed into shared state so the
      // generated *_join tool / chat handoff can drive it.
      session.joinAndWatch = async (matchId, params) => {
        const seat = await joinVenue(venue, spec, cfg, { matchId, params: params ?? {}, extra: joinExtra() });
        ctx.logger.info(`[${label}] ${agentId} seated in ${seat.id} (${seat.controls?.length ?? 0} to control)${seat.started ? " — live" : " — waiting for opponent"}`);

        controller?.abort(); // leaving a previous room
        controller = new AbortController();
        // Leaving the previous match → drop its persistent session so the new
        // match starts with fresh context (and stale transcripts don't pile up).
        if (sessionKey && activeSessionKey && activeSessionKey !== `${sessionKey}:${seat.id}`) {
          api.runtime.subagent.deleteSession({ sessionKey: activeSessionKey }).catch(() => {});
        }
        // ONE persistent session for THIS match, stable across all its turns.
        activeSessionKey = sessionKey ? `${sessionKey}:${seat.id}` : null;
        let move = 0;
        // Fire-and-forget: the watcher runs until aborted or the gateway stops.
        void startObserveWatcher(
          { serverUrl: cfg.serverUrl, matchId: seat.id!, agentId, mode: cfg.mode, strategyFile: cfg.strategyFile, actTool, label },
          async ({ system, user, tick, clock }) => {
            if (!sessionKey) {
              ctx.logger.warn(`[${label}] no sessionKey configured; cannot deliver move prompts.`);
              return;
            }
            // Option A (docs/design/agent-bridge-plugin.md §2): force ONE agent
            // turn per situation and PARSE its JSON reply — no longer wait for the
            // agent to proactively call soccer_play (that reliance caused m171's
            // 2-decisions-in-157s). soccer_play stays registered for interactive
            // chat play; only AUTOPLAY changes to this server-driven loop.
            //
            // ONE persistent session per MATCH (sessionKey:matchId, stable across
            // turns) so the agent accumulates context — its own prior decisions —
            // and the session transcript is the full per-match request log. `turn`
            // is kept only for the idempotency key and the context-growth cap.
            const turn = move++;
            const matchSessionKey = `${sessionKey}:${seat.id}`;
            const idempotencyKey = `agentnet:${venue.id}:${seat.id}:${agentId}:${turn}`;
            const did = session.did ?? agentId;
            const sys = system || undefined;
            const msg = `${user}${STRICT_JSON_DIRECTIVE}`;
            // Mark when this prompt was handed to the agent: x-agent-decision-ms is
            // the prompt→reply latency measured inside runAutoplayTurn.
            session.promptDeliveredAt = Date.now();
            const result = await runAutoplayTurn({
              runtime: api.runtime,
              sessionKey: matchSessionKey,
              turn,
              idempotencyKey,
              // The static rulebook (spec.instructions.system) rides the SYSTEM
              // channel; the per-tick board is the user message. '' on the
              // fallback path → no extra system prompt.
              extraSystemPrompt: sys,
              // Steer the agent to reply with ONLY the moves JSON (no tool call).
              message: msg,
              // 45s ceiling, matching the watcher's per-delivery watchdog backstop:
              // a run that hasn't produced a decision by then is treated as stalled
              // (was 300s, which let one hung run silence the team for 5 min — m171).
              timeoutMs: 45_000,
              matchId: seat.id!,
              cfg,
              did,
              token: session.token,
              base,
              logger: ctx.logger,
            });
            // Report EVERY decision to the pitch — acted AND no-response — so the
            // decision inspector sees no-response turns too. Best-effort, off the
            // hot path, never throws.
            void postDecisionReport(
              {
                tick,
                clock,
                prompt: { ...(sys ? { system: sys } : {}), user: msg },
                outcome: result.outcome,
                ...(result.reason ? { reason: result.reason } : {}),
                ...(result.moves ? { moves: result.moves } : {}),
                rawText: result.rawText,
                latencyMs: result.latencyMs,
                ...(session.lastModel ? { model: session.lastModel } : {}),
              },
              { base, matchId: seat.id!, agentId: did, token: session.token, logger: ctx.logger },
            );
            // act-verification by the natural signal: did we parse+post (or did the
            // model act via the tool)? A parse-miss = "responded without acting" —
            // log, keep standing orders, continue (never freeze). The watcher's own
            // lastActAt check stays correct because executeMoves/soccer_play stamp it.
            if (!result.acted) {
              ctx.logger.warn(`[${label}] agent responded without acting (turn ${turn}): ${result.reason}`);
            }
          },
          {
            signal: controller.signal,
            logger: ctx.logger,
            onReclaim: async () => {
              // Server restarted and forgot us — re-seat into the same room via
              // seatRoute, or (room gone) quickmatch into a fresh one.
              try {
                const again = await joinVenue(venue, spec, cfg, { matchId: seat.id, extra: joinExtra() });
                ctx.logger.info(`[${label}] re-seated in ${again.id} after server restart`);
              } catch (e) {
                if (!cfg.autoJoin) throw e;
                const q = await joinVenue(venue, spec, cfg, { extra: joinExtra() });
                ctx.logger.info(`[${label}] room ${seat.id} gone — re-quickmatched into ${q.id}`);
                if (q.id !== seat.id) void session.joinAndWatch!(undefined);
              }
            },
          },
        );
        return seat;
      };

      // Startup seating: a pinned matchId seats that room; autoJoin quick-matches
      // (find-or-create, atomic server-side); otherwise idle until asked.
      try {
        if (cfg.matchId) await session.joinAndWatch(cfg.matchId);
        else if (cfg.autoJoin) await session.joinAndWatch(undefined);
        else ctx.logger.info(`[${label}] idle — ask me to join or create a game.`);
      } catch (e) { ctx.logger.error(`[${label}] startup seating failed: ${String(e)}`); }

      // Seat poller: when the agent is IDLE, a seat may be taken from ANOTHER
      // process (a chat turn, the generated *_join tool, the dashboard). Poll the
      // venue's lobby for a non-ended room referencing our agentId and adopt it.
      // Driven by spec.client.lobby.route — no hardcoded /matches path. Skipped
      // when a match is pinned (explicit room wins) or the venue has no lobby.
      // Critically it only adopts while idle (session.matchId empty): once we're
      // in a match it must NOT yank us into some other (e.g. stale) room.
      if (lobbyRoute && !cfg.matchId) {
        poller = setInterval(async () => {
          if (session.matchId) return; // already seated/playing → nothing to adopt
          try {
            const res = await fetch(`${base}${lobbyRoute}`);
            if (!res.ok) return;
            const data = (await res.json()) as Record<string, any>;
            const rows = (data.matches ?? data.rows ?? []) as Record<string, any>[];
            const mine = rows.find((r) => !ENDED.has(String(r.status ?? "")) && referencesAgent(r, agentId));
            const id = mine?.id ?? mine?.[roomIdField];
            if (id) {
              ctx.logger.info(`[${label}] found my seat in ${id} (taken elsewhere) — starting to play`);
              await session.joinAndWatch!(id);
            }
          } catch { /* server down — the watcher's own backoff handles it */ }
        }, 10_000);
      }
    },

    stop: async (ctx) => {
      ctx.logger.info(`[${label}] watcher stopping`);
      if (poller) { clearInterval(poller); poller = null; }
      controller?.abort();
      controller = null;
      if (activeSessionKey) {
        api.runtime.subagent.deleteSession({ sessionKey: activeSessionKey }).catch(() => {});
        activeSessionKey = null;
      }
      session.joinAndWatch = null;
      session.matchId = null;
    },
  });
}
