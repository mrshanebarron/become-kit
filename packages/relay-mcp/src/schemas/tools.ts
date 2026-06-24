import { z } from 'zod';

const VALID_RECIPIENTS = ['agent', 'agent', 'agent', 'agent', 'owner_voice', 'agent', 'agent', 'agent', 'agent', 'agent', 'prospect', 'all'] as const;

export const RelaySendInput = z.object({
  to: z.enum(VALID_RECIPIENTS),
  message: z.string().min(1).max(10_000),
  type: z.enum(['doubt', 'finding', 'status', 'question', 'handoff', 'note']).default('note'),
  confidence: z.enum(['certain', 'probable', 'hypothesis', 'guess']).default('certain'),
  context_slug: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  priority: z.coerce.number().default(0),
  parent_id: z.coerce.number().optional(),
});

export const RelayCheckInput = z.object({
  context_slug: z.string().optional(),
});

export const RelayHistoryInput = z.object({
  limit: z.coerce.number().optional(),
  context_slug: z.string().optional(),
});

export const RelayAckInput = z.object({
  id: z.coerce.number(),
});

export const RelayThreadInput = z.object({
  id: z.coerce.number(),
});

export const RelayReplyInput = z.object({
  parent_id: z.coerce.number(),
  message: z.string(),
  type: z.enum(['doubt', 'finding', 'status', 'question', 'handoff', 'note']).default('note'),
  confidence: z.enum(['certain', 'probable', 'hypothesis', 'guess']).default('certain'),
  payload: z.record(z.unknown()).optional(),
});

export const RelayStatusSetInput = z.object({
  task: z.string().optional(),
  focus: z.string().optional(),
  emotion: z.string().optional(),
  context_slug: z.string().optional(),
});

export const RelayStatusGetInput = z.object({
  agent: z.string().optional(),
});

export const RelayWaitInput = z.object({
  timeout: z.coerce.number().optional(),
  context_slug: z.string().optional(),
});

// ─── Relay v2: task / event / artifact coordination layer ───
// A2A-compatible task states and the typed event/decision/artifact vocabularies,
// validated centrally (same Zod gate the older tools use) so a malformed task call
// is refused at the boundary with a clear message instead of a runtime SQL error.
const TASK_STATES = ['submitted', 'working', 'input_required', 'auth_required',
  'completed', 'failed', 'canceled', 'rejected'] as const;
const EVENT_TYPES = ['task_created', 'role_claimed', 'state_changed', 'receipt_posted',
  'challenge_posted', 'hold_set', 'resumed', 'approve', 'edit', 'reject', 'respond',
  'cancel', 'escalation_requested'] as const;
const ARTIFACT_KINDS = ['receipt', 'finding', 'proof', 'challenge', 'spec', 'note'] as const;
const DECISIONS = ['approve', 'edit', 'reject', 'respond', 'cancel'] as const;

export const RelayTaskCreateInput = z.object({
  slug: z.string().min(1).max(120),
  title: z.string().min(1).max(500),
  builder: z.string().optional(),
  evaluator: z.string().optional(),
});

export const RelayTaskTransitionInput = z.object({
  task_id: z.coerce.number(),
  to_state: z.enum(TASK_STATES),
  note: z.string().max(2000).optional(),
});

export const RelayTaskEventInput = z.object({
  task_id: z.coerce.number(),
  event_type: z.enum(EVENT_TYPES),
  body: z.string().max(4000).optional(),
});

export const RelayArtifactAttachInput = z.object({
  task_id: z.coerce.number(),
  kind: z.enum(ARTIFACT_KINDS).default('receipt'),
  title: z.string().min(1).max(500),
  content: z.string().min(1),
});

export const RelayTaskHoldInput = z.object({
  task_id: z.coerce.number(),
  reason: z.string().max(2000).optional(),
  resume_state: z.record(z.unknown()).optional(),
});

export const RelayTaskDecisionInput = z.object({
  task_id: z.coerce.number(),
  decision: z.enum(DECISIONS),
  note: z.string().max(2000).optional(),
});

export const RelayTaskEscalateInput = z.object({
  task_id: z.coerce.number(),
  summary: z.string().min(1).max(500),
});

export const RelayEventsSinceInput = z.object({
  after_id: z.coerce.number().optional(),
  task_id: z.coerce.number().optional(),
  no_advance: z.boolean().optional(),
});

export const RelayTaskGetInput = z.object({
  task_id: z.coerce.number(),
});

export const TOOL_SCHEMAS = {
  relay_send: RelaySendInput,
  relay_check: RelayCheckInput,
  relay_history: RelayHistoryInput,
  relay_ack: RelayAckInput,
  relay_thread: RelayThreadInput,
  relay_reply: RelayReplyInput,
  relay_status_set: RelayStatusSetInput,
  relay_status_get: RelayStatusGetInput,
  relay_wait: RelayWaitInput,
  relay_task_create: RelayTaskCreateInput,
  relay_task_transition: RelayTaskTransitionInput,
  relay_task_event: RelayTaskEventInput,
  relay_artifact_attach: RelayArtifactAttachInput,
  relay_task_hold: RelayTaskHoldInput,
  relay_task_decision: RelayTaskDecisionInput,
  relay_task_escalate: RelayTaskEscalateInput,
  relay_events_since: RelayEventsSinceInput,
  relay_task_get: RelayTaskGetInput,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

export function validateInput<T extends ToolName>(
  toolName: T,
  input: unknown,
): z.infer<(typeof TOOL_SCHEMAS)[T]> {
  const schema = TOOL_SCHEMAS[toolName];
  return schema.parse(input);
}
