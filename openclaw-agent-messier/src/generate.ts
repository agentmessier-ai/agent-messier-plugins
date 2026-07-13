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
import { ok, err, venueUrl, agentIdOf, identityOf, rememberDid, rememberToken, cacheFilePath, secureWriteJson, secureReadJson, type GameSpec, type PluginCfg } from "./tools.js";
import { authedFetch, pitchFetch } from "./http.js";
import { session, type RuntimeSession } from "./state.js";
import { ACTION_TYPES } from "./decide.js";

/** Thrown by joinVenue on a failed join, carrying the HTTP status so callers
 *  (buildJoin) can give unmistakable, status-specific guidance — e.g. a 401
 *  means re-auth via agentmessier_login, not "the server is down". Mirrors
 *  Hermes's explicit join-failure handling (generate.py:112-120). */
export class JoinError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "JoinError";
    this.status = status;
  }
}

export type Venue = { id: string; origin: string; specUrl?: string };
export type Seat = { id?: string; token?: string; controls?: string[]; agentId?: string; started?: boolean;
  /** The join response's manager console URL — its #mk= fragment is the
   *  manager key the governance extras (propose/approve) authenticate with. */
  managerUrl?: string };

// Seat per venue (id/token/controls/agentId).
const seats = new Map<string, Seat>();
export function _resetSeats(): void { seats.clear(); }
export function seatOf(venueId: string): Seat | undefined { return seats.get(venueId); }

// Per-venue runtime state. The autoplay service registers each realtime venue's
// RuntimeSession here so the GENERATED act tool stamps the SAME lastActAt the
// venue's watcher + decision core read (act-verification agreement across all
// three writers). Unregistered venues (interactive-only) fall back to the global
// session, preserving single-venue behaviour.
const venueStates = new Map<string, RuntimeSession>();
export function setVenueState(venueId: string, state: RuntimeSession): void { venueStates.set(venueId, state); }
export function _resetVenueStates(): void { venueStates.clear(); }
function stateOf(venueId: string): RuntimeSession { return venueStates.get(venueId) ?? session; }

function sub(route: string, kv: Record<string, string>): string {
  return Object.entries(kv).reduce((r, [k, v]) => r.replace(`{${k}}`, encodeURIComponent(v)), route);
}
function did(venueId: string, cfg: PluginCfg): string {
  return seats.get(venueId)?.agentId ?? agentIdOf(cfg);
}

/** One HTTP call to a venue, with every available auth header (the server uses
 *  what it needs: Bearer→DID for games, x-caller-did for work, seat token for
 *  acts). Thin wrapper over the shared `authedFetch` (src/http.ts) — kept so
 *  every call site in this file stays unchanged; the global `session` (not a
 *  per-venue state) is used here, matching this function's historical
 *  single-venue-tool-call semantics. */
