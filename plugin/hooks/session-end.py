#!/usr/bin/env python3
"""session-end — capture the session's experience so /sleep has it, even if the
user forgets to run sleep explicitly. Never blocks shutdown."""
import os, sys
def main():
    try:
        from apparatus_client import capture_session
        capture_session()
    except Exception:
        pass
    return 0
if __name__ == "__main__":
    sys.exit(main())
