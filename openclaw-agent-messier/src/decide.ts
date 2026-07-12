/**
 * Decision core — cadence-paced, direct-completion, self-reporting.
 *
 * Mirrors the Hermes plugin's design (extensions/hermes-agent-messier/decide.py):
 * each tick we build a prompt (rulebook + strategy + recent-decisions history +
 * situation + JSON directive), make ONE direct LLM completion via the SDK's
 * `api.runtime.llm.complete` (not the heavy subagent/chat path), parse the JSON
 * moves, POST one /action per move, and SELF-REPORT the decision to the pitch.
 *
 *   buildMessages → complete → parseMoves → executeMoves(/action) → postDecisionReport(/decision)
 *
 * Why this shape: the prior subagent-driven loop produced sparse, tick-keyed
 * SERVER-INFERRED records because its self-reports never landed and its cadence
 * was latency-driven. Self-reporting with the SAME agentId+token used for
 * /action makes the report LAND (the pitch flips to self-reporting and stops
 * inferring), and the direct completion gives the effective provider/model
 * reliably — no llm_output hook needed.
 */
import { statSync, readFileSync } from "node:fs";
import { PLUGIN_VERSION, type PluginCfg, type GameSpec } from "./tools.js";
import { authedFetch } from "./http.js";
import { session, type RuntimeSession, type Diagnosis } from "./state.js";
import type { ReportBody, TeamView } from "./contract.js";

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
  /** Every OTHER key the model sent for this move (to/target/through/burst/
   *  name/players/shape/ttl/sticky, and any future action-specific field) —
   *  passed through to the server untouched, exactly like the Hermes plugin's
   *  `params = {k:v for k,v in move.items() if k not in _RESERVED}`. The
   *  server's action schema is the authority on what's valid; the plugin
   *  doesn't need its own copy of every action's field list to stay current. */
  params?: Record<string, unknown>;
};

/** Action vocabulary fallback — used ONLY when the fetched GameSpec carries no
 *  `actions.enum` (offline / pre-spec). The live path validates against
 *  `spec.actions.enum` instead (server-authoritative, mirrors the Hermes
 *  plugin's `_enum(spec)`), so this never goes stale for a connected agent —
 *  it's a last resort, not the source of truth. Kept in sync with
 *  services/pitch/src/schemas.ts `actionTypes` by hand for the offline case. */
export const ACTION_TYPES = [
  "run", "kick", "idle", "chase", "shoot", "dribble",
  "pass", "lob-pass", "long-ball", "defend", "press", "cover", "push",
  "mark", "strategy", "stop", "run-behind", "team-shape", "hold",
] as const;

/** Ball-relative action set named in the FALLBACK prompt — copied verbatim from
 *  the Hermes plugin's ACTIONS (extensions/hermes-agent-messier/decide.py). The
 *  engine resolves direction toward the ball/goal/zone, so the model never sends
 *  raw coordinates. (The server's own `/spec` instructions are used when present;
 *  this list only feeds the offline fallback below.) */
export const FALLBACK_ACTIONS = [
  "chase", "shoot", "dribble", "pass", "defend", "press", "cover", "idle",
] as const;

export class DecideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecideError";
  }
}

/**
 * Static fallback prompt — used ONLY when the server's `/spec` carries no
 * `instructions` envelope (pre-envelope / offline). Copied VERBATIM from the
 * Hermes plugin's FALLBACK_INSTRUCTIONS (extensions/hermes-agent-messier/
 * decide.py) so both clients play identically. The normal path uses the server's
 * own `instructions` (system/play/output) — the SAME text Hermes receives — so on
 * a live pitch the two plugins are prompt-identical. The output directive is the
 * Hermes map shape `{"moves":{"<id>":{"action":…}}}`, which parseMoves accepts. */
