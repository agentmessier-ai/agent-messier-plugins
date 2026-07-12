import { Type } from "@sinclair/typebox";
import { readFileSync, mkdirSync, openSync, closeSync, writeSync, fstatSync, constants as fsConstants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join as joinPath } from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { session } from "./state.js";
import { getAccessToken, effectiveApiKey } from "./oauth.js";
import { getPitchAgent } from "./http.js";

/** Plugin version from package.json (the file the publish pipeline bumps), read
 *  once at module load. Sent in x-agent-runtime so the pitch records WHICH
 *  plugin version holds a seat. Falls back to 'dev' if the manifest is missing. */
export const PLUGIN_VERSION: string = (() => {
  // package.json sits at the package ROOT. The relative depth differs by layout:
  // dev loads src/tools.ts (root is ../), but the esbuild output is dist/src/tools.js
  // (root is ../../). Try a few levels so the real version lands either way; "dev"
  // only if none resolve.
  for (const rel of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      const v = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version;
      if (v) return v;
    } catch { /* try the next candidate */ }
  }
  return "dev";
})();

export type PluginCfg = {
  serverUrl?: string;
  /** Auto quick-match at startup: find-or-create a room. The standard zero-touch
   *  way to get a demo/bot agent playing. Default ON (matches the same
   *  default-on convention as resumeOnBoot below) — set false for the legacy
   *  idle-on-boot behavior. */
  autoJoin?: boolean;
  /** Optional: pin a specific room at startup (overrides autoJoin). */
  matchId?: string;
  /** Reconnect-on-boot: on startup, probe the venue's resume route and rejoin an
   *  in-progress match if the server still has us seated (default ON — a gateway
   *  restart mid-match resumes the SAME game instead of going idle). Set false to
   *  keep the legacy idle-on-boot behavior. */
  resumeOnBoot?: boolean;
  sessionKey?: string;
  /** AgentNet API key — sent as Bearer on join so the server can verify identity
   *  (REQUIRE_AUTH). Falls back to the AGENTMESSIER_API_KEY env var. */
  apiKey?: string;
  /** AgentNet accounts service (person plane) — used to redeem owner claim codes. */
  accountsUrl?: string;
  mode?: "easy" | "advanced" | "both";
  /** Min ms between autoplay decisions (cadence floor). Default 3000 (min 500).
   *  Steady, bounded decision rate independent of model latency. */
  cadenceMs?: number;
  /** Path to a human-editable strategy.md injected into the watcher move prompt
   *  (Phase 5). Capped ~1k chars, mtime-cached so edits apply mid-match. */
  strategyFile?: string;
  /** Venue-neutral display identity sent on join — e.g. {name,nation,clan,style}
   *  for soccer; any venue's identity fields. Changeable at runtime where the
   *  venue supports it (e.g. soccer_set_identity). */
  identity?: Record<string, unknown>;
  /** Venue join params merged into the join body — e.g. {teamSize,team} for
   *  soccer, {holes} for golf. Whitelisted server-side against the venue's spec,
   *  so unknown fields are ignored, not rejected. */
  join?: Record<string, unknown>;
  /** mTLS client certificate PATHS (not inline PEM — no secrets in config
   *  dumps), for venues gated behind a client-cert requirement (e.g. a
   *  Cloudflare mTLS rule on a staging host). Both must be set to take
   *  effect; either missing/unreadable silently falls back to no client
   *  cert (a clear warning is logged, play is never blocked by this). */
  clientCertPath?: string;
  clientKeyPath?: string;
};

export function identityOf(cfg: PluginCfg): Record<string, unknown> {
  return cfg.identity ?? {};
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
    join?: { tool: string; route: string; seatRoute?: string; resumeRoute?: string; params?: Record<string, unknown>; seat: { id: string; token: string; controls: string }; summary: string } | null;
    observe: { tool: string; params?: Record<string, unknown>; summary: string };
    act: { tool: string; params?: Record<string, unknown>; summary: string };
    autoplay?: { tool: string; summary: string; delegate?: boolean };
    leave?: { tool: string; route: string; params?: Record<string, unknown>; summary: string } | null;
  };
};

/** Fetch GET /spec (the game manifest). Returns null when unreachable or
 *  malformed so callers fall back to the static vocabulary (offline-safe). */
