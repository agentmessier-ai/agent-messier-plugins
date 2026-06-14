/**
 * Autoplay observation watcher — a background SSE loop that feeds the agent.
 *
 * Venue-agnostic at runtime: the observe endpoint comes from spec.routes, the
 * move prompt is the server's spec.instructions + rendered summary, and the act
 * tool it names comes from spec.client.act.tool (passed as cfg.actTool). The
 * soccer specifics that remain are only the frame TYPE (TeamView) and the
 * describeTeam fallback renderer used when a server sends no instructions.
 *
 * Subscribes to the observe route, which streams a view (the agent's whole side
 * in soccer) every tick. We never block the match: the reader keeps only the
 * LATEST view; a single in-flight delivery
 * feeds the agent the freshest state one decision at a time. While the agent is
 * thinking, new frames just update `latest`; when it finishes it gets the
 * newest state. Once the match ends, delivery stops (no prompt = no LLM call).
 *
 * SSE loop + exponential-backoff reconnect, signal-abortable.
 */
import { statSync, readFileSync } from "node:fs";
import { describeTeam, type TeamView } from "./format.js";
import { fetchMatchSpec, type GameSpec, type PluginCfg } from "./tools.js";
import { session } from "./state.js";

export type WatcherCfg = {
  serverUrl?: string;
  matchId: string;
  /** Stable agent id whose claimed players this watcher drives. */
  agentId: string;
  /** Tool tier — tailors the move prompt to the agent's tools. Default "easy". */
  mode?: "easy" | "advanced" | "both";
  /** Human-editable strategy.md injected into the move prompt (Phase 5). */
  strategyFile?: string;
  /** The venue's act tool (spec.client.act.tool) named in the move prompt.
   *  Default "soccer_play" so a pre-VA-5 caller is unchanged. */
  actTool?: string;
  /** Log tag for this venue's watcher (e.g. "agent-soccer"). Default "agentnet". */
  label?: string;
  /** Watchdog: max ms a single delivery may hold the in-flight latch. If a
   *  deliver (subagent run) hangs or runs longer than this, the watcher releases
   *  the latch, warns, and delivers the freshest frame — so a slow/stuck decision
   *  can't silence the team for the full subagent timeout. Default 45000. */
  deliverTimeoutMs?: number;
};

/** Default per-delivery watchdog (ms). Matches index.ts's waitForRun timeout so
 *  the latch is released right around when the run would time out anyway. */
export const DEFAULT_DELIVER_TIMEOUT_MS = 45_000;

// ── human-editable strategy (Phase 5) ────────────────────────────────────────
// A markdown file the manager edits; injected into the move prompt. mtime-cached
// (no re-read per tick), refreshed on edit, capped so it can't blow the prompt.
const STRATEGY_CAP = 1000;
const _strategyCache = new Map<string, { mtimeMs: number; text: string }>();

/** Test seam: drop the mtime cache. */
export function _clearStrategyCache(): void { _strategyCache.clear(); }

/** The manager's standing instructions, mtime-cached + capped. '' when the file
 *  is unset/absent/unreadable, so no block is injected. */
export function strategyText(file?: string): string {
  if (!file) return "";
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; }
  catch { _strategyCache.delete(file); return ""; }
  const cached = _strategyCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;
  let text: string;
  try { text = readFileSync(file, "utf8").trim().slice(0, STRATEGY_CAP); }
  catch { return ""; }
  _strategyCache.set(file, { mtimeMs, text });
  return text;
}

export type WatcherLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type WatcherOptions = {
  signal?: AbortSignal;
  logger?: WatcherLogger;
  /** Called when the server no longer knows our claim (404 — e.g. it restarted).
   *  Should re-claim players; the watcher then reconnects. */
  onReclaim?: () => Promise<void>;
};

/** One SSE block → {event?, data?}. Named events carry the per-match spec
 *  handshake; plain data blocks are observation frames. Pure, unit-tested. */