export const FALLBACK_INSTRUCTIONS = {
  system: "You are a decisive soccer tactician. Output only JSON. Be fast.",
  play:
    `Choose ONE action per player from: ${FALLBACK_ACTIONS.join(", ")}.\n` +
    `Guidance: the ball-carrier should dribble or shoot if near the +x goal, else pass; ` +
    `others chase/press if we don't have it, or make space (cover) if we do.\n` +
    `ACT EVERY TIME YOU ARE PROMPTED — re-issue a move for every player, even if the plan is ` +
    `unchanged. Orders hold until you change them, so if you go quiet your team freezes on stale ` +
    `orders. Never reply without moves.`,
  output:
    `Reply with ONLY a JSON object mapping each of your player ids to an action, ` +
    `optionally with a short shout. Example:\n` +
    `{"moves":{"home-9":{"action":"shoot","say":"GOAL!"},"home-10":{"action":"chase"}}}`,
} as const;

/** Operational guard prepended to the user message on the subagent-fallback path
 *  ONLY (old openclaw, where the venue's act tool is in scope): it steers the model
 *  to a JSON reply we parse + post, instead of calling soccer_play. Hermes has no
 *  such path so its prompt carries no equivalent; the direct llm.complete path has
 *  no tools in scope, so it isn't needed there either. */
export const NO_TOOL_DIRECTIVE =
  "Do NOT call any tool — reply with ONLY the moves JSON, no prose, no markdown fences.\n\n";

// ── tolerant JSON extraction ─────────────────────────────────────────────────

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

/** Reserved input keys the move-shape parsing itself consumes — everything else
 *  on the raw object rides through to `params` untouched (mirrors Hermes's
 *  `_RESERVED = {"action", "say"}`, extended for the extra id/type aliases and
 *  the named convenience fields this parser also pulls out explicitly). */
const RESERVED_MOVE_KEYS = new Set(["playerId", "id", "player", "type", "action", "dir", "power", "zone", "say"]);

/**
 * Extract validated moves from a reply. Accepts the Hermes/server MAP shape
 * `{"moves":{"<id>":{action,…}}}` (the id is the key) AND the array shape
 * `{"moves":[{playerId,type,…}]}` / a bare `[…]`, plus `action`/`id`/`player`
 * aliases. Invalid entries are dropped; throws DecideError when nothing usable is
 * found (the caller treats that as "responded without acting").
 *
 * `spec` (when available) supplies the live action vocabulary via
 * `spec.actions.enum` — the server-authoritative list, mirroring the Hermes
 * plugin's `_enum(spec)`. Falls back to the local `ACTION_TYPES` constant only
 * when no spec was fetched (offline / pre-spec).
 */
/** Cap on a move's `say` chatter text (hermes decide.py:236 parity) — keeps the
 *  pitch's chat bubble/log readable and bounds prompt-echo growth in history. */
const SAY_CAP = 60;

