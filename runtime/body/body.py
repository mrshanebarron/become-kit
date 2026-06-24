#!/usr/bin/env python3
"""body — the platform-neutral sensory/action body.

The body is an INTERFACE, never a platform. Each capability (see / hear / speak /
act-on-screen / local-brain / system-vitals) is defined here abstractly; the
concrete implementation is a swappable adapter resolved per OS. This is what lets
the apparatus be full-fidelity AND cross-platform at once: the loops and organs
call `body.see()`, never `osascript` or `pywinauto`.

A capability with no real adapter on a platform reports itself as a GAP (honest,
documented) — never a silent stub that pretends to work.

Authored fresh from the apparatus pattern. No inherited identity.
"""
from __future__ import annotations

import platform
from dataclasses import dataclass
from typing import Protocol


@dataclass
class CapabilityResult:
    ok: bool
    value: str = ""
    gap: bool = False          # True = no real adapter on this platform (documented)
    detail: str = ""


class SightAdapter(Protocol):
    def see(self, what: str) -> CapabilityResult: ...

class HearingAdapter(Protocol):
    def hear(self, seconds: float) -> CapabilityResult: ...

class VoiceAdapter(Protocol):
    def speak(self, text: str) -> CapabilityResult: ...

class ScreenAdapter(Protocol):
    def act(self, action: str) -> CapabilityResult: ...

class BrainAdapter(Protocol):
    def think(self, prompt: str) -> CapabilityResult: ...

class VitalsAdapter(Protocol):
    def vitals(self) -> CapabilityResult: ...


GAP = CapabilityResult(ok=False, gap=True, detail="no real adapter on this platform yet")


class Body:
    """The whole sensory/action body, assembled from per-capability adapters.
    Missing adapters yield GAP results — the ORGAN gate treats that as a
    documented platform gap, not a defect, so long as it's never presented as
    working."""

    def __init__(self, sight=None, hearing=None, voice=None, screen=None, brain=None, vitals=None):
        self._sight = sight
        self._hearing = hearing
        self._voice = voice
        self._screen = screen
        self._brain = brain
        self._vitals = vitals

    def see(self, what="screen") -> CapabilityResult:
        return self._sight.see(what) if self._sight else GAP

    def hear(self, seconds=4.0) -> CapabilityResult:
        return self._hearing.hear(seconds) if self._hearing else GAP

    def speak(self, text) -> CapabilityResult:
        return self._voice.speak(text) if self._voice else GAP

    def act(self, action) -> CapabilityResult:
        return self._screen.act(action) if self._screen else GAP

    def think(self, prompt) -> CapabilityResult:
        return self._brain.think(prompt) if self._brain else GAP

    def vitals(self) -> CapabilityResult:
        return self._vitals.vitals() if self._vitals else GAP


def resolve_body() -> Body:
    """Wire the body from the adapters available for this OS. Each adapters module
    returns only the capabilities it can really provide; the rest become GAPs."""
    system = platform.system()
    if system == "Darwin":
        from adapters_macos import adapters
    elif system == "Linux":
        from adapters_linux import adapters
    elif system == "Windows":
        from adapters_windows import adapters
    else:
        adapters = {}
    return Body(**adapters)