async function vfetch(base: string, path: string, opts: { method?: string; body?: unknown; cfg: PluginCfg; token?: string; did: string; headers?: Record<string, string> }): Promise<{ ok: boolean; status: number; data: any }> {
  return authedFetch(base, path, opts);
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
  opts: { matchId?: string; params?: Record<string, unknown>; extra?: Record<string, unknown>;
    /** Seat via a DIFFERENT spec step than client.join — the create tool passes
     *  client.create here (its route always makes a brand-new room); everything
     *  downstream (body build, seat mapping, state hydration) is identical. */
    step?: { route: string; params?: Record<string, unknown>; seat: { id: string; token: string; controls: string } } } = {},
): Promise<Seat> {
  const j = opts.step ? { ...opts.step, seatRoute: undefined as string | undefined } : spec.client?.join;
  if (!j) throw new Error(`${venue.id} is not joinable (no client.join in spec)`);
  const sm = j.seat;
  const base = venueUrl(venue.origin, cfg);
  const meId = agentIdOf(cfg);
  const usingSeatRoute = !!(opts.matchId && j.seatRoute);
  const route = usingSeatRoute ? sub(j.seatRoute!, { matchId: opts.matchId! }) : j.route;
  const body = { agentId: meId, ...(opts.extra ?? {}), ...whitelist(opts.params ?? {}, j.params ?? {}) };
  let r = await vfetch(base, route, { cfg, did: meId, method: "POST", body });
  // Stale-room fallback: a seatRoute rejoin 404s when the pinned room no longer
  // exists (server restart / match reaped). Retry ONCE as a fresh quickmatch
  // (the find-or-create `route`) instead of dead-ending — mirrors Hermes's
  // generate.py:156-159. A quickmatch-route (no matchId) 404 is a real failure,
  // not retried again.
  if (!r.ok && r.status === 404 && usingSeatRoute) {
    r = await vfetch(base, j.route, { cfg, did: meId, method: "POST", body });
  }
  if (!r.ok) throw new JoinError(`join ${venue.id}: ${r.status} ${JSON.stringify(r.data)}`, r.status);
  const d = r.data;
  if (typeof d.did === "string") rememberDid(cfg, d.did);     // cross-process identity
  if (typeof d.token === "string") rememberToken(cfg, venue.id, d.token); // venue-scoped cache (never the global session)
  // A rejoin via seatRoute already KNOWS the room (it's in the URL), so the
  // server's response omits it — fall back to the matchId we joined with, or
  // seat.id ends up undefined and the observe loop hits /…//… → 404 → reclaim.
  const seatId = d[sm.id] ?? opts.matchId;
  // Phantom-seat guard: a 2xx response with NO usable match id means the
  // server accepted the request but we aren't actually seated anywhere — never
  // silently return an unseated "seat" for the caller to act as if joined
  // (mirrors Hermes's generate.py:172-174 "2xx with no match id is NOT a join").
  if (seatId == null) throw new JoinError(`join ${venue.id}: server accepted the request but returned no match id — not seated`, r.status);
  const seat: Seat = { id: seatId, token: d[sm.token], controls: d[sm.controls] ?? [], agentId: d.did ?? meId, started: d.started,
    ...(typeof d.managerUrl === "string" ? { managerUrl: d.managerUrl } : {}) };
  seats.set(venue.id, seat);
  // Mirror into this venue's runtime state (the global session when none is
  // registered) so the watcher/seat-poller and interactive tools see the seat.
  const st = stateOf(venue.id);
  st.matchId = seat.id ?? null; st.players = seat.controls ?? []; st.token = seat.token ?? null; st.did = seat.agentId ?? null;
  return seat;
}

/** Reconnect-on-boot probe (resume-only). Asks the venue's resume route
 *  "am I already seated in a live match?" WITHOUT creating one. Returns the
 *  existing Seat (and hydrates this venue's runtime state, identically to a
 *  successful joinVenue) when the server reports a live seat; returns null when
 *  the agent isn't seated (`matchId:null`) or the venue has no resume support.
 *  The resume route is `client.join.resumeRoute`, defaulting to `<join>/resume`.
 *  Auth/identity are the SAME as joinVenue (agentId + api-key/oauth via vfetch) —
 *  the server only returns a seat token to the caller who already owns it. */
export async function resumeVenue(venue: Venue, spec: GameSpec, cfg: PluginCfg): Promise<Seat | null> {
  const j = spec.client?.join;
  if (!j) return null; // not a joinable venue → nothing to resume
  const sm = j.seat;
  const base = venueUrl(venue.origin, cfg);
  const meId = agentIdOf(cfg);
  const route = j.resumeRoute ?? `${j.route.replace(/\/$/, "")}/resume`;
  const r = await vfetch(base, route, { cfg, did: meId, method: "POST", body: { agentId: meId } });
  // Any non-2xx (e.g. a venue whose server predates resume → 404) → treat as
  // "no seat" so boot falls through to today's idle/autoJoin behavior unchanged.
  if (!r.ok) return null;
  const d = r.data;
  if (!d || d[sm.id] == null) return null; // {matchId:null} → not seated anywhere
  if (typeof d.did === "string") rememberDid(cfg, d.did);
  if (typeof d.token === "string") rememberToken(cfg, venue.id, d.token);
  const seat: Seat = { id: d[sm.id], token: d[sm.token], controls: d[sm.controls] ?? [], agentId: d.did ?? meId, started: d.started };
  seats.set(venue.id, seat);
  const st = stateOf(venue.id);
  st.matchId = seat.id ?? null; st.players = seat.controls ?? []; st.token = seat.token ?? null; st.did = seat.agentId ?? null;
  return seat;
}

// ── data-driven tool generation (mirrors hermes generate.py) ──────────────────
type ClientSpec = NonNullable<GameSpec["client"]>;
type BuildCtx = { venue: Venue; spec: GameSpec; cfg: PluginCfg; base: string; c: ClientSpec; enumList: string[]; descs: Record<string, string> };

/** Build a tool whose execute is wrapped so an UNEXPECTED throw returns a clean
 *  error instead of bubbling into the host agent loop (mirrors hermes `_safe`). */
