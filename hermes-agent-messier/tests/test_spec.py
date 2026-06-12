"""Phase 4 — the soccer_play tool is GENERATED from the /spec manifest, with a
static fallback when /spec is unreachable. Tests use a FIXTURE manifest (no live
server): adding a fake action to the fixture must appear in the generated tool
with zero further code change."""
import sys

import pytest

tools = sys.modules["hsoccer.tools"]
client = sys.modules["hsoccer.client"]


# A fixture /spec manifest with a FAKE action the static list has never heard of.
FIXTURE_SPEC = {
    "game": "agent-soccer",
    "specVersion": 1,
    "rulesVersion": 1,
    "actions": {
        "type": "string",
        "enum": ["run", "kick", "chase", "shoot", "teleport"],
        "descriptions": {"teleport": "blink to the ball (test-only fake action)"},
    },
}


def test_play_schema_from_spec_includes_fake_action():
    schema = tools.build_play_schema(FIXTURE_SPEC)
    enum = schema["parameters"]["properties"]["type"]["enum"]
    assert "teleport" in enum                       # the fake action surfaced
    assert "shoot" in enum
    # per-action descriptions from the spec ride along when present
    assert "teleport" in schema["description"] or "blink" in schema["description"]


def test_load_spec_actions_uses_the_server_manifest(monkeypatch):
    def fake_request(method, path, *a, **k):
        if method == "GET" and path == "/spec":
            return FIXTURE_SPEC
        raise client.PitchError(404, "no route")
    monkeypatch.setattr(client, "request", fake_request)
    spec = tools.load_spec()
    assert spec is not None
    assert "teleport" in spec["actions"]["enum"]


def test_load_spec_returns_none_when_unreachable(monkeypatch):
    def boom(method, path, *a, **k):
        raise client.PitchError(0, "cannot reach pitch")
    monkeypatch.setattr(client, "request", boom)
    assert tools.load_spec() is None


def test_play_schema_falls_back_to_static_when_spec_absent():
    # No spec → the hand-written vocabulary still produces a usable tool.
    schema = tools.build_play_schema(None)
    enum = schema["parameters"]["properties"]["type"]["enum"]
    for a in tools._ACTION_TYPES:
        assert a in enum
    assert "teleport" not in enum                   # nothing invented offline


def test_apply_spec_regenerates_the_play_tool(monkeypatch):
    # The connector-time wiring: apply_spec swaps the live SOCCER_PLAY_SCHEMA so
    # the registered tool reflects the server's action vocabulary — no per-rule
    # plugin edit. Restore afterwards so other tests see the static default.
    original = tools.SOCCER_PLAY_SCHEMA
    try:
        tools.apply_spec(FIXTURE_SPEC)
        assert "teleport" in tools.SOCCER_PLAY_SCHEMA["parameters"]["properties"]["type"]["enum"]
    finally:
        tools.apply_spec(None)
        assert tools.SOCCER_PLAY_SCHEMA["parameters"]["properties"]["type"]["enum"] == list(tools._ACTION_TYPES)
