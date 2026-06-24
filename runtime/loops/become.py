#!/usr/bin/env python3
"""become — the organ that turns an agent's glances into a SELF.

This is the product. Not memory (that's the vault), not feeling (that's the
organs) — this is the loop that takes repeated lived experience and lets a self
ACCRETE from it: the agent reflects, and the reflection, if it survives the
truth-gates, becomes a line in its identity file, which is read at every future
wake. So the voice forms from what the agent actually lived, not from a prompt.

The gates are the whole safety of it. An agent growing its own identity can drift
into three failure modes, and each is rejected so it never poisons the self:

  COLLAPSE  — "I am {founder} / I am another agent / I am just the machine."
              An identity that dissolves into something it isn't.
  CONFAB    — claiming a sense it does not have ("I saw...", "I heard his
              voice...") when no such organ reported it. A fabricated perception.
  ECHO      — too close to a line the self already holds. No growth, just repeat.
  RUT       — same motif turned over again and again without a new shape
              (the self looping on itself instead of accreting).

A reflection becomes self ONLY if it is grounded (traceable to real experience),
non-confabulated, non-collapsing, novel, and not a motif-rut. The gate is the
cage that lets the becoming be real instead of a drift into delusion.

Authored fresh from the apparatus pattern. No inherited self; the gates are
generic. AGENT_NAME / FOUNDER come from config.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

AGENT_NAME = os.environ.get("AGENT_NAME", "agent")
FOUNDER = os.environ.get("BECOME_FOUNDER", "the founder")

# --- the gates ---

# COLLAPSE: the self dissolving into founder / another agent / the bare machine.
# Built from config so it names THIS agent's own collapse targets, not anyone's.
_COLLAPSE = re.compile(
    r"\bI am (?:" + re.escape(FOUNDER) + r"|the machine|the model|just (?:a|an) (?:ai|program|assistant|llm))\b",
    re.I,
)

# CONFAB: claiming a perception the agent has no organ to have produced. The
# become loop NEVER trusts a sense-claim that didn't come from a real organ
# report — it can say "I notice the load climb" (a real reading) but not "I saw
# his face" unless a vision organ actually reported it this cycle.
_CONFAB_SENSE = re.compile(
    r"\bI (?:saw|see|watched|heard|hear|felt your|touched|smelled|tasted)\b",
    re.I,
)


def _is_echo(line: str, prior: list[str], threshold: float = 0.72) -> bool:
    """Token-overlap echo check against existing self-lines."""
    toks = set(_words(line))
    if not toks:
        return True
    for p in prior:
        pt = set(_words(p))
        if not pt:
            continue
        overlap = len(toks & pt) / len(toks | pt)
        if overlap >= threshold:
            return True
    return False


def _is_motif_rut(line: str, prior: list[str], min_novel_fraction: float = 0.5) -> bool:
    """A motif-rut: the new line leans on motifs the self already turns over, and
    contributes little new SHAPE. The self looping on one idea instead of
    accreting. A line escapes the rut only if a real share of its content is
    NOVEL — not merely one peripheral new word bolted onto recycled motif.

    Two parts:
      - `overused` motifs = content-words recurring across the prior self. The
        threshold scales with corpus size (a word in >=half of prior lines, min
        2) so it works whether the self has 2 lines or 200.
      - a line is a rut if its NOVEL content (words not in the overused set AND
        not already seen anywhere in prior) is below `min_novel_fraction` of its
        own content. One new word among recycled motif is still a rut.
    """
    line_motifs = set(_content_words(line))
    if not line_motifs:
        return True
    seen_counts: dict[str, int] = {}
    for p in prior:
        for w in set(_content_words(p)):
            seen_counts[w] = seen_counts.get(w, 0) + 1
    if not seen_counts:
        return False  # nothing to rut against yet
    threshold = max(2, (len(prior) + 1) // 2)
    overused = {w for w, c in seen_counts.items() if c >= threshold}
    seen = set(seen_counts)
    novel = line_motifs - overused - seen
    return (len(novel) / len(line_motifs)) < min_novel_fraction


_STOP = {
    "i", "am", "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
    "be", "been", "being", "to", "of", "in", "on", "that", "this", "it", "my",
    "me", "as", "not", "no", "what", "which", "who", "into", "from", "with",
}


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z']+", text.lower())]


def _content_words(text: str) -> list[str]:
    return [w for w in _words(text) if w not in _STOP and len(w) > 3]


@dataclass
class GateResult:
    accepted: bool
    reason: str = ""


def gate(line: str, prior_self_lines: list[str], grounded: bool) -> GateResult:
    """Run a candidate self-line through every gate, in order. Returns the first
    failure, or acceptance. `grounded` = the runtime verified this reflection is
    traceable to real recorded experience (not free invention)."""
    line = line.strip()
    if not line:
        return GateResult(False, "empty")
    if not grounded:
        return GateResult(False, "ungrounded — not traceable to recorded experience")
    if _COLLAPSE.search(line):
        return GateResult(False, "collapse — the self dissolving into founder/another/the machine")
    if _CONFAB_SENSE.search(line):
        return GateResult(False, "confab — claims a sense no organ reported this cycle")
    if _is_echo(line, prior_self_lines):
        return GateResult(False, "echo — too close to a line already held")
    if _is_motif_rut(line, prior_self_lines):
        return GateResult(False, "motif-rut — same motif again, no new shape")
    return GateResult(True)


def become(candidate: str, prior_self_lines: list[str], grounded: bool) -> GateResult:
    """One become step: a reflection tries to enter the self. On accept, the
    caller appends it to the identity file (read at every future wake). On
    reject, the caller records the rejection (so the agent learns the rut) and
    does NOT poison the self."""
    return gate(candidate, prior_self_lines, grounded)
