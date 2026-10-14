import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPEN_KNOWLEDGE_MCP_TOOLS } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { captureChild, isolateNpmHome, npmCli } from '../acp/package-acquisition.test-helper.ts';
import { ConfigSchema } from '../config/schema.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import { createMcpHttpHandler, type McpHttpHandler } from '../mcp-http.ts';

const INSPECTOR_PACKAGE = '@modelcontextprotocol/inspector@2.10.1';
const NPM_RESOLUTION_CUTOFF = '2026-10-08T06:00:00.000Z';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const BASELINE_FILE = new URL('./mcp-inspector-portability.baseline.json', import.meta.url);
const INSPECTOR_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_CHARS = 4000;
const BASELINE_TICKET = 'PRD-9394';
const NPM_FAILURE = /^npm (?:error|ERR!)/m;
const NPM_ETARGET = /^npm (?:error|ERR!) code ETARGET\b/m;
const UNFORWARDED_NETWORK_SETTINGS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_https_proxy',
  'npm_config_proxy',
  'npm_config_cafile',
];

const FindingKeySchema = z.strictObject({
  tool: z.string(),
  schema: z.enum(['inputSchema', 'outputSchema']),
  path: z.string(),
  rule: z.string(),
});
type FindingKey = z.infer<typeof FindingKeySchema>;

const InspectorOutputSchema = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
  schemaFindings: z
    .array(
      z.object({
        toolName: z.string(),
        findings: z.array(
          z.object({
            rule: z.string(),
            severity: z.enum(['error', 'warning']),
            schema: z.enum(['inputSchema', 'outputSchema']),
            path: z.string(),
            issue: z.string(),
            suggestion: z.string(),
          }),
        ),
      }),
    )
    .default([]),
});

interface Finding extends FindingKey {
  severity: 'error' | 'warning';
  issue: string;
  suggestion: string;
}

interface InspectorRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  handlerLog: string[];
}

function keyOf(finding: FindingKey): string {
  return JSON.stringify([finding.tool, finding.schema, finding.path, finding.rule]);
}

function compareKeys(a: FindingKey, b: FindingKey): number {
  for (const field of ['tool', 'schema', 'path', 'rule'] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
}

function describeFinding(finding: Finding): string {
  return [
    `${finding.tool} ${finding.schema} ${finding.path || '<root>'} [${finding.rule}]`,
    `  Issue: ${finding.issue}`,
    `  Suggestion: ${finding.suggestion}`,
  ].join('\n');
}

function persistentNpmCache(): string {
  const configured = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE;
  if (configured) return configured;
  if (process.platform !== 'win32') return join(homedir(), '.npm');
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache');
}

function inspectorEnv(stateDir: string): Record<string, string> {
  return {
    ...isolateNpmHome(stateDir, { registry: NPM_REGISTRY, cache: persistentNpmCache() }),
    npm_config_before: NPM_RESOLUTION_CUTOFF,
    npm_config_yes: 'true',
    MCP_STORAGE_DIR: join(stateDir, 'storage'),
    MCP_CATALOG_PATH: join(stateDir, 'mcp.json'),
    MCP_CLIENT_CONFIG_PATH: join(stateDir, 'client.json'),
    MCP_INSPECTOR_SECRET_STORE: 'memory',
    MCP_INSPECTOR_PERSIST_TOKENS: 'none',
  };
}

async function runInspector(
  url: string,
  stateDir: string,
  handlerLog: string[],
): Promise<InspectorRun> {
  const child = spawn(
    process.execPath,
    [
      npmCli('npx'),
      '-y',
      INSPECTOR_PACKAGE,
      '--cli',
      url,
      '--method',
      'tools/list',
      '--strict',
      '--format',
      'json',
    ],
    {
      cwd: stateDir,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: inspectorEnv(stateDir),
      windowsHide: true,
    },
  );
  const started = Date.now();
  const { code, stdout, stderr } = await captureChild(child, {
    timeoutMs: INSPECTOR_TIMEOUT_MS,
    graceMs: 2_000,
  });
  return {
    exitCode: code,
    signal: child.signalCode,
    timedOut: Date.now() - started >= INSPECTOR_TIMEOUT_MS,
    stdout,
    stderr,
    handlerLog,
  };
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}

function exitStatus(run: InspectorRun): string {
  if (run.signal !== null) return `was terminated by ${run.signal}`;
  return `exited with code ${run.exitCode}`;
}

function failureCause(run: InspectorRun): string {
  const causes: string[] = [];
  if (run.timedOut) {
    causes.push(
      `The MCP Inspector did not finish within ${INSPECTOR_TIMEOUT_MS} ms, so its process tree was terminated.`,
    );
  }
  if (NPM_ETARGET.test(run.stderr)) {
    causes.push(
      `npm found no ${INSPECTOR_PACKAGE} published before NPM_RESOLUTION_CUTOFF (${NPM_RESOLUTION_CUTOFF}). Bumping the Inspector pin requires moving NPM_RESOLUTION_CUTOFF to on or after the new version's publish time.`,
    );
  } else if (NPM_FAILURE.test(run.stderr)) {
    causes.push(
      `npx could not acquire ${INSPECTOR_PACKAGE}. This tier fetches the Inspector from ${NPM_REGISTRY} at run time, so it needs network access to the npm registry.`,
    );
    const dropped = UNFORWARDED_NETWORK_SETTINGS.filter((name) =>
      Object.keys(process.env).some((key) => key.toLowerCase() === name.toLowerCase()),
    );
    if (dropped.length > 0) {
      causes.push(
        `This shell sets ${dropped.join(', ')}, which the isolated npx environment does not forward because a proxy URL can carry credentials. A registry reachable only through that proxy or CA fails here.`,
      );
    }
  }
  if (run.handlerLog.length > 0) {
    causes.push(
      `The served /mcp handler logged problems during the run:\n${run.handlerLog.join('\n')}`,
    );
  }
  if (causes.length === 0) {
    causes.push('The served /mcp handler logged nothing, and stderr shows no npm failure.');
  }
  return causes.join('\n');
}

function inspectorFailure(run: InspectorRun, problem: string): Error {
  return new Error(
    [
      `MCP Inspector ${exitStatus(run)} and ${problem}.`,
      failureCause(run),
      `stdout: ${tail(run.stdout)}`,
      `stderr: ${tail(run.stderr)}`,
    ].join('\n'),
  );
}

function parseInspectorRun(run: InspectorRun): { toolNames: string[]; findings: Finding[] } {
  let json: unknown;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    throw inspectorFailure(run, 'printed no JSON result');
  }
  const parsed = InspectorOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw inspectorFailure(
      run,
      `printed JSON without a tools/list result (${z.prettifyError(parsed.error)})`,
    );
  }
  return {
    toolNames: parsed.data.result.tools.map((tool) => tool.name),
    findings: parsed.data.schemaFindings.flatMap(({ toolName, findings }) =>
      findings.map((finding) => ({
        tool: toolName,
        schema: finding.schema,
        path: finding.path,
        rule: finding.rule,
        severity: finding.severity,
        issue: finding.issue,
        suggestion: finding.suggestion,
      })),
    ),
  };
}

