import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchSpec, playActionTypes, createSoccerTools, type GameSpec, type PluginCfg } from "./tools.js";

// A FIXTURE manifest with a FAKE action the static list never had. Adding it
// here must surface it in the generated tool with zero further code change.
const FIXTURE: GameSpec = {
  game: "agent-soccer",
  specVersion: 1,
  rulesVersion: 1,
  actions: {
    type: "string",
    enum: ["run", "kick", "chase", "shoot", "teleport", "stop"],
    descriptions: { teleport: "blink to the ball (test-only fake action)" },
  },
};

function cfg(extra: Partial<PluginCfg> = {}): PluginCfg {
  return { serverUrl: "http://pitch.test", sessionKey: `s-${Math.random().toString(36).slice(2)}`, ...extra };
}

describe("Phase 4 — soccer tools generate from /spec (static fallback when absent)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("playActionTypes derives the easy-tier enum from the manifest (fake action included)", () => {
    const acts = playActionTypes(FIXTURE, "easy");
    expect(acts).toContain("teleport");   // the fake action surfaced
    expect(acts).toContain("shoot");
    expect(acts).not.toContain("run");    // run/kick are the advanced tier, excluded from easy
  });

  it("playActionTypes falls back to the static vocabulary when spec is null", () => {
    const acts = playActionTypes(null, "easy");
    expect(acts).toContain("chase");
    expect(acts).toContain("shoot");
    expect(acts).not.toContain("teleport"); // nothing invented offline
  });

  it("fetchSpec returns the manifest from GET /spec", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      expect(String(url)).toContain("/spec");
      return { ok: true, json: async () => FIXTURE } as any;
    }));
    expect(await fetchSpec(cfg())).toEqual(FIXTURE);
  });

  it("fetchSpec returns null when /spec is unreachable (offline-safe)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchSpec(cfg())).toBeNull();
  });

  it("fetchSpec returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, text: async () => "nope" } as any)));
    expect(await fetchSpec(cfg())).toBeNull();
  });

  it("createSoccerTools wires the spec into soccer_play's action enum", () => {
    const tools = createSoccerTools({ pluginConfig: cfg({ mode: "easy" }), config: {} } as any, FIXTURE);
    const play = tools.find(t => t.name === "soccer_play")!;
    const moveSchema: any = (play.parameters as any).properties.moves.items;
    const actionEnum: string[] = moveSchema.properties.action.anyOf.map((s: any) => s.const);
    expect(actionEnum).toContain("teleport");
  });

  it("createSoccerTools without a spec keeps the static play vocabulary", () => {
    const tools = createSoccerTools({ pluginConfig: cfg({ mode: "easy" }), config: {} } as any);
    const play = tools.find(t => t.name === "soccer_play")!;
    const moveSchema: any = (play.parameters as any).properties.moves.items;
    const actionEnum: string[] = moveSchema.properties.action.anyOf.map((s: any) => s.const);
    expect(actionEnum).toContain("chase");
    expect(actionEnum).not.toContain("teleport");
  });
});

// ── per-match spec snapshot + protection ladder ──────────────────────────────
import { fetchMatchSpec } from "./tools.js";

describe("fetchMatchSpec — per-game snapshot with the /spec fallback ladder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the match's snapshot first", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      seen.push(String(url));
      return { ok: true, json: async () => FIXTURE } as any;
    }));
    expect(await fetchMatchSpec(cfg(), "m7")).toEqual(FIXTURE);
    expect(seen[0]).toContain("/matches/m7/spec");
  });

  it("falls back to server-current /spec when the match route fails (old server)", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      seen.push(String(url));
      if (String(url).includes("/matches/")) return { ok: false, status: 404 } as any;
      return { ok: true, json: async () => FIXTURE } as any;
    }));
    expect(await fetchMatchSpec(cfg(), "m7")).toEqual(FIXTURE);
    expect(seen.length).toBe(2);
    expect(seen[1]).toMatch(/\/spec$/);
  });

  it("returns null when the whole ladder fails (caller stays on static fallback and retries later)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchMatchSpec(cfg(), "m7")).toBeNull();
  });
});
