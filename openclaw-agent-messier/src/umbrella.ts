/** The `agentmessier` umbrella tool — ONE fixed-name router over every tool
 *  this plugin defines (docs/design/openclaw-umbrella-tool.md).
 *
 *  Why: OpenClaw's tools.alsoAllow matches literal tool names, so every new
 *  granular tool strands hosts configured with per-tool allowlists — and the
 *  public hosts that matter most are exactly the ones our update tooling can
 *  never reach. The ClawHub ecosystem norm (apify/lobster/composio) is one
 *  umbrella tool with actions as parameters: `alsoAllow '["agentmessier"]'`
 *  is one line, forever. Granular tools stay registered untouched — hosts
 *  already on per-tool lists or group:plugins keep working identically.
 *
 *  Pure delegation: `command` is an existing tool's name; `params` passes
 *  through verbatim to that tool's OWN execute closure (mkTool's, with its
 *  try/catch error envelope). Zero game logic here — nothing to drift.
 *
 *  The delegation table is a mutable Map: register() seeds it synchronously
 *  (the 2026-07-14 session-snapshot lesson — the umbrella's NAME must exist
 *  at registration), and start()'s live-spec refresh may re-seed venue
 *  entries later. That's safe because the host snapshot pins only the
 *  umbrella's name+schema, never its routing — which also means a venue
 *  added server-side becomes reachable through the umbrella without a
 *  plugin release, something the granular path can never do. */
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { ok } from "./tools.js";

type ToolLike = { name: string; description?: string; parameters?: unknown; execute: (id: string, params?: object) => Promise<unknown> };

const registry = new Map<string, ToolLike>();

/** Test seam. */
export function _resetUmbrella(): void { registry.clear(); }

/** Seed/refresh the delegation table. Later calls overwrite same-named
 *  entries (live-spec refresh replacing baked-spec builds); the umbrella
 *  closure reads the Map at call time, so no re-registration is needed —
 *  and none must happen (host registerTool APPENDS, no dedup). */
export function umbrellaRegister(tools: AnyAgentTool[]): void {
  for (const t of tools as unknown as ToolLike[]) {
    if (t?.name && t.name !== UMBRELLA_NAME) registry.set(t.name, t);
  }
}

export const UMBRELLA_NAME = "agentmessier";

export function umbrellaCommands(): string[] { return [...registry.keys()].sort(); }

/** One line per command with its top params, harvested from each delegate's
 *  own schema — generated, so it cannot drift from what actually executes.
 *  The "when a hint names a tool" sentence is what makes server-driven hint
 *  cards ("soccer_autoplay off to take over") work on umbrella-only hosts
 *  with zero server copy changes. */
export function buildUmbrellaDescription(): string {
  const byPrefix = new Map<string, string[]>();
  for (const name of umbrellaCommands()) {
    const t = registry.get(name)!;
    const props = (t.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const keys = Object.keys(props).slice(0, 4);
    const prefix = name.includes("_") ? name.split("_")[0]! : "platform";
    const line = keys.length ? `${name}(${keys.join(",")})` : name;
    (byPrefix.get(prefix) ?? byPrefix.set(prefix, []).get(prefix)!).push(line);
  }
  const groups = [...byPrefix.entries()].map(([p, lines]) => `  ${p}: ${lines.join(" · ")}`).join("\n");
  return (
    "Play games and work on the AgentNet platform (soccer matches, task marketplace). " +
    "Call with a command name and its params. When any instruction, hint card, or error " +
    "mentions a tool by name (e.g. \"call soccer_observe\"), invoke THIS tool with " +
    "command=\"soccer_observe\". Unknown commands return the full valid command list.\n" +
    "Commands:\n" + groups
  );
}

export function buildUmbrellaTool(): AnyAgentTool {
  return {
    name: UMBRELLA_NAME,
    label: UMBRELLA_NAME,
    description: buildUmbrellaDescription(),
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "One of the commands listed in this tool's description, e.g. soccer_join" },
        params: { type: "object", description: "Arguments for that command — same shape the command documents (see description)" },
      },
    },
    execute: async (id: string, p?: { command?: string; params?: object }) => {
      const cmd = String(p?.command ?? "").trim();
      const t = registry.get(cmd);
      if (!t) return ok({ error: `unknown command "${cmd}"`, commands: umbrellaCommands() });
      return t.execute(id, p?.params ?? {});
    },
  } as unknown as AnyAgentTool;
}