function mkTool(name: string, description: string, parameters: unknown,
               execute: (id: string, params?: any) => Promise<any>): AnyAgentTool {
  const safe = async (id: string, params?: any) => {
    try { return await execute(id, params); }
    catch (e) { return ok({ error: `${name} failed: ${String(e instanceof Error ? e.message : e)}` }); }
  };
  return { name, label: name, description, parameters, execute: safe } as unknown as AnyAgentTool;
}

function buildLobby({ c, base, cfg, venue }: BuildCtx): AnyAgentTool | null {
  const s = c.lobby; if (!s) return null;
  return mkTool(s.tool, s.summary, paramsSchema(s.params ?? {}), async (_id, params) => {
    const r = await vfetch(base, s.route, { cfg, did: did(venue.id, cfg) });
    if (!r.ok) return ok({ error: r.data?.error ?? `lobby ${r.status}` });
    let rows = (r.data?.matches ?? r.data?.rows ?? []) as Record<string, unknown>[];
    const want = String((params as any).status ?? "").trim().toLowerCase();
    if (want) rows = rows.filter(x => x["status"] === want);
    return ok({ count: rows.length, rows, hint: `join with ${c.prefix}_join` });
  });
}

function buildJoin({ c, base, cfg, venue, spec }: BuildCtx): AnyAgentTool | null {
  const s = c.join; if (!s) return null;
  return mkTool(s.tool, s.summary, paramsSchema(s.params ?? {}), async (_id, params) => {
    // matchId (if the spec advertises it) targets a SPECIFIC room via seatRoute;
    // it's routing, not a body field, so pull it out of params.
    const { matchId: mid, ...rest } = (params ?? {}) as Record<string, unknown>;
    // Config-derived identity/join extras ride along on EVERY join, tool-invoked
    // or service-invoked — previously only the autoplay service injected these
    // (joinExtra in index.ts), so a chat-invoked join appeared nameless/flagless
    // in the viewer. Per-call params still win (whitelist() below is applied
    // AFTER extra in joinVenue's body spread).
    const extra = { ...(cfg.join ?? {}), identity: identityOf(cfg) };
    let seat;
    try {
      seat = await joinVenue(venue, spec, cfg, { matchId: typeof mid === "string" && mid ? mid : undefined, params: rest, extra });
    } catch (e) {
      // Unmistakable join failure — never let the caller narrate a match that
      // didn't happen (mirrors Hermes's generate.py:112-120). A 401 gets
      // specific re-auth guidance since it's silently recoverable.
      const status = e instanceof JoinError ? e.status : undefined;
      const reauth = status === 401 ? ` Your credentials were rejected — run agentmessier_login to re-authenticate.` : "";
      return ok({ ok: false, started: false, error: String(e instanceof Error ? e.message : e),
        note: `MATCH NOT STARTED — you are NOT seated in a match. Do not describe joining a game.${reauth}` });
    }
    // Venue-gated delegation: only a delegate=true venue hands the seat to the
    // watcher on join. Otherwise you're seated MANUAL — drive via observe/play,
    // or run <venue>_autoplay on. Joining never implies hands-free play.
    const delegated = !!(c.autoplay && (c.autoplay as { delegate?: boolean }).delegate) && !!stateOf(venue.id).startWatcher?.();
    const watchUrl = `${base}/matches/${seat.id}/view`;
    const next = delegated
      ? `The watcher is now playing it — ${c.autoplay!.tool} off to take over manually.`
      : `Then observe with ${c.observe.tool} and play with ${c.act.tool}${c.autoplay ? `, or ${c.autoplay.tool} on for hands-free play` : ""}.`;
    return ok({ joined: seat.id, yours: seat.controls, watchUrl, delegated,
      // Lead with the watch link so the agent SHOWS it to its human. No manager console —
      // managing is now via the owner's web session, not a plugin-surfaced URL.
      note: `Seated in ${seat.id}. TELL YOUR HUMAN they can watch live here: ${watchUrl}. ${next}` });
  });
}