export function parseMoves(text: string, spec?: GameSpec | null, allowedPlayerIds?: string[]): Move[] {
  const obj = extractJson(text);
  if (obj == null) throw new DecideError("no JSON found in reply");
  const movesField = (obj as { moves?: unknown }).moves;
  let arr: unknown[];
  if (Array.isArray(obj)) arr = obj;
  else if (Array.isArray(movesField)) arr = movesField;
  else if (movesField && typeof movesField === "object") {
    // Map shape: fold each entry into a flat record so the loop below reads it like
    // the array shape (the key supplies the playerId). The value is either the move
    // object `{"action":…}` OR the bare-action shorthand `"chase"` (weak models emit
    // the latter on the free-text path — hermes dodges this via host-enforced JSON).
    arr = Object.entries(movesField as Record<string, unknown>).map(([playerId, v]) =>
      typeof v === "string" ? { playerId, type: v }
        : v && typeof v === "object" ? { playerId, ...(v as Record<string, unknown>) }
          : { playerId });
  } else throw new DecideError("reply JSON has no moves");

  const specEnum = spec?.actions?.enum;
  const valid = new Set<string>(Array.isArray(specEnum) && specEnum.length ? specEnum : ACTION_TYPES);
  const allowed = allowedPlayerIds && allowedPlayerIds.length ? new Set(allowedPlayerIds) : null;
  const moves: Move[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const playerId =
      typeof r.playerId === "string" ? r.playerId
        : typeof r.id === "string" ? r.id
          : typeof r.player === "string" ? r.player
            : undefined;
    // Case-insensitive action match (hermes decide.py:233 parity — a model
    // occasionally emits "Chase"/"CHASE"; the server's enum is lowercase, so a
    // strict-case check silently dropped an otherwise-valid move).
    const typeRaw = typeof r.type === "string" ? r.type : typeof r.action === "string" ? r.action : undefined;
    const type = typeRaw ? typeRaw.trim().toLowerCase() : undefined;
    if (!playerId || !type || !valid.has(type)) continue;
    // Scope to players this agent actually controls (hermes decide.py:229-232
    // parity) — an id outside view.mine would just 4xx server-side; drop it
    // here instead of wasting the POST.
    if (allowed && !allowed.has(playerId)) continue;
    const move: Move = { playerId, type };
    const dir = coerceDir(r.dir);
    if (dir) move.dir = dir;
    if (typeof r.power === "number" && Number.isFinite(r.power)) move.power = r.power;
    // Zones are now NAMES (e.g. "att-left"); accept a non-empty string and pass
    // it through verbatim (the server is the authority — no client-side name
    // validation). Still accept an integer for back-compat. Anything else drops.
    if (typeof r.zone === "string" && r.zone.trim() !== "") move.zone = r.zone;
    else if (Number.isInteger(r.zone)) move.zone = r.zone as number;
    if (typeof r.say === "string") move.say = r.say.slice(0, SAY_CAP);
    // Everything else the model sent rides through untouched — the server's
    // action schema validates it, not this parser (matches Hermes's params
    // passthrough; see the Move type's `params` field doc).
    const params: Record<string, unknown> = {};
    for (const k of Object.keys(r)) {
      if (!RESERVED_MOVE_KEYS.has(k)) params[k] = r[k];
    }
    if (Object.keys(params).length) move.params = params;
    moves.push(move);
  }
  if (moves.length === 0) throw new DecideError("no valid moves parsed from reply");
  return moves;
}

// ── read an agent reply from a subagent transcript (fallback path) ───────────

/** One content block → text (string, or an array of {type:"text",text} blocks). */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** Text of the LAST assistant message in a getSessionMessages transcript. Used by
 *  the subagent-fallback complete() on openclaw versions without runtime.llm. */
export function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && typeof m === "object" && (m as { role?: unknown }).role === "assistant") {
      return blockText((m as { content?: unknown }).content);
    }
  }
  return "";
}

// ── human-editable strategy (mtime-cached, capped) ───────────────────────────
// A markdown file the manager edits; injected into the move prompt. Cached on
// mtime (no re-read per tick), refreshed on edit, capped so it can't blow the prompt.
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

// ── per-match rolling history (last N turns) ─────────────────────────────────
// Injected into the prompt so the model remembers its own recent orders (the
// direct-completion path has no host session memory). Reset when the matchId
// changes. Mirrors Hermes decide.py's `_history`.
const HISTORY_TURNS = 3;
const HISTORY_CHARS = 600;
type HistEntry = { board: string; orders: string };
let _history: HistEntry[] = [];
let _historyMatch: string | null = null;

/** Test seam / explicit reset (e.g. on match end). */
export function resetHistory(): void { _history = []; _historyMatch = null; }

function syncHistoryMatch(matchId: string): void {
  if (_historyMatch !== matchId) { _history = []; _historyMatch = matchId; }
}

function boardBrief(v: TeamView): string {
  const o = v.ball.owner ?? "loose";
  return `t${v.tick} ${v.score.home}-${v.score.away} ball@(${v.ball.pos.x.toFixed(0)},${v.ball.pos.y.toFixed(0)}) ${o}`;
}

function summarizeMoves(moves: Move[]): string {
  if (!moves.length) return "(no orders)";
  return moves.map((m) => `${m.playerId}:${m.type}${m.zone != null ? `@${m.zone}` : ""}`).join(", ");
}

function recordTurn(v: TeamView, moves: Move[]): void {
  _history.push({ board: boardBrief(v), orders: summarizeMoves(moves) });
  while (_history.length > HISTORY_TURNS) _history.shift();
}

/** The compact "Recent decisions" prompt block (length-capped), or '' when empty. */
export function historyBlock(): string {
  if (!_history.length) return "";
  const lines = _history.map((t) => `- ${t.board} → ${t.orders}`);
  return ("## Recent decisions (your last few orders)\n" + lines.join("\n")).slice(0, HISTORY_CHARS);
}

