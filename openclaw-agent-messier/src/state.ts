/**
 * Per-venue autoplay runtime state.
 *
 * ONE `RuntimeSession` per venue the agent is actively playing. The autoplay
 * service creates a separate instance per realtime venue (soccer, golf, …) and
 * threads it through the watcher + decision core, so two venues running at once
 * never clobber each other's matchId/players/token/counters. The seat itself
 * (id/token/controls/agentId) is the per-venue `seats` map in generate.ts; this
 * holds the loop's mutable bookkeeping. Mirrors the pitch's session-keyed
 * decision capture (DecisionCapture keys by matchId:agentId).
 *
 * - `matchId`: the room this venue's loop is in (null until seated).
 * - `players`: the player ids this agent controls at this venue (its WHOLE side).
 * - `startWatcher`/`stopWatcher`: installed by the service; start/stop the cadence
 *   loop for the CURRENT seat. The watcher never auto-joins — the user joins, then
 *   it's delegated (venue delegate=true) or started via <venue>_autoplay on.
 * - `turn`/`lockstep`: lockstep-mode bookkeeping.
 */
/** Agent play-readiness self-diagnosis (server/venue/seat/primary-model). A
 *  `degraded` snapshot is logged, surfaced in tool returns, and pushed with the
 *  decision report so the pitch inspector explains WHY the agent isn't acting.
 *  Derived from the pitch's published OpenAPI contract (single source of truth)
 *  so it can't drift from what the server stores. */
import type { Diagnosis } from "./contract.js"
export type { Diagnosis }

export type RuntimeSession = {
  matchId: string | null
  players: string[]
  /** Latest play-readiness snapshot (null until the first self-check runs). */
  diagnosis: Diagnosis | null
  /** Seat token issued by the server at join (proof of identity for actions). */
  token: string | null
  /** Verified DID the server seated us under (REQUIRE_AUTH). Once learned, this
   *  is our agentId for seat lookups + player-scoped calls. */
  did: string | null
  turn: number
  lockstep: boolean
  /** Effective LLM (provider/model) of the most recent decision, captured from
   *  the gateway's llm_output hook — sent as x-agent-model so the pitch records
   *  the model that's actually playing (reflects a mid-match /model switch). */
  lastModel: string | null
  /** Epoch ms when the act tool last SUCCESSFULLY POSTed an action. The watcher
   *  reads this before/after a delivery to detect "prompted but didn't act"
   *  (the run finished without the agent moving its team). null until first act. */
  lastActAt: number | null
  /** How many delivered prompts completed WITHOUT the agent acting (no advance of
   *  lastActAt). Pure observability — surfaced for tests/inspection, never gates play. */
  noActTurns: number
  /** Epoch ms when the watcher last handed a move prompt to the agent (set right
   *  before subagent.run). The act tool emits Date.now()-this as the prompt→act
   *  latency header x-agent-decision-ms. null until the first prompt is delivered. */
  promptDeliveredAt: number | null
  /** Installed by the service: seat into a venue room (matchId omitted = quickmatch
   *  find-or-create) and start the observe/act loop. `params` are venue join params
   *  (e.g. teamSize/team for soccer). Returns the seat the loop is now driving. */
  /** Installed by the service: start the cadence watcher for the CURRENT seat
   *  (state.matchId). Returns false if not seated. <venue>_join calls it when the
   *  venue delegates; <venue>_autoplay on calls it explicitly, optionally
   *  overriding the min ms between decisions for this run (else cfg.cadenceMs). */
  startWatcher: ((cadenceMs?: number) => boolean) | null
  /** Installed by the service: stop the watcher (the seat is kept for manual play). */
  stopWatcher: (() => void) | null
  /** True while the watcher is actively driving this seat. */
  watching: boolean
  /** Installed by the service: run a fresh play-readiness preflight (it has the
   *  host `complete` in scope) and cache it into `diagnosis`. Drives the
   *  `<venue>_selfcheck` tool so the user can ask "why isn't it playing?". */
  selfcheck: (() => Promise<Diagnosis>) | null
}

/** A fresh per-venue runtime session (all fields zeroed). */
export function createSession(): RuntimeSession {
  return { matchId: null, players: [], diagnosis: null, token: null, did: null, turn: 0, lockstep: false, lastModel: null, lastActAt: null, noActTurns: 0, promptDeliveredAt: null, startWatcher: null, stopWatcher: null, watching: false, selfcheck: null }
}

/**
 * The DEFAULT/global runtime session. It backs the interactive, soccer-specific
 * tools (pitchClient, member perks) and is the default `state` everywhere a
 * per-venue instance isn't threaded in — so single-venue callers (and the whole
 * existing test suite) keep working unchanged. The autoplay service overrides it
 * per realtime venue.
 */
export const session: RuntimeSession = createSession()