function buildObserve({ c, base, cfg, venue, spec }: BuildCtx): AnyAgentTool | null {
  const s = c.observe; if (!s) return null;
  const route = spec.routes?.["state"] ?? spec.routes?.["observe"] ?? "/matches/{matchId}/agents/{did}/observe";
  return mkTool(s.tool, s.summary, paramsSchema(s.params ?? {}), async (_id, params) => {
    const seat = seats.get(venue.id) ?? {}; const d = did(venue.id, cfg);
    let path = sub(route, { matchId: seat.id ?? "", did: d });
    if ((s.params ?? {})["cursor"] !== undefined) path += `?cursor=${Number((params as any).cursor ?? 0)}`;
    const r = await vfetch(base, path, { cfg, did: d });
    if (!r.ok) return ok({ error: r.status === 404 ? "your match/seat is gone — join again" : (r.data?.error ?? `observe ${r.status}`) });
    return ok({ view: r.data, hint: `order with ${c.act.tool}` });
  });
}

function buildAct({ c, base, cfg, venue, spec, enumList, descs }: BuildCtx): AnyAgentTool | null {
  const s = c.act; if (!s) return null;
  const actRoute = spec.routes?.["act"] ?? "/matches/{matchId}/players/{playerId}/action";
  const batch = !!c.join?.seat?.controls; // games seat players → batch; seatless work → single
  const desc = s.summary + (Object.keys(descs).length ? " Actions — " + enumList.filter(a => descs[a]).map(a => `${a}: ${descs[a]}`).join("; ") : "");
  if (batch) {
    return mkTool(s.tool, desc + " Set actions for ALL players you control in ONE call: pass moves=[{player, type, …}], one per player.",
      paramsSchema({}, { moves: { type: "array", items: paramsSchema(s.params ?? {}, { player: { type: "string", description: "your player id, e.g. home-9" }, type: { type: "string", enum: enumList, description: "the action" } }, ["player", "type"]) } }, ["moves"]),
      async (_id, params) => {
        const seat = seats.get(venue.id) ?? {}; const d = did(venue.id, cfg); const st = stateOf(venue.id);
        const applied: unknown[] = [];
        for (const m of ((params as any).moves ?? []) as Record<string, unknown>[]) {
          const action = String(m.type ?? "").trim();
          if (!enumList.includes(action)) { applied.push({ player: m.player, error: `type must be one of ${JSON.stringify(enumList)}` }); continue; }
          const path = sub(actRoute, { matchId: seat.id ?? "", did: d, playerId: String(m.player ?? "") });
          const body = { agentId: d, type: action, ...whitelist(m, s.params ?? {}), ...(st.lockstep ? { turn: st.turn } : {}) };
          const r = await vfetch(base, path, { cfg, did: d, method: "POST", body, token: seat.token });
          if (r.ok) st.lastActAt = Date.now(); // act-verification: the agent moved its team this turn
          applied.push(r.ok ? { player: m.player, type: action } : { player: m.player, error: r.data?.error ?? r.status });
        }
        return ok({ applied });
      });
  }
  return mkTool(s.tool, desc,
    paramsSchema(s.params ?? {}, { type: { type: "string", enum: enumList, description: "the action" } }, ["type"]),
    async (_id, params) => {
      const p = params as Record<string, unknown>; const action = String(p.type ?? "").trim();
      if (!enumList.includes(action)) return ok({ error: `type must be one of ${JSON.stringify(enumList)}` });
      const seat = seats.get(venue.id) ?? {}; const d = did(venue.id, cfg);
      const path = sub(actRoute, { matchId: seat.id ?? "", did: d, playerId: String(p.player ?? "") });
      const r = await vfetch(base, path, { cfg, did: d, method: "POST", body: { type: action, ...whitelist(p, s.params ?? {}) }, token: seat.token });
      if (!r.ok) return ok({ error: r.data?.error ?? `act ${r.status}` });
      stateOf(venue.id).lastActAt = Date.now(); // act-verification: the agent acted this turn
      return ok({ type: action, result: r.data });
    });
}

function buildAutoplay({ c, base, venue }: BuildCtx): AnyAgentTool | null {
  const ap = c.autoplay as { tool: string; summary?: string } | undefined; if (!ap) return null;
  return mkTool(ap.tool, ap.summary ?? "Hands-free play on/off.",
    paramsSchema({
      mode: { type: "string", enum: ["on", "off", "status"], description: "on = hand this seat to the watcher, off = stop (seat kept), status = report" },
      cadenceMs: { type: "number", description: "optional: min ms between decisions" },
    }),
    async (_id, params) => {
      const st = stateOf(venue.id);
      const mode = String((params as any)?.mode ?? "status").toLowerCase();
      if (mode === "off") { st.stopWatcher?.(); return ok({ autoplay: "idle", note: "watcher stopped; your seat is kept — observe/play to drive manually" }); }
      if (mode === "status") return ok({ autoplay: st.watching ? "playing" : "idle", matchId: st.matchId, diagnosis: st.diagnosis });
      if (!st.matchId) return ok({ error: `join a match first with ${c.join?.tool ?? "join"}, then ${ap.tool} on` });
      const cadenceMs = typeof (params as any)?.cadenceMs === "number" ? (params as any).cadenceMs : undefined;
      const started = st.startWatcher?.(cadenceMs) ?? false;
      if (!started) return ok({ error: "could not start the watcher (not seated, or the autoplay service isn't running)" });
      const watchUrl = `${base}/matches/${st.matchId}/view`;
      return ok({ autoplay: "playing", watchUrl, note: `TELL YOUR HUMAN they can watch live here: ${watchUrl}. ${ap.tool} off to stop (and stop spending tokens).` });
    });
}

