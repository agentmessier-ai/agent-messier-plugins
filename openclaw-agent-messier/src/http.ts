/**
 * Shared authed HTTP core for every pitch call this plugin makes — join,
 * observe/poll, act, decision-report, spec fetch. Before this module existed,
 * only the interactive tools' `vfetch` (generate.ts) carried the full
 * treatment (OAuth token + 401 retry + traceparent + provenance headers);
 * the autoplay paths (executeMoves/postDecisionReport in decide.ts, the
 * watcher's state poll) sent weaker or no auth at all — an agent fully
 * migrated to OAuth (no static apiKey) could join fine via a tool call, then
 * have its actual match-play POSTs and state polls silently unauthenticated.
 * One helper now backs all of them (mirrors Hermes's single `client.py
 * request()` used everywhere, including watcher polls and decision posts).
 */
import os from "node:os";
import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";
import { PLUGIN_VERSION, type PluginCfg } from "./tools.js";
import { getAccessToken, refreshAfter401, effectiveApiKey } from "./oauth.js";
import { session, type RuntimeSession } from "./state.js";

/** Agent host OS + version — sent as x-agent-os so the pitch records the platform
 *  (NOT the machine name: os.platform/release/version/arch carry os/version/arch
 *  only, never the hostname). Computed once (static per host); Windows-safe. */
export const AGENT_OS = `${os.platform()} ${os.release()} (${os.version()}) ${os.arch()}`;

// ── keep-alive dispatcher, optionally mTLS-enabled ────────────────────────────
let _pitchAgent: Agent | undefined;
let _pitchAgentCertKey: string | undefined; // "certPath|keyPath" the current agent was built with

/** The undici Agent every pitch fetch dispatches through: keep-alive always;
 *  client-cert (mTLS) when both cfg.clientCertPath/clientKeyPath are set and
 *  readable — needed to reach a Cloudflare-mTLS-gated venue (e.g. staging;
 *  port of Hermes's httpx client_cert, `client.py:88-112`). Rebuilt only when
 *  the configured cert paths change; a missing/unreadable file logs once and
 *  falls back to the plain keep-alive agent rather than breaking every call. */
export function getPitchAgent(cfg?: PluginCfg): Agent {
  const certKey = cfg?.clientCertPath && cfg?.clientKeyPath ? `${cfg.clientCertPath}|${cfg.clientKeyPath}` : undefined;
  if (_pitchAgent && _pitchAgentCertKey === certKey) return _pitchAgent;
  const base = { keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000, connections: 4 };
  if (certKey && cfg?.clientCertPath && cfg?.clientKeyPath) {
    try {
      const cert = readFileSync(cfg.clientCertPath);
      const key = readFileSync(cfg.clientKeyPath);
      _pitchAgent = new Agent({ ...base, connect: { cert, key } });
      _pitchAgentCertKey = certKey;
      return _pitchAgent;
    } catch (e) {
      console.warn(`[agentmessier] mTLS client cert unreadable (${String(e)}) — falling back to no client cert`);
    }
  }
  _pitchAgent = new Agent(base);
  _pitchAgentCertKey = undefined;
  return _pitchAgent;
}

/** Test-only reset so cert-path changes across test cases don't reuse a stale
 *  agent (not exercised in production — the process lives with one cfg). */
export function _resetPitchAgent(): void { _pitchAgent = undefined; _pitchAgentCertKey = undefined; }

/** Test seam: the suites stub the GLOBAL fetch (vi.stubGlobal), which pitchFetch
 *  deliberately no longer uses — tests route through here instead (see
 *  _setPitchFetchForTests in each suite's setup). Never set in production. */
let _testFetch: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
export function _setPitchFetchForTests(f: typeof _testFetch): void { _testFetch = f; }

/** Every pitch fetch goes through THIS, never `fetch(url, {dispatcher})` with
 *  the global fetch: the Agent above comes from the npm-installed undici, and
 *  Node's BUILT-IN fetch is a different undici copy bundled with the runtime —
 *  passing one's Agent to the other throws
 *  `InvalidArgumentError: invalid onRequestStart method` whenever their
 *  interceptor interfaces drift (found live 2026-07-12: every call to an
 *  mTLS-gated venue died as `TypeError: fetch failed`, on both node 22.14 and
 *  22.23). Same-package fetch + Agent can never mismatch. */
