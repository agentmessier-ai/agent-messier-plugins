import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { venuesTool, agentmessierClaimTool, agentIdOf, identityOf, venueUrl, type PluginCfg, type GameSpec } from "./src/tools.js";
import { defaultVenueTools, defaultRealtimeVenues, joinVenue, resumeVenue, setVenueState, type Venue } from "./src/generate.js";
import { startCadenceWatcher } from "./src/watcher.js";
import { session, createSession, type RuntimeSession } from "./src/state.js";
import { playTurn, playTurnViaSubagent, type LlmComplete } from "./src/decide.js";
import { preflight } from "./src/selfcheck.js";
import { oauthTools } from "./src/oauth.js";

// Bare default-export entry — supported on ALL openclaw versions. (definePluginEntry
// + openclaw/plugin-sdk/plugin-entry are 2026.6.x-only and break the deployed
// 2026.3.13 with "Cannot find module .../plugin-entry"; this form loads on both.)
export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginCfg;

  // Capture the effective model from the gateway's llm_output hook — the model
  // source for the subagent-FALLBACK path (older openclaw without runtime.llm).
  // Robust across versions: provider/model, else the resolved "provider/model" ref.
  // This is OPTIONAL (newer openclaw reads the model from runtime.llm.complete), so
  // it must never abort register(): 2026.6.x requires opts.name and throws "hook
  // registration missing name" otherwise — which would kill the whole plugin
  // (tools + autoplay service) when loaded as a startup sidecar. Pass the name and
  // guard so an incompatible hook API degrades gracefully instead of breaking play.
  try {
    const onLlmOutput = (event: { provider?: string; model?: string; resolvedRef?: string }) => {
      if (event?.model) session.lastModel = event.provider ? `${event.provider}/${event.model}` : event.model;
      else if (event?.resolvedRef) session.lastModel = event.resolvedRef;
    };
    (api.registerHook as (e: string, h: unknown, o?: unknown) => void)("llm_output", onLlmOutput, { name: "agentmessier-llm-output" });
  } catch (e) {
    (api.runtime as { logger?: { warn?: (m: string) => void } })?.logger?.warn?.(`[agentmessier] llm_output hook not registered (${String(e)}); model comes from runtime.llm`);
  }

  // Direct completion when the runtime exposes it (openclaw >= 2026.6.x); null
  // otherwise → the venue service uses the subagent fallback (playTurnViaSubagent)
  // so the plugin plays on older openclaw (e.g. 2026.3.13) too.
  const llm = (api.runtime as { llm?: { complete: LlmComplete } }).llm;
  const complete: LlmComplete | null = llm && typeof llm.complete === "function" ? (p) => llm.complete(p) : null;

  // The agent's configured default model — fallback for x-agent-model + report.model
  // when the llm_output hook doesn't capture one (older openclaw / subagent path).
  const fallbackModel = (api.config as { agents?: { defaults?: { model?: { primary?: string } } } })?.agents?.defaults?.model?.primary;

  // Tools + autoplay watchers both depend on the venue spec (loaded async from the
  // live /spec endpoint with a disk-cache fallback). All spec-dependent registration
  // happens inside the loader service's start() so it can await the fetch.
  // Platform tools (venues, claim, oauth) need no spec — registered synchronously.
  for (const tool of [venuesTool(cfg), agentmessierClaimTool(cfg), ...oauthTools(cfg)]) {
    api.registerTool(tool as AnyAgentTool);
  }

  api.registerService({
    id: "agentmessier-loader",

    start: async (ctx) => {
      // 1. Venue lifecycle tools (soccer_join/observe/play, work_observe/act, …):
      //    fetch each venue's /spec live, write to disk cache, generate tools from
      //    the live spec. On network failure the disk cache is the fallback. If
      //    neither is available (first run + offline) no venue tools are loaded —
      //    the agent should connect to the pitch once to populate the cache.
      const venueTools = await defaultVenueTools(cfg);
      if (venueTools.length === 0) {
        ctx.logger.warn("[agentmessier] spec unavailable — venue tools not loaded; connect to the pitch once to cache the spec");
      } else {
        for (const tool of venueTools) api.registerTool(tool as AnyAgentTool);
        ctx.logger.info(`[agentmessier] loaded ${venueTools.length} venue tools from live spec`);
      }

      // 2. Autoplay watchers — ONE cadence-gated polling loop per realtime venue,
      //    each with its OWN runtime state so multiple games never clobber each other.
      //    Seating via spec.client.join; the loop polls the state route and decides
      //    via the direct completion. No venue is hardcoded; soccer is just the only
      //    realtime venue today. The FIRST realtime venue reuses the global session so
      //    the interactive/cosmetic tools (which read it) stay in sync; the rest get a
      //    fresh isolated state.
      const realtime = await defaultRealtimeVenues(cfg);
      realtime.forEach(({ venue, spec }, i) => {
        const state = i === 0 ? session : createSession();
        setVenueState(venue.id, state); // the generated act tool stamps THIS instance
        registerVenueService(api, cfg, venue, spec, state, complete, fallbackModel);
      });
    },

    stop: async () => { /* venue services stop themselves */ },
  });
}

