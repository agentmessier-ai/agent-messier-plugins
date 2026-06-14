/**
 * Option A decision-extraction — the server-driven decision core, ported from
 * the tested prototype `services/soccer-driver/src/driver.ts` and adapted to run
 * IN-PROCESS inside the customer's OpenClaw gateway.
 *
 * The m171 bug was relying on the agent to PROACTIVELY call the act tool: a
 * model-dependent, unreliable behaviour that yielded 2 decisions in 157s. The
 * fix (docs/design/agent-bridge-plugin.md §2) is request/response: per situation
 * we FORCE one agent turn and PARSE its JSON reply — N situations → N decisions,
 * regardless of tool-call discipline.
 *
 *   subagent.run({deliver:false}) → waitForRun → getSessionMessages
 *        → lastAssistantText → parseMoves → POST /action per player
 *
 * Tool-vs-JSON-reply decision: the OpenClaw subagent API (SubagentRunParams) has
 * NO knob to remove a tool from the run's scope, so the soccer act tool
 * (soccer_play) is still in scope during an autoplay turn. We therefore (a) steer
 * the prompt hard to "reply with ONLY the moves JSON, do NOT call any tool"
 * (STRICT_JSON_DIRECTIVE), and (b) make the act path idempotent at the cycle
 * level: if the model calls soccer_play anyway, that tool already POSTs actions
 * and stamps session.lastActAt — so runAutoplayTurn detects that the team was
 * acted (lastActAt advanced during the turn) and SKIPS the direct POST rather
 * than double-applying. Only when the model replied with text (no tool call) do
 * we parse that text and POST ourselves. Either way the cycle results in exactly
 * one set of moves.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { apiKeyOf, type PluginCfg } from "./tools.js";
import { session } from "./state.js";

export type Vec2 = { x: number; y: number };

export type Move = {
  playerId: string;
  type: string;
  dir?: Vec2;
  power?: number;
  /** Zone is now a NAME (e.g. "att-left"); an integer is accepted for back-compat
   *  and forwarded as-is (the server normalizes name→id). */
  zone?: string | number;
  say?: string;
};

/** Action vocabulary — mirrors services/pitch/src/schemas.ts `actionTypes`.
 *  Kept local so the plugin carries no cross-package dependency. */
export const ACTION_TYPES = [
  "run", "kick", "idle", "chase", "shoot", "dribble",
  "pass", "defend", "press", "cover", "push", "stop",
] as const;

export class DecideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecideError";
  }
}

/** Appended to the autoplay move prompt so the agent replies with ONLY the moves
 *  JSON instead of (or in addition to) calling the act tool. The strictness is
 *  what keeps parseMoves reliable, and "do not call any tool" is what makes the
 *  forced-turn-then-parse loop work regardless of the model's tool discipline. */
export const STRICT_JSON_DIRECTIVE =
  `\n\nDo NOT call any tool. Reply with ONLY a JSON object — no prose, no markdown ` +
  `fences — in exactly this shape, one entry per player you control:\n` +
  `{"moves":[{"playerId":"<id>","type":"<action>","dir":{"x":1,"y":0},"power":0.8,"zone":"att-left","say":"optional"}]}\n` +
  `Valid action types: ${ACTION_TYPES.join(", ")}. ` +
  `"run"/"kick" need dir {x,y}; "kick" also needs power 0..1; "push" needs a zone NAME; ` +
  `"press"/"cover" may add a zone NAME. Use the zone names from the board. ` +
  `Omit fields an action does not need. Return the moves JSON now.`;

// ── tolerant JSON extraction (ported from driver.ts) ─────────────────────────

