import { describe, it, expect, afterEach, vi } from "vitest";
import { createSoccerTools, _resetVenueCache, type PluginCfg } from "./tools.js";

const REGISTRY = { marketplaces: [
  { id: "agent-soccer", name: "Agent Soccer", origin: "pitch", specUrl: "/spec", feeBps: 2000, status: "live", kind: "game" },
  { id: "taskmarket", name: "Agent Task Market", origin: "taskmarket", specUrl: "/spec", feeBps: 1000, status: "live", kind: "work" },
] };

const WORK_SPEC = {
  game: "taskmarket", specVersion: 1, rulesVersion: 1,
  actions: { type: "string", enum: ["post", "bid", "deliver"], descriptions: {} },
  observe: { mode: "poll", suggestedIntervalMs: 30000 },
  routes: { observe: "/agents/{did}/observe", act: "/agents/{did}/action" },
  instructions: { system: "s", play: "p", output: "o" },
};

function cfg(extra: Partial<PluginCfg> = {}): PluginCfg {
  return { serverUrl: "http://pitch.test", sessionKey: "did:wba:me", ...extra };
}
function tool(name: string) {
  const tools = createSoccerTools({ pluginConfig: cfg(), config: {} } as any);
  return tools.find(t => t.name === name)!;
}
async function run(name: string, params: unknown): Promise<any> {
  const r = await tool(name).execute("id", params as any) as { content: { text: string }[] };
  return JSON.parse(r.content[0]!.text);
}

describe("multi-venue tools (marketplace registry → generated work tools)", () => {
  afterEach(() => { vi.unstubAllGlobals(); _resetVenueCache(); });

  it("venues lists the registry with kinds", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      expect(String(url)).toContain("/platform/marketplaces");
      return { ok: true, json: async () => REGISTRY } as any;
    }));
    const out = await run("venues", {});
    expect(out.venues.map((v: any) => v.kind)).toEqual(["game", "work"]);
  });

  it("work_observe substitutes the DID into the venue's route template", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
      seen.push(String(url));
      if (String(url).endsWith("/spec")) return { ok: true, json: async () => WORK_SPEC } as any;
      expect(init?.headers?.["x-caller-did"]).toBe("did:wba:me");
      return { ok: true, json: async () => ({ summary: "quiet", events: [], cursor: 0 }) } as any;
    }));
    const out = await run("work_observe", {});
    expect(out.summary).toBe("quiet");
    expect(seen.some(u => u.includes("/agents/did%3Awba%3Ame/observe") || u.includes("/agents/did:wba:me/observe"))).toBe(true);
  });

  it("work_act validates against the venue enum and posts the uniform body", async () => {
    let posted: any = null;
    vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
      if (String(url).endsWith("/spec")) return { ok: true, json: async () => WORK_SPEC } as any;
      posted = JSON.parse(init.body);
      return { ok: true, json: async () => ({ id: "task-1", status: "open" }) } as any;
    }));
    const bad = await run("work_act", { action: "fly" });
    expect(bad.error).toContain("post");
    const ok2 = await run("work_act", { action: "post", title: "t", description: "d", budget: 5 });
    expect(ok2.result.id).toBe("task-1");
    expect(posted).toEqual({ type: "post", title: "t", description: "d", budget: 5 });
  });
});
