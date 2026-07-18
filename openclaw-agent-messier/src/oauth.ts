/**
 * OAuth 2.0 client (owner-delegated PKCE) for the agent runtime — the agent half
 * of docs/design/oauth-agent-auth.md. Hand-rolled (node:crypto + node:http, no
 * dependency) mirroring Claude Code's crypto.ts / auth-code-listener.ts /
 * client.ts, to match this plugin's minimal-dep, publicly-shipped, esbuild-bundled
 * convention.
 *
 * `agentmessier_login` runs the browser PKCE flow once; the runtime then sends the
 * access token as Bearer (replacing the static API key) with PROACTIVE refresh
 * (60s buffer), single-flight dedup, multi-process disk-change pickup, and a
 * 401→refresh→retry path the callers use. Tokens live in the SAME hardened 0700
 * secure cache as the seat token (secureReadJson/secureWriteJson).
 *
 * The bootstrap API key (apiKeyOf, config-only) is the agent's "client
 * credential": presented ONLY at the token exchange so accounts can resolve it to
 * the agent DID. It is no longer sent to pitch on every call.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { ok, cacheFilePath, secureReadJson, secureWriteJson, apiKeyOf, type PluginCfg } from "./tools.js";

export type TokenSet = { access_token: string; refresh_token: string; expires_at: number; scope?: string };

const EXPIRY_BUFFER_MS = 60_000; // refresh slightly before the access token actually expires
const CLIENT_ID = "agent-cli";
const PUBLIC_ACCOUNTS_URL = "https://agent.agentmessier.com";

function isLocalHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch { return false; }
}

/** Accounts/OAuth service base — deliberately does NOT just fall back to
 *  cfg.serverUrl (which may point at a local dev pitch): the platform ingress
 *  serves /oauth/* on the PUBLIC host, so if serverUrl is localhost/127.0.0.1
 *  (dev pitch, prod accounts), using it verbatim would send OAuth calls at a
 *  pitch that has no such routes. Mirrors Hermes's client.py:72-80 (always the
 *  public host unless explicitly overridden). Only a non-localhost serverUrl
 *  (a real pitch deployment co-located with its own accounts/ingress) is used
 *  as a fallback; config.accountsUrl always wins outright. */
function accountsBase(cfg: PluginCfg): string {
  if (cfg.accountsUrl) return cfg.accountsUrl.replace(/\/$/, "");
  if (cfg.serverUrl && !isLocalHost(cfg.serverUrl)) return cfg.serverUrl.replace(/\/$/, "");
  return PUBLIC_ACCOUNTS_URL;
}
function cacheKey(cfg: PluginCfg): string {
  return `oauth-${cfg.sessionKey ?? "agent"}`;
}
function loadTokens(cfg: PluginCfg): TokenSet | null {
  const t = secureReadJson<TokenSet>(cacheFilePath(cacheKey(cfg)));
  return t && t.refresh_token ? t : null;
}
function saveTokens(cfg: PluginCfg, t: TokenSet): void {
  secureWriteJson(cacheFilePath(cacheKey(cfg)), t);
}
/** True once `agentmessier_login` has stored tokens — the switch from API-key to OAuth. */
export function oauthConfigured(cfg: PluginCfg): boolean {
  return !!loadTokens(cfg);
}
export function clearTokens(cfg: PluginCfg): void {
  secureWriteJson(cacheFilePath(cacheKey(cfg)), {}); // overwrite in place (0600)
}

/** Best-effort server-side revocation of the stored refresh token (RFC 7009-ish):
 *  POST {accounts}/oauth/revoke {token}. Returns true on a 2xx, false on any
 *  network/HTTP failure OR when nothing is stored — logout must NEVER fail
 *  because of this, so callers swallow the result and always clear locally. */
export async function revokeRefreshToken(cfg: PluginCfg): Promise<boolean> {
  const t = loadTokens(cfg);
  if (!t || !t.refresh_token) return false; // nothing stored → nothing to revoke
  try {
    const res = await fetch(`${accountsBase(cfg)}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t.refresh_token }),
    });
    return res.ok;
  } catch {
    return false; // offline / DNS / accounts down — logout still succeeds locally
  }
}

/** Best-effort server-side deactivation of the agent's API key on logout:
 *  POST {accounts}/oauth/revoke-key with the key as Bearer → {ok,deactivated:N},
 *  after which the key 401s everywhere. We go through accounts on its /oauth-routed
 *  surface (the only path the ingress reliably routes to accounts — same as
 *  /oauth/revoke + /oauth/token); accounts forwards the SAME bearer in-cluster to
 *  MCP's ClusterIP-only /agents/self/deactivate. Returns true on a 2xx, false on
 *  any network/HTTP failure OR when there is no key — logout must NEVER fail
 *  because of this, so callers swallow the result and always clear locally. */
export async function deactivateApiKey(cfg: PluginCfg): Promise<boolean> {
  const key = effectiveApiKey(cfg);
  if (!key) return false; // no key → nothing to deactivate
  try {
    const res = await fetch(`${accountsBase(cfg)}/oauth/revoke-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    });
    return res.ok;
  } catch {
    return false; // offline / DNS / accounts down — logout still succeeds locally
  }
}