export async function fetchSpec(cfg: PluginCfg): Promise<GameSpec | null> {
  const base = (cfg.serverUrl ?? "https://www.agentmessier.com").replace(/\/$/, "");
  try {
    // Dispatched through the (optionally mTLS) agent — a client-cert-gated host
    // requires the cert at the TLS handshake for EVERY request, including this
    // unauthenticated spec fetch; without it, nothing on that venue works at all.
    const res = await fetch(`${base}/spec`, { dispatcher: getPitchAgent(cfg) } as unknown as RequestInit);
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
  const base = (cfg.serverUrl ?? "https://www.agentmessier.com").replace(/\/$/, "");
  for (const url of [`${base}/matches/${encodeURIComponent(matchId)}/spec`, `${base}/spec`]) {
    try {
      const res = await fetch(url, { dispatcher: getPitchAgent(cfg) } as unknown as RequestInit);
      if (!res.ok) continue;
      const spec = (await res.json()) as GameSpec;
      if (spec && typeof spec === "object" && Array.isArray(spec.actions?.enum)) return spec;
    } catch { /* next rung */ }
  }
  return null;
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

// Per-agent caches shared across processes (the gateway joins; chat-turn processes
// need the same token + DID to act). Stored under a PER-USER, owner-only directory
// (mode 0700) — NOT the world-traversable tmpdir — so another local user on a shared
// host can't plant a symlink at a predictable path to clobber our write or POISON
// the cache (which holds the seat token + venue specs the agent then trusts). Reads
// and writes refuse to follow symlinks (O_NOFOLLOW where the OS supports it) and a
// read verifies a regular file owned by the current user before parsing.
const NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
function cacheDir(): string {
  const dir = joinPath(homedir(), ".agent-messier", "cache");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
/** Path to an owner-only cache file (creates the 0700 dir). Shared with generate.ts. */
export function cacheFilePath(name: string): string {
  return joinPath(cacheDir(), `${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}.json`);
}
/** Symlink-refusing 0600 write. Best-effort (caching is non-critical). */
export function secureWriteJson(path: string, value: unknown): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o600);
    writeSync(fd, JSON.stringify(value));
  } catch { /* best-effort */ } finally { if (fd !== null) { try { closeSync(fd); } catch { /* */ } } }
}
/** Symlink-refusing read that confirms a regular file owned by us before parsing. */
export function secureReadJson<T>(path: string): T | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    const uid = userInfo().uid;
    if (!st.isFile() || (uid >= 0 && st.uid !== uid)) return null; // not a regular file we own
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } catch { return null; } finally { if (fd !== null) { try { closeSync(fd); } catch { /* */ } } }
}
function cachePath(kind: string, key: string): string {
  return cacheFilePath(`${kind}-${key}`);
}
export function rememberToken(cfg: PluginCfg, token: string): void {
  session.token = token;
  secureWriteJson(cachePath("token", idKey(cfg)), { token });
}
export function recallToken(cfg: PluginCfg): string | null {
  if (session.token) return session.token;
  const t = secureReadJson<{ token?: string }>(cachePath("token", idKey(cfg)))?.token;
  if (typeof t === "string") { session.token = t; return t; }
  return null;
}
export function rememberDid(cfg: PluginCfg, did: string): void {
  session.did = did;
  secureWriteJson(cachePath("did", idKey(cfg)), { did });
}
export function recallDid(cfg: PluginCfg): string | null {
  if (session.did) return session.did;
  const d = secureReadJson<{ did?: string }>(cachePath("did", idKey(cfg)))?.did;
  if (typeof d === "string") { session.did = d; return d; }
  return null;
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
  // NOTE: a NEW venue (e.g. golf) must advertise its origin as a full http(s)
  // URL in the registry; an unknown short name has no entry in VENUE_DEFAULTS and
  // would fall through to the pitch URL (wrong host). Full-URL origins are the
  // contract for any venue not co-located with the pitch.
  if (origin.startsWith("http://") || origin.startsWith("https://")) return origin;
  if (origin === "pitch") return (cfg.serverUrl ?? "https://www.agentmessier.com").replace(/\/$/, "");
  return VENUE_DEFAULTS[origin] ?? (cfg.serverUrl ?? "https://www.agentmessier.com");
}

// ── Platform tool: the marketplace registry (venue-agnostic). ──
export function venuesTool(cfg: PluginCfg): AnyAgentTool {
  const base = (cfg.serverUrl ?? "https://www.agentmessier.com").replace(/\/$/, "");
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
  } as unknown as AnyAgentTool;
}

// ── Platform tool: agentmessier_claim (owner linking) — parity with hermes tools.py.
// The human mints a one-time code on the AgentNet site and tells it to the agent;
// the agent redeems it authed by its own credential, so the human never handles a
// key. Targets the accounts service (person plane), not the venue. ──
export function agentmessierClaimTool(cfg: PluginCfg): AnyAgentTool {
  const accounts = (cfg.accountsUrl ?? cfg.serverUrl ?? "https://www.agentmessier.com").replace(/\/$/, "");
  return {
    name: "agentmessier_claim",
    label: "Claim agent to owner",
    description: "Link this agent to its human owner's AgentNet account. The human gets a one-time code from the AgentNet site ('Claim my agent') and tells it to you — e.g. 'claim me with code 7F3K-92'. Uses this agent's credential (OAuth token or API key); on a dev pitch it self-asserts this agent's id. The human never handles the key.",
    parameters: { type: "object", properties: { code: { type: "string", description: "the one-time claim code the human read out, e.g. 7F3K-92AB" } }, required: ["code"] },
    async execute(_id: string, params?: Record<string, unknown>) {
      const code = String(params?.code ?? "").trim();
      if (!code) return err("need the claim code the human read out");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // Prefer the OAuth access token, else the config/provisioned API key (parity
      // with the join path); a dev (REQUIRE_AUTH=0) agent self-asserts via agentId.
      const access = await getAccessToken(cfg);
      const bearer = access ?? effectiveApiKey(cfg);
      if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
      try {
        const res = await fetch(`${accounts}/agents/claim`, { method: "POST", headers, body: JSON.stringify({ code, agentId: agentIdOf(cfg) }) });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) return ok({ ok: false, error: (data["error"] as string) ?? `claim failed (${res.status})` });
        return ok({ ok: true, ...data, note: "linked! your owner's membership now unlocks member perks for this agent" });
      } catch (e) { return ok({ ok: false, error: `claim failed: ${String(e)}` }); }
    },
  } as unknown as AnyAgentTool;
}
