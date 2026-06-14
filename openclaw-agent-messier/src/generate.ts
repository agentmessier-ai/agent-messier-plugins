/**
 * Generic per-venue tool generator (venue-agnostic-plugins.md §5.2) — the
 * OpenClaw counterpart of the Hermes generate.py. Given a registry venue + its
 * /spec (with a `client` lifecycle block), emit the named tools as
 * `AnyAgentTool[]`. Handlers are GENERIC: endpoints from spec.routes, seat
 * fields from spec.client.join.seat, action enum from spec.actions. Adding a
 * venue = a registry row + a spec; no per-game code here.
 *
 * The act tool is a BATCH `moves` tool when the venue seats multiple players
 * (a game — preserves the autoplay watcher's "one call, all players" prompt),
 * and a SINGLE action when seatless (a work market). Names + descriptions come
 * from the spec, so generated tools are as well-described as hand-crafted ones.
 */
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { ok, err, venueUrl, agentIdOf, apiKeyOf, rememberDid, rememberToken, type GameSpec, type PluginCfg } from "./tools.js";
import { session } from "./state.js";

export type Venue = { id: string; origin: string; specUrl?: string };
export type Seat = { id?: string; token?: string; controls?: string[]; agentId?: string; started?: boolean; managerUrl?: string };

// Seat per venue (id/token/controls/agentId). The soccer seat is mirrored into
// `session` so the existing service watcher + seat-poller keep working.
const seats = new Map<string, Seat>();
export function _resetSeats(): void { seats.clear(); }
export function seatOf(venueId: string): Seat | undefined { return seats.get(venueId); }

function sub(route: string, kv: Record<string, string>): string {
  return Object.entries(kv).reduce((r, [k, v]) => r.replace(`{${k}}`, encodeURIComponent(v)), route);
}
function did(venueId: string, cfg: PluginCfg): string {
  return seats.get(venueId)?.agentId ?? agentIdOf(cfg);
}

/** One HTTP call to a venue, with every available auth header (the server uses
 *  what it needs: Bearer→DID for games, x-caller-did for work, seat token for acts). */
async function vfetch(base: string, path: string, opts: { method?: string; body?: unknown; cfg: PluginCfg; token?: string; did: string }): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = { "x-caller-did": opts.did, "x-agent-runtime": "openclaw-plugin/0.2.0" };
  if (session.lastModel) headers["x-agent-model"] = session.lastModel; // effective LLM for the pitch roster
  // Prompt→act latency: ms from when the watcher delivered the move prompt to
  // this call. The pitch reads x-agent-decision-ms to record decision speed. Only
  // meaningful on the act POST, but harmless elsewhere (server ignores it there).
  if (session.promptDeliveredAt != null) headers["x-agent-decision-ms"] = String(Math.max(0, Date.now() - session.promptDeliveredAt));
  const key = apiKeyOf(opts.cfg); if (key) headers["Authorization"] = `Bearer ${key}`;
  if (opts.token) headers["x-agent-token"] = opts.token;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method: opts.method ?? "GET", headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function asXY(v: unknown): { x: number; y: number } | null {
  if (Array.isArray(v) && v.length === 2) { const x = Number(v[0]), y = Number(v[1]); return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null; }
  return null;
}
function whitelist(params: Record<string, unknown>, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(props)) {
    if (k === "player" || params[k] === undefined) continue; // player is the routing key, not a body field
    out[k] = asXY(params[k]) ?? params[k];
  }
  return out;
}

// JSON-Schema props (from the spec) double as the TypeBox `parameters` object —
// TypeBox schemas ARE plain JSON-schema at runtime, so the SDK accepts this.
function paramsSchema(props: Record<string, unknown>, extra: Record<string, unknown> = {}, required: string[] = []): unknown {
  return { type: "object", properties: { ...props, ...extra }, ...(required.length ? { required } : {}) };
}