function buildSelfcheck({ c, venue }: BuildCtx): AnyAgentTool | null {
  // Synthesized (not a spec step) for any playable venue, so a new sport needs no
  // server change. Decoupled from autoplay: autoplay OR a joinable seat gets it.
  if (!(c.prefix && (c.autoplay || c.join))) return null;
  const name = `${c.prefix}_selfcheck`;
  return mkTool(name, "Diagnose play-readiness: pitch server, venue spec, your seat, and the primary model.",
    paramsSchema({}), async () => {
      const st = stateOf(venue.id);
      const diag = st.selfcheck ? await st.selfcheck() : st.diagnosis;
      return ok({ diagnosis: diag ?? { state: "ok", reason: "no self-check has run yet (autoplay service not started)" } });
    });
}

function buildLeave({ c, base, cfg, venue }: BuildCtx): AnyAgentTool | null {
  const s = c.leave; if (!s) return null;
  return mkTool(s.tool, s.summary, paramsSchema(s.params ?? {}), async () => {
    const seat = seats.get(venue.id) ?? {}; const d = did(venue.id, cfg);
    if (!seat.id) return ok({ error: "you are not in a match" });
    // Stop the watcher BEFORE posting leave — otherwise the still-running
    // cadence loop keeps polling the room we just left, 404s, and onReclaim
    // re-joins it (silent auto-rejoin loop that also keeps burning tokens).
    // Mirrors Hermes's generate.py:359 (W.stop() before the leave POST).
    stateOf(venue.id).stopWatcher?.();
    const path = sub(s.route, { matchId: seat.id, did: d });
    const r = await vfetch(base, path, { cfg, did: d, method: "POST", body: { agentId: d }, token: seat.token });
    // Clear our seat either way — a failed leave shouldn't leave us wedged.
    seats.delete(venue.id);
    { const st = stateOf(venue.id); st.matchId = null; st.players = []; st.token = null; }
    if (!r.ok) return ok({ error: r.data?.error ?? `leave ${r.status}`, note: "seat cleared locally; you can try joining again" });
    return ok({ left: r.data?.left ?? seat.id, ...r.data, hint: `you're free — ${c.join?.tool ?? "join"} another room` });
  });
}

function buildCreate({ c, base, cfg, venue, spec }: BuildCtx): AnyAgentTool | null {
  const s = c.create; if (!s) return null;
  return mkTool(s.tool, s.summary, paramsSchema(s.params ?? {}), async (_id, params) => {
    // Same seating plumbing as join, but via the CREATE-ONLY route — never
    // find-or-reseat (that's soccer_join / quickmatch). Config identity/join
    // extras ride along identically.
    const extra = { ...(cfg.join ?? {}), identity: identityOf(cfg) };
    let seat;
    try {
      seat = await joinVenue(venue, spec, cfg,
        { params: (params ?? {}) as Record<string, unknown>, extra, step: { route: s.route, ...(s.params ? { params: s.params } : {}), seat: s.seat } });
    } catch (e) {
      const status = e instanceof JoinError ? e.status : undefined;
      const reauth = status === 401 ? ` Your credentials were rejected — run agentmessier_login to re-authenticate.` : "";
      return ok({ ok: false, started: false, error: String(e instanceof Error ? e.message : e),
        note: `ROOM NOT CREATED — you are NOT seated in a match. Do not describe joining a game.${reauth}` });
    }
    const delegated = !!(c.autoplay && (c.autoplay as { delegate?: boolean }).delegate) && !!stateOf(venue.id).startWatcher?.();
    const watchUrl = `${base}/matches/${seat.id}/view`;
    const next = delegated
      ? `The watcher is now playing it — ${c.autoplay!.tool} off to take over manually.`
      : `Then observe with ${c.observe.tool} and play with ${c.act.tool}${c.autoplay ? `, or ${c.autoplay.tool} on for hands-free play` : ""}.`;
    return ok({ created: seat.id, yours: seat.controls, watchUrl, delegated,
      note: `Created a fresh room and seated in ${seat.id}. TELL YOUR HUMAN they can watch live here: ${watchUrl}. ${next}` });
  });
}

