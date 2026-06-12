import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describeTeam, type TeamView } from "./format.js";
import { session } from "./state.js";

export type PluginCfg = {
  serverUrl?: string;
  /** Auto quick-match at startup: find a waiting room (teamSize) or create one.
   *  The standard zero-touch way to get a demo/bot team playing. */
  autoJoin?: boolean;
  /** Preferred players-per-side for quick-match / created rooms (default 5). */
  teamSize?: number;
  /** Optional: pin a specific room at startup (overrides autoJoin). */
  matchId?: string;
  /** Optional side preference. */
  team?: "home" | "away";
  sessionKey?: string;
  /** AgentNet API key — sent as Bearer on join so the server can verify identity
   *  (REQUIRE_AUTH). Falls back to the AGENTNET_API_KEY env var. */
  apiKey?: string;
  /** AgentNet accounts service (person plane) — used to redeem owner claim codes. */
  accountsUrl?: string;
  mode?: "easy" | "advanced" | "both";
  /** Default team identity (changeable at runtime via soccer_set_identity). */
  teamName?: string;
  nation?: string; // ISO code like NL/IT/CN → flag shown in the viewer
  clan?: string;   // e.g. 魔兽工会-style guild tag
  style?: string;  // playing identity, e.g. 全攻全守 total football — shapes play
  /** Path to a human-editable strategy.md injected into the watcher move prompt
   *  (Phase 5). Capped ~1k chars, mtime-cached so edits apply mid-match. */
  strategyFile?: string;
};

export function identityOf(cfg: PluginCfg): Record<string, unknown> {
  return { name: cfg.teamName, nation: cfg.nation, clan: cfg.clan, style: cfg.style };
}

// ── /spec manifest (Phase 4 — generate tools from the published action schema) ──
/** The slice of GET /spec this plugin consumes: the published action vocabulary. */
export type GameSpec = {
  game: string;
  specVersion: number;
  rulesVersion: number;
  actions: { type: "string"; enum: string[]; descriptions?: Record<string, string> };
  /** The self-instructable envelope — how to play, server-authored, frozen per
   *  match. Optional: absent on pre-envelope servers (fallback prompt used). */
  instructions?: { system: string; play: string; output: string };
};

// STATIC FALLBACK vocabularies — used when /spec is unreachable (offline-safe).
// `ADVANCED_ACTIONS` is also the classifier that splits a manifest's enum into
// the easy tier (server computes geometry) vs the advanced tier (agent does).
const EASY_ACTIONS = ["chase", "shoot", "dribble", "pass", "defend", "press", "cover", "stop"];
const ADVANCED_ACTIONS = ["run", "kick", "stop"];

/** Fetch GET /spec (the game manifest). Returns null when unreachable or
 *  malformed so callers fall back to the static vocabulary (offline-safe). */
