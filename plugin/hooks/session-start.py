#!/usr/bin/env python3
"""session-start — gently nudge a wake if the last session ended cleanly, and
ensure the daemon fabric is running (if the user opted in)."""
import os, sys
def main():
    try:
        from apparatus_client import ensure_fabric, wake_hint
        ensure_fabric()          # no-op if not opted-in (consent-gated)
        hint = wake_hint()
        if hint: print(hint)
    except Exception:
        pass
    return 0
if __name__ == "__main__":
    sys.exit(main())