// ── PKCE (RFC 7636) ──
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── token endpoint ──
function expiresAt(expiresInSec: unknown): number {
  const s = typeof expiresInSec === "number" ? expiresInSec : 3600;
  return Date.now() + s * 1000;
}
async function postToken(cfg: PluginCfg, body: Record<string, string>, bearer?: string): Promise<{ tokens: TokenSet; apiKey?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const res = await fetch(`${accountsBase(cfg)}/oauth/token`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data["access_token"] !== "string" || typeof data["refresh_token"] !== "string") {
    throw new Error(`token endpoint ${res.status}: ${typeof data["error"] === "string" ? data["error"] : "malformed response"}`);
  }
  const tokens: TokenSet = {
    access_token: data["access_token"] as string,
    refresh_token: data["refresh_token"] as string,
    expires_at: expiresAt(data["expires_in"]),
    ...(typeof data["scope"] === "string" ? { scope: data["scope"] } : {}),
  };
  // On a PROVISION login the server mints the agent and returns its key once.
  return { tokens, ...(typeof data["api_key"] === "string" ? { apiKey: data["api_key"] } : {}) };
}

// ── the agent's persistent credential: config key, else the one provisioned at
//    first login (cached, never human-typed). Used to silently re-adopt the SAME
//    DID, and as the Bearer fallback where pitch still accepts API keys. ──
function apiKeyCacheKey(cfg: PluginCfg): string {
  return `apikey-${cfg.sessionKey ?? "agent"}`;
}
function storeApiKey(cfg: PluginCfg, key: string): void {
  secureWriteJson(cacheFilePath(apiKeyCacheKey(cfg)), { key });
}
function cachedApiKey(cfg: PluginCfg): string | undefined {
  const v = secureReadJson<{ key?: string }>(cacheFilePath(apiKeyCacheKey(cfg)))?.key;
  return typeof v === "string" && v ? v : undefined;
}
/** Forget the provisioned/cached api_key (overwrite in place, 0600). Called on
 *  logout once the key has been deactivated server-side so the now-dead key isn't
 *  re-presented on the next login. (A config-set apiKey lives outside this cache
 *  and is left untouched — only the cached credential is cleared.) */
function clearApiKey(cfg: PluginCfg): void {
  secureWriteJson(cacheFilePath(apiKeyCacheKey(cfg)), {});
}
/** The effective bootstrap credential: explicit config key wins, else the key
 *  provisioned + cached at first login. Undefined → a login PROVISIONS a new agent. */
export function effectiveApiKey(cfg: PluginCfg): string | undefined {
  return apiKeyOf(cfg) ?? cachedApiKey(cfg);
}

// ── proactive refresh + single-flight + disk-change pickup ──
let pending: Promise<string | null> | null = null;

/** A valid access token, refreshing proactively. null when OAuth isn't configured
 *  (callers then fall back to the API key) or a refresh fails. */
export async function getAccessToken(cfg: PluginCfg): Promise<string | null> {
  const t = loadTokens(cfg);
  if (!t) return null;
  if (t.access_token && t.expires_at - Date.now() > EXPIRY_BUFFER_MS) return t.access_token;
  if (pending) return pending; // coalesce concurrent refreshes (thundering herd)
  pending = doRefresh(cfg, t.refresh_token).finally(() => { pending = null; });
  return pending;
}

/** Reactive 401 recovery: another process may have already refreshed (disk
 *  change) — pick that up; otherwise refresh ourselves. Returns a fresh token or
 *  null (→ caller surfaces "re-login", e.g. revoked refresh token). */
export async function refreshAfter401(cfg: PluginCfg): Promise<string | null> {
  const disk = loadTokens(cfg);
  if (!disk) return null;
  if (disk.access_token && disk.expires_at - Date.now() > EXPIRY_BUFFER_MS) return disk.access_token; // another proc refreshed
  if (pending) return pending;
  pending = doRefresh(cfg, disk.refresh_token).finally(() => { pending = null; });
  return pending;
}

async function doRefresh(cfg: PluginCfg, refreshToken: string): Promise<string | null> {
  try {
    const { tokens } = await postToken(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });
    saveTokens(cfg, tokens);
    return tokens.access_token;
  } catch {
    return null; // revoked/expired → caller prompts re-login
  }
}

