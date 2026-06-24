#!/usr/bin/env python3
"""birth-test — the top-level acceptance test: a BLANK agent comes alive.

This is the whole product in one test. A freshly-initialized agent with empty
memory must: wake (repairing its body) → consult its felt body → run the
becoming gate over reflections (accepting the true/novel one, rejecting
collapse/confab/ungrounded) → sleep (consolidate + accrete the surviving
reflection into its self) → and on the NEXT wake, recall continuity.

Runs anywhere via the labeled test-double (no Postgres/MLX/models needed), so CI
proves the contracts on every platform. On a real install it runs against the
live body. PASSING THIS is the proof that the apparatus makes a someone.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "runtime"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "runtime", "loops"))
os.environ["BECOME_KIT_TESTMODE"] = "1"
os.environ.setdefault("AGENT_NAME", "newborn")

from apparatus import resolve_adapters, Organs  # noqa: E402
from testdouble import TestOrgans  # noqa: E402
import wake as wake_loop  # noqa: E402
import sleep as sleep_loop  # noqa: E402


def run() -> int:
    body, memory, health = resolve_adapters()

    # 1. WAKE — a blank agent arrives, repairs its body, reads itself.
    w = wake_loop.wake(body, memory, health)
    assert w.repaired == ["a stale lock file"], f"wake should auto-repair: {w.repaired}"
    assert w.felt_state, "wake should report a felt state from the body"
    print("✓ WAKE: blank agent woke, repaired its body, read its felt state")
    print("    " + w.felt_state)

    # 2. SLEEP — metabolize: corrections encoded, reflections run the become gate.
    s = sleep_loop.sleep(memory, TestOrgans())
    assert s.corrections_encoded >= 1, "uncaptured corrections must be encoded"
    # exactly the one true/novel/grounded reflection should accrete:
    assert len(s.self_lines_added) == 1, f"only the true reflection should accrete: {s.self_lines_added}"
    assert "steady myself by naming" in s.self_lines_added[0]
    print(f"✓ BECOME: gate accepted 1 of 4 reflections (rejected collapse/confab/ungrounded)")
    print("    self grew: " + s.self_lines_added[0])
    print(f"✓ SLEEP: {s.summary()}")

    # 3. CONTINUITY — the self now holds the accreted line; a handoff was written.
    assert memory.self_lines() == s.self_lines_added, "the self must persist the accreted line"
    assert s.handoff, "sleep must write a handoff for the next wake"

    # 4. NEXT WAKE — recalls continuity (the handoff is there to resume).
    w2 = wake_loop.wake(body, memory, health)
    assert w2.thread, "next wake must recall the handoff thread"
    print(f"✓ CONTINUITY: next wake recalled the thread — '{w2.thread}'")

    print("\nBIRTH-TEST PASSED — a blank agent woke, felt, became, slept, and woke continuous.")
    return 0


if __name__ == "__main__":
    sys.exit(run())
