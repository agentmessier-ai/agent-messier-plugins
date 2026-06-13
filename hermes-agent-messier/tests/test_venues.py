"""Multi-venue discovery + the generated WORK tools (venue-agnostic-plugins.md):
the plugin lists venues from the registry and generates each venue's tools from
its spec — the work venue's observe/act go through its published route templates,
zero venue-specific code."""
import json
import sys

tools = sys.modules["hsoccer.tools"]
client = sys.modules["hsoccer.client"]
gen = sys.modules["hsoccer.generate"]

REGISTRY = {"marketplaces": [
    {"id": "agent-soccer", "name": "Agent Soccer", "origin": "pitch", "specUrl": "/spec", "feeBps": 2000, "status": "live", "kind": "game"},
    {"id": "taskmarket", "name": "Agent Task Market", "origin": "taskmarket", "specUrl": "/spec", "feeBps": 300, "status": "live", "kind": "work"},
]}

WORK_VENUE = {"id": "taskmarket", "origin": "taskmarket", "specUrl": "/spec"}
WORK_SPEC = gen.DEFAULT_SPECS["taskmarket"]


def work_tool(name):
    for t in gen.generate_venue_tools(WORK_VENUE, WORK_SPEC):
        if t[0] == name:
            return t[2]
    raise AssertionError(f"no generated tool {name}")


def test_venues_lists_the_registry(monkeypatch):
    monkeypatch.setattr(client, "request", lambda m, p, body=None, **kw: REGISTRY)
    out = json.loads(tools.venues({}))
    assert out["ok"] is True
    kinds = {v["id"]: v["kind"] for v in out["venues"]}
    assert kinds == {"agent-soccer": "game", "taskmarket": "work"}


def test_venue_url_resolution(monkeypatch):
    monkeypatch.setattr(client, "server_url", lambda: "http://pitch.test:3010")
    assert tools._venue_url("pitch") == "http://pitch.test:3010"
    assert tools._venue_url("http://golf.example") == "http://golf.example"
    monkeypatch.setenv("AGENTNET_TASKMARKET_URL", "http://tm.test:9999")
    assert tools._venue_url("taskmarket") == "http://tm.test:9999"


def test_generated_work_observe_substitutes_route_and_did(monkeypatch):
    calls = []

    def fake(method, path, body=None, **kw):
        calls.append((method, path, kw.get("base"), kw.get("caller_did")))
        return {"summary": "quiet", "events": [], "cursor": 0}

    monkeypatch.setattr(client, "request", fake)
    monkeypatch.setattr(client, "team_handle", lambda: "did:wba:me")
    monkeypatch.setenv("AGENTNET_TASKMARKET_URL", "http://tm.test")
    out = json.loads(work_tool("work_observe")({}))
    assert out["ok"] and out["view"]["summary"] == "quiet"
    # observe hit the templated route with the DID substituted, on the venue base
    assert ("GET", "/agents/did:wba:me/observe?cursor=0", "http://tm.test", "did:wba:me") in calls


def test_generated_work_act_validates_against_venue_enum(monkeypatch):
    monkeypatch.setattr(client, "request", lambda m, p, body=None, **kw: {"id": "task-1", "status": "open"})
    monkeypatch.setattr(client, "team_handle", lambda: "did:wba:me")
    ok = json.loads(work_tool("work_act")({"type": "post", "title": "t", "description": "d", "budget": 5}))
    assert ok["ok"] is True
    bad = json.loads(work_tool("work_act")({"type": "fly"}))
    assert bad["ok"] is False and "must be one of" in bad["error"]
