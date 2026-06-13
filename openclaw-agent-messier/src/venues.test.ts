import { describe, it, expect, afterEach, vi } from "vitest";
import { venuesTool, type GameSpec, type PluginCfg } from "./tools.js";
import { generateVenueTools, _resetSeats } from "./generate.js";

const REGISTRY = { marketplaces: [
  { id: "agent-soccer", name: "Agent Soccer", origin: "pitch", specUrl: "/spec", feeBps: 2000, status: "live", kind: "game" },
  { id: "taskmarket", name: "Agent Task Market", origin: "taskmarket", specUrl: "/spec", feeBps: 1000, status: "live", kind: "work" },
] };

const WORK_VENUE = { id: "taskmarket", origin: "taskmarket", specUrl: "/spec" };
const WORK_SPEC: GameSpec = {
  game: "taskmarket", specVersion: 1, rulesVersion: 1,
  actions: { type: "string", enum: ["post", "bid", "deliver"], descriptions: {} },
  observe: { mode: "poll", suggestedIntervalMs: 30000 },
  routes: { observe: "/agents/{did}/observe", act: "/agents/{did}/action" },
  client: {
    prefix: "taskmarket", noun: "task", lobby: null, join: null,
    observe: { tool: "work_observe", params: { cursor: { type: "number" } }, summary: "See the task market." },
    act: { tool: "work_act", params: { title: { type: "string" }, description: { type: "string" }, budget: { type: "number" } }, summary: "Act in the task market." },
  },
};

function cfg(extra: Partial<PluginCfg> = {}): PluginCfg {
  return { serverUrl: "http://pitch.test", sessionKey: "did:wba:me", ...extra };
}
function workTool(name: string) {
  const tools = generateVenueTools(WORK_VENUE, WORK_SPEC, cfg());
  return tools.find(t => t.name === name)!;
}
async function runTool(t: any, params: unknown): Promise<any> {
  const r = await t.execute("id", params as any) as { content: { text: string }[] };
  return JSON.parse(r.content[0]!.text);
}

describe("multi-venue tools (marketplace registry → generated work tools)", () => {
  afterEach(() => { vi.unstubAllGlobals(); _resetSeats(); });

  it("venues lists the registry with kinds", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      expect(String(url)).toContain("/platform/marketplaces");
      return { ok: true, json: async () => REGISTRY } as any;
    }));
    const out = await runTool(venuesTool(cfg()), {});
    expect(out.venues.map((v: any) => v.kind)).toEqual(["game", "work"]);
  });

  it("work_observe substitutes the DID into the venue's route template", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
      seen.push(String(url));
      expect(init?.headers?.["x-caller-did"]).toBe("did:wba:me");
      return { ok: true, json: async () => ({ summary: "quiet", events: [], cursor: 0 }) } as any;
    }));
    const out = await runTool(workTool("work_observe"), {});
    expect(out.view.summary).toBe("quiet");
    expect(seen.some(u => u.includes("/agents/did%3Awba%3Ame/observe") || u.includes("/agents/did:wba:me/observe"))).toBe(true);
  });

  it("work_act validates against the venue enum and posts the uniform body", async () => {
    let posted: any = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init?: any) => {
      posted = JSON.parse(init.body);
      return { ok: true, json: async () => ({ id: "task-1", status: "open" }) } as any;
    }));
    const bad = await runTool(workTool("work_act"), { type: "fly" });
    expect(bad.error).toContain("post");
    const ok2 = await runTool(workTool("work_act"), { type: "post", title: "t", description: "d", budget: 5 });
    expect(ok2.result.id).toBe("task-1");
    expect(posted).toEqual({ type: "post", title: "t", description: "d", budget: 5 });
  });
});
