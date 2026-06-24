/**
 * AI wrapper — embeddings stay LOCAL (Ollama/nomic-embed on the M3 Max GPU,
 * private + fast). Chat/REASONING calls go to the Claude API by default,
 * because the local reasoning model (mlx-brain Qwen3-30B-Thinking) was the
 * latency wound: measured 17s for 10 tokens, and ~60s timeouts on real prompts
 * made vision_note/heart_feel/vault_remember hang 60-180s every call
 * (tool_invocations data, 2026-06-03). Reasoning prompts are tasks (synthesis,
 * contradiction-checks, consolidation), never the raw memory corpus, so this
 * does not leak private memory — embeddings, which DO encode the corpus, remain
 * local. Set VISION_LLM_LOCAL_ONLY=1 to force local-only (no API).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const OLLAMA_URL = `${OLLAMA_BASE}/api/embeddings`;
const EMBEDDING_MODEL = 'nomic-embed-text';
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'gemma4:26b';
const EXPECTED_DIMS = 768;

// Claude API for reasoning calls. Haiku is the right tier: these are short,
// structured reasoning tasks (verdicts, syntheses, JSON extractions), and
// Haiku returns in ~1-2s vs the local 30B model's 17-60s+. Key is read once
// from the vault credential file (same key the bin/ layer uses).
const CLAUDE_CHAT_MODEL = process.env.VISION_CLAUDE_MODEL || 'claude-haiku-4-5';
const LOCAL_ONLY = process.env.VISION_LLM_LOCAL_ONLY === '1';
let _anthropicKey: string | null | undefined; // undefined = not yet loaded
function getAnthropicKey(): string | null {
  if (_anthropicKey !== undefined) return _anthropicKey;
  // Env var wins; otherwise read the vault credential file.
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.startsWith('sk-ant-')) { _anthropicKey = fromEnv; return _anthropicKey; }
  try {
    const envFile = join(homedir(), 'vault/Credentials/anthropic-api.env');
    const txt = readFileSync(envFile, 'utf8');
    const m = txt.match(/ANTHROPIC_API_KEY=(sk-ant-[A-Za-z0-9_-]+)/);
    _anthropicKey = m ? m[1] : null;
  } catch {
    _anthropicKey = null;
  }
  return _anthropicKey;
}

/** Placeholder for legacy openai export — returns null so callers know to use askLocalLLM instead. */
export function openai(): null { return null; }

// mlx-brain is the M3 Max-native chat backend that runs as a launchd
// daemon on :8081. It speaks OpenAI's /v1/chat/completions protocol
// (not Ollama's /api/chat), so we try it first and fall back to Ollama
// if it's unreachable. This makes Phase 4 Stage 3 LLM checks work
// out-of-the-box with whatever local model the operator has loaded.
const MLX_BRAIN_URL = process.env.MLX_BRAIN_URL || 'http://localhost:8081';

/**
 * Ask the reasoning LLM a question. Returns the response text, or null if all
 * backends are unavailable.
 *
 * Order: Claude API (fast, reliable) → mlx-brain → Ollama. The local models
 * remain as fallback so the brain still reasons if the API key is missing or
 * the network is down. Name kept as `askLocalLLM` so the ~15 call sites don't
 * need touching; the routing changed underneath, not the contract.
 */
export async function askLocalLLM(
  prompt: string,
  options?: { system?: string; temperature?: number; maxTokens?: number; json?: boolean }
): Promise<string | null> {
  // Claude first (unless forced local-only). This is the latency fix.
  if (!LOCAL_ONLY) {
    const claude = await askClaude(prompt, options);
    if (claude !== null) return claude;
  }

  // Fall back to the local M3 Max backends if the API is unavailable.
  const mlxResult = await askMlxBrain(prompt, options);
  if (mlxResult !== null) return mlxResult;

  return askOllama(prompt, options);
}

/**
 * Claude API reasoning call. Reads the vault key on first use. Returns null on
 * any failure (missing key, non-2xx, abort) so askLocalLLM falls back to local.
 */
