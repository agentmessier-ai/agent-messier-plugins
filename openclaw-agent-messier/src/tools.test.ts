import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pitchClient, agentIdOf, apiKeyOf, type PluginCfg } from "./tools.js";
import { session } from "./state.js";

// A config whose sessionKey is unique per test so the cross-process tmp caches
// (token/did) never collide between cases.
function cfg(extra: Partial<PluginCfg> = {}): PluginCfg {
  return { serverUrl: "http://pitch.test", sessionKey: `t-${Math.random().toString(36).slice(2)}`, ...extra };
}

describe("soccer extension join auth", () => {
  beforeEach(() => {
    session.did = null;
    session.token = null;
    session.matchId = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("apiKeyOf comes from config only — never from the environment", () => {
    expect(apiKeyOf(cfg({ apiKey: "from-cfg" }))).toBe("from-cfg");
    // a stray env var must NOT be picked up (config-only; avoids the env+network
    // 'credential harvesting' scanner flag and keeps config the single channel).
    vi.stubEnv("AGENTNET_API_KEY", "from-env");
    expect(apiKeyOf(cfg())).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("quickMatch sends the Bearer key and learns the returned DID", async () => {
    const seen: { auth?: string } = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      seen.auth = init?.headers?.Authorization;
      return { ok: true, json: async () => ({ matchId: "m1", team: "home", playerIds: ["h1"], started: false, did: "did:wba:tester", token: "seat-tok" }) } as any;
    }));

    const c = cfg({ apiKey: "good-key" });
    const data = await pitchClient(c).quickMatch(agentIdOf(c), { teamSize: 5 });

    expect(seen.auth).toBe("Bearer good-key");
    expect(data.did).toBe("did:wba:tester");
    // DID is now this agent's identity for subsequent seat lookups + calls.
    expect(session.did).toBe("did:wba:tester");
    expect(agentIdOf(c)).toBe("did:wba:tester");
    expect(session.token).toBe("seat-tok");
  });

  it("omits the Authorization header when no key is configured (dev mode)", async () => {
    const seen: { auth?: string } = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      seen.auth = init?.headers?.Authorization;
      return { ok: true, json: async () => ({ matchId: "m1", team: "home", playerIds: ["h1"], started: false, token: "seat-tok" }) } as any;
    }));

    const c = cfg(); // no apiKey, no env
    await pitchClient(c).quickMatch(agentIdOf(c), {});
    expect(seen.auth).toBeUndefined();
  });
});
