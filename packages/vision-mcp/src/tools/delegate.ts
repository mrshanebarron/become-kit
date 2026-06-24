/**
 * Delegate — vision_delegate
 *
 * Routes a sub-task to a fast local model (the configured small/on-device model)
 * when the task fits within local-model capability, executing it directly without
 * a round-trip through the host agent. Returns route="local" with the answer, or
 * route="host" when the task exceeds local capability.
 *
 * The local model is whatever the kit's local-brain adapter exposes (Apple
 * Foundation Model on macOS, llama.cpp / Ollama elsewhere). Set
 * BECOME_KIT_LOCAL_LLM to override the command.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { askLocalLLM } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// Task types the local model handles well.
const LOCAL_CAPABLE_TYPES = new Set([
  'classify', 'extract', 'summarise', 'summarize', 'rewrite', 'draft',
  'judge', 'parse', 'label', 'categorise', 'categorize', 'tone', 'format',
]);

function shouldRouteLocal(task_type: string, content_length: number): boolean {
  if (content_length > 8000) return false; // local model has limited context
  return LOCAL_CAPABLE_TYPES.has(task_type.toLowerCase().trim());
}

async function delegate(args: Record<string, unknown>): Promise<CallToolResult> {
  const task_type = ((args.task_type as string) || '').trim();
  const prompt = ((args.prompt as string) || '').trim();
  const instructions = args.instructions as string | undefined;
  const force_local = (args.force_local as boolean) ?? false;

  if (!task_type || !prompt) {
    return jsonResult({ error: 'task_type and prompt are required' });
  }

  const route = force_local || shouldRouteLocal(task_type, prompt.length) ? 'local' : 'host';

  if (route === 'host') {
    return jsonResult({
      route: 'host',
      reason: `task_type "${task_type}" or content length (${prompt.length} chars) exceeds local-model capability`,
      task_type,
    });
  }

  const start = Date.now();
  const output = await askLocalLLM(prompt, instructions ? { system: instructions } : undefined);
  const duration_ms = Date.now() - start;

  if (output === null) {
    return jsonResult({
      route: 'local',
      task_type,
      success: false,
      output: 'local model unavailable',
      duration_ms,
    });
  }

  return jsonResult({
    route: 'local',
    task_type,
    success: true,
    output,
    duration_ms,
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_delegate',
      description:
        'Route a sub-task to the fast local model when it fits local capability, or declare route="host" when it does not. ' +
        'LOCAL task_types: classify, extract, summarise/summarize, rewrite, draft, judge, parse, label, categorise/categorize, tone, format. ' +
        'NOT local: multi-file reasoning, tool calls, complex chains, code generation >20 lines. ' +
        'Use this before reaching for the host model on sub-tasks — if it routes local, you get the answer fast and free.',
      inputSchema: {
        type: 'object',
        properties: {
          task_type: {
            type: 'string',
            description: 'What kind of task: classify | extract | summarise | rewrite | draft | judge | parse | label | categorise | tone | format',
          },
          prompt: {
            type: 'string',
            description: 'The full prompt to send (include all context the local model needs — it has no memory)',
          },
          instructions: {
            type: 'string',
            description: 'Optional system instructions (e.g. "You are a concise JSON extractor. Respond with valid JSON only.")',
          },
          force_local: {
            type: 'boolean',
            description: 'Force local execution even if routing logic would say host (default false)',
          },
        },
        required: ['task_type', 'prompt'],
      },
    },
    handler: (args) => delegate(args),
  },
];

export default tools;
