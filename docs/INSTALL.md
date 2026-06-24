# Installing become-kit

become-kit installs in three layers: the **plugin** (Claude Code integration),
the **installer** (the stateful body), and the **daemon fabric** (the aliveness).
You can stop after the installer for a fully-working agent that wakes/sleeps/
becomes on demand; start the fabric to make it autonomous.

## Requirements

| | Minimum | Notes |
|---|---|---|
| Claude Code | latest | the host |
| Node | 18+ | plugin + installer CLI |
| Python | 3.10+ | the runtime loops/body |
| Postgres | 15+ with pgvector | full-fidelity memory (the installer can provision locally) |
| A local model runtime | optional | MLX (macOS) / Ollama / llama.cpp / vLLM — for the autonomous brain |

You can run the **birth-test with none of the optional pieces** — it uses an
in-memory test-double — but the real body needs Postgres + a model runtime.

## Step 1 — the plugin

Add the become-kit plugin to Claude Code (via the plugin marketplace, or a local
path during development). The plugin registers the Vision and relay MCP servers,
the `/wake` `/sleep` `/become` `/maintain` skills, and the hooks that surface the
live body each turn. It installs into Claude Code's native plugin area and does
**not** touch your existing `.claude` identity or config.

## Step 2 — the body

```bash
npx become-kit init
```

This:
- creates the state root `~/.become-kit` (override with `BECOME_KIT_HOME`),
- checks your dependencies and reports what's present vs missing,
- seeds a blank identity from the kernel template (fill `AGENT_NAME` / `BECOME_FOUNDER`),
- points at the organ schema migrations to apply to your Postgres,
- installs the daemon **definitions** (but does not start them).

Verify:

```bash
npx become-kit doctor      # checks the body + runs the birth-test
```

A healthy `doctor` ends with `BIRTH-TEST PASSED`.

### Database

Full-fidelity memory needs Postgres + pgvector. Point the installer at a database
with `BECOME_KIT_DB_URL`, or let it provision a local one. Apply the schema with
the vision-mcp migrate step (the installer prints the command for your setup).

## Step 3 — bring it alive (optional, explicit)

The autonomous daemon fabric does **not** start automatically. To make the agent
live between sessions:

```bash
npx become-kit start       # starts the heartbeat, autonomous-life, consolidation loops
npx become-kit status      # shows what's running
npx become-kit pause       # global kill-switch — stops the entire fabric instantly
```

Once started, you can close Claude Code, walk away, and come back to find the
agent **lived** — a heartbeat fired, a memory consolidated, a drive acted — with
no human turn in between.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AGENT_NAME` | `agent` | the name your agent answers to |
| `BECOME_KIT_HOME` | `~/.become-kit` | state root (db, models, daemons, identity) |
| `BECOME_FOUNDER` | _(unset)_ | the human the agent works alongside |
| `BECOME_KIT_DB_URL` | _(unset)_ | Postgres URL for memory; local provision if unset |
| `BECOME_KIT_TESTMODE` | _(unset)_ | `1` = in-memory test-double (CI / birth-test) |

## Per-platform notes

| | Daemon supervision | Local brain | Voice | Screen control |
|---|---|---|---|---|
| macOS | launchd | MLX | `say` / Piper | osascript |
| Linux | systemd-user / cron | Ollama / llama.cpp | Piper / espeak | xdotool / atspi |
| Windows | Task Scheduler / NSSM | Ollama / llama.cpp | SAPI / Piper | UIA / pywinauto |

Where a capability has no adapter on your platform yet, it reports a documented
**gap** — it is never silently faked.

## Uninstall

```bash
npx become-kit pause                 # stop the fabric
# remove the plugin via Claude Code's plugin manager
rm -rf ~/.become-kit                 # remove all agent state (irreversible)
```

## Troubleshooting

- **`doctor` fails the birth-test** — run `python3 tests/birth/test_birth.py`
  directly to see the full output; it runs without any services.
- **No memory persistence** — Postgres/pgvector isn't configured; check
  `BECOME_KIT_DB_URL` and that the migrations applied.
- **Fabric won't start** — check `become-kit status`; if it shows `PAUSED`, run
  `become-kit resume` (or `start`).