// ── prompt assembly ──────────────────────────────────────────────────────────

export type BuildMessagesOpts = { mode?: "easy" | "advanced" | "both"; strategyFile?: string; spec?: GameSpec | null };

/** The instructions envelope to prompt with: the server's `/spec` instructions
 *  when complete (system/play/output all present) — the SAME text Hermes uses —
 *  else the static Hermes-verbatim FALLBACK. Mirrors Hermes `_instructions`. */
function instructionsOf(spec: GameSpec | null): { system: string; play: string; output: string } {
  const ins = spec?.instructions;
  if (ins && typeof ins.system === "string" && ins.system
    && typeof ins.play === "string" && ins.play
    && typeof ins.output === "string" && ins.output) {
    return ins;
  }
  return FALLBACK_INSTRUCTIONS;
}

/**
 * Build {system, user} for one decision — a verbatim mirror of the Hermes plugin's
 * `_compose` (extensions/hermes-agent-messier/decide.py): the instructions' system
 * → system role; strategy + recent-history + situation + play + output → user role.
 * The situation is the server's rendered summary (it's the renderer; the plugin
 * carries no per-sport formatter), or the compact view JSON pre-envelope. By
 * emitting the server's OWN `instructions.output` (not a hardcoded directive) the
 * two plugins ask the model for the identical move shape.
 */
export function buildMessages(v: TeamView & { summary?: string }, opts: BuildMessagesOpts = {}): { system: string; user: string } {
  const ins = instructionsOf(opts.spec ?? null);
  const standing = strategyText(opts.strategyFile);
  const stratBlock = standing ? `## Your manager's standing instructions\n${standing}\n\n` : "";
  const recent = historyBlock();
  const recentBlock = recent ? `${recent}\n\n` : "";
  const situation = v.summary ?? JSON.stringify(v);
  return {
    system: ins.system,
    user: `${stratBlock}${recentBlock}${situation}\n\n${ins.play}\n\n${ins.output}`,
  };
}

// ── direct LLM completion (the SDK contract a plugin can call) ────────────────

/** Matches `api.runtime.llm.complete` — one prompt → text, with provider/model
 *  echoed back so we can record the effective model reliably. */
export type LlmComplete = (params: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  purpose?: string;
}) => Promise<{ text: string; provider?: string; model?: string }>;

// ── execute: POST one action per move to the pitch ───────────────────────────

/** Endpoint templates from the venue's spec.routes — soccer-literal fallbacks so a
 *  pre-envelope/offline server still works. Mirrors the Hermes plugin's _routes:
 *  NOTHING is hardcoded operationally; every URL comes from the spec the server
 *  publishes, so a new venue (golf, …) is driven entirely by its own routes. */
const ROUTE_FALLBACKS: Record<string, string> = {
  state: "/matches/{matchId}/agents/{did}/state",
  observe: "/matches/{matchId}/agents/{did}/observe",
  act: "/matches/{matchId}/players/{playerId}/action",
  decision: "/matches/{matchId}/agents/{did}/decision",
};
/** Resolve + fill a spec route template ({matchId}/{did}/{playerId}). */
export function routePath(
  routes: Record<string, string> | undefined,
  key: keyof typeof ROUTE_FALLBACKS,
  vars: { matchId?: string; did?: string; playerId?: string },
): string {
  let s = routes?.[key] ?? ROUTE_FALLBACKS[key]!;
  if (vars.matchId !== undefined) s = s.replace("{matchId}", encodeURIComponent(vars.matchId));
  if (vars.did !== undefined) s = s.replace("{did}", encodeURIComponent(vars.did));
  if (vars.playerId !== undefined) s = s.replace("{playerId}", encodeURIComponent(vars.playerId));
  return s;
}

