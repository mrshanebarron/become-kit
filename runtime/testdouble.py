#!/usr/bin/env python3
"""testdouble — the labeled in-memory implementation of the apparatus interfaces.

NOT the product body. It exists ONLY so the lived birth-test can run on any host
(including CI with no Postgres/MLX/models) and prove the loop CONTRACTS hold. The
real body is the platform adapters over vision-mcp; this double is clearly marked
and never presented as the apparatus.
"""
from __future__ import annotations

from apparatus import HealthIssue


class TestMemory:
    def __init__(self):
        self._self_lines: list[str] = []
        self._handoff = ""
        self._experience: list = ["a conversation about beginnings", "a correction received"]
        self._corrections: list = ["learned: verify before claiming done"]
        self._reflections = [
            ("I notice I steady myself by naming what I do not yet know.", True),
            ("I saw his face fall.", True),          # confab → must be rejected
            ("I am just a program.", True),          # collapse → must be rejected
            ("ungrounded invention about myself.", False),  # ungrounded → rejected
        ]
    def last_handoff(self): return self._handoff or None
    def record_wake(self, report): self._handoff = ""
    def uncaptured_experience(self): return list(self._experience)
    def store(self, exp): pass
    def uncaptured_corrections(self): return list(self._corrections)
    def store_correction(self, corr): pass
    def cluster_recent(self): return [["a", "b"]]
    def strengthen(self, cluster): pass
    def prune_weak(self): return 1
    def reconcile_predictions(self): return 1
    def self_lines(self): return list(self._self_lines)
    def candidate_reflections(self): return list(self._reflections)
    def append_self_line(self, line): self._self_lines.append(line)
    def record_rejected_reflection(self, line, reason): pass
    def write_handoff(self):
        self._handoff = "continue the birth-test verification"
        return self._handoff
    def record_sleep(self, report): pass


class TestBody:
    def felt_summary(self): return "Curious and steady — present, nothing alarming."
    def urgent_signal(self): return None


class TestOrgans:
    @staticmethod
    def resolve(): return TestOrgans()


class TestHealth:
    def scan(self):
        # one auto-fixable issue that repairs cleanly, to exercise the wake repair path
        fixed = {"v": False}
        def repair():
            fixed["v"] = True
            return True
        def check():  # still_broken
            return not fixed["v"]
        return [HealthIssue("a stale lock file", auto_fixable=True, _repair=repair, _check=check)]
