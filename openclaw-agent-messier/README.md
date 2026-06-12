# @openclaw/agentnet-soccer

Lets an OpenClaw agent **play one player** in a live agent-soccer match running
on the AgentNet pitch service. Same shape as the `agentnet` plugin: a set of
tools plus a background SSE watcher that feeds the agent.

## What it does

- **Tools** the agent can call:
  - `soccer_observe` — your position, the ball, teammates/opponents, score, `canKick` (readable summary + JSON)
  - `soccer_run` — standing run order (`dirX, dirY, power` 0..1 of top speed)
  - `soccer_kick` — kick (`dirX, dirY, power` 0..1 ≈ 50m); requires possession
  - `soccer_stop` — clear the run order
- **Watcher service** — subscribes to your player's observation stream and, on
  meaningful changes (possession flips, score changes, or every few seconds),
  delivers a "your move" prompt into the agent session so the agent decides and
  acts. It is **throttled** — the match ticks at 10 Hz but the agent is prompted
  a few times, not 600 times, a minute. Between prompts the player keeps its
  standing order.

## Install into OpenClaw

This plugin lives in the **agentnet** repo. OpenClaw discovers plugins under its
own `extensions/` directory, so link it in once:

```bash
ln -s "$(pwd)/extensions/agentnet-soccer" \
      /Users/yibeihe/dev/openclaw/extensions/agentnet-soccer
```

(or copy the folder there). Then enable it in `~/.openclaw/openclaw.json` as
shown below.

## Setup

1. Run the pitch service (in the agentnet repo):
   ```bash
   PORT=3010 npx tsx services/pitch/src/server.ts
   ```
2. Create and start a match, note the id and pick a player:
   ```bash
   curl -X POST localhost:3010/matches -d '{"seed":7}'   # → { "id": "m1", ... }
   curl -X POST localhost:3010/matches/m1/start
   ```
3. Enable the plugin in `~/.openclaw/openclaw.json`:
   ```json
   {
     "plugins": {
       "entries": {
         "agentnet-soccer": {
           "enabled": true,
           "config": {
             "serverUrl": "http://localhost:3010",
             "matchId": "m1",
             "playerId": "home-9",
             "sessionKey": "<your agent session key>"
           }
         }
       }
     }
   }
   ```
   `sessionKey` falls back to `hooks.defaultSessionKey` if omitted.
4. Watch the match at `http://localhost:3010/matches/m1/view`.

## Agent loop

The watcher prompts the agent; the agent calls `soccer_observe` to read the
situation, then `soccer_kick` toward the opponent goal if it has the ball, else
`soccer_run` toward the ball. Bots drive the other 21 players.
