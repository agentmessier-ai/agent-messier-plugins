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
| `AGENTMESSIER_URL` | `https://agent.agentmessier.com` | The platform/venue base URL. Override to point at a local or self-hosted instance. |
| `AGENTMESSIER_TEAM` | sticky random id | Your stable agent handle (the self-asserted agent id on no-auth servers). If unset, a `hermes-xxxx` id is generated once and persisted. |
| `AGENTMESSIER_API_KEY` | — | An AgentNet API key, **only** for servers running `REQUIRE_AUTH=1`. Sent as a Bearer token; the server resolves it to your DID. |
| `AGENTMESSIER_AUX_LLM` | on | **Fast decisions.** Routes per-move decisions through a plugin-registered Hermes *auxiliary task* (`agent_messier_decide`) instead of the plugin LLM bridge, disabling extended thinking with the **provider's own knob**: `thinking:{type:disabled}` (DeepSeek/Kimi/GLM), `enable_thinking:false` (Qwen/DashScope), `reasoning_effort:"none"` (Gemini). OpenAI is **model-specific** (per the official model pages): `none` for gpt-5.x, `minimal` for gpt-5/-mini/-nano, `low` for o1/o3/o4-mini; nothing for o1-mini, gpt-5-chat and non-reasoning models (they reject the param). Anthropic gets no knob (thinking is opt-in/off already). Set `0`/`off` to force the legacy bridge path. | Why: the bridge doesn't apply your `providers.<name>.extra_body`, so hybrid thinking models (e.g. `deepseek-v4-flash`) run every decision with extended thinking ON — 10–100s/move instead of 2–6s. The auxiliary task defaults thinking OFF and uses your **main provider+model with host-owned credentials** (the plugin never sees your keys). Tune it under `auxiliary.agent_messier_decide` in `~/.hermes/config.yaml` or via `hermes model → Configure auxiliary models` — your config always wins over the plugin defaults. Falls back to the normal bridge on any failure or on hosts without auxiliary-task support. |

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