/** Register the cadence autoplay service for one realtime venue. Seating is driven
 *  from {venue, spec}; each tick polls the state route and decides via `complete`. */
function registerVenueService(
  api: OpenClawPluginApi,
  cfg: PluginCfg,
  venue: Venue,
  spec: GameSpec,
  state: RuntimeSession,
  complete: LlmComplete | null,
  fallbackModel: string | undefined,
) {
  const label = venue.id;
  const base = venueUrl(venue.origin, cfg);

  let controller: AbortController | null = null;

  api.registerService({
    id: `agentmessier-${venue.id}-watcher`,

    start: async (ctx) => {
      const agentId = agentIdOf(cfg);
      // Config-derived join body: a generic identity object plus any venue join
      // params (cfg.join — teamSize/team for soccer, holes for golf, …). A venue
      // whose spec doesn't use a field simply leaves it unset; the server ignores
      // extras. joinVenue itself stays venue-agnostic.
      const joinExtra = (): Record<string, unknown> => ({ ...(cfg.join ?? {}), identity: identityOf(cfg) });

      // ── play-readiness self-diagnosis (server / venue / seat / primary model) ──
      // Keep-retry: we never pause, we FLAG. Consecutive-failure counters flip
      // health ONCE on crossing the threshold (running the real preflight so the
      // diagnosis names the root cause — e.g. a broken model) and clear on the
      // next acted decision. The degraded snapshot lives on `state` so the decision
      // report pushes it (→ inspector banner) and the *_selfcheck tool returns it.
      const FAIL_THRESHOLD = 3;
      let consecEmpty = 0, consecNet = 0, degraded = false;
      const runSelfcheck = () => preflight({ base, cfg, spec, state, agentId, complete, ...(fallbackModel ? { fallbackModel } : {}) });
      const noteFailure = async (kind: "empty" | "net") => {
        if (kind === "empty") consecEmpty++; else consecNet++;
        if (!degraded && (consecEmpty >= FAIL_THRESHOLD || consecNet >= FAIL_THRESHOLD)) {
          degraded = true;
          try { state.diagnosis = await runSelfcheck(); } catch { /* diagnosis must never break play */ }
          ctx.logger.warn(`[${label}] ⚠ DEGRADED — ${state.diagnosis?.reason ?? kind} (autoplay keeps retrying)`);
        }
      };
      const noteSuccess = () => {
        consecEmpty = 0; consecNet = 0;
        if (degraded) {
          degraded = false;
          state.diagnosis = { state: "ok", reason: null, primaryModel: state.diagnosis?.primaryModel ?? null, checkedAt: new Date().toISOString(), checks: [] };
          ctx.logger.info(`[${label}] ✓ recovered — playing normally`);
        }
      };
      // Expose an on-demand full preflight (has `complete` in scope) for the
      // generated <venue>_selfcheck tool.
      state.selfcheck = async () => { state.diagnosis = await runSelfcheck(); return state.diagnosis; };

      // Start the cadence loop for the CURRENT seat (state.matchId, set by joinVenue).
      // The watcher NEVER joins — the user joins first (via <venue>_join), then the
      // venue delegates (delegate=true) or the user runs <venue>_autoplay on, both of
      // which call this. Returns false if not seated.
      state.startWatcher = (cadenceMs?: number): boolean => {
        if (!state.matchId) return false;
        const matchId = state.matchId;
        controller?.abort(); // replace any prior loop
        controller = new AbortController();
        const sig = controller.signal;
        const effectiveCadence = cadenceMs ?? cfg.cadenceMs;
        void startCadenceWatcher(
          { serverUrl: cfg.serverUrl, matchId, agentId, cfg, ...(effectiveCadence !== undefined ? { cadenceMs: effectiveCadence } : {}) },
          {
            signal: sig,
            logger: ctx.logger,
            spec, // the venue's spec — authoritative routes, no soccer-centric re-fetch
            state,
            onNetworkError: () => noteFailure("net"),
            play: (view, viewSpec) => {
              const common = {
                view, spec: viewSpec, cfg, base, matchId,
                agentId: state.did ?? agentId, // SAME identity as /action → report lands
                token: state.token, state,
                ...(cfg.mode ? { mode: cfg.mode } : {}),
                ...(cfg.strategyFile ? { strategyFile: cfg.strategyFile } : {}),
                ...(fallbackModel ? { fallbackModel } : {}),
                signal: sig,
                logger: ctx.logger,
              };
              const turn = complete
                ? playTurn({ complete, ...common })
                : playTurnViaSubagent({ runtime: api.runtime, sessionKey: `${cfg.sessionKey ?? agentId}:${matchId}`, ...common });
              // Runtime self-diagnosis: a no_response (esp. empty reply) is the
              // silent-failure signal; an acted decision is recovery.
              return turn.then((r) => { if (r) { if (r.outcome === "no_response") void noteFailure("empty"); else noteSuccess(); } });
            },
            onReclaim: async () => {
              // Server restart forgot our seat — reclaim the SAME room only. NO
              // quickmatch into a new game (no auto-join): if it's gone, go idle.
              try {
                const again = await joinVenue(venue, spec, cfg, { matchId, extra: joinExtra() });
                ctx.logger.info(`[${label}] reclaimed seat in ${again.id} after server restart`);
              } catch {
                ctx.logger.info(`[${label}] room ${matchId} gone — idle (rejoin to play again)`);
                state.stopWatcher?.();
              }
            },
            onEnded: () => {
              // Match finished → idle. No re-seat / quickmatch; the user decides to rejoin.
              ctx.logger.info(`[${label}] match ${matchId} ended — idle (rejoin to play again)`);
              state.matchId = null; state.watching = false;
              controller?.abort(); controller = null;
            },
          },
        );
        state.watching = true;
        ctx.logger.info(`[${label}] watcher playing ${matchId}`);
        return true;
      };
      state.stopWatcher = () => { controller?.abort(); controller = null; state.watching = false; };

      // Reconnect-on-boot (resume-on-boot): a gateway restart / auto-update mid-match
      // dropped our in-memory seat. BEFORE the normal seat logic, probe the venue's
      // resume route — if the server still has us seated in a LIVE match, hydrate
      // state (matchId/token/players/did, via resumeVenue) and resume the SAME match
      // (the existing startWatcher path, identical to onReclaim) instead of going
      // idle or quickmatching into a NEW game. Resume is default-on; cfg.resumeOnBoot
      // === false opts out (e.g. for a host that wants the old idle-on-boot behavior).
      // If not seated (or the probe fails), fall through to today's exact behavior.
      let resumed = false;
      if (cfg.resumeOnBoot !== false) {
        try {
          const seat = await resumeVenue(venue, spec, cfg);
          if (seat?.id) {
            resumed = state.startWatcher(); // hydrated by resumeVenue → resumes the SAME match
            if (resumed) ctx.logger.info(`[${label}] resumed live match ${seat.id} after gateway restart`);
          }
        } catch (e) { ctx.logger.warn(`[${label}] resume-on-boot probe failed: ${String(e)} — continuing to normal seat logic`); }
      }

      // Default: zero-touch quickmatch at startup (cfg.autoJoin default ON, same
      // convention as cfg.resumeOnBoot above) — seat + play immediately, no user
      // action needed. cfg.matchId pins a specific room instead of quickmatch.
      // Set cfg.autoJoin: false for the legacy idle-on-boot behavior (wait for
      // <venue>_join). (Skipped when we just resumed an existing seat above.)
      try {
        if (resumed) { /* already seated + watching the resumed match — skip seat logic */ }
        else if (cfg.matchId) { await joinVenue(venue, spec, cfg, { matchId: cfg.matchId, extra: joinExtra() }); state.startWatcher(); }
        else if (cfg.autoJoin !== false) { await joinVenue(venue, spec, cfg, { extra: joinExtra() }); state.startWatcher(); }
        else ctx.logger.info(`[${label}] idle — ${spec.client?.join?.tool ?? "join"} a match to play${spec.client?.autoplay ? ` (then ${spec.client.autoplay.tool} on if not auto-delegated)` : ""}.`);
      } catch (e) { ctx.logger.error(`[${label}] startup seating failed: ${String(e)}`); }

      // Preflight the dependencies up front (server, venue, seat, PRIMARY MODEL).
      // Keep-retry: we've already armed; this surfaces readiness so a broken model
      // / unreachable pitch is visible immediately, not after a silent loss.
      try {
        state.diagnosis = await runSelfcheck();
        if (state.diagnosis.state === "degraded") ctx.logger.warn(`[${label}] ⚠ preflight DEGRADED — ${state.diagnosis.reason} (autoplay armed; will keep retrying)`);
        else ctx.logger.info(`[${label}] preflight ok — primary model ${state.diagnosis.primaryModel ?? "unverified"}`);
      } catch (e) { ctx.logger.warn(`[${label}] preflight error: ${String(e)}`); }
      // NOTE: no lobby seat-poller — the agent never adopts a seat it didn't join.
    },

    stop: async (ctx) => {
      ctx.logger.info(`[${label}] watcher stopping`);
      controller?.abort();
      controller = null;
      state.startWatcher = null;
      state.stopWatcher = null;
      state.watching = false;
      state.matchId = null;
    },
  });
}
