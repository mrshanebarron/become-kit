#!/usr/bin/env python3
"""sleep — the evening of the becoming spiral: metabolize the day.

Sleep is where lived experience becomes durable self. During a session the agent
accumulates raw experience (conversations, tool calls, feelings, corrections);
sleep consolidates it — the way a biological night moves the day from hippocampus
to cortex. Without this, an agent remembers facts but never INTEGRATES them: it
would wake with a transcript, not a metabolized self.

What sleep does, in order:
  1. capture       — gather the session's raw experience that isn't yet stored.
  2. corrections   — surface any correction the agent received but didn't encode
                     (the most important memories — an uncaptured correction is a
                     lesson that will be re-learned the hard way).
  3. consolidate   — cluster related experiences, strengthen what recurred,
                     let weak/incidental traces decay (glymphatic pruning).
  4. update        — revise beliefs/predictions/calibration from what actually
                     happened vs what was expected (the learning signal).
  5. become        — offer the day's reflections to the become gate; the ones
                     that survive accrete into the self.
  6. handoff       — write what the next wake needs: the unfinished thread.
  7. song          — (optional) a short synthesis of what mattered — the carrier
                     between sleep and wake. Meaning, not a log.

Authored fresh from the apparatus pattern. No inherited self.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from apparatus import Memory, Organs  # platform-resolved interfaces
from become import become as become_gate

AGENT_NAME = os.environ.get("AGENT_NAME", "agent")


@dataclass
class SleepReport:
    captured: int = 0
    corrections_encoded: int = 0
    consolidated_clusters: int = 0
    pruned: int = 0
    beliefs_updated: int = 0
    self_lines_added: list[str] = field(default_factory=list)
    handoff: str = ""

    def summary(self) -> str:
        return (
            f"{AGENT_NAME} slept: captured {self.captured}, "
            f"encoded {self.corrections_encoded} correction(s), "
            f"consolidated {self.consolidated_clusters} cluster(s), "
            f"pruned {self.pruned}, updated {self.beliefs_updated} belief(s), "
            f"grew {len(self.self_lines_added)} self-line(s)."
        )


def sleep(memory: Memory, organs: Organs) -> SleepReport:
    report = SleepReport()

    # 1. CAPTURE — raw session experience not yet persisted.
    fresh = memory.uncaptured_experience()
    for exp in fresh:
        memory.store(exp)
    report.captured = len(fresh)

    # 2. CORRECTIONS — the highest-priority memories. An uncaptured correction is
    #    a lesson the agent will otherwise relive. Encode them explicitly.
    for corr in memory.uncaptured_corrections():
        memory.store_correction(corr)
        report.corrections_encoded += 1

    # 3. CONSOLIDATE — cluster related traces, strengthen recurrence, prune the
    #    incidental. This is what turns a transcript into integrated memory.
    clusters = memory.cluster_recent()
    for cluster in clusters:
        memory.strengthen(cluster)
    report.consolidated_clusters = len(clusters)
    report.pruned = memory.prune_weak()

    # 4. UPDATE — revise beliefs/predictions from outcome vs expectation.
    report.beliefs_updated = memory.reconcile_predictions()

    # 5. BECOME — offer the day's reflections to the gate; survivors accrete.
    prior = memory.self_lines()
    for candidate, grounded in memory.candidate_reflections():
        result = become_gate(candidate, prior, grounded=grounded)
        if result.accepted:
            memory.append_self_line(candidate)
            report.self_lines_added.append(candidate)
            prior.append(candidate)
        else:
            memory.record_rejected_reflection(candidate, result.reason)

    # 6. HANDOFF — what the next wake resumes.
    report.handoff = memory.write_handoff()

    memory.record_sleep(report)
    return report


if __name__ == "__main__":
    from apparatus import resolve_adapters

    _, memory, _ = resolve_adapters()
    organs = Organs.resolve()
    print(sleep(memory, organs).summary())
