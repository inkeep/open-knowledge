import { type ChildProcess, execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { installPackedCli } from './packed-install.test-helper';

test('retains npm debug logs exactly once in a fresh acquisition deadline error chain after cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-cli-deadline-diagnostics-'));
  const packageDir = join(root, 'package');
  const packDest = join(root, 'pack');
  const installPrefix = join(root, 'install');
  for (const dir of [packageDir, packDest, installPrefix]) mkdirSync(dir);
  let clock = 0;
  let budget = 0;
  let installer: ChildProcess | undefined;
  let nativeFailure: unknown;
  let failure: unknown;
  let logs: string[] = [];
  const registry = createServer((_request, response) => {
    if (installer && installer.exitCode === null && installer.signalCode === null) {
      clock += budget;
      installer.kill('SIGTERM');
    } else {
      response.writeHead(500);
      response.end('No active installer');
    }
  });
  try {
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    if (!address || typeof address === 'string') throw new Error('Registry did not bind TCP');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@inkeep/open-knowledge',
        version: '1.0.0',
        dependencies: { 'ok-deadline-snapshot-fixture': '1.0.0' },
      }),
    );
    writeFileSync(join(root, 'empty.npmrc'), '');
    failure = await installPackedCli(
      {
        packageDir,
        packDest,
        installPrefix,
        mode: 'fresh',
        env: {
          ...process.env,
          npm_config_userconfig: join(root, 'empty.npmrc'),
          npm_config_registry: `http://127.0.0.1:${address.port}`,
          npm_config_loglevel: 'silent',
        },
      },
      {
        now: () => clock,
        executeInstall: (command, args, options) => {
          budget = options.timeout ?? 0;
          const execution = promisify(execFile)(command, args, {
            ...options,
            timeout: Math.min(budget, 5_000),
          });
          installer = execution.child;
          return execution.catch((error: unknown) => {
            nativeFailure = error;
            throw error;
          });
        },
      },
    ).catch((error: unknown) => error);
    logs = readdirSync(packDest, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('-debug-0.log'))
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
  } finally {
    if (installer && installer.exitCode === null && installer.signalCode === null)
      installer.kill('SIGTERM');
    registry.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      registry.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
  expect(existsSync(root)).toBe(false);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected acquisition deadline failure');
  const matchesStartupGuard =
    nativeFailure instanceof Error &&
    'killed' in nativeFailure &&
    nativeFailure.killed === true &&
    'code' in nativeFailure &&
    nativeFailure.code === null &&
    'signal' in nativeFailure &&
    nativeFailure.signal === 'SIGTERM';
  expect(
    clock,
    matchesStartupGuard
      ? 'npm install stopped before the fixture registry request; check the 5-second startup hang guard'
      : failure.message,
  ).toBeGreaterThanOrEqual(budget);
  expect(failure.message).toContain('acquisition deadline elapsed on attempt 1 of 3.');
  expect(failure.cause).toBe(nativeFailure);
  expect(nativeFailure).toMatchObject({ code: null, killed: true, signal: 'SIGTERM' });
  expect(logs).toContainEqual(expect.stringMatching(/verbose title npm pack\b/));
  expect(logs).toContainEqual(expect.stringMatching(/verbose title npm install\b/));
  const messages: string[] = [];
  let current: unknown = failure;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  for (const log of logs) expect(failure.message).toContain(log);
  const copies = logs.map((log) => messages.join('\n').split(log).length - 1);
  expect(copies).toEqual(logs.map(() => 1));
});
