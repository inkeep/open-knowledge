
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(HERE, '..', 'cli.ts');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
  }
}

async function pollUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  return predicate();
}

describe('ok mcp orphan reaping (PRD-6917)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch {
      }
    }
  });

  test('ok mcp exits when its launching parent dies even if stdin never EOFs (no orphan to launchd)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-orphan-reaping-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const fifo = join(dir, 'mcp.stdin');
    execFileSync('mkfifo', [fifo]);
    const mcpErr = join(dir, 'mcp.err');
    writeFileSync(mcpErr, '');

    const keeperScript = join(dir, 'keeper.mjs');
    writeFileSync(
      keeperScript,
      [
        "import { openSync } from 'node:fs';",
        'openSync(process.argv[2], "a");',
        'setInterval(() => {}, 1 << 30);',
      ].join('\n'),
      'utf-8',
    );
    const keeper = spawn(process.execPath, [keeperScript, fifo], {
      detached: true,
      stdio: 'ignore',
    });
    keeper.unref();
    cleanups.push(() => killQuietly(keeper.pid));

    const parentScript = join(dir, 'parent.mjs');
    writeFileSync(
      parentScript,
      [
        "import { spawn } from 'node:child_process';",
        "import { openSync } from 'node:fs';",
        'const [cliEntry, fifoPath, errPath] = process.argv.slice(2);',
        'const rfd = openSync(fifoPath, "r");',
        'const efd = openSync(errPath, "a");',
        'const child = spawn(process.execPath, [cliEntry, "mcp"], {',
        '  cwd: process.cwd(),',
        '  stdio: [rfd, "ignore", efd],',
        '  env: { ...process.env, OK_BUNDLE_PROXY: "0" },',
        '});',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source emitted into the spawned child script, not a template string in this file
        'process.stdout.write(`CHILDPID:${child.pid}\\n`);',
        'setInterval(() => {}, 1 << 30);',
      ].join('\n'),
      'utf-8',
    );

    const parent = spawn(process.execPath, [parentScript, CLI_ENTRY, fifo, mcpErr], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    cleanups.push(() => killQuietly(parent.pid));

    let stdoutBuf = '';
    parent.stdout.on('data', (chunk) => {
      stdoutBuf += String(chunk);
    });
    const gotPid = await pollUntil(() => /CHILDPID:(\d+)/.test(stdoutBuf), 15_000, 100);
    const match = stdoutBuf.match(/CHILDPID:(\d+)/);
    expect(gotPid && match).toBeTruthy();
    const childPid = Number(match?.[1]);
    cleanups.push(() => killQuietly(childPid));

    const cameUp = await pollUntil(() => isAlive(childPid), 6_000, 100);
    expect(cameUp).toBe(true);
    const diedWhileParented = await pollUntil(() => !isAlive(childPid), 3_000, 250);
    expect(diedWhileParented).toBe(false);

    killQuietly(parent.pid);

    const exited = await pollUntil(() => !isAlive(childPid), 12_000, 250);
    expect(exited).toBe(true);
  }, 40_000);
});
