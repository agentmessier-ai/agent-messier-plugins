/**
 * Soccer team-observation watcher — background SSE loop that feeds the agent.
 *
 * Subscribes to GET /matches/:id/agents/:agentId/observe, which streams a
 * TeamView (the agent's whole side) every tick (10 Hz). We never block the
 * match: the reader keeps only the LATEST view; a single in-flight delivery
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
};

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

export function prompt(v: TeamView & { summary?: string }, mode: "easy" | "advanced" | "both", strategyFile?: string, spec?: GameSpec | null): string {
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
      `Decide and act now: make ONE call to your play tool with a move for every player you control. ` +
      `Each is a standing order until you change it.`
    );
  }
  // Fallback (pre-envelope server or handshake not yet arrived): the legacy
  // plugin-side rendering.
  return (
    stratBlock +
    `${describeTeam(v, mode)}\n\n` +
    `Decide and act now: make ONE soccer_play call with a move for every player you control. ` +
    `Each is a standing order until you change it.`
  );
}

export async function startObserveWatcher(
  cfg: WatcherCfg,
  deliver: (msg: string) => void | Promise<void>,
  options: WatcherOptions = {},
): Promise<void> {
  const { signal, logger } = options;
  const base = (cfg.serverUrl ?? "http://localhost:3010").replace(/\/$/, "");
  const url = `${base}/matches/${encodeURIComponent(cfg.matchId)}/agents/${encodeURIComponent(cfg.agentId)}/observe`;

  let latest: TeamView | null = null;
  let latestSeq = 0;
  let deliveredSeq = -1;
  let busy = false;

  // The match's spec snapshot (instructions frozen per game). Normally arrives
  // as the SSE `event: spec` handshake; the guard below lazily fetches it when
  // a frame shows up first (handshake lost / pre-envelope server) — at most one
  // in-flight attempt, re-tried on later frames until it lands. A null spec
  // only degrades the prompt to the legacy rendering; it never blocks play.
  let spec: GameSpec | null = null;
  let specFetching = false;
  function ensureSpec() {
    if (spec !== null || specFetching) return;
    specFetching = true;
    fetchMatchSpec({ serverUrl: cfg.serverUrl } as PluginCfg, cfg.matchId)
      .then((s) => { if (s) { spec = s; logger?.info(`[agentnet-soccer] spec recovered via API (rulesVersion ${s.rulesVersion})`); } })
      .finally(() => { specFetching = false; });
  }

  function maybeDeliver() {
    if (busy || signal?.aborted || latest === null || latestSeq === deliveredSeq) return;
    // Match over → stop prompting. No message to the gateway = no LLM call.
    if (latest.phase === "ended") { deliveredSeq = latestSeq; return; }
    busy = true;
    const seq = latestSeq;
    const obs = latest;
    Promise.resolve(deliver(prompt(obs, cfg.mode ?? "easy", cfg.strategyFile, spec)))
      .catch((e) => logger?.error(`[agentnet-soccer] deliver failed: ${String(e)}`))
      .finally(() => { deliveredSeq = seq; busy = false; maybeDeliver(); });
  }

  let attempt = 0;
  while (true) {
    if (signal?.aborted) return;
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal });
      if (res.status === 404 && options.onReclaim) {
        // Server forgot us (restart) — re-claim our players, then reconnect.
        try { await options.onReclaim(); } catch (e) { logger?.warn(`[agentnet-soccer] re-claim failed: ${String(e)}`); }
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
