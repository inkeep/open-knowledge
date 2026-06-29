import { describe as _bunDescribe, afterEach, beforeEach, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface HttpProbeResult {
  status: number;
  body: string;
}

function fetchTo(port: number, path = '/'): Promise<HttpProbeResult> {
  return new Promise((resolveFetch, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolveFetch({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2_000, () => req.destroy(new Error('http request timeout')));
    req.end();
  });
}

const GRANDCHILD_MARKER = 'GRANDCHILD-ALIVE-MARKER-7742';

describe('detached spawn lifetime (A3 / D-003)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `detached-spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('grandchild survives parent exit AND keeps serving HTTP for ≥5s', async () => {
    const grandchildScript = join(testDir, 'grandchild.ts');
    const stateFile = join(testDir, 'grandchild.state.json');
    const mcpSurrogateScript = join(testDir, 'mcp-surrogate.ts');

    writeFileSync(
      grandchildScript,
      `
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(${JSON.stringify(GRANDCHILD_MARKER)});
});
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) process.exit(2);
  writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ pid: process.pid, port: addr.port }));
});

await wait(30_000);
`,
      'utf-8',
    );

    writeFileSync(
      mcpSurrogateScript,
      `
import { spawn } from 'node:child_process';
const child = spawn('bun', [${JSON.stringify(grandchildScript)}], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
});
child.unref();
setTimeout(() => process.exit(0), 300);
`,
      'utf-8',
    );

    const mcp = spawn('bun', [mcpSurrogateScript], { stdio: 'ignore' });
    const mcpPid = mcp.pid;
    expect(mcpPid).toBeGreaterThan(0);

    const mcpExited = new Promise<number>((resolveExit) => {
      mcp.on('exit', (code) => resolveExit(code ?? -1));
    });
    const mcpExitCode = await mcpExited;
    expect(mcpExitCode).toBe(0);

    const stateDeadline = Date.now() + 3_000;
    while (Date.now() < stateDeadline && !existsSync(stateFile)) {
      await wait(50);
    }
    expect(existsSync(stateFile)).toBe(true);

    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
      pid: number;
      port: number;
    };
    expect(state.pid).toBeGreaterThan(0);
    expect(state.port).toBeGreaterThan(0);

    if (mcpPid !== undefined) {
      expect(isProcessAlive(mcpPid)).toBe(false);
    }
    expect(state.pid).not.toBe(mcpPid);

    try {
      expect(isProcessAlive(state.pid)).toBe(true);
      const probe1 = await fetchTo(state.port);
      expect(probe1.status).toBe(200);
      expect(probe1.body).toBe(GRANDCHILD_MARKER);

      await wait(5_000);

      expect(isProcessAlive(state.pid)).toBe(true);
      const probe2 = await fetchTo(state.port);
      expect(probe2.status).toBe(200);
      expect(probe2.body).toBe(GRANDCHILD_MARKER);
    } finally {
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch {}
    }
  }, 20_000); // bun test timeout: 5s sleep + setup + safety margin
});