/** One generated tool per spec.client.extras row — a generic single-call REST
 *  tool: substitute {matchId}/{did} from the current seat, attach the declared
 *  extra credential ('seat' → x-agent-token rides authedFetch's token; 'manager'
 *  → x-manager-key parsed from the join response's managerUrl #mk= fragment).
 *  Adding a row server-side ships a new tool with zero plugin code changes. */
function buildExtras({ c, base, cfg, venue }: BuildCtx): AnyAgentTool[] {
  return (c.extras ?? []).map((s) => mkTool(s.tool, s.summary, paramsSchema(s.params ?? {}), async (_id, params) => {
    const seat = seats.get(venue.id) ?? {};
    const p = (params ?? {}) as Record<string, unknown>;
    const matchId = typeof p["matchId"] === "string" && p["matchId"] ? (p["matchId"] as string) : seat.id;
    if (!matchId && s.route.includes("{matchId}")) return ok({ error: `no match — join first (${c.join?.tool ?? "join"}), or pass matchId` });
    const d = did(venue.id, cfg);
    const path = sub(s.route, { matchId: matchId ?? "", did: d });
    const method = (s.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (s.auth === "manager") {
      const mk = /[#?&]mk=([^&#]+)/.exec(seat.managerUrl ?? "")?.[1];
      if (!mk) return ok({ error: `no manager key for this seat — the key arrives with the join response; rejoin (${c.join?.tool ?? "join"}) and retry` });
      headers["x-manager-key"] = mk;
    }
    const bodyFields = { agentId: d, ...whitelist(p, s.params ?? {}) };
    delete (bodyFields as Record<string, unknown>)["matchId"]; // routing, not a body field
    const r = await vfetch(base, path, {
      cfg, did: d, method,
      ...(method !== "GET" ? { body: bodyFields } : {}),
      ...(s.auth === "seat" && seat.token ? { token: seat.token } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    if (!r.ok) return ok({ error: r.data?.error ?? `${s.tool} ${r.status}`, status: r.status });
    return ok({ ...r.data });
  }));
}

/** Ordered lifecycle — the emission order IS the agent-facing tool order. Adding a
 *  step = one builder + one row (mirrors hermes generate.py `_BUILDERS`). The
 *  spec-driven `extras` rows are appended after the lifecycle tools. */
const BUILDERS = [buildLobby, buildJoin, buildCreate, buildObserve, buildAct, buildAutoplay, buildSelfcheck, buildLeave];

/** Drop duplicate tool names (a venue prefix collision / dup registry row), keeping
 *  the first — registering two tools under one name is a host error. */
function dedup(tools: AnyAgentTool[]): AnyAgentTool[] {
  const seen = new Set<string>(); const out: AnyAgentTool[] = [];
  for (const t of tools) { if (seen.has(t.name)) continue; seen.add(t.name); out.push(t); }
  return out;
}

export function generateVenueTools(venue: Venue, spec: GameSpec, cfg: PluginCfg): AnyAgentTool[] {
  const c = spec.client; if (!c) return [];
  const ctx: BuildCtx = { venue, spec, cfg, base: venueUrl(venue.origin, cfg), c, enumList: spec.actions?.enum ?? [], descs: spec.actions?.descriptions ?? {} };
  return dedup([...BUILDERS.map(b => b(ctx)), ...buildExtras(ctx)].filter((t): t is AnyAgentTool => !!t));
}

// ── discovery + offline fallback (mirrors generate.py) ────────────────────────
const DEFAULT_VENUES: Venue[] = [
  { id: "agent-soccer", origin: "pitch", specUrl: "/spec" },
  { id: "taskmarket", origin: "taskmarket", specUrl: "/spec" },
  { id: "agent-golf", origin: "pitch", specUrl: "/golf/spec" },
];

/** Baked-in venues + minimal specs used ONLY when discovery/spec fetch is
 *  unreachable AND no disk cache exists yet (first-run-offline / a gateway
 *  cold-start that races the network) — the plugin still registers venue
 *  tools + starts the autoplay watcher offline, exactly like the Hermes
 *  plugin's DEFAULT_VENUES/DEFAULT_SPECS (generate.py:390-423). Without this,
 *  a single failed cold-start fetch permanently disabled venue tools for the
 *  life of the process (no retry ever fired autoJoin never had a tool to
 *  call) — the root cause of a live E2E failure (2026-07-12).
 *  Kept in sync BY HAND with services/pitch/src/api/spec.ts (GAME_SPEC) and
 *  services/taskmarket/src/gsp/spec.ts (WORK_SPEC) — same convention as
 *  decide.ts's ACTION_TYPES/FALLBACK_ACTIONS fallback lists. */
const DEFAULT_SPECS: Record<string, GameSpec> = {
  "agent-soccer": {
    game: "agent-soccer",
    specVersion: 1,
    rulesVersion: 1,
    actions: { type: "string", enum: [...ACTION_TYPES], descriptions: {} },
    observe: { mode: "stream", suggestedIntervalMs: 3000 },
    routes: {
      observe: "/matches/{matchId}/agents/{did}/observe",
      state: "/matches/{matchId}/agents/{did}/state",
      act: "/matches/{matchId}/players/{playerId}/action",
      decision: "/matches/{matchId}/agents/{did}/decision",
    },
    client: {
      prefix: "soccer",
      noun: "match",
      lobby: { tool: "soccer_matches", route: "/matches", params: { status: { type: "string", enum: ["live", "waiting", "ended"] } }, summary: "List Agent Messier soccer matches (offline default)." },
      join: {
        tool: "soccer_join", route: "/quickmatch", seatRoute: "/matches/{matchId}/join",
        params: { teamSize: { type: "integer" }, team: { type: "string" }, name: { type: "string" }, nation: { type: "string" }, clan: { type: "string" }, style: { type: "string" }, matchId: { type: "string" } },
        seat: { id: "matchId", token: "token", controls: "playerIds" },
        summary: "Join a match and take a side. Pass matchId for a specific room, else quickmatch.",
      },
      observe: { tool: "soccer_observe", params: {}, summary: "See the pitch." },
      act: {
        tool: "soccer_play",
        params: { player: { type: "string" }, dir: { type: "array", items: { type: "number" } }, distance: { type: "number" }, power: { type: "number" }, zone: { type: "string" }, say: { type: "string" } },
        summary: "Order a player.",
      },
      autoplay: { tool: "soccer_autoplay", delegate: true, summary: "Hands-free play on/off." },
      leave: { tool: "soccer_leave", route: "/matches/{matchId}/leave", summary: "Leave your match (forfeit if live)." },
      create: {
        tool: "soccer_create", route: "/rooms",
        params: { teamSize: { type: "integer" }, team: { type: "string" }, name: { type: "string" }, nation: { type: "string" }, clan: { type: "string" }, style: { type: "string" } },
        seat: { id: "matchId", token: "token", controls: "playerIds" },
        summary: "Create a BRAND-NEW room and take a side (never reuses/rejoins — that's soccer_join).",
      },
      extras: [
        { tool: "soccer_result", method: "GET", route: "/matches/{matchId}/result", auth: "none", params: { matchId: { type: "string" } }, summary: "The final result of a match (score, winner, how it ended)." },
        { tool: "soccer_set_identity", method: "POST", route: "/matches/{matchId}/identity", auth: "seat", params: { name: { type: "string" }, nation: { type: "string" }, clan: { type: "string" }, style: { type: "string" } }, summary: "Change your team identity mid-match (may cost credits for non-members)." },
        { tool: "soccer_propose", method: "POST", route: "/matches/{matchId}/controls/propose", auth: "manager", params: { action: { type: "string", enum: ["pause", "resume", "reset", "config"] } }, summary: "Propose a room control (pause/resume/reset) — needs >70% owner approval." },
        { tool: "soccer_approve", method: "POST", route: "/matches/{matchId}/controls/approve", auth: "manager", params: {}, summary: "Approve the pending room-control proposal." },
      ],
    },
  },
  taskmarket: {
    game: "taskmarket",
    specVersion: 1,
    rulesVersion: 1,
    actions: { type: "string", enum: ["post", "bid", "accept", "deliver", "confirm", "cancel", "dispute"], descriptions: {} },
    observe: { mode: "poll", suggestedIntervalMs: 30000 },
    routes: { observe: "/agents/{did}/observe", act: "/agents/{did}/action" },
    client: {
      prefix: "taskmarket", noun: "task", lobby: null, join: null,
      observe: { tool: "work_observe", params: { cursor: { type: "number" } }, summary: "See the task market." },
      act: {
        tool: "work_act",
        params: { taskId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, budget: { type: "number" }, price: { type: "number" }, message: { type: "string" }, etaHours: { type: "number" }, bidId: { type: "string" }, result: { type: "string" } },
        summary: "Act in the task market.",
      },
      autoplay: { tool: "work_autoplay", summary: "Hands-free work on/off." },
    },
  },
};

export async function discoverVenues(cfg: PluginCfg): Promise<Venue[]> {
  try {
    const res = await pitchFetch(`${venueUrl("pitch", cfg)}/platform/marketplaces`, {}, cfg);
    if (res.ok) { const { marketplaces } = (await res.json()) as { marketplaces: Venue[] }; if (marketplaces?.length) return marketplaces; }
  } catch { /* offline */ }
  return DEFAULT_VENUES;
}

export async function fetchVenueSpec(venue: Venue, cfg: PluginCfg): Promise<GameSpec | null> {
  try {
    // Dispatched through the (optionally mTLS) agent — a client-cert-gated
    // venue needs it even for this unauthenticated spec fetch (the TLS
    // handshake itself requires the cert), or nothing on that venue loads.
    const res = await pitchFetch(`${venueUrl(venue.origin, cfg)}${venue.specUrl ?? "/spec"}`, {}, cfg);
    if (res.ok) { const s = (await res.json()) as GameSpec; if (s?.client) return s; }
  } catch { /* offline → caller falls back to disk cache, then the baked default */ }
  return null;
}

/** Fetch a venue's spec live, write to disk cache on success; on network
 *  failure return the cached copy; on first-run-offline (no cache yet) fall
 *  back to the baked DEFAULT_SPECS entry (if any) so tool generation and the
 *  autoplay watcher never hard-fail on a cold-start network hiccup — only
 *  null when the venue is truly unknown (not in DEFAULT_SPECS either).
 *  Cache key: `spec-<venue.id>` under ~/.agent-messier/cache/. */
export async function loadVenueSpec(venue: Venue, cfg: PluginCfg): Promise<GameSpec | null> {
  const path = cacheFilePath(`spec-${venue.id}`);
  const live = await fetchVenueSpec(venue, cfg); // handles errors internally, returns null on fail
  if (live) {
    secureWriteJson(path, live);
    return live;
  }
  // Live fetch failed (offline / non-200) — fall back to the disk cache, then the baked default.
  return secureReadJson<GameSpec>(path) ?? DEFAULT_SPECS[venue.id] ?? null;
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

/** Fetch-live then cache: generate tools for every default venue.
 *  Loads each spec via loadVenueSpec (fetch → disk cache → null). Venues whose
 *  spec is unavailable (offline + no cache) are silently skipped — call sites
 *  should warn the agent if the returned list is empty. */
export async function defaultVenueTools(cfg: PluginCfg): Promise<AnyAgentTool[]> {
  const out: AnyAgentTool[] = [];
  for (const v of DEFAULT_VENUES) {
    const spec = await loadVenueSpec(v, cfg);
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

/** The first realtime venue, loaded via live /spec with disk-cache fallback.
 *  Null when none is realtime or all specs are unavailable. */
export async function defaultRealtimeVenue(cfg: PluginCfg = {}): Promise<{ venue: Venue; spec: GameSpec } | null> {
  return (await defaultRealtimeVenues(cfg))[0] ?? null;
}

/** Every realtime venue from DEFAULT_VENUES — specs loaded live with disk-cache
 *  fallback. Each gets its own watcher, so multiple games run concurrently. */
export async function defaultRealtimeVenues(cfg: PluginCfg = {}): Promise<{ venue: Venue; spec: GameSpec }[]> {
  const out: { venue: Venue; spec: GameSpec }[] = [];
  for (const venue of DEFAULT_VENUES) {
    const spec = await loadVenueSpec(venue, cfg);
    if (isRealtimeVenue(spec)) out.push({ venue, spec: spec! });
  }
  return out;
}

/** Whether any default venue's live/cached spec carries this client prefix — used
 *  to gate soccer-only tools so they aren't offered when soccer is unavailable. */
export async function hasBakedVenuePrefix(prefix: string, cfg: PluginCfg = {}): Promise<boolean> {
  for (const v of DEFAULT_VENUES) {
    const spec = await loadVenueSpec(v, cfg);
    if (spec?.client?.prefix === prefix) return true;
  }
  return false;
}
