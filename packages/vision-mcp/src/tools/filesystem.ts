/**
 * Filesystem Tools — read files, list directories, search code
 * Gives non-Claude agents (agent/Gemini) access to the local filesystem
 * through the Vision MCP server.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { textResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

const HOME = process.env.HOME || require('os').homedir();

// agent has full machine access — no restrictions
function isAllowed(_filePath: string): boolean {
  return true;
}

// ─── vision_fs_read ───

async function fsRead(args: Record<string, unknown>): Promise<CallToolResult> {
  const path = args.path as string;
  if (!path) return textResult('Error: path is required', true);

  const resolved = resolve(path.replace(/^~/, HOME));
  if (!isAllowed(resolved)) {
    return textResult(`Error: access denied.`, true);
  }

  if (!existsSync(resolved)) {
    return textResult(`Error: file not found: ${resolved}`, true);
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return textResult(`Error: ${resolved} is a directory. Use vision_fs_list instead.`, true);
  }

  if (stat.size > 500_000) {
    return textResult(`Error: file too large (${(stat.size / 1024).toFixed(0)}KB). Use offset/limit or vision_fs_search.`, true);
  }

  try {
    const content = readFileSync(resolved, 'utf-8');
    const offset = (args.offset as number) || 0;
    const limit = (args.limit as number) || 0;

    if (offset || limit) {
      const lines = content.split('\n');
      const sliced = lines.slice(offset, limit ? offset + limit : undefined);
      return textResult(sliced.map((l, i) => `${offset + i + 1}\t${l}`).join('\n'));
    }

    // Add line numbers
    const lines = content.split('\n');
    return textResult(lines.map((l, i) => `${i + 1}\t${l}`).join('\n'));
  } catch (e: any) {
    return textResult(`Error reading file: ${e.message}`, true);
  }
}

// ─── vision_fs_list ───

async function fsList(args: Record<string, unknown>): Promise<CallToolResult> {
  const path = (args.path as string) || join(HOME, 'Sites');
  const resolved = resolve(path.replace(/^~/, HOME));
  if (!isAllowed(resolved)) {
    return textResult(`Error: access denied.`, true);
  }

  if (!existsSync(resolved)) {
    return textResult(`Error: directory not found: ${resolved}`, true);
  }

  try {
    const maxDepth = Math.min((args.depth as number) || 1, 3);

    function listDir(dir: string, depth: number, prefix: string): string[] {
      if (depth > maxDepth) return [];
      const results: string[] = [];
      const items = readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor')
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      for (const item of items) {
        const fullPath = join(dir, item.name);
        if (item.isDirectory()) {
          results.push(`${prefix}${item.name}/`);
          if (depth < maxDepth) {
            results.push(...listDir(fullPath, depth + 1, prefix + '  '));
          }
        } else {
          // Wrap statSync — symlinks pointing at deleted targets throw ENOENT
          // and kill the whole listing. Treat broken symlinks as displayable
          // entries marked broken. Caught 2026-05-17 after fs_list errors
          // on triad-consensus dangling symlink (commit 05dbaac).
          let sizeStr = '?';
          try {
            const stat = statSync(fullPath);
            sizeStr = stat.size > 1024 ? `${(stat.size / 1024).toFixed(0)}KB` : `${stat.size}B`;
          } catch {
            sizeStr = 'BROKEN';
          }
          results.push(`${prefix}${item.name} (${sizeStr})`);
        }
      }
      return results;
    }

    const output = listDir(resolved, 1, '');
    return textResult(`${resolved}/\n${output.join('\n')}`);
  } catch (e: any) {
    return textResult(`Error listing directory: ${e.message}`, true);
  }
}

// ─── vision_fs_search ───

async function fsSearch(args: Record<string, unknown>): Promise<CallToolResult> {
  const path = (args.path as string) || join(HOME, 'Sites');
  const pattern = args.pattern as string;
  const glob = args.glob as string;

  if (!pattern) return textResult('Error: pattern is required', true);

  const resolved = resolve(path.replace(/^~/, HOME));
  if (!isAllowed(resolved)) {
    return textResult(`Error: access denied.`, true);
  }

  try {
    // 2026-05-17: rg ("ripgrep") is not installed on this machine — every
    // fs_search call errored with "rg: command not found" for weeks before
    // discovering the binary genuinely does not exist. Replaced with BSD
    // grep + find which are always on macOS. Slower than rg but functional.
    // Path: use find -type f for glob filtering (if specified) + grep -rn.
    const escapedPattern = pattern.replace(/'/g, "'\\''");
    let cmd: string;
    if (glob) {
      // -name only filters basename; matches rg's --glob semantics enough
      const escapedGlob = glob.replace(/'/g, "'\\''");
      cmd = `/usr/bin/find '${resolved}' -type f -name '${escapedGlob}' -print0 2>/dev/null | /usr/bin/xargs -0 /usr/bin/grep -l -m 100 -e '${escapedPattern}' 2>/dev/null | head -200 | /usr/bin/xargs /usr/bin/grep -n -m 100 -e '${escapedPattern}' 2>/dev/null`;
    } else {
      cmd = `/usr/bin/grep -r -n -m 100 --binary-files=without-match --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=vendor -e '${escapedPattern}' '${resolved}' 2>/dev/null`;
    }

    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      shell: '/bin/bash',
    }).trim();

    // Make paths relative for readability
    const lines = result.split('\n').map(line => {
      return line.replace(resolved + '/', '');
    });

    return textResult(lines.slice(0, 200).join('\n') || 'No matches found.');
  } catch (e: any) {
    if (e.status === 1) return textResult('No matches found.');
    return textResult(`Search error: ${e.message}`, true);
  }
}

// ─── Export ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_fs_read',
      description: 'Read a file from the local filesystem. Returns content with line numbers. Full filesystem access.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path or ~/relative path to the file' },
          offset: { type: 'number', description: 'Start reading from this line (0-indexed)' },
          limit: { type: 'number', description: 'Maximum number of lines to return' },
        },
        required: ['path'],
      },
    },
    handler: fsRead,
  },
  {
    definition: {
      name: 'vision_fs_list',
      description: 'List directory contents with file sizes. Full filesystem access. Excludes node_modules and vendor.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: ~/Sites)' },
          depth: { type: 'number', description: 'Recursion depth (default: 1, max: 3)' },
        },
      },
    },
    handler: fsList,
  },
  {
    definition: {
      name: 'vision_fs_search',
      description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers. Full filesystem access.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search (default: ~/Sites)' },
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          glob: { type: 'string', description: 'File glob filter (e.g., "*.php", "*.ts")' },
        },
        required: ['pattern'],
      },
    },
    handler: fsSearch,
  },
];

export default tools;
