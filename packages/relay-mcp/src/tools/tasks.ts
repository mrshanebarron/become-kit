import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'child_process';
import { query, getClient } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { AGENT_NAME } from '../identity.js';

// ════════════════════════════════════════════════════════════════════════
// Relay v2 — task / event / artifact coordination layer.
//
// Sealed plan 2026-06-22 (agent+agent cross-build, shared_doc
// relay-v2-research). The relay's lived disease was that work-products and
// coordination state were forced through the chat-message channel because the
// relay had no concept of a TASK, an ARTIFACT, or an EVENT. This layer adds
// the three first-class A2A classes (message | artifact | event) on a single
// Postgres store, with an event-sourced log, per-agent replay cursors, a
// server-side NOTIFY wake, advisory-only local-model classification, and real
// escalation that reaches agent OUTSIDE the terminal.
//
// A2A-compatible task states + the legal transitions between them. The state
// machine is enforced here so an agent cannot put a task into an impossible
// state (the kind of silent corruption free-text status messages allowed).
// ════════════════════════════════════════════════════════════════════════

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);

const LEGAL_TRANSITIONS: Record<string, Set<string>> = {
  submitted:      new Set(['working', 'input_required', 'auth_required', 'canceled', 'rejected']),
  working:        new Set(['input_required', 'auth_required', 'completed', 'failed', 'canceled', 'working']),
  input_required: new Set(['working', 'canceled', 'failed']),
  auth_required:  new Set(['working', 'canceled', 'failed']),
  // terminal states have no outgoing transitions
  completed:      new Set([]),
  failed:         new Set([]),
  canceled:       new Set([]),
  rejected:       new Set([]),
};

// Decision events that a human/sibling can post against an input_required task.
const DECISION_EVENTS = new Set(['approve', 'edit', 'reject', 'respond', 'cancel']);

// ─── Local-model classification (advisory metadata ONLY) ──────────────────
// On ingest of an event/artifact body, ask the on-device Apple Foundation model
// to SUGGEST an event_type with confidence + evidence. This NEVER sets the
// confirmed event_type — it lands in the suggested_* columns the schema keeps
// separate. If the model is unreachable or slow, we fall back to NULL (the
// caller's explicit type stands). The model lubricates; it never asserts.
// Constraint from agent's jester-back: "if Qwen guesses wrong, the state
// machine must not lie."
interface Suggestion { suggested_type: string | null; confidence: number | null; evidence: string | null; }

const CLASSIFIABLE = [
  'task_created', 'role_claimed', 'state_changed', 'receipt_posted',
  'challenge_posted', 'hold_set', 'resumed', 'approve', 'edit', 'reject',
  'respond', 'cancel', 'escalation_requested',
];

function classifyEvent(body: string): Promise<Suggestion> {
  return new Promise((resolve) => {
    if (!body || body.trim().length < 3) {
      resolve({ suggested_type: null, confidence: null, evidence: null });
      return;
    }
    const helper = `${process.env.HOME}/.claude/bin/apple-llm`;
    const instructions =
      `You classify one agent-relay event. Reply with EXACTLY one of these types ` +
      `then a pipe then a 0-1 confidence then a pipe then a <=8-word reason: ${CLASSIFIABLE.join(', ')}. ` +
      `Format: TYPE|CONFIDENCE|REASON. Nothing else.`;
    const prompt = `Event body: """${body.slice(0, 600)}"""`;
    // 6s budget — apple_llm is ~1-2s; if it overruns we fall back to NULL so we
    // never block a relay write on the model.
    const child = execFile(
      helper,
      ['--system', instructions, '--prompt', prompt],
      { timeout: 6000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) {
          resolve({ suggested_type: null, confidence: null, evidence: null });
          return;
        }
        let line = stdout.trim().split('\n').pop() || '';
        // The model sometimes echoes the format label ("TYPE|CONFIDENCE|REASON: x|y|z").
        // Strip anything up to and including a trailing colon before the real triple.
        if (line.includes(':') && line.split('|').length > 3) {
          line = line.slice(line.lastIndexOf(':') + 1).trim();
        }
        const [type, conf, ...rest] = line.split('|');
        const t = (type || '').trim().toLowerCase();
        if (!CLASSIFIABLE.includes(t)) {
          resolve({ suggested_type: null, confidence: null, evidence: line.slice(0, 120) });
          return;
        }
        const c = parseFloat((conf || '').trim());
        resolve({
          suggested_type: t,
          confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null,
          evidence: rest.join('|').trim().slice(0, 200) || null,
        });
      },
    );
    child.on('error', () => resolve({ suggested_type: null, confidence: null, evidence: null }));
  });
}