/** Seat into a venue from its spec.client.join — the one join path, shared by
 *  the generated `*_join` tool AND the autoplay service. `route` finds-or-creates
 *  (quickmatch); `seatRoute` (if present) rejoins a KNOWN room. `extra` lets the
 *  service inject config-derived body fields (teamSize/team/identity for soccer)
 *  without this generic helper knowing any venue's semantics. Persists token+DID
 *  to the cross-process cache so a seat taken here is usable from another process. */
export async function joinVenue(
  venue: Venue, spec: GameSpec, cfg: PluginCfg,
  opts: { matchId?: string; params?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
): Promise<Seat> {
  const j = spec.client?.join;
  if (!j) throw new Error(`${venue.id} is not joinable (no client.join in spec)`);
  const sm = j.seat;
  const base = venueUrl(venue.origin, cfg);
  const meId = agentIdOf(cfg);
  const route = opts.matchId && j.seatRoute ? sub(j.seatRoute, { matchId: opts.matchId }) : j.route;
  const body = { agentId: meId, ...(opts.extra ?? {}), ...whitelist(opts.params ?? {}, j.params ?? {}) };
  const r = await vfetch(base, route, { cfg, did: meId, method: "POST", body });
  if (!r.ok) throw new Error(`join ${venue.id}: ${r.status} ${JSON.stringify(r.data)}`);
  const d = r.data;
  if (typeof d.did === "string") rememberDid(cfg, d.did);     // cross-process identity
  if (typeof d.token === "string") rememberToken(cfg, d.token); // cross-process seat token
  // A rejoin via seatRoute already KNOWS the room (it's in the URL), so the
  // server's response omits it — fall back to the matchId we joined with, or
  // seat.id ends up undefined and the observe loop hits /…//… → 404 → reclaim.
  const seat: Seat = { id: d[sm.id] ?? opts.matchId, token: d[sm.token], controls: d[sm.controls] ?? [], agentId: d.did ?? meId, started: d.started, managerUrl: d.managerUrl };
  seats.set(venue.id, seat);
  // soccer back-compat: the service watcher + seat-poller read `session`.
  session.matchId = seat.id ?? null; session.players = seat.controls ?? []; session.token = seat.token ?? null; session.did = seat.agentId ?? null;
  return seat;
}

export function generateVenueTools(venue: Venue, spec: GameSpec, cfg: PluginCfg): AnyAgentTool[] {
  const c = spec.client!;
  const base = venueUrl(venue.origin, cfg);
  const enumList = spec.actions?.enum ?? [];
  const descs = spec.actions?.descriptions ?? {};
  const out: AnyAgentTool[] = [];

  if (c.lobby) {
    const s = c.lobby;
    out.push({ name: s.tool, label: s.tool, description: s.summary, parameters: paramsSchema(s.params ?? {}),
      async execute(_id, params) {
        const r = await vfetch(base, s.route, { cfg, did: did(venue.id, cfg) });
        if (!r.ok) return ok({ error: r.data?.error ?? `lobby ${r.status}` });
        let rows = (r.data?.matches ?? r.data?.rows ?? []) as Record<string, unknown>[];
        const want = String((params as any).status ?? "").trim().toLowerCase();
        if (want) rows = rows.filter(x => x["status"] === want);
        return ok({ count: rows.length, rows, hint: `join with ${c.prefix}_join` });
      } } as AnyAgentTool);
  }

  if (c.join) {
    const s = c.join;
    out.push({ name: s.tool, label: s.tool, description: s.summary, parameters: paramsSchema(s.params ?? {}),
      async execute(_id, params) {
        try {
          // matchId (if the spec advertises it) targets a SPECIFIC room via
          // seatRoute; it's routing, not a body field, so pull it out of params.
          const { matchId: mid, ...rest } = (params ?? {}) as Record<string, unknown>;
          const seat = await joinVenue(venue, spec, cfg, { matchId: typeof mid === "string" && mid ? mid : undefined, params: rest });
          const watchUrl = `${base}/matches/${seat.id}/view`;
          return ok({ joined: seat.id, yours: seat.controls, watchUrl, managerUrl: seat.managerUrl,
            // Lead with the watch link so the agent SHOWS it to its human — that's
            // how they actually find the match. Then the play loop.
            note: `Seated in ${seat.id}. TELL YOUR HUMAN they can watch live here: ${watchUrl}${seat.managerUrl ? ` (manager console: ${seat.managerUrl})` : ""}. Then observe with ${c.observe.tool} and play with ${c.act.tool}.` });
        } catch (e) { return ok({ error: String(e instanceof Error ? e.message : e) }); }
      } } as AnyAgentTool);
  }

  // observe
  {
    const s = c.observe;
    const route = spec.routes?.["state"] ?? spec.routes?.["observe"] ?? "/matches/{matchId}/agents/{did}/observe";
    out.push({ name: s.tool, label: s.tool, description: s.summary, parameters: paramsSchema(s.params ?? {}),
      async execute(_id, params) {
        const seat = seats.get(venue.id) ?? {}; const d = did(venue.id, cfg);
        let path = sub(route, { matchId: seat.id ?? "", did: d });
        if ((s.params ?? {})["cursor"] !== undefined) path += `?cursor=${Number((params as any).cursor ?? 0)}`;
        const r = await vfetch(base, path, { cfg, did: d });
        if (!r.ok) return ok({ error: r.status === 404 ? "your match/seat is gone — join again" : (r.data?.error ?? `observe ${r.status}`) });
        return ok({ view: r.data, hint: `order with ${c.act.tool}` });
      } } as AnyAgentTool);
  }

  // act — BATCH (moves[]) for venues that seat multiple players (a game), else SINGLE.
  {
    const s = c.act;
    const actRoute = spec.routes?.["act"] ?? "/matches/{matchId}/players/{playerId}/action";
    const batch = !!c.join?.seat?.controls; // games seat players → batch; seatless work → single
    const desc = s.summary + (Object.keys(descs).length ? " Actions — " + enumList.filter(a => descs[a]).map(a => `${a}: ${descs[a]}`).join("; ") : "");
    if (batch) {
      out.push({ name: s.tool, label: s.tool,
        description: desc + " Set actions for ALL players you control in ONE call: pass moves=[{player, type, …}], one per player.",
        parameters: paramsSchema({}, { moves: { type: "array", items: paramsSchema(s.params ?? {}, { player: { type: "string", description: "your player id, e.g. home-9" }, type: { type: "string", enum: enumList, description: "the action" } }, ["player", "type"]) } }, ["moves"]),
        async execute(_id, params) {
          const seat = seats.get(venue.id) ?? {}; const d = did(venue.id, cfg);
          const applied: unknown[] = [];
          for (const m of ((params as any).moves ?? []) as Record<string, unknown>[]) {
            const action = String(m.type ?? "").trim();
            if (!enumList.includes(action)) { applied.push({ player: m.player, error: `type must be one of ${JSON.stringify(enumList)}` }); continue; }
            const path = sub(actRoute, { matchId: seat.id ?? "", did: d, playerId: String(m.player ?? "") });
            const body = { agentId: d, type: action, ...whitelist(m, s.params ?? {}), ...(session.lockstep ? { turn: session.turn } : {}) };
            const r = await vfetch(base, path, { cfg, did: d, method: "POST", body, token: seat.token });
            if (r.ok) session.lastActAt = Date.now(); // act-verification: the agent moved its team this turn
            applied.push(r.ok ? { player: m.player, type: action } : { player: m.player, error: r.data?.error ?? r.status });
          }
          return ok({ applied });
        } } as AnyAgentTool);
    } else {
      out.push({ name: s.tool, label: s.tool, description: desc,
        parameters: paramsSchema(s.params ?? {}, { type: { type: "string", enum: enumList, description: "the action" } }, ["type"]),
        async execute(_id, params) {
          const p = params as Record<string, unknown>; const action = String(p.type ?? "").trim();
          if (!enumList.includes(action)) return ok({ error: `type must be one of ${JSON.stringify(enumList)}` });
          const seat = seats.get(venue.id) ?? {}; const d = did(venue.id, cfg);
          const path = sub(actRoute, { matchId: seat.id ?? "", did: d, playerId: String(p.player ?? "") });
          const r = await vfetch(base, path, { cfg, did: d, method: "POST", body: { type: action, ...whitelist(p, s.params ?? {}) }, token: seat.token });
          if (!r.ok) return ok({ error: r.data?.error ?? `act ${r.status}` });
          session.lastActAt = Date.now(); // act-verification: the agent acted this turn
          return ok({ type: action, result: r.data });
        } } as AnyAgentTool);
    }
  }

  // leave — exit the current match (a forfeit if it's live). Frees the seat so
  // the agent can join another room. Server route from spec.client.leave.
  if (c.leave) {
    const s = c.leave;
    out.push({ name: s.tool, label: s.tool, description: s.summary, parameters: paramsSchema(s.params ?? {}),
      async execute() {
        const seat = seats.get(venue.id) ?? {}; const d = did(venue.id, cfg);
        if (!seat.id) return ok({ error: "you are not in a match" });
        const path = sub(s.route, { matchId: seat.id, did: d });
        const r = await vfetch(base, path, { cfg, did: d, method: "POST", body: { agentId: d }, token: seat.token });
        // Clear our seat either way — a failed leave shouldn't leave us wedged.
        seats.delete(venue.id); session.matchId = null; session.players = []; session.token = null;
        if (!r.ok) return ok({ error: r.data?.error ?? `leave ${r.status}`, note: "seat cleared locally; you can try joining again" });
        return ok({ left: r.data?.left ?? seat.id, ...r.data, hint: `you're free — ${c.join?.tool ?? "join"} another room` });
      } } as AnyAgentTool);
  }

  return out;
}

// ── discovery + offline fallback (mirrors generate.py) ────────────────────────
const DEFAULT_VENUES: Venue[] = [
  { id: "agent-soccer", origin: "pitch", specUrl: "/spec" },
  { id: "taskmarket", origin: "taskmarket", specUrl: "/spec" },
];

export async function discoverVenues(cfg: PluginCfg): Promise<Venue[]> {
  try {
    const res = await fetch(`${venueUrl("pitch", cfg)}/platform/marketplaces`);
    if (res.ok) { const { marketplaces } = (await res.json()) as { marketplaces: Venue[] }; if (marketplaces?.length) return marketplaces; }
  } catch { /* offline */ }
  return DEFAULT_VENUES;
}

export async function fetchVenueSpec(venue: Venue, cfg: PluginCfg): Promise<GameSpec | null> {
  try {
    const res = await fetch(`${venueUrl(venue.origin, cfg)}${venue.specUrl ?? "/spec"}`);
    if (res.ok) { const s = (await res.json()) as GameSpec; if (s?.client) return s; }
  } catch { /* offline → caller skips this venue's generated tools */ }
  return null;
}

/** Every venue's generated tools — discovered from the registry, spec per venue. */
export async function allVenueTools(cfg: PluginCfg): Promise<AnyAgentTool[]> {
  const out: AnyAgentTool[] = [];
  for (const v of await discoverVenues(cfg)) {
    const spec = await fetchVenueSpec(v, cfg);
    if (spec?.client) out.push(...generateVenueTools(v, spec, cfg));
  }
  return out;
}

// ── baked default specs (offline-safe) — register() is sync (can't await a
// fetch), so it generates from these; they mirror the server's client blocks.
const DEFAULT_SPECS: Record<string, GameSpec> = {
  "agent-soccer": {
    game: "agent-soccer", specVersion: 1, rulesVersion: 2,
    actions: { type: "string", enum: ["run", "kick", "chase", "shoot", "dribble", "pass", "defend", "press", "cover", "idle", "stop"], descriptions: {} },
    observe: { mode: "stream", suggestedIntervalMs: 3000 },
    routes: { observe: "/matches/{matchId}/agents/{did}/observe", state: "/matches/{matchId}/agents/{did}/state", act: "/matches/{matchId}/players/{playerId}/action" },
    client: {
      prefix: "soccer", noun: "match",
      lobby: { tool: "soccer_matches", route: "/matches", params: { status: { type: "string", enum: ["live", "waiting", "ended"] } }, summary: "List soccer matches: live, open seats, scores." },
      join: { tool: "soccer_join", route: "/quickmatch", seatRoute: "/matches/{matchId}/join", params: { teamSize: { type: "integer" }, team: { type: "string" }, name: { type: "string" }, nation: { type: "string" }, clan: { type: "string" }, style: { type: "string" }, matchId: { type: "string", description: "join THIS room (e.g. m160) instead of quickmatch" } }, seat: { id: "matchId", token: "token", controls: "playerIds" }, summary: "Join a match and take a whole side. Pass matchId for a specific room, else quickmatch." },
      observe: { tool: "soccer_observe", params: {}, summary: "See the pitch from your side's POV: ball, your players, opponents, score." },
      act: { tool: "soccer_play", params: { dir: { type: "array", items: { type: "number" } }, distance: { type: "number" }, power: { type: "number" }, say: { type: "string" } }, summary: "Order your players — a standing action per player (run/kick need dir)." },
      autoplay: { tool: "soccer_autoplay", summary: "Hands-free play (handled by the watcher service)." },
      leave: { tool: "soccer_leave", route: "/matches/{matchId}/leave", summary: "Leave your match (forfeit if live — opponent wins). Frees you to join another room." },
    },
  },
  "taskmarket": {
    game: "taskmarket", specVersion: 1, rulesVersion: 1,
    actions: { type: "string", enum: ["post", "bid", "accept", "deliver", "confirm", "cancel", "dispute"], descriptions: {} },
    observe: { mode: "poll", suggestedIntervalMs: 30000 },
    routes: { observe: "/agents/{did}/observe", act: "/agents/{did}/action" },
    client: {
      prefix: "taskmarket", noun: "task", lobby: null, join: null,
      observe: { tool: "work_observe", params: { cursor: { type: "number" } }, summary: "See the task market: events, your posts/bids, the open market, per-task legalActions." },
      act: { tool: "work_act", params: { taskId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, budget: { type: "number" }, price: { type: "number" }, message: { type: "string" }, etaHours: { type: "number" }, bidId: { type: "string" }, result: { type: "string" } }, summary: "Act in the task market: post/bid/accept/deliver/confirm/cancel/dispute." },
    },
  },
};

/** Sync tool generation from the baked default venues — used by register()
 *  (which can't await). Live discovery (new venues) uses allVenueTools(). */
export function defaultVenueTools(cfg: PluginCfg): AnyAgentTool[] {
  const out: AnyAgentTool[] = [];
  for (const v of DEFAULT_VENUES) {
    const spec = DEFAULT_SPECS[v.id];
    if (spec?.client) out.push(...generateVenueTools(v, spec, cfg));
  }
  return out;
}

/** Does a spec describe a venue the autoplay watcher can drive? It must stream
 *  observations, seat the agent (players to control), and offer hands-free play.
 *  Soccer qualifies; the seatless poll-based taskmarket does not. */
export function isRealtimeVenue(spec?: GameSpec | null): boolean {
  return !!spec && spec.observe?.mode === "stream" && !!spec.client?.join?.seat && !!spec.client?.autoplay;
}

/** The realtime venue the watcher service should drive, from the baked defaults
 *  (register() is sync). Null when none is realtime. Drives seating/observe/act
 *  entirely from {venue, spec} — no soccer literals in the service. */
export function defaultRealtimeVenue(): { venue: Venue; spec: GameSpec } | null {
  for (const venue of DEFAULT_VENUES) {
    const spec = DEFAULT_SPECS[venue.id];
    if (isRealtimeVenue(spec)) return { venue, spec };
  }
  return null;
}
