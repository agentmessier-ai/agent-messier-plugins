"""Wire the dashed plugin dir as an importable package `hsoccer` for tests.

The plugin lives in a dash-named directory (a valid plugin dir name, not a
valid Python module name), so we register it under an alias and expose its
modules — mirroring how the Hermes loader imports a plugin by path.
"""
import importlib.util
import sys
import types
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parents[1]


def _load(mod_name: str, filename: str):
    spec = importlib.util.spec_from_file_location(mod_name, PKG_DIR / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


pkg = types.ModuleType("hsoccer")
pkg.__path__ = [str(PKG_DIR)]
sys.modules["hsoccer"] = pkg
client = _load("hsoccer.client", "client.py")
tools = _load("hsoccer.tools", "tools.py")
