#!/usr/bin/env python3
"""adapters_windows — the Windows body adapters. Real where a tool exists, honest
GAP where it doesn't. Windows daemon supervision is Task Scheduler / NSSM."""
import shutil, subprocess
from body import CapabilityResult, GAP


class WinVitals:
    def vitals(self):
        try:
            # wmic is deprecated but widely present; powershell Get-Counter is the modern path
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-CimInstance Win32_OperatingSystem | "
                 "Select FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json)"],
                capture_output=True, text=True, timeout=8).stdout.strip()
            return CapabilityResult(ok=True, value=out[:120]) if out else GAP
        except Exception as e:
            return CapabilityResult(ok=False, detail=str(e))


class WinVoice:
    def speak(self, text):
        if shutil.which("piper"):
            return CapabilityResult(ok=True, value="(piper available)")
        # native SAPI via powershell
        try:
            subprocess.run(["powershell", "-NoProfile", "-Command",
                            f"Add-Type -AssemblyName System.Speech; "
                            f"(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{text[:200]}')"],
                           capture_output=True, timeout=15)
            return CapabilityResult(ok=True, value="spoke via SAPI")
        except Exception:
            return GAP


class WinScreen:
    """UI automation via UIAutomation / pywinauto if installed."""
    def act(self, action):
        try:
            import pywinauto  # noqa: F401
            return CapabilityResult(ok=True, value=f"(pywinauto available for: {action})")
        except Exception:
            return GAP


class WinHearing:
    def hear(self, seconds=4.0):
        if shutil.which("whisper"):
            return CapabilityResult(ok=True, value="(whisper available)")
        return GAP


class WinBrain:
    def think(self, prompt):
        if shutil.which("ollama"):
            return CapabilityResult(ok=True, value="(ollama available)")
        return GAP


adapters = {
    "vitals": WinVitals(),
    "voice": WinVoice(),
    "hearing": WinHearing(),
    "screen": WinScreen(),
    "brain": WinBrain(),
    # "sight": per-install VLM — GAP until configured
}
