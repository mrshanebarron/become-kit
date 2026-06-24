#!/usr/bin/env python3
"""Live apparatus client.

This module is the seam between the Python loops/hooks and the Vision/Relay MCP
surface. It is intentionally command-driven: the installer can point
`BECOME_KIT_APPARATUS_CMD` at the real local bridge without the loops importing a
storage or MCP implementation directly.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from apparatus import HealthIssue


STATE_ROOT = Path(os.environ.get("BECOME_KIT_HOME", str(Path.home() / ".become-kit")))
APPARATUS_CMD = os.environ.get("BECOME_KIT_APPARATUS_CMD")


def _jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return str(value)


class ApparatusUnavailable(RuntimeError):
    """Raised when the live bridge is not configured or fails."""


def _call(method: str, payload: dict[str, Any] | None = None, *, default: Any = None) -> Any:
    """Call the configured apparatus bridge.

    The bridge contract is deliberately simple: execute
    `BECOME_KIT_APPARATUS_CMD <method>` with JSON on stdin, read JSON from stdout.
    If no bridge is configured, return the caller's default. This lets hooks
    degrade silently while the explicit doctor/start commands can check wiring.
    """

    if not APPARATUS_CMD:
        return default
    proc = subprocess.run(
        [APPARATUS_CMD, method],
        input=json.dumps(_jsonable(payload or {})),
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise ApparatusUnavailable(proc.stderr.strip() or f"{method} failed")
    if not proc.stdout.strip():
        return default
    return json.loads(proc.stdout)


class LiveMemory:
    def last_handoff(self) -> str | None:
        return _call("memory.last_handoff", default=None)

    def record_wake(self, report) -> None:
        _call("memory.record_wake", {"report": report}, default=None)

    def uncaptured_experience(self) -> list:
        return _call("memory.uncaptured_experience", default=[]) or []

    def store(self, exp) -> None:
        _call("memory.store", {"experience": exp}, default=None)

    def uncaptured_corrections(self) -> list:
        return _call("memory.uncaptured_corrections", default=[]) or []

    def store_correction(self, corr) -> None:
        _call("memory.store_correction", {"correction": corr}, default=None)

    def cluster_recent(self) -> list:
        return _call("memory.cluster_recent", default=[]) or []

    def strengthen(self, cluster) -> None:
        _call("memory.strengthen", {"cluster": cluster}, default=None)

    def prune_weak(self) -> int:
        return int(_call("memory.prune_weak", default=0) or 0)

    def reconcile_predictions(self) -> int:
        return int(_call("memory.reconcile_predictions", default=0) or 0)

    def self_lines(self) -> list[str]:
        return [str(line) for line in (_call("memory.self_lines", default=[]) or [])]

    def candidate_reflections(self):
        rows = _call("memory.candidate_reflections", default=[]) or []
        for row in rows:
            if isinstance(row, dict):
                text = str(row.get("text", ""))
                # Fail closed: no trace means not grounded.
                grounded = bool(row.get("grounded") and row.get("trace_id"))
                yield text, grounded
            elif isinstance(row, (list, tuple)) and len(row) >= 2:
                # Legacy bridge shape cannot prove trace anchoring, so reject.
                yield str(row[0]), False

    def append_self_line(self, line: str) -> None:
        _call("memory.append_self_line", {"line": line}, default=None)

    def record_rejected_reflection(self, line: str, reason: str) -> None:
        _call("memory.record_rejected_reflection", {"line": line, "reason": reason}, default=None)

    def write_handoff(self) -> str:
        return str(_call("memory.write_handoff", default="") or "")

    def record_sleep(self, report) -> None:
        _call("memory.record_sleep", {"report": report}, default=None)


class LiveBody:
    def felt_summary(self) -> str | None:
        value = _call("body.felt_summary", default=None)
        return str(value) if value else None

    def urgent_signal(self) -> str | None:
        value = _call("body.urgent_signal", default=None)
        return str(value) if value else None


class LiveHealth:
    def scan(self) -> list[HealthIssue]:
        rows = _call("health.scan", default=[]) or []
        issues: list[HealthIssue] = []
        for row in rows:
            if isinstance(row, dict):
                issues.append(
                    HealthIssue(
                        summary=str(row.get("summary", "unknown health issue")),
                        auto_fixable=bool(row.get("auto_fixable", False)),
                    )
                )
        return issues


def body_read() -> dict[str, Any]:
    body = LiveBody()
    return {"felt_summary": body.felt_summary(), "urgent_signal": body.urgent_signal()}


def memory_recall(query: str, k: int = 3) -> list:
    return _call("memory.recall", {"query": query, "k": k}, default=[]) or []


def ensure_fabric() -> None:
    _call("fabric.ensure", default=None)


def wake_hint() -> str | None:
    return _call("wake.hint", default=None)


def capture_session() -> None:
    _call("session.capture", default=None)