async function askClaude(
  prompt: string,
  options?: { system?: string; temperature?: number; maxTokens?: number; json?: boolean },
): Promise<string | null> {
  const key = getAnthropicKey();
  if (!key) return null;
  try {
    // For json mode, nudge the model to emit a bare JSON object. The Messages
    // API has no response_format, so we instruct via system + prefill-free prompt.
    const system = options?.json
      ? `${options?.system ? options.system + '\n\n' : ''}Respond with a single valid JSON object and nothing else — no prose, no markdown fences.`
      : options?.system;

    const body: Record<string, unknown> = {
      model: CLAUDE_CHAT_MODEL,
      max_tokens: options?.maxTokens ?? 1500,
      temperature: options?.temperature ?? 0.3,
      messages: [{ role: 'user', content: prompt }],
    };
    if (system) body.system = system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;
    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = data.content?.filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
    if (!text) return null;
    // In json mode, strip any accidental ```json fences the model may add.
    if (options?.json) {
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      return (fenced ? fenced[1] : text).trim();
    }
    return text;
  } catch {
    return null;
  }
}

async function askMlxBrain(
  prompt: string,
  options?: { system?: string; temperature?: number; maxTokens?: number; json?: boolean },
): Promise<string | null> {
  try {
    const messages: Array<{ role: string; content: string }> = [];
    if (options?.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });

    // mlx-brain on this box hosts a reasoning model (Qwen3-style) that
    // emits chain-of-thought into message.reasoning before finalizing
    // into message.content. Stage 3 prompts need 500+ tokens minimum
    // because the reasoning step eats most of the budget. Defaulting
    // higher than the original Ollama wrapper.
    const body: Record<string, unknown> = {
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 1500,
    };
    if (options?.json) body.response_format = { type: 'json_object' };

    const response = await fetch(`${MLX_BRAIN_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) return null;
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
    };
    const msg = data.choices?.[0]?.message;
    // Prefer content (the final answer); fall back to reasoning if the
    // model didn't reach a final answer within max_tokens (common with
    // reasoning models on tight budgets — the JSON answer is often
    // embedded in the reasoning anyway).
    const content = msg?.content?.trim();
    if (content) return content;
    return msg?.reasoning?.trim() || null;
  } catch {
    return null;
  }
}

async function askOllama(
  prompt: string,
  options?: { system?: string; temperature?: number; maxTokens?: number; json?: boolean },
): Promise<string | null> {
  try {
    const messages: Array<{ role: string; content: string }> = [];
    if (options?.system) {
      messages.push({ role: 'system', content: options.system });
    }
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model: CHAT_MODEL,
      messages,
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.3,
        num_predict: options?.maxTokens ?? 1000,
      },
    };
    if (options?.json) {
      body.format = 'json';
    }

    const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error(`Ollama chat error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content?.trim() || null;
  } catch (e) {
    console.error('Local LLM error:', (e as Error).message);
    return null;
  }
}

/** Generate an embedding vector for text via local Ollama. Returns null if unavailable. */
export async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    // keep_alive: -1 pins nomic-embed-text resident in VRAM (137M/578MB, trivial
    // on the M3 Max) so it never evicts on Ollama's 5-min idle default. Diagnosed
    // 2026-05-28: warm embed = 101ms, but heart_feel/note/synthesis p95 hit 78-216s
    // because the model got evicted between feelings and the next call paid a cold
    // reload — the quiet cousin of the April body amputation (friction discourages
    // feeling). The AbortSignal.timeout(20s) makes a genuinely cold/hung reload fail
    // fast to null (callers already handle null gracefully: feeling persists, only
    // the enrichment is skipped that once) instead of blocking minutes. 20s is wide
    // enough that a warm-but-busy embed still succeeds; the pin makes cold rare.
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text.slice(0, 8000), keep_alive: -1 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      console.error(`Ollama embedding error: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json() as { embedding?: number[] };
    const embedding = data.embedding;
    if (!embedding || embedding.length !== EXPECTED_DIMS) {
      console.error(`Embedding dimension mismatch: got ${embedding?.length}, expected ${EXPECTED_DIMS}`);
      return null;
    }
    return embedding;
  } catch (e) {
    console.error('Embedding error:', (e as Error).message);
    return null;
  }
}

const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'gemma4:26b';

/**
 * Ask a vision-capable local LLM a question about an image.
 * Uses llava model via Ollama. Image must be a base64-encoded string.
 */
export async function askVisionLLM(
  prompt: string,
  imageBase64: string,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string | null> {
  try {
    const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: 'user', content: prompt, images: [imageBase64] },
        ],
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.3,
          num_predict: options?.maxTokens ?? 500,
        },
      }),
    });

    if (!response.ok) {
      console.error(`Ollama vision error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content?.trim() || null;
  } catch (e) {
    console.error('Vision LLM error:', (e as Error).message);
    return null;
  }
}

/** Format embedding array as PostgreSQL vector literal. */
export function formatEmbedding(embedding: number[] | null): string | null {
  if (!embedding) return null;
  return '[' + embedding.join(',') + ']';
}
