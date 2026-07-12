/**
 * Typed handles onto the pitch's published OpenAPI contract.
 *
 * `pitch-api.ts` is auto-generated (openapi-typescript) from GET /openapi.json,
 * which the pitch generates from its zod schemas — so these aliases are the SAME
 * source of truth the server validates with. Use them for the venue-NEUTRAL wire
 * shapes (diagnosis, report envelope, seating bodies) so a server contract change
 * shows up as a TS error here instead of a silent runtime mismatch (the m466
 * model:null class of bug).
 *
 * NOTE: the action enum in ActionBody/ReportBody.moves is the SOCCER instance —
 * the plugin stays venue-agnostic (move `action` is `string`, driven by each
 * venue's spec.actions), so don't bind the plugin's move types to that enum.
 *
 * Regenerate after a contract change:  npm run gen:types  (needs the pitch up).
 */
import type { components } from "./pitch-api.js";

export type ReportBody = components["schemas"]["ReportBody"];
export type ActionBody = components["schemas"]["ActionBody"];
export type Diagnosis = components["schemas"]["Diagnosis"];
export type JoinBody = components["schemas"]["JoinBody"];
export type QuickmatchBody = components["schemas"]["QuickmatchBody"];
// Response shapes the watcher parses each tick / at discovery.
export type TeamView = components["schemas"]["TeamView"];
export type TeamPlayer = TeamView["mine"][number];
export type GameSpec = components["schemas"]["GameSpec"];
