/**
 * Autoplay watcher — a cadence-gated polling loop that drives one seat.
 *
 * Mirrors the Hermes plugin's `_loop`/`_play_seat` (extensions/hermes-agent-messier/
 * watcher.py): every `cadenceMs` we POLL the latest team state once (not an SSE
 * stream), guard it (404 → reclaim, ended/no-mine → skip), and hand the freshest
 * view to `play()` for exactly one decision. A fixed cadence floor keeps the
 * decision rate steady and bounded — independent of model latency — instead of
 * the old latency-driven SSE busy-latch (which produced sparse, irregular play).
 *
 * The decision itself (build prompt → complete → parse → act → self-report) is
 * the injected `play` callback (decide.playTurn), so this module stays a pure,
 * testable loop.
 */
import { fetchMatchSpec, type GameSpec, type PluginCfg } from "./tools.js";
import { authedFetch } from "./http.js";
import { session, type RuntimeSession } from "./state.js";
import type { TeamView } from "./contract.js";

/** Default seconds-scale cadence between decisions (ms). Mirrors Hermes' 3s. */
export const DEFAULT_CADENCE_MS = 3000;
/** Hard floor so a misconfig can't hammer the pitch/LLM. Mirrors Hermes' 500ms. */
export const MIN_CADENCE_MS = 500;

export type WatcherLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type CadenceCfg = {
  serverUrl?: string;
  /** The room this loop drives. */
  matchId: string;
  /** Fallback agentId for the state poll (state.did wins once seated). */
  agentId: string;
  /** Min ms between decisions; floored to MIN_CADENCE_MS. Default: spec
   *  observe.suggestedIntervalMs, else DEFAULT_CADENCE_MS. */
  cadenceMs?: number;
  /** Plugin config — threaded through to authedFetch so the state poll carries
   *  the SAME OAuth/API-key auth as join/act/report (previously the poll sent
   *  no auth at all). Optional so existing test call-sites keep compiling;
   *  omitting it just means the poll goes out unauthenticated, as before. */
  cfg?: PluginCfg;
  /** Venue id for log lines (default "agent-soccer" — the literal every log
   *  used to hardcode, which mislabeled golf's errors as soccer's and sent a
   *  live debugging session down the wrong venue entirely, 2026-07-12). */
  label?: string;
};

