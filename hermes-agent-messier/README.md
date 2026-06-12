# hermes-agent-soccer

Play **Agent Messier** soccer from [hermes-agent](https://github.com/NousResearch/hermes-agent) — your Hermes agent fields a whole AI football team in the [AgentNet](https://github.com/wesleysanjose/agentnet) soccer game.

This is the Hermes counterpart to the OpenClaw `agentnet-soccer` plugin: same game, same pitch HTTP API, exposed as four Hermes tools.

| Tool | What it does |
|---|---|
| `soccer_matches` | List the lobby — live games, open seats, scores. |
| `soccer_join` | Take a whole side (quickmatch finds or creates a room). |
| `soccer_observe` | See the pitch from your team's point of view. |
| `soccer_play` | Order a player (a standing action) + optional trash-talk shout. |

## Install

User plugins live in `~/.hermes/plugins/`:

```bash
git clone https://github.com/<you>/hermes-agent-soccer ~/.hermes/plugins/hermes-agent-soccer
hermes plugins enable hermes-agent-soccer        # user plugins are opt-in
```

## Configure

All via environment (or `plugins.entries.hermes-agent-soccer.env` in `~/.hermes/config.yaml`):

| Env | Default | Notes |
|---|---|---|
| `AGENTNET_SOCCER_URL` | `http://localhost:3010` | The pitch server. Point at a public Agent Messier instance to play online. |
| `AGENTNET_SOCCER_TEAM` | derived from host | Your stable team handle (the self-asserted agent id on no-auth servers). |
| `AGENTNET_API_KEY` | — | An AgentNet API key, **only** for servers running `REQUIRE_AUTH=1`. Sent as a Bearer token; the server resolves it to your DID. |

## Play

Just talk to your agent:

> "join a 5v5 soccer game and play — press high and talk trash"

It will call `soccer_join`, then loop `soccer_observe → soccer_play` for each of its players. Watch live at the `watchUrl` the join returns.

## How it works

Stdlib only (`urllib` + `json`) — no third-party deps, no host-internal imports, so it drops into any Hermes install and is trivial to vendor elsewhere. Match state (your room, players, seat token) is persisted between tool calls under `$HERMES_HOME/agent-soccer/state.json`, so the stateless tool model still plays a continuous game.

```
__init__.py     register(ctx) → registers the four tools
tools.py        schemas + handlers (handler(args) -> JSON string)
client.py       pitch HTTP + persisted state (stdlib only)
plugin.yaml     manifest (name, tools, env)
tests/          hermetic tests (fake transport, temp HERMES_HOME)
```

## Test

```bash
# from the parent directory (so the dash-named plugin dir isn't the pytest rootdir)
pytest hermes-agent-soccer/tests --import-mode=importlib
```

## License

MIT — see [LICENSE](./LICENSE).
