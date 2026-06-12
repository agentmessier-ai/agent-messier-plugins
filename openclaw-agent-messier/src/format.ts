/** Shared types + formatting — no OpenClaw SDK or typebox deps, so it is
 *  unit-testable on its own. */

export type AgentView = {
  tick: number;
  clock: number;
  phase: string;
  me: { id: string; number: number; team: string; pos: { x: number; y: number }; vel: { x: number; y: number }; stamina: number; hasBall: boolean };
  ball: { pos: { x: number; y: number }; vel: { x: number; y: number }; owner: string | null; distance: number };
  teammates: { id: string; number: number; pos: { x: number; y: number }; vel: { x: number; y: number } }[];
  opponents: { id: string; number: number; pos: { x: number; y: number }; vel: { x: number; y: number } }[];
  score: { home: number; away: number };
  canKick: boolean;
};

/** Team view: one agent controlling several players on the same side, in that
 *  side's attacking frame (always +x). Mirrors the server's TeamView. */
export type TeamPlayer = { id: string; number: number; pos: { x: number; y: number }; vel: { x: number; y: number }; hasBall: boolean };
export type TeamView = {
  tick: number;
  clock: number;
  phase: string;
  team: string;
  score: { home: number; away: number };
  mine: TeamPlayer[];
  ball: { pos: { x: number; y: number }; vel: { x: number; y: number }; owner: string | null };
  teammates: { id: string; number: number; pos: { x: number; y: number }; vel: { x: number; y: number } }[];
  opponents: { id: string; number: number; pos: { x: number; y: number }; vel: { x: number; y: number } }[];
  identity?: {
    you: { name: string; flag: string | null; clan: string | null; style: string | null };
    opponent: { name: string; flag: string | null; clan: string | null; style: string | null };
  };
  field?: { length: number; width: number; attackGoal: { x: number; y: number }; ownGoal: { x: number; y: number }; goalHalfWidth: number; tickHz: number };
  latency?: { yoursMs: number | null; slowestMs: number | null };
  forecast?: { slices: { afterTicks: number; ball: { pos: { x: number; y: number }; owner: string | null }; mine: { id: string; pos: { x: number; y: number } }[] }[] };
};

/** Render a TEAM observation: the whole side's situation + a per-player
 *  recommended action. One agent reads this and issues one tool call per player
 *  it wants to (re)direct, passing player="<id>". */