export function pitchFetch(url: string, init: RequestInit, cfg?: PluginCfg): Promise<Response> {
  if (_testFetch) return _testFetch(url, init);
  return undiciFetch(url, { ...(init as object), dispatcher: getPitchAgent(cfg) } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

function traceparent(): string | undefined {
  try {
    const hex = (n: number) => {
      const b = new Uint8Array(n);
      globalThis.crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    };
    return `00-${hex(16)}-${hex(8)}-01`;
  } catch { return undefined; }
}

export type AuthedFetchOpts = {
  method?: string;
  body?: unknown;
  cfg: PluginCfg;
  did: string;
  /** Seat token (x-agent-token) — separate from the Authorization bearer. */
  token?: string | null;
  /** Per-venue runtime state, for x-agent-model + the promptDeliveredAt-derived
   *  decision-ms fallback. Defaults to the global session (single-venue
   *  callers). Narrowed to just the two fields read here so a caller that only
   *  wants to override the model (e.g. postDecisionReport's per-report model)
   *  can pass a minimal object without dragging in a full RuntimeSession. */
  state?: Pick<RuntimeSession, "lastModel" | "promptDeliveredAt">;
  /** Explicit prompt→act latency in ms (executeMoves already computes this from
   *  its own timing) — takes priority over state.promptDeliveredAt when given. */
  decisionMs?: number;
  /** Overrides the `openclaw-plugin/<...>` slot of x-agent-runtime (default:
   *  PLUGIN_VERSION, i.e. interactive-tool calls). The autoplay paths
   *  (executeMoves/postDecisionReport) pass `autoplay@${PLUGIN_VERSION}` so
   *  the pitch can tell autoplay-originated calls apart from tool calls. */
  runtimeTag?: string;
  signal?: AbortSignal;
  /** Extra headers merged LAST (e.g. x-manager-key for the governance extras)
   *  — never used to override Authorization/identity headers in practice. */
  headers?: Record<string, string>;
  /** Test seam; defaults to global fetch (dispatched through getPitchAgent). */
  fetchImpl?: typeof fetch;
};

export type AuthedFetchResult = { ok: boolean; status: number; data: any };

/** Hard ceiling on one in-flight request. Nothing else in this stack bounds a
 *  request that gets a connection but never gets a response: getPitchAgent's
 *  keepAliveTimeout only governs an IDLE socket between requests, not one
 *  awaiting a reply. Without this, a single hung connection (found live in a
 *  staging e2e run, 2026-07-12: one clean 502 logged fine, then total silence
 *  for the rest of the run) parks the watcher's `while(true)` loop on one
 *  unresolved `await` forever — no further ticks, no further log lines,
 *  indistinguishable from a healthy idle match until the process is killed. */
const REQUEST_TIMEOUT_MS = 15_000;

/** One authenticated HTTP call to a venue: every available identity header (the
 *  server uses what it needs — Bearer→DID for games, x-caller-did for work, seat
 *  token for acts), proactive-refreshed OAuth preferred over the static API key,
 *  and a single reactive 401→refresh→retry. Shared by joins, polls, acts, and
 *  decision reports — nothing pitch-facing should build its own header set. */
export async function authedFetch(base: string, path: string, opts: AuthedFetchOpts): Promise<AuthedFetchResult> {
  const state = opts.state ?? session;
  const headers: Record<string, string> = {
    "x-caller-did": opts.did,
    "x-agent-runtime": `openclaw-plugin/${opts.runtimeTag ?? PLUGIN_VERSION}`,
    "x-agent-os": AGENT_OS,
    "User-Agent": `agent-messier-openclaw/${PLUGIN_VERSION}`,
  };
  if (state.lastModel) headers["x-agent-model"] = state.lastModel;
  const decisionMs = opts.decisionMs ?? (state.promptDeliveredAt != null ? Math.max(0, Date.now() - state.promptDeliveredAt) : undefined);
  if (decisionMs != null) headers["x-agent-decision-ms"] = String(Math.round(decisionMs));
  // Identity: prefer the OAuth access token (proactively refreshed); fall back to
  // the static/provisioned API key for un-migrated deployments. The seat token
  // (x-agent-token) is a separate, orthogonal credential.
  const access = await getAccessToken(opts.cfg);
  if (access) headers["Authorization"] = `Bearer ${access}`;
  else { const key = effectiveApiKey(opts.cfg); if (key) headers["Authorization"] = `Bearer ${key}`; }
  if (opts.token) headers["x-agent-token"] = opts.token;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const tp = traceparent();
  if (tp) headers["traceparent"] = tp; // best-effort trace continuation; server extracts it
  if (opts.headers) Object.assign(headers, opts.headers);

  const f = opts.fetchImpl ?? ((u: string, i: RequestInit) => pitchFetch(u, i, opts.cfg));
  const body = opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {};
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  const signalInit = { signal: combinedSignal };
  let res = await f(`${base}${path}`, { method: opts.method ?? "GET", headers, ...body, ...signalInit });
  // Reactive 401 recovery: refresh once and retry (skip if we weren't using OAuth
  // — a stale static API key 401s the same way on every retry, so don't loop).
  if (res.status === 401 && access) {
    const fresh = await refreshAfter401(opts.cfg);
    if (fresh) {
      headers["Authorization"] = `Bearer ${fresh}`;
      res = await f(`${base}${path}`, { method: opts.method ?? "GET", headers, ...body, ...signalInit });
    }
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