export function parseSseBlock(block: string): { event?: string; data?: string } {
  let event: string | undefined;
  let data: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) {
      const payload = line.slice(6).trim();
      if (payload) data = payload;
    }
  }
  return event !== undefined ? { event, ...(data !== undefined ? { data } : {}) } : (data !== undefined ? { data } : {});
}

export function prompt(v: TeamView & { summary?: string }, mode: "easy" | "advanced" | "both", strategyFile?: string, spec?: GameSpec | null, actTool = "soccer_play"): string {
  const standing = strategyText(strategyFile);
  const stratBlock = standing ? `## Your manager's standing instructions\n${standing}\n\n` : "";
  const ins = spec?.instructions;
  if (ins && ins.system && ins.play && v.summary) {
    // Generic GSP path: the server authored the instructions AND rendered the
    // situation — the plugin only concatenates. Tool-calling host, so the
    // direct-JSON `output` contract is replaced by a generic tool-act line
    // (host concern, not game knowledge).
    return (
      `${ins.system}\n\n` +
      stratBlock +
      `${v.summary}\n\n` +
      `${ins.play}\n\n` +
      `Decide and act NOW: make ONE ${actTool} call with a move for every player you control — ` +
      `every time you are prompted, even if the plan is unchanged. The order holds until you change it, ` +
      `so if you go quiet your team freezes on stale orders. Never reply without acting.`
    );
  }
  // Fallback (pre-envelope server or handshake not yet arrived). describeTeam is
  // the soccer-specific renderer — only valid for a TeamView; for any other
  // venue with no server instructions, dump the raw view rather than crash.
  const rendered = Array.isArray(v.mine) ? describeTeam(v, mode) : JSON.stringify(v);
  return (
    stratBlock +
    `${rendered}\n\n` +
    `Decide and act NOW: make ONE ${actTool} call with a move for every player you control — ` +
    `every time you are prompted, even if the plan is unchanged. The order holds until you change it, ` +
    `so if you go quiet your team freezes on stale orders. Never reply without acting.`
  );
}

/** The observe path for a venue, from spec.routes ({matchId}/{did} substituted),
 *  with the soccer-literal fallback when no spec is reachable — so the watcher
 *  is endpoint-agnostic (a golf venue would drive the same loop) but never
 *  breaks offline. Returns the path (no host); caller prepends the base. */
export function observeUrl(spec: GameSpec | null, matchId: string, did: string): string {
  const tpl = spec?.routes?.["observe"] ?? "/matches/{matchId}/agents/{did}/observe";
  return tpl.replace("{matchId}", encodeURIComponent(matchId)).replace("{did}", encodeURIComponent(did));
}

