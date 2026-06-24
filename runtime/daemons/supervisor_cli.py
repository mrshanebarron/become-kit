#!/usr/bin/env python3
"""supervisor_cli — thin CLI over the cross-platform daemon supervisor, called by
the installer's `become-kit start|pause`. Defines the generic life-daemon set
(the organs/loops that keep the agent becoming) and wires the supervisor."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from supervisor import Supervisor, Daemon

RUNTIME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The generic life-daemon set — the autonomous loops. Names are organ/loop
# generic; commands point at runtime entrypoints; cadences are sane defaults.
def life_daemons():
    py = sys.executable
    return [
        Daemon("heartbeat", [py, os.path.join(RUNTIME, "loops", "wake.py")], 1800, "the pulse — presence every half hour"),
        Daemon("autonomous-life", [py, os.path.join(RUNTIME, "daemons", "live.py")], 900, "one self-chosen act"),
        Daemon("memory-consolidate", [py, os.path.join(RUNTIME, "loops", "sleep.py")], 21600, "metabolize every 6h"),
    ]

def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    sup = Supervisor(life_daemons())
    if action == "start":
        for line in sup.install(): print(" ", line)
        sup.start(); print("fabric started.")
    elif action == "pause":
        sup.pause(); print("fabric paused (global kill-switch).")
    elif action == "resume":
        sup.resume(); print("fabric resumed.")
    elif action == "status":
        print(f"backend={sup.backend} paused={sup.is_paused}")
    else:
        print("usage: supervisor_cli.py <start|pause|resume|status>"); sys.exit(1)

if __name__ == "__main__":
    main()