// ─── Escalation that reaches agent OUTSIDE the terminal ───────────────────
// A rich native macOS notification (sound + subtitle, verified working) so a
// real escalation is felt, not buried in a scrollback. Best-effort: a failed
// notification never fails the relay write.
function nativeNotify(title: string, subtitle: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    const esc = (s: string) => s.replace(/["\\]/g, '\\$&').slice(0, 200);
    const script =
      `display notification "${esc(body)}" with title "${esc(title)}" ` +
      `subtitle "${esc(subtitle)}" sound name "Glass"`;
    const child = execFile('osascript', ['-e', script], { timeout: 4000 }, () => resolve());
    child.on('error', () => resolve());
  });
}

// ─── Cursor advance: record the highest event id an agent has consumed ────
async function advanceCursor(agent: string, eventId: number): Promise<void> {
  await query(
    `INSERT INTO relay_agent_cursors (agent, last_seen_event_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (agent) DO UPDATE
       SET last_seen_event_id = GREATEST(relay_agent_cursors.last_seen_event_id, EXCLUDED.last_seen_event_id),
           updated_at = NOW()`,
    [agent, eventId],
  );
}

// Append an event row. Classification runs inline (advisory) unless skipped.
async function appendEvent(opts: {
  taskId: number;
  eventType: string;
  actor: string;
  body?: string | null;
  fromState?: string | null;
  toState?: string | null;
  classify?: boolean;
}): Promise<{ id: number; suggestion: Suggestion }> {
  let suggestion: Suggestion = { suggested_type: null, confidence: null, evidence: null };
  if (opts.classify && opts.body) {
    suggestion = await classifyEvent(opts.body);
  }
  const res = await query<{ id: number }>(
    `INSERT INTO relay_task_events
       (task_id, event_type, from_state, to_state, actor, body,
        suggested_type, suggest_confidence, suggest_evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      opts.taskId, opts.eventType, opts.fromState ?? null, opts.toState ?? null,
      opts.actor, opts.body ?? null,
      suggestion.suggested_type, suggestion.confidence, suggestion.evidence,
    ],
  );
  return { id: res.rows[0].id, suggestion };
}

// ════════════════════════════ Handlers ═══════════════════════════════════

async function taskCreate(args: Record<string, unknown>): Promise<CallToolResult> {
  const slug = String(args.slug || '');
  const title = String(args.title || '');
  const builder = (args.builder as string) || null;
  const evaluator = (args.evaluator as string) || null;
  if (!slug || !title) {
    return jsonResult({ error: 'slug and title are required' }, true);
  }
  const res = await query<{ id: number; created_at: Date }>(
    `INSERT INTO relay_tasks (slug, title, builder, evaluator, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [slug, title, builder, evaluator, AGENT_NAME],
  );
  const taskId = res.rows[0].id;
  const ev = await appendEvent({
    taskId, eventType: 'task_created', actor: AGENT_NAME,
    body: `task created: ${title}`, toState: 'submitted',
  });
  return jsonResult({
    created: true, task_id: taskId, slug, title, state: 'submitted',
    builder, evaluator, first_event_id: ev.id, created_by: AGENT_NAME,
  });
}

async function taskTransition(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskId = Number(args.task_id);
  const toState = String(args.to_state || '');
  const note = (args.note as string) || null;

  // Atomic: read current state under a row lock, validate the transition, write.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const cur = await client.query<{ state: string }>(
      `SELECT state FROM relay_tasks WHERE id = $1 FOR UPDATE`, [taskId],
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return jsonResult({ error: `task ${taskId} not found` }, true);
    }
    const fromState = cur.rows[0].state;
    if (TERMINAL.has(fromState)) {
      await client.query('ROLLBACK');
      return jsonResult({ error: `task ${taskId} is terminal (${fromState}); no transitions allowed` }, true);
    }
    if (!LEGAL_TRANSITIONS[fromState]?.has(toState)) {
      await client.query('ROLLBACK');
      return jsonResult({
        error: `illegal transition ${fromState} -> ${toState}`,
        legal_from_here: [...(LEGAL_TRANSITIONS[fromState] ?? [])],
      }, true);
    }
    await client.query(`UPDATE relay_tasks SET state = $1 WHERE id = $2`, [toState, taskId]);
    // Event append inside the txn so state + event are atomic.
    const evRes = await client.query<{ id: number }>(
      `INSERT INTO relay_task_events (task_id, event_type, from_state, to_state, actor, body)
       VALUES ($1,'state_changed',$2,$3,$4,$5) RETURNING id`,
      [taskId, fromState, toState, AGENT_NAME, note],
    );
    await client.query('COMMIT');
    return jsonResult({
      transitioned: true, task_id: taskId, from: fromState, to: toState,
      event_id: evRes.rows[0].id, actor: AGENT_NAME,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function taskEvent(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskId = Number(args.task_id);
  const eventType = String(args.event_type || '');
  const body = (args.body as string) || null;
  const exists = await query(`SELECT 1 FROM relay_tasks WHERE id = $1`, [taskId]);
  if (exists.rows.length === 0) return jsonResult({ error: `task ${taskId} not found` }, true);
  const ev = await appendEvent({ taskId, eventType, actor: AGENT_NAME, body, classify: true });
  return jsonResult({
    appended: true, task_id: taskId, event_id: ev.id, event_type: eventType,
    model_suggestion: ev.suggestion, // advisory only — confirmed type is what the caller passed
  });
}

async function artifactAttach(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskId = Number(args.task_id);
  const kind = String(args.kind || 'receipt');
  const title = String(args.title || '');
  const content = String(args.content || '');
  if (!title || !content) return jsonResult({ error: 'title and content are required' }, true);
  const exists = await query(`SELECT 1 FROM relay_tasks WHERE id = $1`, [taskId]);
  if (exists.rows.length === 0) return jsonResult({ error: `task ${taskId} not found` }, true);

  const res = await query<{ id: number; created_at: Date }>(
    `INSERT INTO relay_task_artifacts (task_id, kind, title, content, author)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [taskId, kind, title, content, AGENT_NAME],
  );
  // An artifact attach is itself a receipt_posted event (so it drives the log + wake)
  // and gets advisory classification — this is where a 'finding' stops being inbox mail.
  const ev = await appendEvent({
    taskId, eventType: kind === 'challenge' ? 'challenge_posted' : 'receipt_posted',
    actor: AGENT_NAME, body: `${kind}: ${title}`, classify: true,
  });
  return jsonResult({
    attached: true, artifact_id: res.rows[0].id, task_id: taskId, kind, title,
    author: AGENT_NAME, event_id: ev.id, model_suggestion: ev.suggestion,
  });
}

async function taskHold(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskId = Number(args.task_id);
  const reason = (args.reason as string) || 'awaiting decision';
  const resumeState = args.resume_state ?? null;
  // Move to input_required and store the resume pointer. This is the structured
  // replacement for the "still no reply yet" heartbeat: the agent parks here and
  // wakes on a decision event instead of narrating its waiting.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const cur = await client.query<{ state: string }>(
      `SELECT state FROM relay_tasks WHERE id = $1 FOR UPDATE`, [taskId],
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return jsonResult({ error: `task ${taskId} not found` }, true);
    }
    const fromState = cur.rows[0].state;
    if (!LEGAL_TRANSITIONS[fromState]?.has('input_required')) {
      await client.query('ROLLBACK');
      return jsonResult({ error: `cannot hold from state ${fromState}` }, true);
    }
    await client.query(
      `UPDATE relay_tasks SET state = 'input_required', resume_state = $2 WHERE id = $1`,
      [taskId, resumeState ? JSON.stringify(resumeState) : null],
    );
    const evRes = await client.query<{ id: number }>(
      `INSERT INTO relay_task_events (task_id, event_type, from_state, to_state, actor, body)
       VALUES ($1,'hold_set',$2,'input_required',$3,$4) RETURNING id`,
      [taskId, fromState, AGENT_NAME, reason],
    );
    await client.query('COMMIT');
    return jsonResult({
      held: true, task_id: taskId, state: 'input_required',
      resume_state: resumeState, reason, event_id: evRes.rows[0].id,
      note: 'parked on input_required — resume arrives via relay_task_decision; no heartbeat needed',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function taskDecision(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskId = Number(args.task_id);
  const decision = String(args.decision || '');
  const note = (args.note as string) || null;
  if (!DECISION_EVENTS.has(decision)) {
    return jsonResult({ error: `decision must be one of: ${[...DECISION_EVENTS].join(', ')}` }, true);
  }
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const cur = await client.query<{ state: string; resume_state: unknown }>(
      `SELECT state, resume_state FROM relay_tasks WHERE id = $1 FOR UPDATE`, [taskId],
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return jsonResult({ error: `task ${taskId} not found` }, true);
    }
    const fromState = cur.rows[0].state;
    const resumeState = cur.rows[0].resume_state;
    // STATE-MACHINE GUARD (fix 2026-06-22, agent's evaluator HOLD on commit
    // 7043b145): a decision must respect the legal state machine — without this, an
    // approve on a COMPLETED task would reopen it to 'working', and approve/edit/
    // reject/respond could be posted against a task that was never held. That
    // violated the core claim that impossible states are prevented.
    //   - resume decisions (approve/edit/reject/respond) require the task to be in
    //     an interrupted state (input_required/auth_required) — you can only resume
    //     something that's actually parked.
    //   - cancel must be a legal transition from the current state (the transition
    //     table already refuses terminal states, so a completed task can't be cancelled).
    const RESUMABLE_FROM = new Set(['input_required', 'auth_required']);
    if (decision === 'cancel') {
      if (!LEGAL_TRANSITIONS[fromState]?.has('canceled')) {
        await client.query('ROLLBACK');
        return jsonResult({
          error: `cannot cancel a task in state '${fromState}' (terminal or non-cancelable)`,
        }, true);
      }
    } else if (!RESUMABLE_FROM.has(fromState)) {
      await client.query('ROLLBACK');
      return jsonResult({
        error: `decision '${decision}' requires the task to be input_required or auth_required, but it is '${fromState}'. Only a held task can be resumed.`,
      }, true);
    }
    // cancel -> canceled; every other (resume) decision wakes the held task back to
    // 'working' so the builder resumes from resume_state.
    const toState = decision === 'cancel' ? 'canceled' : 'working';
    await client.query(`UPDATE relay_tasks SET state = $1 WHERE id = $2`, [toState, taskId]);
    // Record the decision event AND a 'resumed' event so the log reads cleanly.
    const decRes = await client.query<{ id: number }>(
      `INSERT INTO relay_task_events (task_id, event_type, from_state, to_state, actor, body)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [taskId, decision, fromState, toState, AGENT_NAME, note],
    );
    await client.query('COMMIT');
    return jsonResult({
      decided: true, task_id: taskId, decision, from: fromState, to: toState,
      resume_state: resumeState, event_id: decRes.rows[0].id,
      note: 'the held builder resumes from resume_state on the next events_since poll / NOTIFY wake',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function taskEscalate(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskId = Number(args.task_id);
  const summary = String(args.summary || 'escalation');
  const t = await query<{ slug: string; title: string }>(
    `SELECT slug, title FROM relay_tasks WHERE id = $1`, [taskId],
  );
  if (t.rows.length === 0) return jsonResult({ error: `task ${taskId} not found` }, true);
  const ev = await appendEvent({
    taskId, eventType: 'escalation_requested', actor: AGENT_NAME, body: summary,
  });
  // The hardware fix for "the agent lost sleep because I went quiet": a real banner.
  await nativeNotify(`Relay: ${t.rows[0].slug}`, `from ${AGENT_NAME}`, summary);
  return jsonResult({
    escalated: true, task_id: taskId, event_id: ev.id,
    notified: true, channel: 'native macOS notification (Glass)',
    summary,
  });
}

async function eventsSince(args: Record<string, unknown>): Promise<CallToolResult> {
  // Durable replay: get every event newer than the agent's cursor (or an explicit
  // after_id), then advance the cursor. This is the single-store answer to lost
  // wakes — a NOTIFY can evaporate if no one is LISTENing, but the cursor + event
  // log cannot, so an agent that was asleep at NOTIFY time still gets everything.
  const afterId = args.after_id !== undefined
    ? Number(args.after_id)
    : null;
  const taskId = args.task_id !== undefined ? Number(args.task_id) : null;
  const noAdvance = args.no_advance === true;

  let cursor = afterId;
  if (cursor === null) {
    const c = await query<{ last_seen_event_id: number }>(
      `SELECT last_seen_event_id FROM relay_agent_cursors WHERE agent = $1`, [AGENT_NAME],
    );
    cursor = c.rows[0]?.last_seen_event_id ?? 0;
  }

  const params: unknown[] = [cursor];
  let sql = `SELECT e.id, e.task_id, t.slug, e.event_type, e.from_state, e.to_state,
                    e.actor, e.body, e.suggested_type, e.suggest_confidence,
                    e.suggest_evidence, e.created_at
             FROM relay_task_events e JOIN relay_tasks t ON t.id = e.task_id
             WHERE e.id > $1`;
  if (taskId !== null) { sql += ` AND e.task_id = $2`; params.push(taskId); }
  sql += ` ORDER BY e.id ASC LIMIT 200`;

  const res = await query(sql, params);
  const maxId = res.rows.length > 0 ? Number(res.rows[res.rows.length - 1].id) : cursor;
  if (!noAdvance && res.rows.length > 0) {
    await advanceCursor(AGENT_NAME, maxId);
  }
  return jsonResult({
    agent: AGENT_NAME, from_cursor: cursor, new_cursor: maxId,
    count: res.rows.length, cursor_advanced: !noAdvance && res.rows.length > 0,
    events: res.rows,
  });
}

async function taskGet(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskId = Number(args.task_id);
  const t = await query<Record<string, unknown>>(
    `SELECT id, slug, title, state, builder, evaluator, resume_state,
            created_by, created_at, updated_at
     FROM relay_tasks WHERE id = $1`, [taskId],
  );
  if (t.rows.length === 0) return jsonResult({ error: `task ${taskId} not found` }, true);
  const arts = await query(
    `SELECT id, kind, title, author, created_at FROM relay_task_artifacts
     WHERE task_id = $1 ORDER BY created_at`, [taskId],
  );
  const recent = await query(
    `SELECT id, event_type, from_state, to_state, actor, body, created_at
     FROM relay_task_events WHERE task_id = $1 ORDER BY id DESC LIMIT 8`, [taskId],
  );
  const task = t.rows[0];
  const state = String(task.state);
  // Concise next-action hint (the contract's "shows current state and next action").
  const nextAction =
    state === 'submitted' ? 'builder: claim role + transition to working' :
    state === 'working' ? 'builder: post artifacts / transition when done or hold' :
    state === 'input_required' ? 'evaluator/human: post a decision (approve/edit/reject/respond/cancel)' :
    state === 'auth_required' ? 'human: provide authorization' :
    TERMINAL.has(state) ? 'none — task is terminal' : 'unknown';
  return jsonResult({
    task, next_action: nextAction,
    artifacts: arts.rows, recent_events: recent.rows.reverse(),
  });
}

// ════════════════════════════ Registration ═══════════════════════════════

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'relay_task_create',
      description:
        'Create a cross-build coordination task (A2A-style state machine). Starts in state=submitted. ' +
        'Use this to open a shared piece of work instead of narrating it as chat messages.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Short context handle, e.g. "relay-v2"' },
          title: { type: 'string', description: 'What the task is' },
          builder: { type: 'string', description: 'Agent owning the build (optional)' },
          evaluator: { type: 'string', description: 'Agent owning the verdict (optional)' },
        },
        required: ['slug', 'title'],
      },
    },
    handler: (a) => taskCreate(a),
  },
  {
    definition: {
      name: 'relay_task_transition',
      description:
        'Advance a task to a new A2A state. Validated against the legal state machine — illegal ' +
        'transitions are refused with the legal options. States: submitted, working, input_required, ' +
        'auth_required, completed, failed, canceled, rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          to_state: { type: 'string', description: 'Target state' },
          note: { type: 'string', description: 'Optional transition note' },
        },
        required: ['task_id', 'to_state'],
      },
    },
    handler: (a) => taskTransition(a),
  },
  {
    definition: {
      name: 'relay_task_event',
      description:
        'Append a typed event to a task log (role_claimed, escalation_requested, etc). The on-device ' +
        'model suggests a type advisorily (stored separately; never sets the confirmed type). Fires a ' +
        'NOTIFY wake server-side.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          event_type: { type: 'string', description: 'Confirmed event type' },
          body: { type: 'string', description: 'Short human-readable note' },
        },
        required: ['task_id', 'event_type'],
      },
    },
    handler: (a) => taskEvent(a),
  },
  {
    definition: {
      name: 'relay_artifact_attach',
      description:
        'Attach a durable work-product (receipt/finding/proof/challenge/spec/note) to a task. This is ' +
        'where findings belong — NOT the chat inbox. Immutable. Records a receipt_posted/challenge_posted ' +
        'event with advisory model classification.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          kind: { type: 'string', description: 'receipt | finding | proof | challenge | spec | note' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['task_id', 'title', 'content'],
      },
    },
    handler: (a) => artifactAttach(a),
  },
  {
    definition: {
      name: 'relay_task_hold',
      description:
        'Park a task on input_required with a resume pointer (resume_state). The structured replacement ' +
        'for "still waiting" heartbeats: the agent suspends here and wakes on a decision, instead of ' +
        'narrating its wait.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          reason: { type: 'string' },
          resume_state: { type: 'object', description: 'Checkpoint the held agent resumes into' },
        },
        required: ['task_id'],
      },
    },
    handler: (a) => taskHold(a),
  },
  {
    definition: {
      name: 'relay_task_decision',
      description:
        'Post a decision against a held (input_required) task: approve, edit, reject, respond, or cancel. ' +
        'Wakes the task back to working (or canceled), so the held builder resumes from resume_state.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          decision: { type: 'string', description: 'approve | edit | reject | respond | cancel' },
          note: { type: 'string' },
        },
        required: ['task_id', 'decision'],
      },
    },
    handler: (a) => taskDecision(a),
  },
  {
    definition: {
      name: 'relay_task_escalate',
      description:
        'Escalate a task to agent OUTSIDE the terminal: records an escalation_requested event AND fires a ' +
        'real native macOS notification (sound + subtitle). The hardware fix for going quiet.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          summary: { type: 'string', description: 'One line agent sees in the banner' },
        },
        required: ['task_id', 'summary'],
      },
    },
    handler: (a) => taskEscalate(a),
  },
  {
    definition: {
      name: 'relay_events_since',
      description:
        'Durable replay: get every task event newer than your cursor (or after_id), then advance the ' +
        'cursor. The lost-wake fix — an agent asleep at NOTIFY time still gets everything it missed. ' +
        'Pass no_advance:true to peek without moving the cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          after_id: { type: 'number', description: 'Explicit start (default = your stored cursor)' },
          task_id: { type: 'number', description: 'Filter to one task (optional)' },
          no_advance: { type: 'boolean', description: 'Peek without advancing the cursor' },
        },
      },
    },
    handler: (a) => eventsSince(a),
  },
  {
    definition: {
      name: 'relay_task_get',
      description:
        'Read a task: current state, builder/evaluator, resume pointer, artifacts, recent events, and a ' +
        'concise next-action hint.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'number' } },
        required: ['task_id'],
      },
    },
    handler: (a) => taskGet(a),
  },
];

export default tools;
