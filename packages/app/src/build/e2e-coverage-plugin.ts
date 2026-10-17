import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { Session } from 'node:inspector/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';
import {
  E2E_COVERAGE_PATH,
  recordableSource,
  type ScriptCoverage,
  type SourceRegion,
  serverScriptFiles,
  sourceRegions,
} from './e2e-coverage-contract';

interface ScriptSource {
  readonly file: string;
  readonly packageDir: string;
  readonly regions: readonly SourceRegion[];
}

export interface CoverageSession {
  takePreciseCoverage(): Promise<readonly ScriptCoverage[]>;
}

function packageDirOf(file: string): string | undefined {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

export function processCoverageFiles(
  scripts: readonly ScriptCoverage[],
  okRoot: string,
  sourceOf: (url: string) => ScriptSource | undefined,
): string[] {
  const files = new Set<string>();
  for (const script of scripts) {
    if (!script.url.startsWith('file://') || script.url.includes('/node_modules/')) continue;
    const source = sourceOf(script.url);
    if (source === undefined) continue;
    for (const file of serverScriptFiles(script, source.file, source.regions, source.packageDir)) {
      const recorded = recordableSource(file, okRoot);
      if (recorded !== undefined) files.add(recorded);
    }
  }
  return [...files].sort();
}

export function diskScriptSources(): (url: string) => ScriptSource | undefined {
  const cache = new Map<string, ScriptSource | undefined>();
  return (url) => {
    if (cache.has(url)) return cache.get(url);
    let source: ScriptSource | undefined;
    try {
      const file = fileURLToPath(url);
      const packageDir = packageDirOf(file);
      if (packageDir !== undefined) {
        source = { file, packageDir, regions: sourceRegions(readFileSync(file, 'utf8')) };
      }
    } catch {
      source = undefined;
    }
    cache.set(url, source);
    return source;
  };
}

export function inspectorCoverage(): CoverageSession {
  let started: Promise<Session> | undefined;
  const start = async (): Promise<Session> => {
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.startPreciseCoverage', { callCount: false, detailed: false });
    return session;
  };
  return {
    async takePreciseCoverage() {
      started ??= start();
      const session = await started;
      const { result } = await session.post('Profiler.takePreciseCoverage');
      return result;
    },
  };
}

export function coverageMiddleware(
  okRoot: string,
  session: CoverageSession,
  sourceOf: (url: string) => ScriptSource | undefined,
): Connect.NextHandleFunction {
  return (request: Connect.IncomingMessage, response: ServerResponse, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'POST' || url.pathname !== E2E_COVERAGE_PATH) {
      next();
      return;
    }
    const op = url.searchParams.get('op');
    if (op !== 'reset' && op !== 'take') {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: `op must be reset or take, not ${op}` }));
      return;
    }
    session.takePreciseCoverage().then(
      (scripts) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        response.end(
          JSON.stringify({
            files: op === 'take' ? processCoverageFiles(scripts, okRoot, sourceOf) : [],
          }),
        );
      },
      (error: unknown) => {
        response.statusCode = 500;
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      },
    );
  };
}

export function e2eCoveragePlugin(okRoot: string): Plugin {
  const middleware = coverageMiddleware(okRoot, inspectorCoverage(), diskScriptSources());
  return {
    name: 'ok-e2e-coverage',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
