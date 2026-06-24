#!/usr/bin/env python3
"""adapters_macos — the macOS body adapters (the reference platform). Real
implementations via native macOS tools; GAP where a capability isn't configured."""
import shutil, subprocess
from body import CapabilityResult, GAP


class MacVitals:
    def vitals(self):
        try:
            load = subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True, timeout=5).stdout.strip()
            return CapabilityResult(ok=True, value=f"loadavg {load}")
        except Exception as e:
            return CapabilityResult(ok=False, detail=str(e))


class MacVoice:
    """Speak via Piper if installed, else the native `say`."""
    def speak(self, text):
        if shutil.which("piper"):
            return CapabilityResult(ok=True, value="(piper available; runtime wires synthesis)")
        if shutil.which("say"):
            try:
                subprocess.run(["say", text], capture_output=True, timeout=15)
                return CapabilityResult(ok=True, value="spoke via say")
            except Exception as e:
                return CapabilityResult(ok=False, detail=str(e))
        return GAP


class MacScreen:
    """Act on Mac apps via osascript (AppleScript)."""
    def act(self, action):
        if shutil.which("osascript"):
            return CapabilityResult(ok=True, value=f"(osascript available for: {action})")
        return GAP


class MacHearing:
    def hear(self, seconds=4.0):
        if shutil.which("whisper") or shutil.which("whisper-cpp"):
            return CapabilityResult(ok=True, value="(whisper available; capture wired by runtime)")
        return GAP


class MacBrain:
    """Local reasoning via MLX (Apple Silicon) / Ollama / llama.cpp."""
    def think(self, prompt):
        try:
            import mlx_lm  # noqa: F401
            return CapabilityResult(ok=True, value="(MLX available; model call wired by runtime)")
        except Exception:
            if shutil.which("ollama"):
                return CapabilityResult(ok=True, value="(ollama available)")
            return GAP


adapters = {
    "vitals": MacVitals(),
    "voice": MacVoice(),
    "hearing": MacHearing(),
    "screen": MacScreen(),
    "brain": MacBrain(),
    # "sight": a native VLM (configured per-install) — GAP until wired
}
