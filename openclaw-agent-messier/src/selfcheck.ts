/**
 * Agent play-readiness self-diagnosis.
 *
 * Before (and during) a game the watcher must answer: *can this agent actually
 * play?* That needs four live dependencies — the pitch SERVER is up, the VENUE
 * is speakable (a usable spec), the SEAT/auth is valid, and the primary MODEL
 * produces output. When any silently fails the agent degrades into a wall of
 * empty "no_response" decisions (the m471 incident). This module verifies each
 * and returns a `Diagnosis` the watcher surfaces (logs + tool returns) and pushes
 * to the pitch (rides the decision report → inspector banner).
 *
 * Mirrors the Hermes plugin's selfcheck.py. The MODEL check exercises the SAME
 * `complete` the loop plays with, and reports the raw error (e.g. an undefined
 * provider) instead of a swallowed empty string.
 */
import { fetchMatchSpec, type GameSpec, type PluginCfg } from "./tools.js";
import { stateUrl } from "./watcher.js";
import type { Diagnosis, RuntimeSession } from "./state.js";
import type { LlmComplete } from "./decide.js";

/** The spec manifest shape this plugin understands. */
export const KNOWN_SPEC_VERSION = 1;

export type Check = { name: string; ok: boolean; detail?: string | null };

export type PreflightDeps = {
  base: string;
  cfg: PluginCfg;
  /** The venue's spec (from discovery); fetched if absent. */
  spec?: GameSpec | null;
  /** Per-venue runtime state — the seat check reads matchId/token/did. */
  state: RuntimeSession;
  /** Fallback agentId for the seat-state read (state.did wins). */
  agentId: string;
  /** The direct completion (null on the subagent path → model check is n/a). */
  complete: LlmComplete | null;
  /** Configured primary model name — reported when the live probe can't name one. */
  fallbackModel?: string | undefined;
  /** Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
};

async function checkServer(base: string, f: typeof fetch): Promise<Check> {
  try {
    const res = await f(`${base}/health`, { headers: { Accept: "application/json" } });
    if (!res.ok) return { name: "server", ok: false, detail: `GET /health ${res.status}` };
    const body = (await res.json()) as { ok?: boolean };
    return body?.ok === true
      ? { name: "server", ok: true, detail: "GET /health 200" }
      : { name: "server", ok: false, detail: "GET /health: unexpected response" };
  } catch (e) {
    return { name: "server", ok: false, detail: `unreachable: ${String(e)}`.slice(0, 200) };
  }
}

function checkVenue(spec: GameSpec | null): Check {
  if (!spec || !spec.routes || !spec.actions) {
    return { name: "venue", ok: false, detail: "no usable spec (routes/actions missing)" };
  }
  const sv = (spec as { specVersion?: number }).specVersion;
  if (sv !== undefined && sv !== KNOWN_SPEC_VERSION) {
    return { name: "venue", ok: false, detail: `incompatible specVersion ${sv} (expected ${KNOWN_SPEC_VERSION})` };
  }
  const rules = (spec as { rulesVersion?: number }).rulesVersion;
  return { name: "venue", ok: true, detail: `spec v${sv} rules${rules}` };
}

async function checkSeat(base: string, spec: GameSpec | null, state: RuntimeSession, agentId: string, f: typeof fetch): Promise<Check> {
  if (!state.matchId) return { name: "seat", ok: true, detail: "n/a — not seated" };
  const did = state.did ?? agentId;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (state.token) headers["x-agent-token"] = state.token;
  try {
    const res = await f(`${base}${stateUrl(spec, state.matchId, did)}`, { headers });
    if (res.ok) return { name: "seat", ok: true, detail: "state 200" };
    if (res.status === 404) return { name: "seat", ok: false, detail: "seat/match gone (404)" };
    if (res.status === 401) return { name: "seat", ok: false, detail: "bad/missing seat token (401)" };
    return { name: "seat", ok: false, detail: `state ${res.status}` };
  } catch (e) {
    return { name: "seat", ok: false, detail: `unreachable: ${String(e)}`.slice(0, 160) };
  }
}

async function checkModel(complete: LlmComplete | null, fallbackModel?: string): Promise<{ check: Check; primary: string | null }> {
  if (!complete) {
    return { check: { name: "model", ok: true, detail: "n/a — direct completion not wired (subagent path)" }, primary: fallbackModel ?? null };
  }
  try {
    const r = await complete({ messages: [{ role: "user", content: "Reply with the single word: OK" }], maxTokens: 16, purpose: "agent-selfcheck" });
    const primary = r.model ? (r.provider ? `${r.provider}/${r.model}` : r.model) : (fallbackModel ?? null);
    const suffix = primary ? ` (primary=${primary})` : "";
    if (!(r.text ?? "").trim()) return { check: { name: "model", ok: false, detail: `empty reply${suffix}` }, primary };
    return { check: { name: "model", ok: true, detail: `replied (${primary ?? "model"})` }, primary };
  } catch (e) {
    const primary = fallbackModel ?? null;
    const suffix = primary ? ` (primary=${primary})` : "";
    return { check: { name: "model", ok: false, detail: `error: ${String(e)}${suffix}`.slice(0, 200) }, primary };
  }
}

/**
 * Run all four checks against `base` and return the shared diagnosis contract.
 * `state` is degraded iff any non-n/a check fails; `reason` is the first failure.
 */
export async function preflight(deps: PreflightDeps): Promise<Diagnosis> {
  const f = deps.fetch ?? fetch;
  const base = deps.base.replace(/\/$/, "");
  let spec = deps.spec ?? null;
  if (!spec) spec = await fetchMatchSpec({ serverUrl: deps.cfg.serverUrl } as PluginCfg, deps.state.matchId ?? "").catch(() => null);

  const [server, seat, model] = await Promise.all([
    checkServer(base, f),
    checkSeat(base, spec, deps.state, deps.agentId, f),
    checkModel(deps.complete, deps.fallbackModel),
  ]);
  const venue = checkVenue(spec);
  const checks: Check[] = [server, venue, seat, model.check];
  const failed = checks.find((c) => !c.ok);
  return {
    state: failed ? "degraded" : "ok",
    reason: failed ? (failed.detail ?? failed.name) : null,
    primaryModel: model.primary,
    checkedAt: new Date().toISOString(),
    checks,
  };
}
