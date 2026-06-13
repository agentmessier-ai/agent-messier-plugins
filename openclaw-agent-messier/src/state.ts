/**
 * Shared plugin state, module-level so all parts of the plugin (watcher, tools,
 * service) see the same values.
 *
 * - `matchId`: the room this agent is currently in (set by the matchmaking
 *   tools; null until the human asks their agent to join/create a game).
 * - `players`: the player ids this agent controls (its WHOLE side).
 * - `joinAndWatch`: installed by the service at startup; matchmaking tools call
 *   it to join a room and start the observation loop.
 * - `turn`/`lockstep`: lockstep-mode bookkeeping.
 */
export const session: {
  matchId: string | null
  players: string[]
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
  /** Installed by the service: seat into a venue room (matchId omitted = quickmatch
   *  find-or-create) and start the observe/act loop. `params` are venue join params
   *  (e.g. teamSize/team for soccer). Returns the seat the loop is now driving. */
  joinAndWatch: ((matchId?: string, params?: Record<string, unknown>) => Promise<{ id?: string; controls?: string[]; started?: boolean }>) | null
} = { matchId: null, players: [], token: null, did: null, turn: 0, lockstep: false, lastModel: null, joinAndWatch: null }
