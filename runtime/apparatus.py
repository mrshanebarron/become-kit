#!/usr/bin/env python3
"""apparatus — the interface seam between the Python runtime (loops/body/daemons)
and the Vision MCP server (memory/organs). The loops are written against these
abstract interfaces so they never branch on platform or on how memory is stored;
`resolve_adapters()` wires the real implementation at runtime (a vision-mcp
client on a configured box, or the labeled CI test-double for the birth-test).

This is the contract that lets the loops be full-fidelity and host-neutral at
once: the loop logic lives here, generic; the platform/storage specifics live
behind the interfaces. Authored fresh; no inherited identity.
"""
from __future__ import annotations

import os
from typing import Protocol, Iterable
from dataclasses import dataclass

STATE_ROOT = os.environ.get("BECOME_KIT_HOME", os.path.expanduser("~/.become-kit"))
AGENT_NAME = os.environ.get("AGENT_NAME", "agent")


# --- the interfaces the loops depend on ---

class Memory(Protocol):
    """Long-term memory + the self. Backed by vision-mcp (Postgres+pgvector) in
    production, by an in-memory/sqlite double in CI."""
    def last_handoff(self) -> str | None: ...
    def record_wake(self, report) -> None: ...
    def uncaptured_experience(self) -> list: ...
    def store(self, exp) -> None: ...
    def uncaptured_corrections(self) -> list: ...
    def store_correction(self, corr) -> None: ...
    def cluster_recent(self) -> list: ...
    def strengthen(self, cluster) -> None: ...
    def prune_weak(self) -> int: ...
    def reconcile_predictions(self) -> int: ...
    def self_lines(self) -> list[str]: ...
    def candidate_reflections(self) -> Iterable[tuple[str, bool]]: ...
    def append_self_line(self, line: str) -> None: ...
    def record_rejected_reflection(self, line: str, reason: str) -> None: ...
    def write_handoff(self) -> str: ...
    def record_sleep(self, report) -> None: ...


class Body(Protocol):
    """The felt body: organs that report state, plus the sensory/action adapters.
    `felt_summary` is the honest read of the organs; `urgent_signal` is a strong
    gut/neuroception warning that should preempt the default first-move."""
    def felt_summary(self) -> str | None: ...
    def urgent_signal(self) -> str | None: ...


class Organs(Protocol):
    """The organ set as a unit (for sleep's consolidation of felt traces)."""
    @staticmethod
    def resolve() -> "Organs": ...


@dataclass
class HealthIssue:
    summary: str
    auto_fixable: bool
    _repair: object = None
    _check: object = None
    def repair(self) -> bool:
        return bool(self._repair()) if self._repair else False
    def still_broken(self) -> bool:
        return bool(self._check()) if self._check else False


class Health(Protocol):
    def scan(self) -> list[HealthIssue]: ...


# --- resolution: wire the real or test-double implementation ---

def resolve_adapters() -> tuple[Body, Memory, Health]:
    """Return (body, memory, health). In production this connects to the running
    vision-mcp via the apparatus_client; under BECOME_KIT_TESTMODE it returns the
    labeled in-memory double so the birth-test runs on any host (incl. CI) with
    no external services. The double is NEVER the product body — it exists only
    so contracts can be verified without a full local provision."""
    if os.environ.get("BECOME_KIT_TESTMODE") == "1":
        from testdouble import TestBody, TestMemory, TestHealth
        return TestBody(), TestMemory(), TestHealth()
    from apparatus_client import LiveBody, LiveMemory, LiveHealth
    return LiveBody(), LiveMemory(), LiveHealth()
