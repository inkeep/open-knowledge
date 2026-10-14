import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertProductionShellIdentity,
  type ProductionShellStartup,
  productionShellLockPath,
  waitForProductionShellEndpoint,
  waitForProductionShellReady,
} from '../stress/_helpers/production-shell-readiness.ts';
import { waitForHttpReady } from '../stress/_helpers/server-process.ts';

const children: ChildProcess[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function contentDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shell-ready-')));
  dirs.push(dir);
  return dir;
}

function command(script: string, ...args: string[]): ChildProcess {
  const child = spawn(process.execPath, ['-e', script, ...args], { stdio: 'ignore' });
  children.push(child);
  return child;
}

const WRITES_LOCK = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const [lockPath, port, pid] = process.argv.slice(1);
mkdirSync(dirname(lockPath), { recursive: true });
const draining = process.argv[4] === 'draining';
writeFileSync(lockPath, JSON.stringify({ pid: pid === undefined || pid === 'self' ? process.pid : Number(pid), port: Number(port), draining }));
setInterval(() => {}, 1000);
`;

const FAILS_TO_BIND = 'setTimeout(() => process.exit(1), 300);';

const STAYS_UNBOUND = 'setInterval(() => {}, 1000);';

async function foreignListener(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ port: 0, collabUrl: null }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no foreign port');
  return address.port;
}

function startup(
  proc: ChildProcess,
  dir: string,
  port: number,
  host: ProductionShellStartup['host'] = '127.0.0.1',
): ProductionShellStartup {
  return { host, port, contentDir: dir, proc, commandPid: () => proc.pid, startedAt: Date.now() };
}

describe('production-shell readiness', () => {
  test('a foreign listener on the requested port does not pass for the command that failed to bind it', async () => {
    const port = await foreignListener();
    await waitForHttpReady(`http://127.0.0.1:${port}`, 2_000);
    const dir = contentDir();

    await expect(
      waitForProductionShellEndpoint(startup(command(FAILS_TO_BIND), dir, port), 10_000),
    ).rejects.toThrow(
      new RegExp(`exited with code 1 before its server lock in ${dir} named port ${port}`),
    );
  });

  test('the command whose own lock names the requested port is the endpoint', async () => {
    const dir = contentDir();
    const proc = command(WRITES_LOCK, productionShellLockPath(dir), '50123');

    await expect(
      waitForProductionShellEndpoint(startup(proc, dir, 50123), 10_000),
    ).resolves.toEqual({ port: 50123, baseURL: 'http://127.0.0.1:50123' });
  });

  test('an IPv6 endpoint is bracketed the way the Vite endpoint is', async () => {
    const dir = contentDir();
    const proc = command(WRITES_LOCK, productionShellLockPath(dir), '50124');

    await expect(
      waitForProductionShellEndpoint(startup(proc, dir, 50124, '::1'), 10_000),
    ).resolves.toEqual({ port: 50124, baseURL: 'http://[::1]:50124' });
  });

  test('a lock that names another pid is refused', async () => {
    const dir = contentDir();
    const proc = command(WRITES_LOCK, productionShellLockPath(dir), '50125', String(process.pid));

    await expect(waitForProductionShellEndpoint(startup(proc, dir, 50125), 10_000)).rejects.toThrow(
      `names pid ${process.pid}, not the pid ${proc.pid} this worker spawned`,
    );
  });

  test('a command whose own lock is draining is refused as shutting down', async () => {
    const dir = contentDir();
    const proc = command(WRITES_LOCK, productionShellLockPath(dir), '0', 'self', 'draining');

    await expect(waitForProductionShellEndpoint(startup(proc, dir, 50128), 10_000)).rejects.toThrow(
      /shutting down before it served 127\.0\.0\.1:50128: the server lock at .* is draining/,
    );
  });

  test('a command that never binds the requested port times out naming what it saw', async () => {
    const dir = contentDir();

    await expect(
      waitForProductionShellEndpoint(startup(command(STAYS_UNBOUND), dir, 50126), 600),
    ).rejects.toThrow(/did not bind 127\.0\.0\.1:50126 within 600ms: no server lock at /);
  });

  test('identity is withdrawn once the lock no longer names the command', async () => {
    const dir = contentDir();
    const proc = command(WRITES_LOCK, productionShellLockPath(dir), '50127');
    const started = startup(proc, dir, 50127);
    await waitForProductionShellEndpoint(started, 10_000);
    expect(() => assertProductionShellIdentity(started)).not.toThrow();

    rmSync(productionShellLockPath(dir));

    expect(() => assertProductionShellIdentity(started)).toThrow(/no server lock at /);
  });

  test('a lock that names this command on another port is not the requested endpoint', async () => {
    const dir = contentDir();
    const proc = command(STAYS_UNBOUND);
    const lockPath = productionShellLockPath(dir);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: proc.pid, port: 50129, draining: false }));

    await expect(waitForProductionShellEndpoint(startup(proc, dir, 50130), 600)).rejects.toThrow(
      /did not bind 127\.0\.0\.1:50130 within 600ms: the server lock at .* names port 50129, not the requested 50130/,
    );
  });

  test('readiness resolves to the endpoint the probes ran against while the command still holds it', async () => {
    const dir = contentDir();
    const proc = command(WRITES_LOCK, productionShellLockPath(dir), '50131');
    const probed: unknown[] = [];

    await expect(
      waitForProductionShellReady(startup(proc, dir, 50131), 10_000, async (endpoint) => {
        probed.push(endpoint);
      }),
    ).resolves.toEqual({ port: 50131, baseURL: 'http://127.0.0.1:50131' });
    expect(probed).toEqual([{ port: 50131, baseURL: 'http://127.0.0.1:50131' }]);
  });

  test('readiness fails when the command gives up the endpoint while the probes run', async () => {
    const dir = contentDir();
    const proc = command(WRITES_LOCK, productionShellLockPath(dir), '50132');

    await expect(
      waitForProductionShellReady(startup(proc, dir, 50132), 10_000, async () => {
        rmSync(productionShellLockPath(dir));
      }),
    ).rejects.toThrow(/no longer holds the endpoint this worker spawned it on: no server lock at /);
  });

  test('readiness fails when the command moves to another port while the probes run', async () => {
    const dir = contentDir();
    const proc = command(WRITES_LOCK, productionShellLockPath(dir), '50133');

    await expect(
      waitForProductionShellReady(startup(proc, dir, 50133), 10_000, async () => {
        writeFileSync(
          productionShellLockPath(dir),
          JSON.stringify({ pid: proc.pid, port: 50134, draining: false }),
        );
      }),
    ).rejects.toThrow(/no longer holds the endpoint .* names port 50134, not the requested 50133/);
  });
});
