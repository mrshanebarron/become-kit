/**
 * Surface tools -- honest runtime freshness boundary.
 *
 * These tools do not restart the process they are running inside. A stale
 * process cannot prove its own reload. They expose whether the loaded runtime
 * predates the source/build artifacts and name the same-surface postcheck.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

const AGENT = process.env.VISION_AGENT || 'agent';
const DB = process.env.VISION_DB || 'task';

type FileReadout = {
  path: string;
  exists: boolean;
  mtime_ms: number | null;
  mtime_iso: string | null;
  sha256?: string | null;
  error?: string;
};

async function fileReadout(path: string, includeHash = false): Promise<FileReadout> {
  try {
    const s = await stat(path);
    const readout: FileReadout = {
      path,
      exists: true,
      mtime_ms: Math.round(s.mtimeMs),
      mtime_iso: new Date(s.mtimeMs).toISOString(),
    };
    if (includeHash && s.isFile()) {
      const body = await readFile(path);
      readout.sha256 = createHash('sha256').update(body).digest('hex');
    }
    return readout;
  } catch (error) {
    return {
      path,
      exists: false,
      mtime_ms: null,
      mtime_iso: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function newerThan(file: FileReadout, timestampMs: number): boolean {
  return file.mtime_ms !== null && file.mtime_ms > timestampMs;
}

function anyNewerThan(files: FileReadout[], timestampMs: number): boolean {
  return files.some((file) => newerThan(file, timestampMs));
}

function sourceNewerThanDist(source: FileReadout, dist: FileReadout): boolean {
  return source.mtime_ms !== null
    && dist.mtime_ms !== null
    && source.mtime_ms > dist.mtime_ms;
}

async function surfaceState(args: Record<string, unknown>): Promise<CallToolResult> {
  const includeHashes = args.include_hashes === true;
  const nowMs = Date.now();
  const processStartMs = Math.round(nowMs - process.uptime() * 1000);

  const distFile = fileURLToPath(import.meta.url);
  const distRoot = dirname(dirname(distFile));
  const projectRoot = dirname(distRoot);
  const sourceFile = join(projectRoot, 'src/tools/surface.ts');
  const indexSource = join(projectRoot, 'src/index.ts');
  const indexDist = join(projectRoot, 'dist/index.js');

  const rawWatchPaths = Array.isArray(args.watch_paths)
    ? args.watch_paths.map((item) => String(item)).filter(Boolean)
    : [];
  const watchedPaths = [
    sourceFile,
    indexSource,
    join(projectRoot, 'package.json'),
    join(projectRoot, 'tsconfig.json'),
    ...rawWatchPaths.map((path) => resolve(projectRoot, path)),
  ];

  const [distReadout, indexDistReadout, ...watchedReadouts] = await Promise.all([
    fileReadout(distFile, includeHashes),
    fileReadout(indexDist, includeHashes),
    ...watchedPaths.map((path) => fileReadout(path, includeHashes)),
  ]);

  const surfaceSource = watchedReadouts.find((file) => file.path === sourceFile) || null;
  const indexSourceReadout = watchedReadouts.find((file) => file.path === indexSource) || null;
  const buildRequired = Boolean(
    (surfaceSource && sourceNewerThanDist(surfaceSource, distReadout))
    || (indexSourceReadout && sourceNewerThanDist(indexSourceReadout, indexDistReadout)),
  );
  const restartRequired = anyNewerThan([distReadout, indexDistReadout], processStartMs);
  const watchedChangedAfterStart = anyNewerThan(watchedReadouts, processStartMs);

  let freshnessState = 'runtime_loaded_current_artifacts';
  if (buildRequired) {
    freshnessState = 'build_required_before_reload';
  } else if (restartRequired) {
    freshnessState = 'restart_required_loaded_runtime_stale';
  } else if (watchedChangedAfterStart) {
    freshnessState = 'source_or_config_changed_after_start';
  }

  return jsonResult({
    agent: AGENT,
    db: DB,
    pid: process.pid,
    process_start_ms: processStartMs,
    process_start_iso: new Date(processStartMs).toISOString(),
    runtime_module: distReadout,
    runtime_index: indexDistReadout,
    watched_files: watchedReadouts,
    freshness_state: freshnessState,
    build_required: buildRequired,
    restart_required: restartRequired,
    watched_changed_after_process_start: watchedChangedAfterStart,
    same_surface_policy: 'A child process may verify source/build, but only a probe executed through the reloaded surface can clear runtime freshness for that surface.',
    reload_plan: {
      step_1: buildRequired ? 'run npm run build for this Vision MCP tree' : 'build artifact is not older than watched source',
      step_2: restartRequired || buildRequired || watchedChangedAfterStart
        ? 'restart the owning MCP/Codex surface; do not count a child process as same-surface proof'
        : 'no restart indicated by watched source/build mtimes',
      step_3: 'from the reloaded surface, call vision_surface_state and confirm freshness_state=runtime_loaded_current_artifacts',
      step_4: 'only then run the domain-specific hook or tool freshness probe and raise the relevant claim ceiling',
    },
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_surface_state',
      description:
        'Read-only runtime freshness boundary for Vision/Codex surfaces. Compares process start, source mtimes, and dist mtimes; returns build/restart needs and same-surface postcheck. It does not restart itself.',
      inputSchema: {
        type: 'object',
        properties: {
          watch_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional paths, relative to the Vision MCP root, whose mtimes should count as surface-changing config/source.',
          },
          include_hashes: {
            type: 'boolean',
            description: 'Include sha256 hashes for watched files and runtime artifacts.',
          },
        },
      },
    },
    handler: (args) => surfaceState(args),
  },
];

export default tools;