export async function startObserveWatcher(
  cfg: WatcherCfg,
  deliver: (msg: string) => void | Promise<void>,
  options: WatcherOptions = {},
): Promise<void> {
  const { signal, logger } = options;
  const base = (cfg.serverUrl ?? "http://localhost:3010").replace(/\/$/, "");
  const tag = cfg.label ?? "agentnet";       // venue-derived log prefix
  const actTool = cfg.actTool ?? "soccer_play";

  // Fetch the spec up front so the observe endpoint comes from spec.routes
  // (venue-agnostic) rather than a literal /matches path — falls back to the
  // soccer-literal route when no spec is reachable. Also seeds the prompt's
  // instructions; the SSE `event: spec` handshake still refreshes it.
  let spec: GameSpec | null = await fetchMatchSpec({ serverUrl: cfg.serverUrl } as PluginCfg, cfg.matchId);
  const url = base + observeUrl(spec, cfg.matchId, cfg.agentId);

  let latest: TeamView | null = null;
  let latestSeq = 0;
  let deliveredSeq = -1;
  let busy = false;

  // If the up-front fetch failed, the guard below lazily retries when a frame
  // shows up (handshake lost / pre-envelope server) — at most one in-flight
  // attempt. A null spec only degrades the prompt; it never blocks play.
  let specFetching = false;
  function ensureSpec() {
    if (spec !== null || specFetching) return;
    specFetching = true;
    fetchMatchSpec({ serverUrl: cfg.serverUrl } as PluginCfg, cfg.matchId)
      .then((s) => { if (s) { spec = s; logger?.info(`[${tag}] spec recovered via API (rulesVersion ${s.rulesVersion})`); } })
      .finally(() => { specFetching = false; });
  }

  const deliverTimeoutMs = cfg.deliverTimeoutMs ?? DEFAULT_DELIVER_TIMEOUT_MS;

  function maybeDeliver() {
    if (busy || signal?.aborted || latest === null || latestSeq === deliveredSeq) return;
    // Match over → stop prompting. No message to the gateway = no LLM call.
    if (latest.phase === "ended") { deliveredSeq = latestSeq; return; }
    busy = true;
    const seq = latestSeq;
    const obs = latest;
    // Act-verification baseline: if the act tool doesn't stamp lastActAt past
    // this during the run, the agent was prompted but never moved its team.
    const actAtBefore = session.lastActAt;

    // The watchdog and the deliver race for the latch. Whichever fires FIRST
    // owns the release; `settled` makes the loser a no-op, so a slow deliver that
    // resolves AFTER the watchdog can't double-release or re-deliver the same
    // seq. Without this, a hung deliver (subagent run) would hold `busy` for the
    // whole subagent timeout and silence the team on stale standing orders.
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const release = (onTimeout: boolean) => {
      if (settled) return;
      settled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      deliveredSeq = seq;
      busy = false;
      if (onTimeout) {
        logger?.warn(`[${tag}] deliver exceeded ${deliverTimeoutMs}ms — releasing latch, agent may be stalled`);
      } else if (session.lastActAt === actAtBefore) {
        // The run finished but no action was POSTed — surfaced, never gated.
        session.noActTurns++;
        logger?.warn(`[${tag}] agent responded without acting (turn ${seq})`);
      }
      maybeDeliver();
    };

    watchdog = setTimeout(() => release(true), deliverTimeoutMs);
    signal?.addEventListener("abort", () => { if (watchdog !== undefined) clearTimeout(watchdog); }, { once: true });

    Promise.resolve(deliver(prompt(obs, cfg.mode ?? "easy", cfg.strategyFile, spec, actTool)))
      .catch((e) => logger?.error(`[${tag}] deliver failed: ${String(e)}`))
      .finally(() => release(false));
  }

  let attempt = 0;
  while (true) {
    if (signal?.aborted) return;
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal });
      if (res.status === 404 && options.onReclaim) {
        // Server forgot us (restart) — re-claim our players, then reconnect.
        try { await options.onReclaim(); } catch (e) { logger?.warn(`[${tag}] re-claim failed: ${String(e)}`); }
        await backoff(attempt++, signal);
        continue;
      }
      if (!res.ok || !res.body) { await backoff(attempt++, signal); continue; }
      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (signal?.aborted) { reader.cancel().catch(() => {}); return; }
        let done: boolean, value: Uint8Array | undefined;
        try { ({ done, value } = await reader.read()); } catch { break; }
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const { event, data } = parseSseBlock(block);
          if (!data) continue;
          if (event === "spec") {
            // The per-game handshake: this match's frozen instructions.
            try {
              const s = JSON.parse(data) as GameSpec;
              if (s && Array.isArray(s.actions?.enum)) spec = s;
            } catch { /* malformed handshake → the ensureSpec guard recovers */ }
            continue;
          }
          let v: TeamView;
          try { v = JSON.parse(data) as TeamView; } catch { continue; }
          if (!v || !Array.isArray(v.mine)) continue; // skip non-team frames
          ensureSpec(); // protection: frame before handshake → fetch via API
          // The team stream is authoritative for which players we control, so
          // a live ratio change on the server is followed without reconnecting.
          session.players = v.mine.map((p) => p.id);
          latest = v;
          latestSeq++;
          maybeDeliver();
        }
      }
    } catch {
      if (signal?.aborted) return;
    }
    await backoff(attempt++, signal);
  }
}

async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  const delay = base + base * 0.2 * Math.random();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, delay);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