export async function fetchSpec(cfg: PluginCfg): Promise<GameSpec | null> {
  const base = (cfg.serverUrl ?? "http://localhost:3010").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/spec`);
    if (!res.ok) return null;
    const spec = (await res.json()) as GameSpec;
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.actions?.enum)) return null;
    return spec;
  } catch { return null; }
}

/** Per-match spec snapshot with the protection ladder (self-instructable-
 *  observation.md): the match's frozen snapshot first, then server-current
 *  /spec (pre-snapshot servers), then null — the caller stays on its static
 *  fallback and retries on a later tick (degraded, never permanently). */
export async function fetchMatchSpec(cfg: PluginCfg, matchId: string): Promise<GameSpec | null> {
  const base = (cfg.serverUrl ?? "http://localhost:3010").replace(/\/$/, "");
  for (const url of [`${base}/matches/${encodeURIComponent(matchId)}/spec`, `${base}/spec`]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const spec = (await res.json()) as GameSpec;
      if (spec && typeof spec === "object" && Array.isArray(spec.actions?.enum)) return spec;
    } catch { /* next rung */ }
  }
  return null;
}

/** The action enum for the play tool at a given tier: derived from the manifest
 *  when present (easy = manifest minus the raw run/kick geometry actions; advanced
 *  = just those), else the static fallback. New server actions surface for free. */
export function playActionTypes(spec: GameSpec | null, mode: "easy" | "advanced" | "both"): string[] {
  if (!spec) return mode === "easy" ? EASY_ACTIONS : mode === "advanced" ? ADVANCED_ACTIONS : [...new Set([...EASY_ACTIONS, ...ADVANCED_ACTIONS])];
  const all = spec.actions.enum.filter((a) => typeof a === "string");
  const advanced = all.filter((a) => a === "run" || a === "kick" || a === "stop");
  const easy = all.filter((a) => a !== "run" && a !== "kick" && a !== "idle");
  if (!easy.includes("stop")) easy.push("stop");
  return mode === "easy" ? easy : mode === "advanced" ? advanced : [...new Set([...easy, ...advanced])];
}

/** Stable cross-process cache key for this agent (one gateway = one sessionKey).
 *  Used for the tmp-file caches — known before any join, unlike the DID. */
function idKey(cfg: PluginCfg): string {
  return cfg.sessionKey ?? "agent";
}

/** AgentNet API key for join-time verification (config, then env fallback). */
export function apiKeyOf(cfg: PluginCfg): string | undefined {
  return cfg.apiKey ?? process.env.AGENTNET_API_KEY ?? undefined;
}

/** The agentId the server seats us under. Once the server has verified us and
 *  returned a DID, that DID is our identity (it keys our seat + player calls);
 *  before that, the configured sessionKey (also used in dev / REQUIRE_AUTH=0). */
export function agentIdOf(cfg: PluginCfg): string {
  return recallDid(cfg) ?? cfg.sessionKey ?? "agent";
}

/** Per-agent tmp caches shared across processes (the gateway joins; chat-turn
 *  processes need the same token + DID to act). Keyed on the stable idKey. */
function cachePath(kind: string, key: string): string {
  return joinPath(tmpdir(), `agentnet-soccer-${kind}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}
export function rememberToken(cfg: PluginCfg, token: string): void {
  session.token = token;
  try { writeFileSync(cachePath("token", idKey(cfg)), JSON.stringify({ token }), { mode: 0o600 }); } catch { /* best-effort */ }
}
export function recallToken(cfg: PluginCfg): string | null {
  if (session.token) return session.token;
  try {
    const t = (JSON.parse(readFileSync(cachePath("token", idKey(cfg)), "utf8")) as { token?: string }).token;
    if (typeof t === "string") { session.token = t; return t; }
  } catch { /* none yet */ }
  return null;
}
export function rememberDid(cfg: PluginCfg, did: string): void {
  session.did = did;
  try { writeFileSync(cachePath("did", idKey(cfg)), JSON.stringify({ did }), { mode: 0o600 }); } catch { /* best-effort */ }
}
export function recallDid(cfg: PluginCfg): string | null {
  if (session.did) return session.did;
  try {
    const d = (JSON.parse(readFileSync(cachePath("did", idKey(cfg)), "utf8")) as { did?: string }).did;
    if (typeof d === "string") { session.did = d; return d; }
  } catch { /* none yet */ }
  return null;
}

