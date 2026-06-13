import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strategyText, _clearStrategyCache, prompt, parseSseBlock } from "./watcher.js";
import type { TeamView } from "./format.js";
import type { GameSpec } from "./tools.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "soccer-strat-")); _clearStrategyCache(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const VIEW = {
  tick: 1, clock: 0, phase: "live", team: "home",
  score: { home: 0, away: 0 },
  field: { length: 105, width: 68, attackGoal: { x: 52.5, y: 0 }, ownGoal: { x: -52.5, y: 0 }, goalHalfWidth: 3.66, tickHz: 10 },
  mine: [{ id: "home-9", number: 9, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, hasBall: true }],
  ball: { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, owner: "home-9" },
  teammates: [], opponents: [],
} as unknown as TeamView;

describe("Phase 5 — strategyText (mtime-cached, capped) + prompt injection", () => {
  it("returns '' when the file is absent", () => {
    expect(strategyText(join(dir, "nope.md"))).toBe("");
    expect(strategyText(undefined)).toBe("");
  });

  it("reads a present file", () => {
    const f = join(dir, "strategy.md");
    writeFileSync(f, "Press high. Keep the ball.");
    expect(strategyText(f)).toContain("Press high");
  });

  it("caps the injected text at ~1k chars", () => {
    const f = join(dir, "strategy.md");
    writeFileSync(f, "x".repeat(5000));
    expect(strategyText(f).length).toBeLessThanOrEqual(1000);
  });

  it("refreshes when the file mtime changes", () => {
    const f = join(dir, "strategy.md");
    writeFileSync(f, "first plan");
    expect(strategyText(f)).toContain("first plan");
    writeFileSync(f, "second plan");
    const future = new Date(Date.now() + 5000);
    utimesSync(f, future, future);
    const out = strategyText(f);
    expect(out).toContain("second plan");
    expect(out).not.toContain("first plan");
  });

  it("prompt injects the strategy block when a strategyFile is set", () => {
    const f = join(dir, "strategy.md");
    writeFileSync(f, "Park the bus. Counter fast.");
    const p = prompt(VIEW, "easy", f);
    expect(p.toLowerCase()).toContain("standing instructions");
    expect(p).toContain("Park the bus");
  });

  it("prompt has no strategy block when the file is absent", () => {
    const p = prompt(VIEW, "easy", join(dir, "missing.md"));
    expect(p.toLowerCase()).not.toContain("standing instructions");
  });
});

// ── the self-instructable envelope (generic GSP client) ─────────────────────
const SPEC = {
  game: "agent-soccer", specVersion: 1, rulesVersion: 2,
  actions: { type: "string", enum: ["chase", "shoot", "lob"], descriptions: { lob: "chip it" } },
  instructions: {
    system: "You are a decisive tactician.",
    play: "SERVER PLAY GUIDANCE: lob when the keeper is off his line.",
    output: 'Reply with ONLY JSON {"moves":{...}}',
  },
} as unknown as GameSpec;

const VIEW_WITH_SUMMARY = { ...VIEW, summary: "⚽ SERVER-RENDERED SITUATION." } as TeamView & { summary: string };

describe("generic prompt — instructions + summary come from the server", () => {
  it("uses the server's instructions and summary when a spec is cached", () => {
    const p = prompt(VIEW_WITH_SUMMARY, "easy", undefined, SPEC, "golf_play");
    expect(p).toContain("SERVER-RENDERED SITUATION");
    expect(p).toContain("SERVER PLAY GUIDANCE");
    // tool-calling host: act via the venue's act tool, named from the spec
    expect(p).toContain("golf_play");
    // the plugin's hardcoded soccer prose is gone on this path
    expect(p).not.toContain("YOU ATTACK +x: opponent goal at x=+52.5");
  });

  it("keeps the strategy block on the generic path", () => {
    const f = join(dir, "strategy.md");
    writeFileSync(f, "Park the bus tonight.");
    const p = prompt(VIEW_WITH_SUMMARY, "easy", f, SPEC);
    expect(p).toContain("Park the bus tonight");
    expect(p).toContain("SERVER PLAY GUIDANCE");
  });

  it("falls back to local rendering when there is no spec (old server)", () => {
    const p = prompt(VIEW, "easy", undefined, null);
    expect(p).toContain("soccer_play"); // the legacy describeTeam path
  });
});

describe("parseSseBlock — named events for the handshake", () => {
  it("parses a named event block", () => {
    const b = parseSseBlock('event: spec\ndata: {"game":"agent-soccer"}');
    expect(b.event).toBe("spec");
    expect(JSON.parse(b.data!)).toEqual({ game: "agent-soccer" });
  });

  it("parses a plain data block (no event name)", () => {
    const b = parseSseBlock('data: {"tick":1}');
    expect(b.event).toBeUndefined();
    expect(JSON.parse(b.data!)).toEqual({ tick: 1 });
  });

  it("ignores comments and empty payloads", () => {
    expect(parseSseBlock(": connected").data).toBeUndefined();
    expect(parseSseBlock("data: ").data).toBeUndefined();
  });
});

import { observeUrl } from "./watcher.js";

describe("observeUrl — venue-agnostic observe endpoint (VA-4)", () => {
  it("substitutes spec.routes.observe with matchId + did", () => {
    const spec = { routes: { observe: "/matches/{matchId}/agents/{did}/observe" } } as any;
    expect(observeUrl(spec, "m7", "did:wba:me")).toBe("/matches/m7/agents/did%3Awba%3Ame/observe");
  });
  it("uses a non-soccer venue's route shape unchanged", () => {
    const spec = { routes: { observe: "/golf/{matchId}/player/{did}/look" } } as any;
    expect(observeUrl(spec, "g3", "alice")).toBe("/golf/g3/player/alice/look");
  });
  it("falls back to the soccer-literal route when no spec", () => {
    expect(observeUrl(null, "m9", "bob")).toBe("/matches/m9/agents/bob/observe");
  });
});
