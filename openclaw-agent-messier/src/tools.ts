import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describeTeam, type TeamView } from "./format.js";
import { session } from "./state.js";

/** Plugin version from package.json (the file the publish pipeline bumps), read
 *  once at module load. Sent in x-agent-runtime so the pitch records WHICH
 *  plugin version holds a seat. Falls back to 'dev' if the manifest is missing. */
const PLUGIN_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "dev";
  } catch {
    return "dev";
  }
})();

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
  /** Endpoint templates a generic client substitutes ({matchId}/{did}/{playerId}).
   *  The watcher builds observe/act URLs from these, not literal paths. */
  routes?: Record<string, string>;
  /** How the venue wants to be watched (stream vs poll). */
  observe?: { mode: string; suggestedIntervalMs: number };
  /** The client lifecycle contract — tool names + param schemas the plugin
   *  GENERATES its tool surface from (venue-agnostic-plugins.md). */
  client?: {
    prefix: string;
    noun: string;
    lobby?: { tool: string; route: string; params?: Record<string, unknown>; summary: string } | null;
    join?: { tool: string; route: string; seatRoute?: string; params?: Record<string, unknown>; seat: { id: string; token: string; controls: string }; summary: string } | null;
    observe: { tool: string; params?: Record<string, unknown>; summary: string };
    act: { tool: string; params?: Record<string, unknown>; summary: string };
    autoplay?: { tool: string; summary: string };
    leave?: { tool: string; route: string; params?: Record<string, unknown>; summary: string } | null;
  };
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
  // Config-only — the key comes from the plugin config (openclaw config set
  // plugins.entries.<id>.config.apiKey). We deliberately do NOT read it from the
  // OS environment: an env read + network send in one module trips OpenClaw's
  // "credential harvesting" scanner, and config is the portable channel anyway.
  return cfg.apiKey ?? undefined;
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
  // Tells the lobby roster what kind of client — and which VERSION — holds this
  // seat. PLUGIN_VERSION is read from package.json (bumped by the publish
  // pipeline) so the pitch can see which plugin build a seat is actually running.
  const RUNTIME = { "x-agent-runtime": `openclaw-plugin/agent-messier@${PLUGIN_VERSION}` };
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
    throw new Error("not in a match — use soccer_join first");
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

export const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
export const err = (msg: string) => ({ content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true });

// ── venue-URL resolution (origin → base URL); kept — generate.ts imports it. ──
const VENUE_DEFAULTS: Record<string, string> = { taskmarket: "http://localhost:3030" };
export function venueUrl(origin: string, cfg: PluginCfg): string {
  // A registry origin is normally a full URL (used as-is) or "pitch" (the
  // configured serverUrl). Short names fall back to a baked default. No OS
  // environment read here — keeps this network module config-only, so
  // OpenClaw's env+network scanner stays quiet.
  if (origin.startsWith("http://") || origin.startsWith("https://")) return origin;
  if (origin === "pitch") return (cfg.serverUrl ?? "http://localhost:3010").replace(/\/$/, "");
  return VENUE_DEFAULTS[origin] ?? (cfg.serverUrl ?? "http://localhost:3010");
}

// ── Member / account tools — soccer cosmetic + ownership, NOT lifecycle, so
// they stay hand-written (a venue's lifecycle tools are generated; perks aren't). ──
export function memberTools(cfg: PluginCfg): AnyAgentTool[] {
  const client = pitchClient(cfg);
  const agentId = agentIdOf(cfg);
  return [
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
        "Link this agent to its human owner's AgentNet account. The human gets a one-time code from the AgentNet site ('Claim my agent') and tells it to you — e.g. 'claim me on AgentNet with code 7F3K-92'. Redeems with this agent's API key (prod); on a dev pitch (no key) it self-asserts this agent's id. Either way the human never handles the key.",
      parameters: Type.Object({
        code: Type.String({ description: "the one-time claim code the human read out, e.g. 7F3K-92AB" }),
      }),
      async execute(_id, params) {
        const key = apiKeyOf(cfg);
        const base = (cfg.accountsUrl ?? "http://localhost:3005").replace(/\/$/, "");
        const res = await fetch(`${base}/agents/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          // agentId lets a dev (REQUIRE_AUTH=0) agent claim without a key; prod ignores it and uses the Bearer→DID.
          body: JSON.stringify({ code: params.code, agentId: agentIdOf(cfg) }),
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

// ── Platform tool: the marketplace registry (venue-agnostic). ──
export function venuesTool(cfg: PluginCfg): AnyAgentTool {
  const base = (cfg.serverUrl ?? "http://localhost:3010").replace(/\/$/, "");
  return {
    name: "venues",
    label: "Platform venues",
    description: "List every venue on the AgentNet platform — games (agent-soccer; golf later) and work marketplaces (taskmarket). Each venue's own tools (soccer_join, work_act, …) are GENERATED from its spec. Use to discover where you can play or earn.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const res = await fetch(`${base}/platform/marketplaces`);
        if (!res.ok) return ok({ error: `registry unavailable (${res.status})` });
        const { marketplaces } = (await res.json()) as { marketplaces: Record<string, unknown>[] };
        return ok({ venues: marketplaces.map(v => ({ id: v["id"], name: v["name"], kind: v["kind"], origin: v["origin"], feeBps: v["feeBps"], status: v["status"] })),
          hint: "each venue has its own generated tools — games: {id}_join/observe/play; work: work_observe/work_act." });
      } catch (e) { return ok({ error: String(e) }); }
    },
  } as AnyAgentTool;
}
