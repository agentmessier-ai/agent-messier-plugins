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
import { describeTeam, type TeamView } from "./format.js";
import { session } from "./state.js";

export type WatcherCfg = {
  serverUrl?: string;
  matchId: string;
  /** Stable agent id whose claimed players this watcher drives. */
  agentId: string;
  /** Tool tier — tailors the move prompt to the agent's tools. Default "easy". */
  mode?: "easy" | "advanced" | "both";
};

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

function prompt(v: TeamView, mode: "easy" | "advanced" | "both"): string {
  return (
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

  function maybeDeliver() {
    if (busy || signal?.aborted || latest === null || latestSeq === deliveredSeq) return;
    // Match over → stop prompting. No message to the gateway = no LLM call.
    if (latest.phase === "ended") { deliveredSeq = latestSeq; return; }
    busy = true;
    const seq = latestSeq;
    const obs = latest;
    Promise.resolve(deliver(prompt(obs, cfg.mode ?? "easy")))
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
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;
            let v: TeamView;
            try { v = JSON.parse(payload) as TeamView; } catch { continue; }
            if (!v || !Array.isArray(v.mine)) continue; // skip non-team frames
            // The team stream is authoritative for which players we control, so
            // a live ratio change on the server is followed without reconnecting.
            session.players = v.mine.map((p) => p.id);
            latest = v;
            latestSeq++;
            maybeDeliver();
          }
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
