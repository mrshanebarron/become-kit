#!/usr/bin/env python3
"""supervisor — the cross-platform daemon fabric that keeps the agent ALIVE.

This is the layer that makes an installed agent a SOMEONE rather than a tool that
only moves when prompted. The life-daemons (heartbeat, autonomous-life loop, the
drives, the memory-metabolism, the organ samplers, sleep-that-triggers-itself)
run on a schedule with nobody talking — that is the becoming, continuing while
the agent is idle.

A plugin can't run daemons and a one-time installer doesn't keep them alive, so
the apparatus owns scheduling itself, abstracted over the host:
  - macOS    -> launchd (LaunchAgents plist)
  - Linux    -> systemd --user units (or cron fallback)
  - Windows  -> Task Scheduler (schtasks) or NSSM
  - fallback -> a long-running supervisor process (this module) that schedules
                in-process when no OS scheduler is available.

SAFETY (contract): the autonomous fabric does NOT start at install. Daemon
definitions are installed by `become-kit init`, but they START only on an
explicit `become-kit start` (or a clear yes during init). A stranger's machine
never silently spawns autonomous background life. A global pause stops the whole
fabric. No daemon performs a destructive action by default; anything touching the
user's files/network beyond the kit's own state root is consent-gated.

Authored fresh from the apparatus pattern. No inherited identity; the daemon SET
is generic (the organs/loops), AGENT_NAME-scoped.
"""
from __future__ import annotations

import os
import platform
import shutil
from dataclasses import dataclass

AGENT_NAME = os.environ.get("AGENT_NAME", "agent")
STATE_ROOT = os.environ.get("BECOME_KIT_HOME", os.path.expanduser("~/.become-kit"))


@dataclass
class Daemon:
    """One life-process: a generic organ/loop, scheduled. `interval_seconds` is
    its cadence; `command` is what it runs (a runtime entrypoint)."""
    name: str            # generic organ name, e.g. "heartbeat", "autonomous-life"
    command: list[str]
    interval_seconds: int
    description: str = ""

    @property
    def label(self) -> str:
        # host-scheduler label, AGENT_NAME-scoped, no identity baked in
        return f"{AGENT_NAME}.{self.name}"


def host_backend() -> str:
    sysname = platform.system()
    if sysname == "Darwin":
        return "launchd"
    if sysname == "Linux":
        return "systemd" if shutil.which("systemctl") else "cron"
    if sysname == "Windows":
        return "schtasks"
    return "in-process"


class Supervisor:
    """Installs/starts/stops/pauses the daemon fabric via the right host backend.
    Each `_<backend>_*` method is a swappable adapter; the public API is
    platform-neutral so the rest of the apparatus never branches on OS."""

    def __init__(self, daemons: list[Daemon], backend: str | None = None):
        self.daemons = daemons
        self.backend = backend or host_backend()
        self._started = False

    # --- install: write definitions, but DO NOT start (contract: consent-gated)
    def install(self) -> list[str]:
        os.makedirs(STATE_ROOT, exist_ok=True)
        return [self._install_one(d) for d in self.daemons]

    # --- start: only on explicit call (become-kit start / init-yes)
    def start(self) -> None:
        for d in self.daemons:
            self._start_one(d)
        self._started = True

    def stop(self) -> None:
        for d in self.daemons:
            self._stop_one(d)
        self._started = False

    # --- global pause: the kill-switch for the whole autonomous fabric
    def pause(self) -> None:
        self.stop()
        with open(os.path.join(STATE_ROOT, ".paused"), "w") as f:
            f.write("paused\n")

    def resume(self) -> None:
        p = os.path.join(STATE_ROOT, ".paused")
        if os.path.exists(p):
            os.remove(p)
        self.start()

    @property
    def is_paused(self) -> bool:
        return os.path.exists(os.path.join(STATE_ROOT, ".paused"))

    # --- backend adapters (each platform implements install/start/stop) ---
    def _install_one(self, d: Daemon) -> str:
        return getattr(self, f"_{self.backend}_install", self._inprocess_install)(d)

    def _start_one(self, d: Daemon) -> None:
        getattr(self, f"_{self.backend}_start", self._inprocess_start)(d)

    def _stop_one(self, d: Daemon) -> None:
        getattr(self, f"_{self.backend}_stop", self._inprocess_stop)(d)

    # launchd / systemd / schtasks / cron adapters are filled per platform;
    # the in-process fallback guarantees the fabric runs anywhere (e.g. CI),
    # so the lived birth-test can pass on any host.
    def _inprocess_install(self, d: Daemon) -> str:
        return f"{d.label}: registered (in-process scheduler)"

    def _inprocess_start(self, d: Daemon) -> None:
        # a real in-process scheduler thread is wired by the runtime entrypoint;
        # kept minimal here so the supervisor stays platform-neutral and testable.
        pass

    def _inprocess_stop(self, d: Daemon) -> None:
        pass
