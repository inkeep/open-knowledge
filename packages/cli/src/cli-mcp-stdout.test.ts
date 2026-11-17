import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const CLI_PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const CLI_SOURCE = resolve(import.meta.dirname, 'cli.ts');
const TEST_TIMEOUT_MS = 60_000;
const SERVING_WARNING = 'a warning logged while ok mcp serves requests';
const WINDOWS_SYSTEM_ENV = ['SystemRoot', 'windir'] as const;

let home: string | undefined;
let child: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
  const running = child;
  child = undefined;
  if (running !== undefined && running.exitCode === null && running.signalCode === null) {
    const closed = new Promise((done) => running.once('close', done));
    running.kill('SIGKILL');
    await closed;
  }
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function parseJson(line: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

function childEnv(isolatedHome: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    NO_COLOR: '1',
  };
  for (const name of WINDOWS_SYSTEM_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function okMcpWithWarningOnInitialize(isolatedHome: string): string {
  return `
    const { getLogger } = await import('@inkeep/open-knowledge-server');
    const writeStdout = process.stdout.write.bind(process.stdout);
    let warned = false;
    process.stdout.write = (chunk, ...rest) => {
      const written = writeStdout(chunk, ...rest);
      if (!warned && String(chunk).includes('"id":1')) {
        warned = true;
        getLogger('mcp:exec').warn({}, ${JSON.stringify(SERVING_WARNING)});
      }
      return written;
    };
    process.argv = [process.execPath, ${JSON.stringify(CLI_SOURCE)}, '--cwd', ${JSON.stringify(isolatedHome)}, 'mcp', '--no-bundle-proxy'];
    await import(${JSON.stringify(pathToFileURL(CLI_SOURCE).href)});
  `;
}

test(
  'a warning logged while the global stdio MCP serves goes to stderr and keeps stdout pure JSON-RPC',
  async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-mcp-stdio-logs-')));
    const spawned = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=development',
        '--input-type=module',
        '-e',
        okMcpWithWarningOnInitialize(home),
      ],
      { cwd: CLI_PACKAGE_ROOT, env: childEnv(home), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child = spawned;
    let stdout = '';
    let stderr = '';
    let childError: Error | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    spawned.stdout.setEncoding('utf-8');
    spawned.stderr.setEncoding('utf-8');
    spawned.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    spawned.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    spawned.on('error', (error) => {
      childError ??= error;
    });
    spawned.stdin.on('error', (error) => {
      childError ??= error;
    });
    spawned.once('close', (code, signal) => {
      exit = { code, signal };
    });
    const deadline = AbortSignal.timeout(TEST_TIMEOUT_MS - 10_000);
    const transcript = () =>
      `exit: ${exit === undefined ? 'still running' : `code ${exit.code}, signal ${exit.signal}`}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    const waitFor = (condition: () => boolean, waitingFor: string) => {
      const { promise, resolve: done, reject } = Promise.withResolvers<void>();
      const check = (): void => {
        if (condition()) done();
        else if (childError !== undefined)
          reject(
            new Error(
              `ok mcp failed (${childError.message}) before ${waitingFor}\n${transcript()}`,
            ),
          );
        else if (exit !== undefined)
          reject(new Error(`ok mcp exited before ${waitingFor}\n${transcript()}`));
        else if (deadline.aborted)
          reject(new Error(`timed out waiting for ${waitingFor}\n${transcript()}`));
        else setTimeout(check, 20);
      };
      check();
      return promise;
    };
    const stdoutLines = () => stdout.split('\n').filter((line) => line.trim() !== '');
    const response = (id: number) =>
      stdoutLines()
        .map(parseJson)
        .find((parsed) => parsed.ok && (parsed.value as { id?: unknown }).id === id);
    const send = (message: unknown): void => {
      spawned.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stdio-logs-test', version: '1' },
      },
    });
    await waitFor(() => response(1) !== undefined, 'the initialize response');
    await waitFor(
      () => stderr.includes(SERVING_WARNING) || stdout.includes(SERVING_WARNING),
      'the logged warning',
    );
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await waitFor(() => response(2) !== undefined, 'the ping response');
    spawned.stdin.end();
    await waitFor(() => exit !== undefined, 'ok mcp to exit after stdin closed');

    expect(stdoutLines().filter((line) => !parseJson(line).ok)).toEqual([]);
    expect(
      stdoutLines().map((line) => {
        const parsed = parseJson(line);
        return parsed.ok ? (parsed.value as { jsonrpc?: unknown }).jsonrpc : undefined;
      }),
    ).not.toContain(undefined);
    expect(stderr).toContain(SERVING_WARNING);
  },
  TEST_TIMEOUT_MS,
);