/** First balanced {…} or […] block, skipping string contents. */
function firstBalanced(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse JSON out of an LLM reply: whole body → ```json fence → first balanced
 *  block. Returns null if nothing parses. */
function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const cand = firstBalanced(t);
  if (cand) {
    try {
      return JSON.parse(cand);
    } catch {
      /* fall through */
    }
  }
  return null;
}

function coerceDir(d: unknown): Vec2 | undefined {
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const { x, y } = d as Record<string, unknown>;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }
  if (Array.isArray(d) && d.length === 2 && d.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { x: d[0] as number, y: d[1] as number };
  }
  return undefined;
}

/**
 * Extract validated moves from a reply. Tolerant of `{"moves":[…]}` or a bare
 * `[…]`, and of `action`/`id`/`player` aliases. Invalid entries are dropped;
 * throws DecideError when nothing usable is found (the caller treats that as
 * "responded without acting").
 */
export function parseMoves(text: string): Move[] {
  const obj = extractJson(text);
  if (obj == null) throw new DecideError("no JSON found in reply");
  const arr = Array.isArray(obj)
    ? obj
    : Array.isArray((obj as { moves?: unknown }).moves)
      ? ((obj as { moves: unknown[] }).moves)
      : null;
  if (!arr) throw new DecideError("reply JSON has no moves array");

  const valid = new Set<string>(ACTION_TYPES);
  const moves: Move[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const playerId =
      typeof r.playerId === "string" ? r.playerId
        : typeof r.id === "string" ? r.id
          : typeof r.player === "string" ? r.player
            : undefined;
    const type = typeof r.type === "string" ? r.type : typeof r.action === "string" ? r.action : undefined;
    if (!playerId || !type || !valid.has(type)) continue;
    const move: Move = { playerId, type };
    const dir = coerceDir(r.dir);
    if (dir) move.dir = dir;
    if (typeof r.power === "number" && Number.isFinite(r.power)) move.power = r.power;
    // Zones are now NAMES (e.g. "att-left"); accept a non-empty string and pass
    // it through verbatim (the server is the authority — no client-side name
    // validation). Still accept an integer for back-compat. Anything else drops.
    if (typeof r.zone === "string" && r.zone.trim() !== "") move.zone = r.zone;
    else if (Number.isInteger(r.zone)) move.zone = r.zone as number;
    if (typeof r.say === "string") move.say = r.say;
    moves.push(move);
  }
  if (moves.length === 0) throw new DecideError("no valid moves parsed from reply");
  return moves;
}

// ── read the agent's reply from the transcript ───────────────────────────────

/** One content block in an assistant message (string content, or an array of
 *  {type:"text", text} blocks per the OpenClaw transcript shape). */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
          return (b as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** The text of the LAST assistant message in a getSessionMessages transcript.
 *  A fresh per-turn session yields one user + one assistant record, so this is
 *  trivially that assistant reply. Returns "" when there is no assistant text. */
export function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && typeof m === "object" && (m as { role?: unknown }).role === "assistant") {
      return blockText((m as { content?: unknown }).content);
    }
  }
  return "";
}

// ── execute: POST one action per move to the pitch ───────────────────────────

export type ExecuteDeps = {
  /** Pitch base URL (cfg.serverUrl), e.g. http://localhost:3010. */
  base: string;
  cfg: PluginCfg;
  /** Caller DID / agentId (session.did ?? agentId). */
  did: string;
  /** Seat token (session.token), sent as x-agent-token. */
  token?: string | null | undefined;
  /** Reported as x-agent-decision-ms — the prompt→reply latency (ms). */
  decisionMs?: number;
  /** Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
};

/**
 * POST one `/action` per move, carrying the decision-observability headers the
 * pitch reads (x-agent-model from session.lastModel, x-agent-decision-ms =
 * prompt→reply latency). Mirrors generate.ts's vfetch act path so capture sees
 * the same shape. Stamps session.lastActAt on the first successful POST so the
 * watcher's act-verification sees "we posted moves this cycle".
 */
export async function executeMoves(
  matchId: string,
  moves: Move[],
  deps: ExecuteDeps,
): Promise<{ posted: number; results: { playerId: string; status: number }[] }> {
  const f = deps.fetch ?? fetch;
  const base = deps.base.replace(/\/$/, "");
  const results: { playerId: string; status: number }[] = [];
  for (const m of moves) {
    const body: Record<string, unknown> = { agentId: deps.did, type: m.type };
    if (m.dir) body.dir = m.dir;
    if (m.power !== undefined) body.power = m.power;
    if (m.zone !== undefined) body.zone = m.zone;
    if (m.say !== undefined) body.say = m.say;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-caller-did": deps.did,
      "x-agent-runtime": "openclaw-plugin/autoplay",
    };
    if (deps.token) headers["x-agent-token"] = deps.token;
    if (session.lastModel) headers["x-agent-model"] = session.lastModel;
    if (deps.decisionMs !== undefined) headers["x-agent-decision-ms"] = String(Math.max(0, Math.round(deps.decisionMs)));
    const key = apiKeyOf(deps.cfg);
    if (key) headers.Authorization = `Bearer ${key}`;
    const url = `${base}/matches/${encodeURIComponent(matchId)}/players/${encodeURIComponent(m.playerId)}/action`;
    const res = await f(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.ok) session.lastActAt = Date.now(); // act-verification: the team was moved this cycle
    results.push({ playerId: m.playerId, status: res.status });
  }
  return { posted: results.length, results };
}

// ── the full autoplay turn: run → wait → read → parse → post ─────────────────

export type AutoplayTurnDeps = {
  runtime: PluginRuntime;
  sessionKey: string;
  idempotencyKey: string;
  /** The strict-JSON move prompt (the per-tick board) to deliver to the agent. */
  message: string;
  /** The static game rulebook (spec.instructions.system), delivered on the run's
   *  SYSTEM channel rather than concatenated into the per-tick board. */
  extraSystemPrompt?: string;
  /** Backstop ceiling for waitForRun (the watcher watchdog is the latch backstop). */
  timeoutMs: number;
  matchId: string;
  cfg: PluginCfg;
  did: string;
  token?: string | null;
  base: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
};

export type AutoplayTurnResult =
  | { acted: true; via: "post"; posted: number }
  | { acted: true; via: "tool" }                 // the model called soccer_play itself
  | { acted: false; reason: string };            // responded without acting (parse miss / empty reply)

/**
 * Force exactly one agent turn for a delivered situation and act on its reply.
 * Returns whether the team was acted this cycle (post or tool) or not (the
 * watcher logs/counts a no-act turn and keeps standing orders — never freezes).
 */
export async function runAutoplayTurn(deps: AutoplayTurnDeps): Promise<AutoplayTurnResult> {
  const { runtime } = deps;
  // act-verification baseline: if soccer_play runs during this turn it advances
  // session.lastActAt past this — our cue to NOT double-post.
  const actAtBefore = session.lastActAt;
  const startedAt = Date.now();

  const { runId } = await runtime.subagent.run({
    sessionKey: deps.sessionKey,
    message: deps.message,
    ...(deps.extraSystemPrompt ? { extraSystemPrompt: deps.extraSystemPrompt } : {}),
    deliver: false,
    idempotencyKey: deps.idempotencyKey,
  });
  await runtime.subagent.waitForRun({ runId, timeoutMs: deps.timeoutMs });
  const decisionMs = Math.max(0, Date.now() - startedAt);

  // The model called the act tool itself (it POSTed + stamped lastActAt). Treat
  // the cycle as acted; do NOT parse+post again (would double-apply).
  if (session.lastActAt !== actAtBefore) {
    return { acted: true, via: "tool" };
  }

  let text = "";
  try {
    const { messages } = await runtime.subagent.getSessionMessages({ sessionKey: deps.sessionKey, limit: 10 });
    text = lastAssistantText(messages);
  } catch (e) {
    deps.logger?.warn(`getSessionMessages failed: ${String(e)}`);
  } finally {
    // Fresh session per turn → drop it so transcripts don't accumulate. Cleanup
    // failure is non-fatal (the run already happened).
    runtime.subagent.deleteSession({ sessionKey: deps.sessionKey }).catch(() => {});
  }

  let moves: Move[];
  try {
    moves = parseMoves(text);
  } catch (e) {
    return { acted: false, reason: e instanceof DecideError ? e.message : String(e) };
  }

  const { posted } = await executeMoves(deps.matchId, moves, {
    base: deps.base,
    cfg: deps.cfg,
    did: deps.did,
    token: deps.token,
    decisionMs,
  });
  return { acted: true, via: "post", posted };
}
