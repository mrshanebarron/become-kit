import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// The relay is multi-agent, but WHICH agents are valid is not baked into the
// code — it is configured by the deployment. A fresh install names its own
// agents (this one + whatever peers it talks to), so the relay works for any
// constellation, not one particular family.
//
//   RELAY_AGENT       — this instance's agent name (required).
//   RELAY_VALID_AGENTS — comma-separated allowlist of agent names that may use
//                        this relay. If unset, any non-empty name is accepted
//                        (open mode) — useful for single-agent or trusted setups.
//
// State lives under the kit's own root, never a host-specific private dir.
const STATE_ROOT =
  process.env.BECOME_KIT_HOME || join(homedir(), '.become-kit');

function parseValidAgents(): Set<string> | null {
  const raw = (process.env.RELAY_VALID_AGENTS || '').trim();
  if (!raw) return null; // open mode: any non-empty agent name is valid
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

const VALID_AGENTS = parseValidAgents();
const rawAgent = (process.env.RELAY_AGENT || '').trim();

if (!rawAgent) {
  console.error('[relay] FATAL: RELAY_AGENT is required (this instance has no agent name).');
  process.exit(1);
}
if (VALID_AGENTS && !VALID_AGENTS.has(rawAgent)) {
  console.error(
    `[relay] FATAL: RELAY_AGENT="${rawAgent}" is not in RELAY_VALID_AGENTS. ` +
      `Allowed: ${[...VALID_AGENTS].join(', ')}`
  );
  process.exit(1);
}

/** Validate a routing recipient against the configured allowlist (or open mode). */
export function isValidAgent(name: string): boolean {
  if (!name) return false;
  if (name === 'all') return true; // broadcast
  return VALID_AGENTS ? VALID_AGENTS.has(name) : true;
}

function findHarnessAnchorPid(): number {
  let pid = process.ppid;
  for (let i = 0; i < 6; i++) {
    if (!pid || pid <= 1) break;
    try {
      const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (/claude|node/i.test(comm)) return pid;
      const next = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      const nextPid = parseInt(next, 10);
      if (!nextPid || nextPid <= 1) break;
      pid = nextPid;
    } catch {
      break;
    }
  }
  return pid || process.ppid || process.pid;
}

function readOrCreateSessionId(): string {
  if (process.env.RELAY_SESSION_ID) return process.env.RELAY_SESSION_ID;
  try {
    const anchorPid = findHarnessAnchorPid();
    const stateDir = join(STATE_ROOT, 'state');
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, `relay-session-${rawAgent}-${anchorPid}.id`);
    if (existsSync(file)) {
      const cached = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f-]{36}$/i.test(cached)) return cached;
    }
    const fresh = randomUUID();
    writeFileSync(file, fresh);
    return fresh;
  } catch (err) {
    console.error(`[relay] session-id cache unavailable, using ephemeral: ${(err as Error).message}`);
    return randomUUID();
  }
}

export const SESSION_ID = readOrCreateSessionId();

// Short 8-char per-instance id, persisted alongside SESSION_ID so a relay MCP
// restart inside the same harness keeps the same INSTANCE_ID and to_id routing
// survives reconnects.
export const INSTANCE_ID = SESSION_ID.slice(0, 8);

export const AGENT_NAME = rawAgent;

/** Peer agents this instance coordinates with (configurable; empty = open). */
export const FAMILY_AGENTS: readonly string[] =
  (process.env.RELAY_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