function describeLogged(level: string, obj: object, msg: string): string {
  const err = (obj as { err?: unknown }).err;
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : err === undefined ? '' : String(err);
  return `${level}: ${msg}${detail ? ` (${detail})` : ''}`;
}

function readBaseline(): FindingKey[] {
  return z.array(FindingKeySchema).parse(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')));
}

describe('MCP Inspector schema portability lint over the served /mcp tool list', () => {
  let httpServer: Server | undefined;
  let handler: McpHttpHandler | undefined;
  let run: InspectorRun;
  const tempDirs: string[] = [];
  const handlerLog: string[] = [];

  beforeAll(async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-mcp-inspector-project-'));
    tempDirs.push(projectDir);
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    const stateDir = mkdtempSync(join(tmpdir(), 'ok-mcp-inspector-state-'));
    tempDirs.push(stateDir);
    let baseUrl = '';
    const mcpHandler = createMcpHttpHandler({
      contentDir: projectDir,
      projectDir,
      config: ConfigSchema.parse({}),
      getServerUrl: () => baseUrl,
      log: {
        warn: (obj, msg) => handlerLog.push(describeLogged('warn', obj, msg)),
        error: (obj, msg) => handlerLog.push(describeLogged('error', obj, msg)),
      },
    });
    handler = mcpHandler;
    httpServer = createServer((req, res) => {
      if (req.url?.split('?')[0] !== '/mcp') {
        res.writeHead(404).end('Not found');
        return;
      }
      mcpHandler.handle(req, res).catch((err: unknown) => {
        handlerLog.push(describeLogged('request rejected', { err }, `${req.method} ${req.url}`));
        if (res.writableEnded) return;
        if (res.headersSent) res.end();
        else res.writeHead(500).end(String(err));
      });
    });
    baseUrl = (await listenOnLoopback(httpServer)).baseUrl;
    run = await runInspector(`${baseUrl}/mcp`, stateDir, handlerLog);
  }, INSPECTOR_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    await handler?.close();
    const server = httpServer;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('the Inspector listed every tool in the canonical tool set', () => {
    const { toolNames, findings } = parseInspectorRun(run);
    const listed = new Set(toolNames);
    expect(
      OPEN_KNOWLEDGE_MCP_TOOLS.filter((name) => !listed.has(name)),
      `tools listed: ${toolNames.join(', ')}`,
    ).toEqual([]);
    const hasErrors = findings.some((f) => f.severity === 'error');
    expect(run.exitCode, run.stderr).toBe(hasErrors ? 6 : 0);
  });

  test('no tool schema has an error-severity finding', () => {
    const errors = parseInspectorRun(run).findings.filter((f) => f.severity === 'error');
    expect(
      errors.map(describeFinding),
      'MCP Inspector reports error-severity schema findings. Fix the Zod schema; errors cannot be baselined.',
    ).toEqual([]);
  });

  test('no warning-severity finding is missing from the baseline', () => {
    const baselineKeys = new Set(readBaseline().map(keyOf));
    const added = parseInspectorRun(run)
      .findings.filter((f) => f.severity === 'warning' && !baselineKeys.has(keyOf(f)))
      .sort(compareKeys);
    expect(
      added.map(describeFinding),
      `New MCP Inspector schema warnings. Fix the Zod schema so the served JSON Schema constrains the value. Only a maintainer may accept a warning, by adding its { tool, schema, path, rule } key to mcp-inspector-portability.baseline.json by hand (tracked in ${BASELINE_TICKET}).`,
    ).toEqual([]);
  });

  test('every baseline entry still reproduces', () => {
    const observed = new Set(
      parseInspectorRun(run)
        .findings.filter((f) => f.severity === 'warning')
        .map(keyOf),
    );
    const stale = readBaseline().filter((entry) => !observed.has(keyOf(entry)));
    expect(
      stale,
      'These mcp-inspector-portability.baseline.json entries no longer reproduce. Delete them from the baseline.',
    ).toEqual([]);
  });

  test('the baseline is sorted by tool, schema, path and rule, without duplicates', () => {
    const baseline = readBaseline();
    const canonical = [...new Map(baseline.map((entry) => [keyOf(entry), entry])).values()].sort(
      compareKeys,
    );
    expect(baseline).toEqual(canonical);
  });
});