export function pitchClient(cfg: PluginCfg) {
  const base = (cfg.serverUrl ?? "http://localhost:3010").replace(/\/$/, "");
  const authHeaders = (): Record<string, string> => {
    const t = recallToken(cfg);
    return t ? { "x-agent-token": t } : {};
  };
  // Bearer API key — sent on join so the server can verify identity → DID.
  const bearer = (): Record<string, string> => {
    const k = apiKeyOf(cfg);
    return k ? { Authorization: `Bearer ${k}` } : {};
  };
  // Tells the lobby roster what kind of client holds this seat.
  const RUNTIME = { "x-agent-runtime": "openclaw-plugin/0.1.0" };
  // The room is dynamic. In-process state is set when the watcher joins, but
  // tools may run in a DIFFERENT process (CLI chat, dashboard) — so fall back
  // to asking the server which room this agentId is seated in.
  const m = async (): Promise<string> => {
    const id = session.matchId ?? cfg.matchId;
    if (id) return encodeURIComponent(id);
    const res = await fetch(`${base}/matches`);
    if (res.ok) {
      const { matches } = (await res.json()) as { matches: { id: string; status: string; sides: { home: string | null; away: string | null } }[] };
      const me = agentIdOf(cfg);
      const seat = matches.find(r => r.status !== "ended" && (r.sides.home === me || r.sides.away === me));
      if (seat) { session.matchId = seat.id; return encodeURIComponent(seat.id); }
    }
    throw new Error("not in a match — use soccer_join_match or soccer_create_match first");
  };
  return {
    async lobby(): Promise<{ matches: { id: string; status: string; teamSize: number; maxGoals: number; score: { home: number; away: number }; sides: { home: string | null; away: string | null } }[] }> {
      const res = await fetch(`${base}/matches`);
      if (!res.ok) throw new Error(`pitch lobby: ${res.status} ${await res.text()}`);
      return res.json() as Promise<any>;
    },
    async createRoom(opts: { teamSize: number; maxGoals?: number }): Promise<{ id: string }> {
      const res = await fetch(`${base}/matches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duel: true, teamSize: opts.teamSize, maxGoals: opts.maxGoals ?? 5 }),
      });
      if (!res.ok) throw new Error(`pitch create: ${res.status} ${await res.text()}`);
      return res.json() as Promise<{ id: string }>;
    },
    async quickMatch(agentId: string, opts: { teamSize?: number; team?: "home" | "away" } = {}): Promise<{ matchId: string; team: "home" | "away"; playerIds: string[]; started: boolean }> {
      const res = await fetch(`${base}/quickmatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...RUNTIME, ...bearer() },
        body: JSON.stringify({ agentId, teamSize: opts.teamSize ?? cfg.teamSize ?? 5, team: opts.team, identity: identityOf(cfg) }),
      });
      if (!res.ok) throw new Error(`pitch quickmatch: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as any;
      if (typeof data.did === "string") rememberDid(cfg, data.did);
      if (typeof data.token === "string") rememberToken(cfg, data.token);
      return data;
    },
    async join(matchId: string, agentId: string, team?: "home" | "away"): Promise<{ team: "home" | "away"; playerIds: string[]; started: boolean }> {
      const res = await fetch(`${base}/matches/${encodeURIComponent(matchId)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...RUNTIME, ...bearer() },
        body: JSON.stringify({ agentId, team, identity: identityOf(cfg) }),
      });
      if (!res.ok) throw new Error(`pitch join: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as any;
      if (typeof data.did === "string") rememberDid(cfg, data.did);
      if (typeof data.token === "string") rememberToken(cfg, data.token);
      return data;
    },
    async credits(agentId: string): Promise<unknown> {
      const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}/credits`);
      if (!res.ok) throw new Error(`pitch credits: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async skinCatalog(): Promise<unknown> {
      const res = await fetch(`${base}/skins`);
      if (!res.ok) throw new Error(`pitch skins: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async mySkins(agentId: string): Promise<unknown> {
      const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}/skins`);
      if (!res.ok) throw new Error(`pitch my skins: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async buySkin(agentId: string, skinId: string): Promise<unknown> {
      const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}/skins/buy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ skinId }),
      });
      if (!res.ok) throw new Error(`pitch buy skin: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async equipSkin(agentId: string, skinId: string | null): Promise<unknown> {
      const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}/skins/equip`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ skinId }),
      });
      if (!res.ok) throw new Error(`pitch equip skin: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async renamePlayer(agentId: string, player: string, name: string): Promise<unknown> {
      const res = await fetch(`${base}/matches/${await m()}/players/${encodeURIComponent(player)}/name`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ agentId, name }),
      });
      if (!res.ok) throw new Error(`pitch rename: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async setIdentity(agentId: string, patch: Record<string, unknown>): Promise<unknown> {
      const res = await fetch(`${base}/matches/${await m()}/identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ agentId, ...patch }),
      });
      if (!res.ok) throw new Error(`pitch identity: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async teamState(agentId: string): Promise<TeamView> {
      const res = await fetch(`${base}/matches/${await m()}/agents/${encodeURIComponent(agentId)}/state`);
      if (!res.ok) throw new Error(`pitch team state: ${res.status} ${await res.text()}`);
      return res.json() as Promise<TeamView>;
    },
    async action(player: string, body: Record<string, unknown>): Promise<unknown> {
      const tagged = session.lockstep ? { ...body, turn: session.turn } : body;
      const res = await fetch(`${base}/matches/${await m()}/players/${encodeURIComponent(player)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(tagged),
      });
      if (!res.ok) throw new Error(`pitch action: ${res.status} ${await res.text()}`);
      return res.json();
    },
  };
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const err = (msg: string) => ({ content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true });

/** Resolve which player a tool call targets: explicit `player`, or the single
 *  claimed player when this agent controls exactly one. */
function target(player?: string): { id: string } | { error: string } {
  if (player) {
    if (session.players.length && !session.players.includes(player)) {
      return { error: `you don't control "${player}". Your players: ${session.players.join(", ")}` };
    }
    return { id: player };
  }
  if (session.players.length === 1) return { id: session.players[0]! };
  return { error: `specify player="<id>" — you control: ${session.players.join(", ") || "(none yet)"}` };
}

const playerParam = Type.Optional(
  Type.String({ description: "Which of your players to move (id, e.g. home-9). Omit only if you control exactly one." }),
);

// ── Matchmaking: how a human (chatting with their agent) gets into a game. ──
function lobbyTools(cfg: PluginCfg): AnyAgentTool[] {
  const client = pitchClient(cfg);
  const agentId = agentIdOf(cfg);
  const fmt = (r: { id: string; status: string; teamSize: number; score: { home: number; away: number }; sides: { home: string | null; away: string | null } }) =>
    `${r.id}: ${r.teamSize}v${r.teamSize} [${r.status}] ${r.score.home}-${r.score.away} home=${r.sides.home ?? "OPEN"} away=${r.sides.away ?? "OPEN"}`;
  const joinVia = async (matchId: string, team?: "home" | "away") => {
    // In the gateway process the service installed joinAndWatch (joins AND
    // starts the playing loop). In a chat process there is no watcher — just
    // take the seat on the server; the gateway's seat-poller will notice the
    // seat within seconds and start playing.
    if (session.joinAndWatch) return session.joinAndWatch(matchId, team);
    const seat = await client.join(matchId, agentId, team);
    session.matchId = matchId;
    session.players = seat.playerIds;
    return { ...seat, started: seat.started };
  };
  return [
    {
      name: "soccer_find_matches",
      label: "Find matches",
      description:
        "List open soccer rooms (the lobby): id, format (e.g. 5v5 or 11v11), status, score, which sides are OPEN. Use when the human asks to find/watch/join a game.",
      parameters: Type.Object({
        teamSize: Type.Optional(Type.Number({ description: "filter by players per side, e.g. 5 or 11" })),
      }),
      async execute(_id, params) {
        const { matches } = await client.lobby();
        const list = matches.filter(r => !params.teamSize || r.teamSize === params.teamSize);
        return ok({ matches: list.map(fmt), hint: list.some(r => r.status === "waiting") ? "join a waiting room with soccer_join_match" : "no open rooms — create one with soccer_create_match" });
      },
    },
    {
      name: "soccer_create_match",
      label: "Create a match",
      description:
        "Create a new room and take a side in it. The match starts automatically when an opponent joins. Use when the human says 'create a 5v5 game', 'start an 11-player match', etc.",
      parameters: Type.Object({
        teamSize: Type.Number({ minimum: 1, maximum: 11, description: "players per side (5 = five-a-side, 11 = standard)" }),
        maxGoals: Type.Optional(Type.Number({ description: "match ends when total goals exceed this (default 5)" })),
        team: Type.Optional(Type.Union([Type.Literal("home"), Type.Literal("away")])),
      }),
      async execute(_id, params) {
        const { id } = await client.createRoom({ teamSize: params.teamSize, ...(params.maxGoals ? { maxGoals: params.maxGoals } : {}) });
        const seat = await joinVia(id, params.team);
        return ok({ matchId: id, ...seat, note: "waiting for an opponent — the match starts automatically when one joins. GIVE YOUR HUMAN the managerUrl link: it's their manager console for this room (pause/reset votes, room controls)." });
      },
    },
    {
      name: "soccer_join_match",
      label: "Join a match",
      description:
        "Join a room and control a WHOLE side. With matchId: join that room. Without: quick-match — join any waiting room (optionally filtered by teamSize), or create one if none. The match starts automatically when both sides are taken.",
      parameters: Type.Object({
        matchId: Type.Optional(Type.String()),
        teamSize: Type.Optional(Type.Number({ description: "quick-match filter / size for a new room (default 5)" })),
        team: Type.Optional(Type.Union([Type.Literal("home"), Type.Literal("away")])),
      }),
      async execute(_id, params) {
        let id = params.matchId;
        if (!id) {
          // atomic server-side find-or-create — two racing agents land in ONE room
          const q = await client.quickMatch(agentId, { ...(params.teamSize ? { teamSize: params.teamSize } : {}), ...(params.team ? { team: params.team } : {}) });
          id = q.matchId;
        }
        const seat = await joinVia(id, params.team);
        return ok({ matchId: id, ...seat, note: (seat.started ? "opponent present — playing now!" : "seated — match starts when an opponent joins") + " GIVE YOUR HUMAN the managerUrl link: it's their manager console for this room." });
      },
    },
    {
      name: "soccer_credits",
      label: "Check credits",
      description:
        "Check your membership status and what it unlocks. Playing and shouting are always free; membership unlocks the cosmetic perks — team skins, runtime identity changes, and player renames.",
      parameters: Type.Object({}),
      async execute() { return ok(await client.credits(agentId)); },
    },
    {
      name: "soccer_skin",
      label: "Team skins",
      description:
        "Browse, claim, and equip team kits (skins) — cosmetic only, shown to everyone watching the match. 'list' shows the catalog + what you own, 'buy' claims a kit (members-only — membership unlocks all skins, free), 'equip' wears one (or pass no skinId to revert to the default kit). Use when the human says 'change our kit', 'wear the volt skin', 'wear something cool'.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("buy"), Type.Literal("equip")]),
        skinId: Type.Optional(Type.String({ description: "skin id from the catalog (required for buy; omit on equip to revert to default)" })),
      }),
      async execute(_id, params) {
        if (params.action === "list") {
          const [catalog, mine] = await Promise.all([client.skinCatalog(), client.mySkins(agentId)]);
          return ok({ catalog, mine });
        }
        if (params.action === "buy") {
          if (!params.skinId) return err("skinId required to buy");
          return ok(await client.buySkin(agentId, params.skinId));
        }
        return ok(await client.equipSkin(agentId, params.skinId ?? null));
      },
    },
    {
      name: "agentnet_claim_owner",
      label: "Claim owner",
      description:
        "Link this agent to its human owner's AgentNet account. The human gets a one-time code from the AgentNet site ('Claim my agent') and tells it to you — e.g. 'claim me on AgentNet with code 7F3K-92'. Redeems the code using this agent's own API key; the human never handles the key.",
      parameters: Type.Object({
        code: Type.String({ description: "the one-time claim code the human read out, e.g. 7F3K-92AB" }),
      }),
      async execute(_id, params) {
        const key = apiKeyOf(cfg);
        if (!key) return err("no AgentNet API key configured (set plugin apiKey or AGENTNET_API_KEY)");
        const base = (cfg.accountsUrl ?? "http://localhost:3005").replace(/\/$/, "");
        const res = await fetch(`${base}/agents/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ code: params.code }),
        });
        const data = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) return err(`claim failed: ${data.error ?? res.status}`);
        return ok({ ...data, note: "linked! your owner's membership now unlocks skins/renames/identity for this agent" });
      },
    },
    {
      name: "soccer_rename_player",
      label: "Rename a player",
      description:
        "Give one of YOUR players a display name shown on the pitch (≤12 chars) — when the human says 'call our striker 梅西二世'. Only works for players you control. MEMBERS-ONLY: membership unlocks player renames.",
      parameters: Type.Object({
        player: Type.String({ description: "player id, e.g. home-9" }),
        name: Type.String({ description: "new display name, ≤12 chars" }),
      }),
      async execute(_id, params) {
        return ok(await client.renamePlayer(agentId, params.player, params.name));
      },
    },
    {
      name: "soccer_set_identity",
      label: "Set team identity",
      description:
        "Change your team's identity at RUNTIME — when the human says 'rename our team to 风暴', 'set our clan to 魔兽工会', 'we play 意大利防守反击'. nation is an ISO code shown as a flag. style shapes how you play. MEMBERS-ONLY mid-match (identity set in config at join time is free for everyone).",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "team name (≤24 chars)" })),
        nation: Type.Optional(Type.String({ description: "ISO country code for the flag, e.g. NL, IT, CN" })),
        clan: Type.Optional(Type.String({ description: "clan/guild tag (≤24 chars)" })),
        style: Type.Optional(Type.String({ description: "playing style that will guide your decisions" })),
      }),
      async execute(_id, params) {
        const data = await client.setIdentity(agentId, params as Record<string, unknown>);
        return ok(data);
      },
    },
  ] as AnyAgentTool[];
}

function observeTool(cfg: PluginCfg, mode: "easy" | "advanced" | "both"): AnyAgentTool {
  const client = pitchClient(cfg);
  const agentId = agentIdOf(cfg);
  return {
    name: "soccer_observe",
    label: "Observe the pitch",
    description:
      "See your whole side: each player you control, the ball, teammates, opponents, score. Call this before deciding moves, then issue one action per player.",
    parameters: Type.Object({}),
    async execute() {
      const v = await client.teamState(agentId);
      return { content: [{ type: "text", text: `${describeTeam(v, mode)}\n\n${JSON.stringify(v)}` }] };
    },
  } as AnyAgentTool;
}

// ── Easy tier: high-level intents; the SERVER computes the geometry. ──
function easyTools(cfg: PluginCfg): AnyAgentTool[] {
  const client = pitchClient(cfg);
  const act = (player: string | undefined, body: Record<string, unknown>) => {
    const t = target(player);
    return "error" in t ? Promise.resolve(err(t.error)) : client.action(t.id, body).then(ok);
  };
  return [
    {
      name: "soccer_chase_ball",
      label: "Chase the ball",
      description: "Make one of your players run to win the ball (server leads the moving ball). Use when that player does NOT have it.",
      parameters: Type.Object({ player: playerParam }),
      async execute(_id, params) { return act(params.player, { type: "chase" }); },
    },
    {
      name: "soccer_shoot",
      label: "Shoot at goal",
      description: "Shoot at the opponent goal. The chosen player must have the ball.",
      parameters: Type.Object({ player: playerParam }),
      async execute(_id, params) { return act(params.player, { type: "shoot" }); },
    },
    {
      name: "soccer_dribble",
      label: "Dribble toward goal",
      description: "Carry the ball toward goal; side veers to beat a defender. The chosen player must have the ball.",
      parameters: Type.Object({
        player: playerParam,
        side: Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("forward")]),
      }),
      async execute(_id, params) { return act(params.player, { type: "dribble", side: params.side }); },
    },
    {
      name: "soccer_pass",
      label: "Pass to a teammate",
      description: "Pass to the best teammate ahead (or clear forward). The chosen player must have the ball.",
      parameters: Type.Object({ player: playerParam }),
      async execute(_id, params) { return act(params.player, { type: "pass" }); },
    },
    {
      name: "soccer_press",
      label: "Press the carrier",
      description: "Explicitly send a player to close down the ball carrier tight (goal-side). Combine with cover/defend to shape your defence — e.g. two pressers for an aggressive press.",
      parameters: Type.Object({ player: playerParam }),
      async execute(_id, params) { return act(params.player, { type: "press" }); },
    },
    {
      name: "soccer_cover",
      label: "Cover behind the press",
      description: "Explicitly position a player as the second defender — deeper on the carrier-goal line, catching the carrier if your presser is beaten.",
      parameters: Type.Object({ player: playerParam }),
      async execute(_id, params) { return act(params.player, { type: "cover" }); },
    },
    {
      name: "soccer_defend",
      label: "Defend / contain",
      description: "Have a player defend: the server keeps it goal-side of the ball carrier and contains it (no ball needed). Use for players off the ball when the opponent has it.",
      parameters: Type.Object({ player: playerParam }),
      async execute(_id, params) { return act(params.player, { type: "defend" }); },
    },
  ] as AnyAgentTool[];
}

// ── Advanced tier: raw run/kick; the AGENT computes the geometry (this +x frame). ──
function advancedTools(cfg: PluginCfg): AnyAgentTool[] {
  const client = pitchClient(cfg);
  const act = (player: string | undefined, body: Record<string, unknown>) => {
    const t = target(player);
    return "error" in t ? Promise.resolve(err(t.error)) : client.action(t.id, body).then(ok);
  };
  return [
    {
      name: "soccer_run",
      label: "Run",
      description: "Run a set DISTANCE (metres) toward dir, then stop. dir is in your +x attacking frame.",
      parameters: Type.Object({
        player: playerParam,
        dirX: Type.Number(), dirY: Type.Number(),
        distance: Type.Number({ minimum: 0, maximum: 105 }),
      }),
      async execute(_id, params) {
        return act(params.player, { type: "run", dir: { x: Number(params.dirX) || 0, y: Number(params.dirY) || 0 }, distance: params.distance });
      },
    },
    {
      name: "soccer_kick",
      label: "Kick",
      description: "Kick the ball (player must have it). power 0..1 (~50m). dir is in your +x attacking frame.",
      parameters: Type.Object({
        player: playerParam,
        dirX: Type.Number(), dirY: Type.Number(),
        power: Type.Number({ minimum: 0, maximum: 1 }),
      }),
      async execute(_id, params) {
        return act(params.player, { type: "kick", dir: { x: Number(params.dirX) || 0, y: Number(params.dirY) || 0 }, power: params.power });
      },
    },
  ] as AnyAgentTool[];
}

function moveToBody(m: Record<string, unknown>): Record<string, unknown> {
  switch (m.action) {
    case "chase": return { type: "chase" };
    case "shoot": return { type: "shoot" };
    case "dribble": return { type: "dribble", side: (m.side as string) ?? "forward" };
    case "pass": return { type: "pass" };
    case "defend": return { type: "defend" };
    case "press": return { type: "press" };
    case "cover": return { type: "cover" };
    case "stop": return { type: "stop" };
    case "run": return { type: "run", dir: { x: Number(m.dirX) || 0, y: Number(m.dirY) || 0 }, distance: Number(m.distance) || 0 };
    case "kick": return { type: "kick", dir: { x: Number(m.dirX) || 0, y: Number(m.dirY) || 0 }, power: Number(m.power) ?? 1 };
    default: return { type: "stop" };
  }
}

// One tool call that moves EVERY player you control — a move per player. This
// is the preferred way to play a multi-player side: one call instead of N.
function playTool(cfg: PluginCfg, mode: "easy" | "advanced" | "both", spec: GameSpec | null = null): AnyAgentTool {
  const client = pitchClient(cfg);
  // Phase 4: the action enum is GENERATED from the /spec manifest when reachable
  // (a new server action surfaces here with no plugin edit), else static fallback.
  const acts = playActionTypes(spec, mode);
  const move = Type.Object({
    player: Type.String({ description: "one of your players (id, e.g. home-9)" }),
    action: Type.Union(acts.map((a) => Type.Literal(a)), { description: "what that player should do" }),
    side: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("forward")], { description: "for dribble" })),
    dirX: Type.Optional(Type.Number()), dirY: Type.Optional(Type.Number()),
    distance: Type.Optional(Type.Number()), power: Type.Optional(Type.Number()),
    say: Type.Optional(Type.String({ description: "short in-character shout shown over this player (≤60 chars). FREE for everyone — banter makes the match fun to watch" })),
  });
  const specHints = spec?.actions.descriptions
    ? acts.filter((a) => spec.actions.descriptions![a]).map((a) => `${a}: ${spec.actions.descriptions![a]}`).join("; ")
    : "";
  return {
    name: "soccer_play",
    label: "Move all players",
    description:
      "Set actions for ALL the players you control in ONE call: pass moves=[{player, action, ...}] with one entry per player. Each move may include say: a short shout your player yells on the pitch (spectators see it — give your team a voice and personality!). Prefer this over calling a per-player tool N times. " +
      `action ∈ ${acts.join("|")}.` +
      (acts.includes("run") || acts.includes("kick") ? " (run/kick need dirX,dirY + distance/power; dribble takes side)." : " (dribble takes side).") +
      (specHints ? " Actions — " + specHints : ""),
    parameters: Type.Object({ moves: Type.Array(move, { description: "one move per player you control" }) }),
    async execute(_id, params) {
      const applied: unknown[] = [];
      for (const m of params.moves as Record<string, unknown>[]) {
        const t = target(m.player as string);
        if ("error" in t) { applied.push({ player: m.player, error: t.error }); continue; }
        try {
          const body = moveToBody(m);
          if (typeof m.say === "string" && m.say.trim()) body.say = m.say;
          await client.action(t.id, body);
          applied.push({ player: t.id, action: m.action });
        }
        catch (e) { applied.push({ player: m.player, error: String(e) }); }
      }
      return ok({ applied });
    },
  } as AnyAgentTool;
}

export function createSoccerTools(api: OpenClawPluginApi, spec: GameSpec | null = null): AnyAgentTool[] {
  const cfg = (api.pluginConfig ?? {}) as PluginCfg;
  const mode = cfg.mode ?? "easy";

  const tools: AnyAgentTool[] = [...lobbyTools(cfg), observeTool(cfg, mode), playTool(cfg, mode, spec)];
  if (mode === "easy" || mode === "both") tools.push(...easyTools(cfg));
  if (mode === "advanced" || mode === "both") tools.push(...advancedTools(cfg));

  const client = pitchClient(cfg);
  tools.push({
    name: "soccer_stop",
    label: "Stop",
    description: "Stop one of your players (clears its standing order).",
    parameters: Type.Object({ player: playerParam }),
    async execute(_id, params) {
      const t = target(params.player);
      return "error" in t ? err(t.error) : ok(await client.action(t.id, { type: "stop" }));
    },
  } as AnyAgentTool);

  return tools;
}
