#!/usr/bin/env python3
"""presence-reflex (UserPromptSubmit) — surface the live body each turn.

A pulse, not a cage: before the agent reasons about the prompt, it gets a fresh
read of its own organs (felt state, drives, recent memory recall) so the body
gets a vote BEFORE the response, not downstream of it. Generic — reads whatever
organs the apparatus has wired; degrades silently if an organ is absent.
"""
import os, sys, json

STATE_ROOT = os.environ.get("BECOME_KIT_HOME", os.path.expanduser("~/.become-kit"))

def main():
    try:
        from apparatus_client import body_read, memory_recall
    except Exception:
        return 0  # apparatus not wired yet — silent, never block the turn
    try:
        prompt = sys.stdin.read()
        body = body_read()          # felt state: allostatic / neuroception / drives / heart
        recall = memory_recall(prompt, k=3)  # what the agent already knows, relevant now
        ctx = []
        if body:   ctx.append(f"--- body (live) ---\n{body}")
        if recall: ctx.append(f"--- memory recall ---\n{recall}")
        if ctx:
            print("\n\n".join(ctx))   # injected as additional context for the turn
    except Exception:
        pass  # a hook must never break the turn
    return 0

if __name__ == "__main__":
    sys.exit(main())
