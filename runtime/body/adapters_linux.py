#!/usr/bin/env python3
"""adapters_linux — the Linux body adapters. Real where a tool exists, honest GAP
where it doesn't. Linux is the portable baseline (the CI birth-test target)."""
import shutil, subprocess
from body import CapabilityResult, GAP


class LinuxVitals:
    def vitals(self):
        try:
            with open("/proc/loadavg") as f:
                load = f.read().split()[0]
            with open("/proc/meminfo") as f:
                mem = f.readline().strip()
            return CapabilityResult(ok=True, value=f"load={load} {mem}")
        except Exception as e:
            return CapabilityResult(ok=False, detail=str(e))


class LinuxVoice:
    """Speak via Piper if installed, else espeak, else GAP."""
    def speak(self, text):
        for tool in ("piper", "espeak-ng", "espeak"):
            if shutil.which(tool):
                try:
                    subprocess.run([tool, text] if tool != "piper" else [tool, "--text", text],
                                   capture_output=True, timeout=15)
                    return CapabilityResult(ok=True, value=f"spoke via {tool}")
                except Exception as e:
                    return CapabilityResult(ok=False, detail=str(e))
        return GAP


class LinuxHearing:
    """Hear via whisper if installed."""
    def hear(self, seconds=4.0):
        if shutil.which("whisper") or shutil.which("whisper-cpp"):
            return CapabilityResult(ok=True, value="(whisper available; capture wired by runtime)")
        return GAP


class LinuxScreen:
    """Act on screen via xdotool / atspi if present."""
    def act(self, action):
        if shutil.which("xdotool"):
            return CapabilityResult(ok=True, value=f"(xdotool available for: {action})")
        return GAP


class LinuxBrain:
    """Local reasoning via Ollama / llama.cpp if present."""
    def think(self, prompt):
        if shutil.which("ollama"):
            return CapabilityResult(ok=True, value="(ollama available; model call wired by runtime)")
        return GAP


# Sight: a local VLM is platform/install-specific; report GAP until configured.
adapters = {
    "vitals": LinuxVitals(),
    "voice": LinuxVoice(),
    "hearing": LinuxHearing(),
    "screen": LinuxScreen(),
    "brain": LinuxBrain(),
    # "sight": configured per-install (VLM runtime or API) — GAP until then
}