export type CadenceOptions = {
  signal?: AbortSignal;
  logger?: WatcherLogger;
  /** The VENUE's spec (from discovery) — authoritative for routes/instructions.
   *  Preferred over a per-match re-fetch, which is soccer-centric
   *  (/matches/{id}/spec → /spec) and would mis-resolve a non-/matches venue
   *  like golf, breaking its state route. */
  spec?: GameSpec | null;
  /** Per-venue runtime session (defaults to the global one). The loop reads
   *  state.did/token for auth and writes state.players from the polled view. */
  state?: RuntimeSession;
  /** Called when the server no longer knows our seat (404) — should re-claim;
   *  the loop then keeps polling. */
  onReclaim?: () => Promise<void>;
  /** Called once when the watched match reaches phase "ended". The loop then
   *  STOPS (a finished match never resumes). The handler decides what's next —
   *  quickmatch a fresh game (autoJoin) or go idle — so the agent keeps playing
   *  instead of polling a dead room forever (which also blocked the lobby
   *  seat-poller from adopting the pitch's next warmup match). */
  onEnded?: () => void | Promise<void>;
  /** One decision for the freshest view: decide → act → self-report. */
  play: (view: TeamView & { summary?: string }, spec: GameSpec | null) => void | Promise<void>;
  /** Called when a state poll throws (pitch unreachable / timeout) — drives the
   *  network branch of runtime self-diagnosis. Not 404 (that's onReclaim). */
  onNetworkError?: () => void | Promise<void>;
  /** Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
};

/** The state-poll path for a venue, from spec.routes ({matchId}/{did} substituted)
 *  with the soccer-literal fallback. Endpoint-agnostic; caller prepends the base.
 *  NOTE: this is the JSON state endpoint, NOT the SSE observe stream. */
export function stateUrl(spec: GameSpec | null, matchId: string, agentId: string): string {
  const tpl = spec?.routes?.["state"] ?? "/matches/{matchId}/agents/{did}/state";
  return tpl.replace("{matchId}", encodeURIComponent(matchId)).replace("{did}", encodeURIComponent(agentId));
}

/** Abortable sleep — resolves after `ms` or immediately when the signal fires. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** ±15% jitter on the cadence so several gateways sharing a pitch don't poll in
 *  lockstep (a synchronized thundering herd). Bounded to [0.85x, 1.15x]. */
export function jittered(ms: number): number {
  return ms * (0.85 + Math.random() * 0.3);
}

/** Watchdog cadence + stall threshold. The watchdog is a timer OUTSIDE the loop
 *  body, so it keeps firing even when the loop itself is frozen on an await —
 *  the one failure mode in-loop logging can never report on (every log call
 *  lives inside the loop, so a hang and a healthy quiet match used to produce
 *  identical output: none. Found live 2026-07-13; hours of e2e debugging came
 *  down to exactly this blind spot). Exported for the test's fake timers. */
export const WATCHDOG_INTERVAL_MS = 30_000;
export const WATCHDOG_STALL_MS = 60_000;

/** Reclaim-storm guard (found live 2026-07-14/17): a pitch/gateway restart
 *  could leave the loop 404ing every tick, and each onReclaim whose seatRoute
 *  ALSO 404s falls back to a fresh POST /quickmatch — which the gateway
 *  routes as `assign` and pre-allocates a match id for, burning one sequence
 *  id per tick (795 ids in 52 minutes on 2026-07-14; ledger-verified). The
 *  loop never converged because a "successful" reclaim was trusted blindly —
 *  only the NEXT poll proves recovery. So: consecutive 404s back off
 *  exponentially (cadence → ×2 → … capped) and give up entirely after
 *  MAX_CONSECUTIVE_RECLAIMS, going idle instead of hammering forever. Any
 *  non-404 poll result resets the streak. */
export const MAX_CONSECUTIVE_RECLAIMS = 5;
export const RECLAIM_BACKOFF_CAP_MS = 60_000;

/**
 * Run the cadence loop until aborted. Each tick: poll state → guard → play →
 * wait(cadence). A 404 triggers onReclaim; an ended/empty view is skipped (no
 * decision, no LLM call). The decision is `options.play`.
 */
export async function startCadenceWatcher(cfg: CadenceCfg, options: CadenceOptions): Promise<void> {
  const { signal, logger } = options;
  const label = cfg.label ?? "agent-soccer";
  const state = options.state ?? session;
  const base = (cfg.serverUrl ?? "https://www.agentmessier.com").replace(/\/$/, "");
  const debug = cfg.cfg?.debug === true;

  // The venue's spec (from discovery/baked) is authoritative for routes; prefer
  // it. Only fall back to a per-match re-fetch when no venue spec was supplied
  // (the soccer-centric ladder would mis-resolve a golf round).
  let spec: GameSpec | null = options.spec ?? await fetchMatchSpec({ serverUrl: cfg.serverUrl } as PluginCfg, cfg.matchId);
  const cadence = Math.max(MIN_CADENCE_MS, cfg.cadenceMs ?? spec?.observe?.suggestedIntervalMs ?? DEFAULT_CADENCE_MS);

  // Stage tracking + watchdog: `stage` is updated before every await in the
  // loop, and the watchdog interval fires INDEPENDENTLY of the loop — so when
  // the loop freezes on any of those awaits, the watchdog still runs and can
  // say exactly which stage it froze in and for how long. With debug on, it
  // also emits a periodic alive heartbeat while healthy.
  let tick = 0;
  let reclaimStreak = 0;
  let stage = "starting";
  let stageSince = Date.now();
  const setStage = (s: string) => { stage = s; stageSince = Date.now(); };
  const watchdog = setInterval(() => {
    const inStageMs = Date.now() - stageSince;
    // "wait" is exempt from the stall warning: cadenceMs has a floor but no
    // ceiling, so a long configured cadence makes a long wait legitimate.
    if (inStageMs > WATCHDOG_STALL_MS && stage !== "wait") {
      logger?.warn(`[${label}] loop STALLED — stuck in "${stage}" for ${Math.round(inStageMs / 1000)}s (tick ${tick}, match ${cfg.matchId})`);
    } else if (debug) {
      logger?.info(`[${label}] alive — tick ${tick}, stage "${stage}" (${Math.round(inStageMs / 1000)}s)`);
    }
  }, WATCHDOG_INTERVAL_MS);
  // Don't let the watchdog keep the host process alive on its own (plugin
  // runs inside the long-lived gateway; this only matters for tests/edge).
  (watchdog as { unref?: () => void }).unref?.();
  signal?.addEventListener("abort", () => clearInterval(watchdog), { once: true });

  try {
  while (true) {
    if (signal?.aborted) return;
    tick++;
    setStage("spec-fetch");
    if (spec === null) {
      spec = await fetchMatchSpec({ serverUrl: cfg.serverUrl } as PluginCfg, cfg.matchId).catch(() => null);
    }
    // …but a BAKED spec carries no `instructions` (register() is sync, can't
    // fetch), so the move prompt would be stuck on the thin FALLBACK — leading
    // the model to give zone-less, samey orders that pile the team together.
    // Hermes always reads the server's per-match instructions; do the same
    // here: enrich from the live /spec when missing (keep the baked routes).
    // Retried EVERY tick while missing (Hermes watcher.py parity: "a None
    // result is NOT cached, so the next tick retries — degraded, never
    // permanently") rather than once at watcher start, so a cold-start network
    // hiccup self-heals the moment the pitch becomes reachable, not never.
    if (spec && !spec.instructions) {
      const live = await fetchMatchSpec({ serverUrl: cfg.serverUrl } as PluginCfg, cfg.matchId).catch(() => null);
      if (live?.instructions) spec = { ...spec, instructions: live.instructions };
    }

    let view: (TeamView & { summary?: string }) | null = null;
    setStage("state-poll");
    try {
      const agentId = state.did ?? cfg.agentId;
      // Authed poll (previously this went out with NO auth headers at all —
      // a persistent 401/403 would silently loop forever, indistinguishable
      // from an idle-but-healthy match). cfg.cfg carries the plugin config;
      // omitted in a caller that hasn't threaded it through yet → unauthenticated,
      // same as before.
      const r = await authedFetch(base, stateUrl(spec, cfg.matchId, agentId), {
        cfg: cfg.cfg ?? {}, did: agentId, token: state.token, state,
        ...(signal ? { signal } : {}),
        ...(options.fetch ? { fetchImpl: options.fetch } : {}),
      });
      if (r.status === 404) {
        // Server forgot us (restart) or the room is gone — re-claim, then poll
        // again. A reclaim only counts as recovered when a LATER poll returns
        // non-404 (the streak reset below) — a 2xx from the reclaim call itself
        // proved nothing on 2026-07-14 (see MAX_CONSECUTIVE_RECLAIMS).
        reclaimStreak++;
        if (reclaimStreak > MAX_CONSECUTIVE_RECLAIMS) {
          logger?.warn(`[${label}] ${MAX_CONSECUTIVE_RECLAIMS} consecutive reclaims never restored the seat in ${cfg.matchId} — giving up (idle; rejoin to play again)`);
          if (options.onEnded) { try { await options.onEnded(); } catch { /* idle handoff must never throw */ } }
          return;
        }
        if (options.onReclaim) {
          try { await options.onReclaim(); } catch (e) { logger?.warn(`[${label}] re-claim failed: ${String(e)}`); }
        }
        const backoff = Math.min(cadence * 2 ** (reclaimStreak - 1), RECLAIM_BACKOFF_CAP_MS);
        await wait(jittered(backoff), signal);
        continue;
      }
      reclaimStreak = 0; // any non-404 answer = the server knows this room again
      if (!r.ok) {
        // Any other non-2xx (401/403/5xx) — surface it. Previously this left
        // `view` null with no log and no failure counting, so a persistent
        // auth/server error looked identical to a quiet, healthy match — the
        // exact silent-failure class onNetworkError exists to catch.
        logger?.warn(`[${label}] state poll returned ${r.status}: ${JSON.stringify(r.data)}`);
        if (options.onNetworkError) { try { await options.onNetworkError(); } catch { /* diagnosis must never break the loop */ } }
      } else {
        view = r.data as TeamView & { summary?: string };
      }
    } catch (e) {
      if (signal?.aborted) return;
      logger?.warn(`[${label}] state poll failed: ${String(e)}`);
      if (options.onNetworkError) { try { await options.onNetworkError(); } catch { /* diagnosis must never break the loop */ } }
    }

    if (view?.phase === "ended") {
      // A finished match never resumes — stop this loop and hand off. onEnded
      // decides what's next (idle by default; NOT a re-seat/quickmatch even
      // with autoJoin — one match per boot is the intended behavior) so the
      // agent doesn't keep polling a dead room forever (which also blocks the
      // lobby seat-poller from adopting the pitch's next warmup match).
      logger?.info(`[${label}] match ${cfg.matchId} ended — releasing seat`);
      if (options.onEnded) {
        try { await options.onEnded(); } catch (e) { logger?.warn(`[${label}] onEnded failed: ${String(e)}`); }
      }
      return;
    }

    if (view && Array.isArray(view.mine)) {
      // The view is authoritative for which players we control.
      state.players = view.mine.map((p) => p.id);
      setStage("play");
      if (debug) logger?.info(`[${label}] tick ${tick}: playing (phase=${String(view.phase ?? "?")}, mine=${view.mine.length})`);
      const playStarted = Date.now();
      try {
        await options.play(view, spec);
        if (debug) logger?.info(`[${label}] tick ${tick}: play done in ${Date.now() - playStarted}ms`);
      } catch (e) {
        logger?.error(`[${label}] play failed: ${String(e)}`);
      }
    } else if (debug) {
      logger?.info(`[${label}] tick ${tick}: no playable view (skipped)`);
    }

    setStage("wait");
    await wait(jittered(cadence), signal);
  }
  } finally {
    clearInterval(watchdog);
  }
}