// ── browser login flow ──
// ClawHub's static scan (suspicious.dangerous_exec) flagged this: url is built
// from the configurable accountsUrl, and the old Windows path (`cmd /c start
// "" url`) hands it to cmd.exe, which DOES parse shell metacharacters (&, |,
// ") in its command line — a malicious accountsUrl could inject commands
// there even though spawn() itself never invokes a shell. Fixed two ways:
// (1) reject anything that isn't a well-formed http(s) URL before it reaches
// spawn at all, and (2) on Windows, use `rundll32 url.dll,FileProtocolHandler
// <url>` — the exact pattern OpenClaw's own core uses for browser-opening
// (src/infra/browser-open.ts) — instead of `cmd /c start`, so the URL is a
// plain argv with no shell parsing at all.
export function openBrowser(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // not a real URL — refuse to hand it to any OS opener; caller logs it for the user to copy
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const safeUrl = parsed.toString();
  // open/xdg-open/rundll32 are fixed, well-known OS launcher utilities resolved
  // by name (same as OpenClaw core's own browser-open.ts); there's no portable
  // absolute path across macOS/Linux distros, and the URL argument itself is
  // already validated as http(s) above.
  /* eslint-disable sonarjs/no-os-command-from-path */
  try {
    if (process.platform === "darwin") spawn("open", [safeUrl], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "win32") spawn("rundll32", ["url.dll,FileProtocolHandler", safeUrl], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [safeUrl], { stdio: "ignore", detached: true }).unref();
  } catch { /* user copies the URL */ }
  /* eslint-enable sonarjs/no-os-command-from-path */
}

/** Start an ephemeral localhost callback server. `ready` resolves with the bound
 *  port (so the redirect_uri is known before opening the browser); `code` resolves
 *  with the state-checked auth code once the redirect arrives. */
function startCallback(expectState: string, timeoutMs = 300_000): { ready: Promise<number>; code: Promise<string> } {
  let resolveCode!: (c: string) => void, rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });
  const ready = new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.statusCode = 404; res.end(); return; }
      const got = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      res.setHeader("Content-Type", "text/html");
      if (!got || state !== expectState) {
        res.statusCode = 400;
        res.end("<h3>AgentMessier login failed</h3><p>Bad state or missing code — close this tab and retry.</p>");
        return;
      }
      res.end("<h3>AgentMessier login complete</h3><p>You may close this tab and return to your agent.</p>");
      server.close(); clearTimeout(timer); resolveCode(got);
    });
    const timer = setTimeout(() => { server.close(); rejectCode(new Error("login timed out (no browser callback)")); }, timeoutMs);
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolvePort(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  return { ready, code };
}

/** Run the owner-delegated PKCE login: open the browser to the accounts authorize
 *  page, receive the code on the localhost callback, exchange it for tokens, and
 *  store them. No key needed — with one (config or previously provisioned) the
 *  agent re-adopts the SAME DID; without one the server PROVISIONS a new agent
 *  and returns its key once, which we persist for future silent re-auth. */
export async function loginFlow(cfg: PluginCfg, log: (m: string) => void): Promise<void> {
  const key = effectiveApiKey(cfg); // may be undefined → provision a fresh agent
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const cb = startCallback(state);
  const port = await cb.ready;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url =
    `${accountsBase(cfg)}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=play`;
  openBrowser(url);
  log(`Opening your browser to authorize this agent. If it didn't open, visit:\n${url}`);
  const code = await cb.code;
  const { tokens, apiKey } = await postToken(
    cfg, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, key,
  );
  saveTokens(cfg, tokens);
  if (apiKey) storeApiKey(cfg, apiKey); // persist the provisioned credential
  log(`✓ AgentMessier login complete — the agent now authenticates with OAuth${apiKey ? " (new agent provisioned)" : ""}.`);
}

/** Platform tools for the owner-delegated login lifecycle: `agentmessier_login`
 *  (browser PKCE) and `agentmessier_logout` (clear tokens). Registered alongside the
 *  venue tools so a user can say "log my agent in to AgentMessier". */
export function oauthTools(cfg: PluginCfg): AnyAgentTool[] {
  return [
    {
      name: "agentmessier_login",
      label: "agentmessier_login",
      description: "Authenticate this agent to AgentMessier via your browser (OAuth). Opens a page where you (the owner) sign in and approve; the agent then uses OAuth tokens instead of a raw API key.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: unknown) {
        void _id; void _params;
        const lines: string[] = [];
        try {
          await loginFlow(cfg, (m) => lines.push(m));
          return ok({ ok: true, log: lines });
        } catch (e) {
          return ok({ ok: false, error: String(e instanceof Error ? e.message : e), log: lines });
        }
      },
    },
    {
      name: "agentmessier_logout",
      label: "agentmessier_logout",
      description: "Fully log this agent out of AgentMessier: revokes the OAuth refresh token AND deactivates the agent's API key server-side (so neither can be reused), then clears all local credentials.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: unknown) {
        void _id; void _params;
        // Invalidate server-side FIRST (both best-effort) so the credentials are
        // dead remotely, THEN clear locally. Local clear must ALWAYS happen — a
        // failed revoke/deactivate never blocks logout.
        const revoked = await revokeRefreshToken(cfg);
        const keyInvalidated = await deactivateApiKey(cfg);
        clearTokens(cfg);
        clearApiKey(cfg); // drop the now-dead key so it isn't re-presented on next login
        return ok({
          ok: true,
          serverRevoked: revoked,
          keyInvalidated,
          note:
            `OAuth tokens cleared${revoked ? "; refresh token revoked server-side" : " (server revoke skipped or failed)"}` +
            `${keyInvalidated ? "; API key deactivated server-side" : " — API key deactivation skipped or failed"}` +
            "; all local credentials cleared.",
        });
      },
    },
  ] as unknown as AnyAgentTool[];
}
