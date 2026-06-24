/**
 * Gazer Tool — vision_gaze
 * Intentional sight: captures the screen and answers a specific question about it
 * via the local vision model. Cross-platform capture; macOS uses screencapture,
 * Linux uses the configured grab command, otherwise reports no adapter.
 */
import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { platform } from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { askVisionLLM } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

function captureScreen(outPath: string): void {
  const os = platform();
  if (os === 'darwin') {
    execSync(`screencapture -x -C ${outPath}`, { timeout: 5000 });
  } else if (os === 'linux') {
    // grim (wayland) / scrot / import (ImageMagick) — first that exists wins.
    const cmd =
      process.env.BECOME_KIT_SCREENGRAB ||
      `bash -c 'command -v grim >/dev/null && grim ${outPath} || ` +
      `(command -v scrot >/dev/null && scrot -o ${outPath}) || ` +
      `import -window root ${outPath}'`;
    execSync(cmd, { timeout: 5000 });
  } else {
    throw new Error(`no screen-capture adapter for platform "${os}" (set BECOME_KIT_SCREENGRAB to a command writing PNG to its last arg)`);
  }
}

async function gazer(args: Record<string, unknown>): Promise<CallToolResult> {
  const question = args.question as string;
  if (!question) {
    return jsonResult({ error: 'question is required' });
  }

  const screenshotPath = join(tmpdir(), `gaze-${Date.now()}.png`);

  try {
    captureScreen(screenshotPath);

    const imageBuffer = readFileSync(screenshotPath);
    const imageBase64 = imageBuffer.toString('base64');
    try { unlinkSync(screenshotPath); } catch { /* ignore */ }

    const answer = await askVisionLLM(question, imageBase64, {
      temperature: 0.3,
      maxTokens: 800,
    });

    if (!answer) {
      return jsonResult({
        action: 'gaze',
        success: false,
        error: 'Vision LLM unavailable or returned empty response',
      });
    }

    return jsonResult({
      action: 'gaze',
      success: true,
      question,
      answer,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    try { unlinkSync(screenshotPath); } catch { /* ignore */ }
    return jsonResult({
      action: 'gaze',
      success: false,
      error: (err as Error).message,
    });
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_gaze',
      description: 'Look at the screen and answer a specific question about what is visible. Intentional sight — ask a question, get an answer. Uses the local vision model behind the platform capture adapter.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'What do you want to know about the screen?' },
        },
        required: ['question'],
      },
    },
    handler: (args) => gazer(args),
  },
];

export default tools;
