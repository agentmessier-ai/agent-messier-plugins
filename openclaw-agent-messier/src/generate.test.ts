import { describe, it, expect, afterEach, vi } from "vitest";
import { generateVenueTools, defaultVenueTools, joinVenue, seatOf, defaultRealtimeVenue, isRealtimeVenue, _resetSeats } from "./generate.js";
import { session } from "./state.js";
import type { GameSpec, PluginCfg } from "./tools.js";

function cfg(extra: Partial<PluginCfg> = {}): PluginCfg {
  return { serverUrl: "http://pitch.test", sessionKey: "did:wba:me", ...extra };
}

// A venue the plugin has NEVER heard of — proves tools come from the spec, not code.
const GOLF_VENUE = { id: "agent-golf", origin: "http://golf.test", specUrl: "/spec" };
const GOLF_SPEC: GameSpec = {
  game: "agent-golf", specVersion: 1, rulesVersion: 1,
  actions: { type: "string", enum: ["drive", "chip", "putt"], descriptions: { drive: "tee shot", putt: "on the green" } },
  observe: { mode: "stream", suggestedIntervalMs: 3000 },
  routes: { observe: "/rounds/{matchId}/agents/{did}/observe", act: "/rounds/{matchId}/players/{playerId}/swing" },
  client: {
    prefix: "golf", noun: "round",
    lobby: { tool: "golf_rounds", route: "/rounds", params: {}, summary: "List rounds." },
    join: { tool: "golf_join", route: "/quickround", seatRoute: "/rounds/{matchId}/join", params: { holes: { type: "integer" } }, seat: { id: "matchId", token: "token", controls: "playerIds" }, summary: "Join a round." },
    autoplay: { tool: "golf_autoplay", summary: "Hands-free." },
    observe: { tool: "golf_observe", params: {}, summary: "See the course." },
    act: { tool: "golf_play", params: { club: { type: "string" } }, summary: "Swing." },
  },
};

describe("generated tool surface comes entirely from the spec", () => {
  it("baked soccer + taskmarket specs generate their canonical named tools", () => {
    const names = defaultVenueTools(cfg()).map(t => t.name);
    // soccer (a game, seated): lobby + join + observe + batch play
    expect(names).toEqual(expect.arrayContaining(["soccer_matches", "soccer_join", "soccer_observe", "soccer_play"]));
    // taskmarket (seatless work): observe + act, NO lobby/join
    expect(names).toEqual(expect.arrayContaining(["work_observe", "work_act"]));
    expect(names).not.toContain("work_join");
  });

  it("golf thesis: a brand-new venue's spec yields golf_* tools with ZERO plugin code", () => {
    _resetSeats();
    const tools = generateVenueTools(GOLF_VENUE, GOLF_SPEC, cfg());
    const names = tools.map(t => t.name);
    expect(names).toEqual(["golf_rounds", "golf_join", "golf_observe", "golf_play"]);

    // The act tool is BATCH (golf seats players) and carries the spec's action enum.
    const play = tools.find(t => t.name === "golf_play")!;
    const enumList = (play.parameters as any).properties.moves.items.properties.type.enum;
    expect(enumList).toEqual(["drive", "chip", "putt"]);
    // Per-action descriptions from the spec flow into the tool description.
    expect(play.description).toContain("drive: tee shot");
  });

  it("the act enum tracks the spec — a server-added action surfaces with no plugin edit", () => {
    _resetSeats();
    const evolved: GameSpec = { ...GOLF_SPEC, actions: { ...GOLF_SPEC.actions!, enum: [...GOLF_SPEC.actions!.enum, "flop"] } };
    const play = generateVenueTools(GOLF_VENUE, evolved, cfg()).find(t => t.name === "golf_play")!;
    expect((play.parameters as any).properties.moves.items.properties.type.enum).toContain("flop");
  });
});

describe("joinVenue — the one spec-driven seating path (tool + service share it)", () => {
  afterEach(() => { vi.unstubAllGlobals(); _resetSeats(); });

  it("quickmatch (no matchId) posts to client.join.route and reads the seat block", async () => {
    let url = "", body: any = null;
    vi.stubGlobal("fetch", vi.fn(async (u: any, init?: any) => {
      url = String(u); body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ matchId: "r7", token: "tok", playerIds: ["p1", "p2"], did: "did:wba:me", started: false }) } as any;
    }));
    const seat = await joinVenue(GOLF_VENUE, GOLF_SPEC, cfg({ sessionKey: "did:wba:me" }), { params: { holes: 9 } });
    expect(url).toBe("http://golf.test/quickround");
    expect(body.agentId).toBe("did:wba:me");
    expect(body.holes).toBe(9);                       // whitelisted join param
    expect(seat.id).toBe("r7");                        // seat.id field from spec
    expect(seat.controls).toEqual(["p1", "p2"]);       // seat.controls field
    expect(seat.token).toBe("tok");
    expect(seatOf("agent-golf")?.id).toBe("r7");
    expect(session.matchId).toBe("r7");                // mirrored for the watcher
  });

  it("rejoining a KNOWN room uses seatRoute with {matchId} substituted", async () => {
    let url = "";
    vi.stubGlobal("fetch", vi.fn(async (u: any) => {
      url = String(u);
      return { ok: true, json: async () => ({ matchId: "r7", token: "t", playerIds: ["p1"] }) } as any;
    }));
    await joinVenue(GOLF_VENUE, GOLF_SPEC, cfg(), { matchId: "r7" });
    expect(url).toBe("http://golf.test/rounds/r7/join");
  });

  it("rejoin response without the seat-id field falls back to the matchId joined with", async () => {
    _resetSeats();
    // per-room join responses omit matchId (you already know it from the URL) —
    // seat.id must still resolve, or the observe loop 404s and reclaim-loops.
    vi.stubGlobal("fetch", vi.fn(async () =>
      ({ ok: true, json: async () => ({ token: "t", playerIds: ["p1", "p2", "p3"], started: true }) }) as any));
    const seat = await joinVenue(GOLF_VENUE, GOLF_SPEC, cfg(), { matchId: "r7" });
    expect(seat.id).toBe("r7");
    expect(session.matchId).toBe("r7");
  });

  it("service extras (teamSize/identity) ride along but tool calls omit them", async () => {
    let body: any = null;
    vi.stubGlobal("fetch", vi.fn(async (_u: any, init?: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ matchId: "r1", token: "t", playerIds: [] }) } as any;
    }));
    await joinVenue(GOLF_VENUE, GOLF_SPEC, cfg(), { params: { holes: 18 }, extra: { teamSize: 5, identity: { name: "Eagles" } } });
    expect(body).toMatchObject({ holes: 18, teamSize: 5, identity: { name: "Eagles" } });
  });
});

describe("realtime-venue detection (which venue the autoplay watcher drives)", () => {
  it("a streamed + seated + autoplay venue is realtime; seatless/poll is not", () => {
    expect(isRealtimeVenue(GOLF_SPEC)).toBe(true);
    expect(isRealtimeVenue({ ...GOLF_SPEC, observe: { mode: "poll", suggestedIntervalMs: 1000 } })).toBe(false);
    expect(isRealtimeVenue({ ...GOLF_SPEC, client: { ...GOLF_SPEC.client!, join: null } } as GameSpec)).toBe(false);
    expect(isRealtimeVenue(null)).toBe(false);
  });

  it("the baked defaults pick soccer (realtime), never the seatless taskmarket", () => {
    const rt = defaultRealtimeVenue();
    expect(rt?.venue.id).toBe("agent-soccer");
    expect(rt?.spec.client?.act.tool).toBe("soccer_play");
  });
});
