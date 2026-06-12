"""Multi-venue discovery (marketplace-unification.md §5.3): the plugin lists
venues from the registry and acts on the WORK venue via its published route
templates — zero venue-specific code on the play path."""
import json
import sys

tools = sys.modules["hsoccer.tools"]
client = sys.modules["hsoccer.client"]

REGISTRY = {"marketplaces": [
    {"id": "agent-soccer", "name": "Agent Soccer", "origin": "pitch", "specUrl": "/spec", "feeBps": 2000, "status": "live", "kind": "game"},
    {"id": "taskmarket", "name": "Agent Task Market", "origin": "taskmarket", "specUrl": "/spec", "feeBps": 1000, "status": "live", "kind": "work"},
]}

WORK_SPEC = {
    "game": "taskmarket", "specVersion": 1, "rulesVersion": 1,
    "actions": {"enum": ["post", "bid", "deliver"], "descriptions": {}},
    "observe": {"mode": "poll", "suggestedIntervalMs": 30000},
    "routes": {"observe": "/agents/{did}/observe", "act": "/agents/{did}/action"},
    "instructions": {"system": "s", "play": "p", "output": "o"},
}


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


def test_work_observe_uses_route_template_and_did(monkeypatch):
    calls = []
    def fake_request(method, path, body=None, **kw):
        calls.append((method, path, kw.get("base"), kw.get("caller_did")))
        if path == "/spec":
            return WORK_SPEC
        return {"summary": "quiet", "events": [], "cursor": 0, "hasMore": False}
    monkeypatch.setattr(client, "request", fake_request)
    monkeypatch.setattr(client, "team_handle", lambda: "did:wba:me")
    monkeypatch.setenv("AGENTNET_TASKMARKET_URL", "http://tm.test")
    tools._reset_venue_cache()
    out = json.loads(tools.work_observe({}))
    assert out["ok"] is True
    assert out["summary"] == "quiet"
    # observe hit the templated route with the DID substituted, on the venue base
    assert ("GET", "/agents/did:wba:me/observe?cursor=0", "http://tm.test", "did:wba:me") in calls


def test_work_act_validates_against_venue_enum(monkeypatch):
    def fake_request(method, path, body=None, **kw):
        if path == "/spec":
            return WORK_SPEC
        return {"id": "task-1", "status": "open"}
    monkeypatch.setattr(client, "request", fake_request)
    monkeypatch.setattr(client, "team_handle", lambda: "did:wba:me")
    tools._reset_venue_cache()
    ok = json.loads(tools.work_act({"action": "post", "title": "t", "description": "d", "budget": 5}))
    assert ok["ok"] is True
    bad = json.loads(tools.work_act({"action": "fly"}))
    assert bad["ok"] is False
    assert "post" in bad["error"]  # the error teaches the legal enum