export function describeTeam(v: TeamView, mode: "easy" | "advanced" | "both" = "easy"): string {
  const f = (n: number) => n.toFixed(1);
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const you = v.identity?.you;
  const opp = v.identity?.opponent;
  const label = you ? `${you.flag ?? ""}${you.name}${you.clan ? ` [${you.clan}]` : ""}` : `TEAM ${v.team}`;
  const lines = [
    `⚽ ${label} (${v.team}) — you control ${v.mine.length} player(s). tick ${v.tick} (${v.clock}s), score ${v.score.home}-${v.score.away}, phase ${v.phase}`,
    `YOU ATTACK +x: opponent goal at x=+52.5; defend x=-52.5.`,
    `ball at (${f(v.ball.pos.x)},${f(v.ball.pos.y)}) moving (${f(v.ball.vel.x)},${f(v.ball.vel.y)}), owner ${v.ball.owner ?? "loose"}`,
  ];
  if (v.opponents.length) {
    lines.push(`opponents: ${v.opponents.map(o => `#${o.number} (${f(o.pos.x)},${f(o.pos.y)})`).join(", ")}`);
  }
  if (you?.style) lines.push(`YOUR STYLE: ${you.style} — let it drive every choice (who presses, when to pass, when to shoot).`);
  if (opp && (opp.style || opp.name)) lines.push(`Opponent: ${opp.flag ?? ""}${opp.name}${opp.style ? ` — they play "${opp.style}", counter it` : ""}.`);
  const hz = v.field?.tickHz ?? 10;
  if (v.latency?.yoursMs) {
    const yours = (v.latency.yoursMs / 1000).toFixed(1);
    const slow = v.latency.slowestMs ? (v.latency.slowestMs / 1000).toFixed(1) : "?";
    lines.push(`Your decisions take ~${yours}s to land (slowest agent here: ~${slow}s) — so aim at the +${yours}s future, not the present.`);
  }
  if (v.forecast?.slices.length) {
    lines.push(
      `If nobody changes orders: ` +
      v.forecast.slices.map(sl =>
        `+${(sl.afterTicks / hz).toFixed(0)}s ball (${f(sl.ball.pos.x)},${f(sl.ball.pos.y)}) ${sl.ball.owner ?? "loose"}`,
      ).join(" | "),
    );
  }
  // Who on our side is nearest the ball — that one should chase; the rest support.
  const nearestId = v.mine.length
    ? [...v.mine].sort((a, b) => dist(a.pos, v.ball.pos) - dist(b.pos, v.ball.pos))[0]!.id
    : null;
  // Does an OPPONENT have the ball? Then off-ball players should defend, not support.
  const ownerTeam = v.ball.owner ? (v.ball.owner.startsWith("away") ? "away" : "home") : null;
  const oppHasBall = ownerTeam !== null && ownerTeam !== v.team;
  lines.push(`Call soccer_play ONCE with moves=[…] — one entry per player below:`);
  for (const p of v.mine) {
    const toGoal = Math.hypot(52.5 - p.pos.x, 0 - p.pos.y);
    let rec: string;
    if (p.hasBall) {
      rec = toGoal < 22
        ? `HAS BALL, ${f(toGoal)}m from goal → {player:"${p.id}", action:"shoot"}`
        : `HAS BALL → {player:"${p.id}", action:"dribble", side:"forward"} (or action:"pass")`;
    } else if (p.id === nearestId) {
      rec = oppHasBall
        ? `nearest — press the carrier → {player:"${p.id}", action:"chase"}`
        : `nearest to ball → {player:"${p.id}", action:"chase"}`;
    } else if (oppHasBall) {
      rec = `off the ball, they have it → pick a defensive role: "defend" (auto block), "press" (aggressive, close the carrier down), or "cover" (protect behind your presser)`;
    } else {
      rec = `support → {player:"${p.id}", action:"chase"} (server spreads non-nearest into space)`;
    }
    lines.push(` • ${p.id} #${p.number} at (${f(p.pos.x)},${f(p.pos.y)}): ${rec}`);
  }
  lines.push(`So: soccer_play(moves=[${v.mine.map(p => `{player:"${p.id}", action:"…"}`).join(", ")}]).`);
  lines.push(`Add say:"…" to any move — your players SHOUT on the pitch and the crowd sees it. Call for passes, warn "man on!", celebrate, talk trash. Stay in character.`);
  if (mode === "advanced" || mode === "both") {
    lines.push(`(advanced actions run/kick take dirX,dirY in this +x frame + distance/power.)`);
  }
  return lines.join("\n");
}

/** Render an observation as an LLM-readable situational summary.
 *  `mode` tailors the action guidance to the tools the agent actually has:
 *   - "easy"     → name the high-level tools (the server does the geometry)
 *   - "advanced" → spell out raw run/kick vectors (the agent does the geometry)
 *   - "both"     → show both. */
export function describe(v: AgentView, mode: "easy" | "advanced" | "both" = "advanced"): string {
  const f = (n: number) => n.toFixed(1);
  // The view is egocentric: you ALWAYS attack +x, your goal is dead ahead at
  // x=+52.5, the goal you defend is behind you at x=-52.5. Positions AND
  // velocities are already in this frame — bigger x is "forward toward the goal".
  const toGoal = Math.hypot(52.5 - v.me.pos.x, 0 - v.me.pos.y);
  // Nearest opponent (egocentric); they steal the ball on contact.
  const opps = v.opponents
    .map((o) => ({ n: o.number, x: o.pos.x, y: o.pos.y, vx: o.vel.x, vy: o.vel.y, d: Math.hypot(o.pos.x - v.me.pos.x, o.pos.y - v.me.pos.y) }))
    .sort((a, b) => a.d - b.d);
  const near = opps[0];

  const lines = [
    `tick ${v.tick} (${v.clock}s), score ${v.score.home}-${v.score.away}, phase ${v.phase}`,
    `you #${v.me.number} at (${f(v.me.pos.x)},${f(v.me.pos.y)}) moving (${f(v.me.vel.x)},${f(v.me.vel.y)}) m/s, stamina ${Math.round(v.me.stamina)}`,
    `YOU ATTACK +x: goal straight ahead at x=+52.5 (${f(toGoal)}m); you defend behind you at x=-52.5`,
    `ball at (${f(v.ball.pos.x)},${f(v.ball.pos.y)}) moving (${f(v.ball.vel.x)},${f(v.ball.vel.y)}) m/s, ${f(v.ball.distance)}m away, owner ${v.ball.owner ?? "loose"}`,
  ];
  if (near) lines.push(`nearest opponent #${near.n} at (${f(near.x)},${f(near.y)}) moving (${f(near.vx)},${f(near.vy)}) m/s, ${f(near.d)}m from you`);

  const easy = mode === "easy" || mode === "both";
  const advanced = mode === "advanced" || mode === "both";

  if (v.canKick) {
    // Is the opponent on a collision path (roughly between me and the goal, near my line)?
    const ahead = near && near.x > v.me.pos.x;                       // opponent is between me and +x goal
    const onMyLine = near && Math.abs(near.y - v.me.pos.y) < 3;      // about the same y as me
    const blocking = near && ahead && onMyLine && near.d < 12;
    lines.push(
      `YOU HAVE THE BALL. RULE: if an opponent touches you (within ~1.2m) they INSTANTLY steal it, and you run SLOWER while carrying — you cannot outrun them.`,
    );
    if (easy) {
      if (blocking) {
        const side = near!.y >= v.me.pos.y ? "right" : "left"; // veer away from the opponent's side
        lines.push(
          `⚠️ Opponent #${near!.n} is BLOCKING your path forward. Don't go straight — call soccer_dribble(side="${side}") to beat it, then soccer_shoot when you have a lane.`,
        );
      } else {
        lines.push(`Path looks clear — call soccer_shoot to shoot at goal, or soccer_dribble(side="forward") to advance. soccer_pass if a teammate is better placed.`);
      }
    }
    if (advanced) {
      if (blocking) {
        const dodge = (near!.y >= v.me.pos.y) ? -1 : 1; // turn away from the opponent's side
        lines.push(
          `⚠️ Opponent #${near!.n} is BLOCKING your path forward (ahead at (${f(near!.x)},${f(near!.y)}), ${f(near!.d)}m, your line). Do NOT run straight into it — TURN: soccer_run(dir = (1, ${dodge * 0.7}), distance ~6) to dribble around it, then continue toward goal. (Or shoot now if you have a lane: soccer_kick(dir x positive).)`,
        );
      } else {
        lines.push(
          `Path looks clear — drive at goal: soccer_kick(dir x positive, power 1) to shoot, or soccer_run(dir x positive) to advance. Watch the opponent's velocity (${near ? `${f(near.vx)},${f(near.vy)}` : "n/a"}); if it cuts toward your line, turn early.`,
        );
      }
    }
  } else {
    if (easy) lines.push(`you do NOT have the ball — call soccer_chase_ball; the server leads the moving ball and runs you to intercept it before the opponent.`);
    if (advanced) {
      // Lead the ball: aim where it is heading, not just where it is.
      lines.push(
        `you do NOT have the ball — intercept it: soccer_run(dir = ball minus you = (${f(v.ball.pos.x - v.me.pos.x)}, ${f(v.ball.pos.y - v.me.pos.y)}), distance ≈ ${f(v.ball.distance)}). The ball is moving (${f(v.ball.vel.x)},${f(v.ball.vel.y)}) — aim ahead of it to cut it off, and try to reach it before the opponent.`,
      );
    }
  }
  return lines.join("\n");
}