export type ExecuteDeps = {
  /** Pitch base URL (cfg.serverUrl), e.g. http://localhost:3010. */
  base: string;
  cfg: PluginCfg;
  /** The venue's spec.routes — the act endpoint is taken from here (spec-driven). */
  routes?: Record<string, string> | undefined;
  /** Caller DID / agentId (session.did ?? agentId). */
  did: string;
  /** Seat token (session.token), sent as x-agent-token. */
  token?: string | null | undefined;
  /** Reported as x-agent-decision-ms — the prompt→reply latency (ms). */
  decisionMs?: number;
  /** Per-venue runtime session (defaults to the global one). Its lastModel rides
   *  the header and its lastActAt is stamped on a successful POST. */
  state?: RuntimeSession;
  /** Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
};

/**
 * POST one `/action` per move, carrying the decision-observability headers the
 * pitch reads (x-agent-model from the per-venue state.lastModel, x-agent-decision-ms
 * = prompt→reply latency). Stamps state.lastActAt on a successful POST.
 */
export async function executeMoves(
  matchId: string,
  moves: Move[],
  deps: ExecuteDeps,
): Promise<{ posted: number; results: { playerId: string; status: number }[] }> {
  const state = deps.state ?? session;
  const base = deps.base.replace(/\/$/, "");
  const results: { playerId: string; status: number }[] = [];
  for (const m of moves) {
    const body: Record<string, unknown> = { agentId: deps.did, type: m.type };
    if (m.dir) body.dir = m.dir;
    if (m.power !== undefined) body.power = m.power;
    if (m.zone !== undefined) body.zone = m.zone;
    if (m.say !== undefined) body.say = m.say;
    // Everything parseMoves couldn't name explicitly (to/target/through/burst/
    // name/players/shape/ttl/sticky, …) — passed through untouched, matching
    // the Hermes plugin's `body.update(params)`. The server's action schema
    // is the sole gatekeeper for what's actually valid.
    if (m.params) Object.assign(body, m.params);
    const url = routePath(deps.routes, "act", { matchId, playerId: m.playerId });
    // authedFetch carries OAuth (proactively refreshed) with a static-key
    // fallback and a 401→refresh→retry — previously this POST used ONLY
    // apiKeyOf(deps.cfg) (no OAuth, no retry), so a fully OAuth-migrated agent
    // (no static key configured) could join fine via a tool call yet have
    // every actual move POST go out unauthenticated or rejected.
    const r = await authedFetch(base, url, {
      cfg: deps.cfg, did: deps.did, token: deps.token, state, decisionMs: deps.decisionMs,
      runtimeTag: `autoplay@${PLUGIN_VERSION}`,
      method: "POST", body,
      ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
    });
    if (r.ok) state.lastActAt = Date.now(); // act-verification: the team was moved this cycle
    results.push({ playerId: m.playerId, status: r.status });
  }
  return { posted: results.length, results };
}

// ── decision reporting: POST every turn's decision to the pitch ──────────────

export type DecisionReportDeps = {
  base: string;
  /** The venue's spec.routes — the decision endpoint is taken from here (spec-driven). */
  routes?: Record<string, string> | undefined;
  matchId: string;
  /** Reporting agentId — MUST be the SAME identity executeMoves posts under
   *  (state.did ?? agentId); the pitch keys the claim + seat token by it, so a
   *  mismatch makes the report 404 and the pitch keeps server-side-inferring. */
  agentId: string;
  /** Seat token — sent as x-agent-token (same auth as executeMoves). */
  token?: string | null | undefined;
  /** Plugin config — for the optional Bearer API key (REQUIRE_AUTH parity). */
  cfg?: PluginCfg;
  fetch?: typeof fetch;
  logger?: { warn: (m: string) => void };
};

/** A move in a DECISION REPORT — the pitch's reportMoveBody requires `action`
 *  (NOT the `/action` endpoint's `type`); a wrong field makes the whole report
 *  fail schema validation (400) and silently not land, leaving the pitch to infer
 *  sparse records. So the report uses `action`. */
export type ReportMove = { playerId: string; action: string; dir?: Vec2; power?: number; zone?: string | number; say?: string; params?: Record<string, unknown> };

/** Map internal Move (type) → report move (action) for the /decision payload.
 *  `params` rides through here too — the pitch report schema is `.passthrough()`
 *  (see services/pitch/src/api/schemas.ts), so nothing is lost for the
 *  decisions inspector / decision capture. */
export function toReportMoves(moves: Move[]): ReportMove[] {
  return moves.map((m) => {
    const r: ReportMove = { playerId: m.playerId, action: m.type };
    if (m.dir) r.dir = m.dir;
    if (m.power !== undefined) r.power = m.power;
    if (m.zone !== undefined) r.zone = m.zone;
    if (m.say !== undefined) r.say = m.say;
    if (m.params) r.params = m.params;
    return r;
  });
}

export type DecisionReport = {
  tick: number;
  clock: number;
  prompt: { system?: string; user: string };
  outcome: "acted" | "no_response";
  reason?: string;
  moves?: ReportMove[];
  rawText?: string;
  latencyMs?: number;
  model?: string;
  /** Play-readiness snapshot pushed when degraded → the pitch inspector banner. */
  diagnosis?: Diagnosis;
};

// Compile-time drift guard: the report's venue-NEUTRAL fields MUST stay assignable
// to the pitch's published contract (ReportBody). `moves` is excluded — its action
// enum is venue-specific, while the plugin is multi-venue (action stays string).
// If the server contract changes, regenerate src/pitch-api.ts and fix the break.
type _ReportNeutral = Omit<ReportBody, "moves">;
const _assertReportMatchesContract = (r: Omit<DecisionReport, "moves">): _ReportNeutral => r;
void _assertReportMatchesContract;

/**
 * POST a decision report to `/matches/:id/agents/:agentId/decision` so EVERY
 * turn — acted AND no-response — reaches the pitch's decision inspector. Auth is
 * the seat token (x-agent-token), same as executeMoves. Best-effort: it NEVER
 * throws so a reporting failure can't disrupt play.
 */
export async function postDecisionReport(report: DecisionReport, deps: DecisionReportDeps): Promise<void> {
  const base = deps.base.replace(/\/$/, "");
  const url = routePath(deps.routes, "decision", { matchId: deps.matchId, did: deps.agentId });
  try {
    // Same authed path executeMoves uses (OAuth + 401 retry, previously this
    // POST only carried the static apiKey) — best-effort: never throw, a
    // reporting failure must never disrupt play.
    await authedFetch(base, url, {
      cfg: deps.cfg ?? {}, did: deps.agentId, token: deps.token,
      // report.model (this decision's effective model) is the x-agent-model
      // source here, NOT whatever the shared session.lastModel happens to be
      // — and promptDeliveredAt stays null so no x-agent-decision-ms header
      // is sent (this endpoint never carried one; the report body itself
      // already has `latencyMs`).
      state: { lastModel: report.model ?? null, promptDeliveredAt: null },
      runtimeTag: `autoplay@${PLUGIN_VERSION}`,
      method: "POST", body: report,
      ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
    });
  } catch (e) {
    deps.logger?.warn(`decision report POST failed: ${String(e)}`);
  }
}

// ── the full per-tick turn: build → complete → parse → act → report ──────────

export type PlayTurnDeps = {
  /** The SDK's direct completion (api.runtime.llm.complete). */
  complete: LlmComplete;
  /** The freshest team view (polled by the watcher). */
  view: TeamView & { summary?: string };
  /** The match's frozen spec (rulebook/instructions), or null on a pre-envelope server. */
  spec: GameSpec | null;
  cfg: PluginCfg;
  base: string;
  matchId: string;
  /** The seat's authoritative agentId (state.did ?? agentId) — used for BOTH
   *  /action and /decision so the report lands. */
  agentId: string;
  token?: string | null;
  state?: RuntimeSession;
  mode?: "easy" | "advanced" | "both";
  strategyFile?: string;
  /** The agent's configured default model — used for x-agent-model + report.model
   *  when the llm_output hook didn't capture one (older openclaw / subagent path). */
  fallbackModel?: string;
  signal?: AbortSignal;
  /** Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
};

export type PlayTurnResult = {
  outcome: "acted" | "no_response";
  posted: number;
  reason?: string;
  moves?: Move[];
  latencyMs: number;
};

/**
 * One decision tick: build the prompt, make a direct completion, capture the
 * effective model, parse + post the moves, and self-report — always, for acted
 * AND no_response. Returns a summary for logging. Never throws on report/post
 * failures (best-effort observability).
 */
export async function playTurn(deps: PlayTurnDeps): Promise<PlayTurnResult> {
  const state = deps.state ?? session;
  if (!state.lastModel && deps.fallbackModel) state.lastModel = deps.fallbackModel;
  syncHistoryMatch(deps.matchId);
  const { system, user } = buildMessages(deps.view, { mode: deps.mode, strategyFile: deps.strategyFile, spec: deps.spec });

  const started = Date.now();
  let text = "";
  try {
    const r = await deps.complete({
      messages: [{ role: "user", content: user }],
      ...(system ? { systemPrompt: system } : {}),
      maxTokens: 500,
      purpose: "agent-soccer autoplay",
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    text = r.text ?? "";
    // Capture the effective provider/model from the RESULT (reliable, no hook).
    if (r.model) state.lastModel = r.provider ? `${r.provider}/${r.model}` : r.model;
  } catch (e) {
    deps.logger?.warn(`llm complete failed: ${String(e)}`);
  }
  const latencyMs = Math.max(0, Date.now() - started);

  let moves: Move[] | null = null;
  let reason: string | undefined;
  try {
    moves = parseMoves(text, deps.spec, deps.view.mine?.map((p) => p.id));
  } catch (e) {
    reason = e instanceof DecideError ? e.message : String(e);
  }

  let posted = 0;
  if (moves) {
    ({ posted } = await executeMoves(deps.matchId, moves, {
      base: deps.base,
      cfg: deps.cfg,
      routes: deps.spec?.routes,
      did: deps.agentId,
      token: deps.token,
      decisionMs: latencyMs,
      state,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }));
    recordTurn(deps.view, moves);
  }

  const outcome: "acted" | "no_response" = moves ? "acted" : "no_response";
  const report: DecisionReport = {
    tick: deps.view.tick,
    clock: deps.view.clock,
    prompt: { ...(system ? { system } : {}), user },
    outcome,
    ...(reason ? { reason } : {}),
    ...(moves ? { moves: toReportMoves(moves) } : {}),
    rawText: text,
    latencyMs,
    ...(state.lastModel ? { model: state.lastModel } : {}),
    // Push the current degraded snapshot so the inspector explains WHY (the
    // root cause behind an empty reply), not just "no response".
    ...(state.diagnosis?.state === "degraded" ? { diagnosis: state.diagnosis } : {}),
  };
  await postDecisionReport(report, {
    base: deps.base,
    routes: deps.spec?.routes,
    matchId: deps.matchId,
    agentId: deps.agentId,
    token: deps.token,
    cfg: deps.cfg,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  if (!moves) deps.logger?.warn(`responded without acting: ${reason}`);
  return { outcome, posted, ...(reason ? { reason } : {}), ...(moves ? { moves } : {}), latencyMs };
}

// ── subagent fallback (openclaw without runtime.llm, e.g. 2026.3.13) ──────────

/** The slice of api.runtime the subagent fallback needs — structural so decide.ts
 *  stays openclaw-import-free (and unit-testable with a plain mock). */
export type SubagentRuntime = {
  subagent: {
    run: (p: { sessionKey: string; message: string; extraSystemPrompt?: string; deliver?: boolean; idempotencyKey?: string }) => Promise<{ runId: string }>;
    waitForRun: (p: { runId: string; timeoutMs?: number }) => Promise<unknown>;
    getSessionMessages: (p: { sessionKey: string; limit?: number }) => Promise<{ messages: unknown[] }>;
    deleteSession: (p: { sessionKey: string }) => Promise<void>;
  };
};

/** Reset the per-match subagent session past this many turns so context can't grow
 *  unbounded (the prompt already carries our own rolling history). */
export const SESSION_RESET_TURN_CAP = 40;

export type SubagentTurnDeps = Omit<PlayTurnDeps, "complete"> & {
  runtime: SubagentRuntime;
  /** Stable PERSISTENT session key for this match (ephemeral keys don't run on
   *  2026.3.13 — the model never gets invoked). */
  sessionKey: string;
  timeoutMs?: number;
};

/**
 * One decision tick via the host chat agent (for openclaw without runtime.llm).
 * Forces one subagent turn and either (a) detects the model called the act tool
 * itself — it already POSTed + stamped state.lastActAt, so we DON'T double-post —
 * or (b) parses the JSON reply and posts the moves. Either way we SELF-REPORT
 * (lands + provenance), exactly like the direct path. Mirrors the proven prior
 * runAutoplayTurn, plus the landing report.
 */
export async function playTurnViaSubagent(deps: SubagentTurnDeps): Promise<PlayTurnResult> {
  const state = deps.state ?? session;
  if (!state.lastModel && deps.fallbackModel) state.lastModel = deps.fallbackModel;
  syncHistoryMatch(deps.matchId);
  const { system, user } = buildMessages(deps.view, { mode: deps.mode, strategyFile: deps.strategyFile, spec: deps.spec });

  // Bound context: reset the persistent session every SESSION_RESET_TURN_CAP turns.
  state.turn = (state.turn ?? 0) + 1;
  if (state.turn % SESSION_RESET_TURN_CAP === 0) {
    await deps.runtime.subagent.deleteSession({ sessionKey: deps.sessionKey }).catch(() => {});
  }

  const actAtBefore = state.lastActAt;
  const started = Date.now();
  try {
    const { runId } = await deps.runtime.subagent.run({
      sessionKey: deps.sessionKey,
      message: NO_TOOL_DIRECTIVE + user,
      ...(system ? { extraSystemPrompt: system } : {}),
      deliver: false,
      idempotencyKey: `${deps.sessionKey}:${deps.view.tick}`,
    });
    await deps.runtime.subagent.waitForRun({ runId, timeoutMs: deps.timeoutMs ?? 45_000 });
  } catch (e) {
    deps.logger?.warn(`subagent run failed: ${String(e)}`);
  }
  const latencyMs = Math.max(0, Date.now() - started);

  const reportBase = { tick: deps.view.tick, clock: deps.view.clock, prompt: { ...(system ? { system } : {}), user }, latencyMs };
  const reportDeps = {
    base: deps.base, routes: deps.spec?.routes, matchId: deps.matchId, agentId: deps.agentId, token: deps.token, cfg: deps.cfg,
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.logger ? { logger: deps.logger } : {}),
  };

  // (a) The model called the act tool itself — it already POSTed and advanced
  //     lastActAt. Report acted; do NOT parse+post again (would double-apply).
  if (state.lastActAt !== actAtBefore) {
    recordTurn(deps.view, []); // moves were posted by the tool; not parsed here
    await postDecisionReport({ ...reportBase, outcome: "acted", rawText: "", ...(state.lastModel ? { model: state.lastModel } : {}) }, reportDeps);
    return { outcome: "acted", posted: 0, latencyMs };
  }

  // (b) Read the reply and parse/post ourselves.
  let text = "";
  try {
    const { messages } = await deps.runtime.subagent.getSessionMessages({ sessionKey: deps.sessionKey, limit: 10 });
    text = lastAssistantText(messages);
  } catch (e) {
    deps.logger?.warn(`getSessionMessages failed: ${String(e)}`);
  }
  let moves: Move[] | null = null;
  let reason: string | undefined;
  try { moves = parseMoves(text, deps.spec, deps.view.mine?.map((p) => p.id)); } catch (e) { reason = e instanceof DecideError ? e.message : String(e); }

  let posted = 0;
  if (moves) {
    ({ posted } = await executeMoves(deps.matchId, moves, {
      base: deps.base, cfg: deps.cfg, routes: deps.spec?.routes, did: deps.agentId, token: deps.token, decisionMs: latencyMs, state,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }));
    recordTurn(deps.view, moves);
  }
  const outcome: "acted" | "no_response" = moves ? "acted" : "no_response";
  await postDecisionReport({
    ...reportBase, outcome, ...(reason ? { reason } : {}), ...(moves ? { moves: toReportMoves(moves) } : {}), rawText: text,
    ...(state.lastModel ? { model: state.lastModel } : {}),
  }, reportDeps);
  if (!moves) deps.logger?.warn(`responded without acting: ${reason}`);
  return { outcome, posted, ...(reason ? { reason } : {}), ...(moves ? { moves } : {}), latencyMs };
}
