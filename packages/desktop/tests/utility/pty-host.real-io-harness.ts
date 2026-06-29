import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  type PtyHostIncomingMessage,
  type PtyHostOutgoingMessage,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

const require = createRequire(import.meta.url);

function ensureSpawnHelperExecutable(): void {
  const pkgDir = dirname(dirname(require.resolve('node-pty')));
  const helper = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

const { spawn } = require('node-pty') as { spawn: SpawnPty };

interface Host {
  send(msg: PtyHostIncomingMessage): void;
  dataOf(ptyId: string): string;
  exitOf(ptyId: string): { exitCode: number; signal: number | null } | null;
  errorOf(ptyId: string): string | null;
  killActive(): void;
}

function createHost(env: Record<string, string | undefined>): Host {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const data = new Map<string, string>();
  const exits = new Map<string, { exitCode: number; signal: number | null }>();
  const errors = new Map<string, string>();
  const handle = setupPtyHost({
    parentPort: {
      on(_event, h) {
        handler = h;
      },
      postMessage(msg: PtyHostOutgoingMessage) {
        if (msg.type === 'data') data.set(msg.ptyId, (data.get(msg.ptyId) ?? '') + msg.data);
        else if (msg.type === 'exit')
          exits.set(msg.ptyId, { exitCode: msg.exitCode, signal: msg.signal });
        else if (msg.type === 'spawn-error') errors.set(msg.ptyId, msg.message);
      },
    },
    spawn,
    env,
  });
  return {
    send: (msg) => handler?.({ data: msg }),
    dataOf: (ptyId) => data.get(ptyId) ?? '',
    exitOf: (ptyId) => exits.get(ptyId) ?? null,
    errorOf: (ptyId) => errors.get(ptyId) ?? null,
    killActive: () => handle.killActive(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
    console.log(`FAIL ${name} :: ${(err as Error).message}`);
  }
}

const BASE_ENV = { ...process.env };

async function main(): Promise<void> {
  ensureSpawnHelperExecutable();

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pty-harness-')));

  await scenario('real command round-trip at project root', async () => {
    const host = createHost(BASE_ENV);
    host.send({ type: 'create', ptyId: 'io', cwd: tmp, cols: 80, rows: 24 });
    await waitFor(() => host.dataOf('io').length > 0, 'shell prompt');
    host.send({ type: 'input', ptyId: 'io', data: 'echo HARNESS_$((6*7))_DONE\r' });
    await waitFor(() => host.dataOf('io').includes('HARNESS_42_DONE'), 'evaluated command output');
    host.send({ type: 'input', ptyId: 'io', data: 'pwd\r' });
    await waitFor(() => host.dataOf('io').includes(basename(tmp)), 'pwd shows project root');
    host.killActive();
  });

  await scenario('strips desktop env markers from the shell', async () => {
    const host = createHost({
      ...BASE_ENV,
      OK_ELECTRON_PROTOCOL_HOST: '1',
      OK_LOCK_KIND: 'interactive',
    });
    host.send({ type: 'create', ptyId: 'env', cwd: tmp, cols: 80, rows: 24 });
    await waitFor(() => host.dataOf('env').length > 0, 'shell prompt');
    host.send({
      type: 'input',
      ptyId: 'env',
      data: 'printf "MARKERS:[%s][%s]\\n" "$OK_LOCK_KIND" "$OK_ELECTRON_PROTOCOL_HOST"\r',
    });
    await waitFor(() => host.dataOf('env').includes('MARKERS:[][]'), 'empty markers in shell');
    if (host.dataOf('env').includes('MARKERS:[interactive]')) {
      throw new Error('OK_LOCK_KIND leaked into the shell');
    }
    host.killActive();
  });

  await scenario('host survives a PTY death and respawns', async () => {
    const host = createHost(BASE_ENV);
    host.send({ type: 'create', ptyId: 'c1', cwd: tmp, cols: 80, rows: 24 });
    await waitFor(() => host.dataOf('c1').length > 0, 'first shell prompt');
    host.send({ type: 'kill', ptyId: 'c1' });
    await waitFor(() => host.exitOf('c1') !== null, 'exit after kill');
    host.send({ type: 'create', ptyId: 'c2', cwd: tmp, cols: 80, rows: 24 });
    await waitFor(() => host.dataOf('c2').length > 0, 'second shell prompt (host survived)');
    host.killActive();
  });

  await scenario('bad shell surfaces as a non-zero exit', async () => {
    const host = createHost(BASE_ENV);
    host.send({
      type: 'create',
      ptyId: 'bad',
      cwd: tmp,
      cols: 80,
      rows: 24,
      shell: '/no/such/shell-xyz',
    });
    await waitFor(() => host.exitOf('bad') !== null, 'exit for unspawnable shell');
    const exit = host.exitOf('bad');
    if (exit && exit.exitCode === 0 && exit.signal === null) {
      throw new Error('expected a non-zero/failed exit for a bad shell');
    }
    host.killActive();
  });

  rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`HARNESS_RESULT ok=${results.length - failed} fail=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

const hardTimeout = setTimeout(() => {
  console.log('HARNESS_RESULT ok=0 fail=1 :: hard timeout');
  process.exit(1);
}, 30000);
hardTimeout.unref();

void main().catch((err) => {
  console.log(`HARNESS_RESULT ok=0 fail=1 :: ${(err as Error).message}`);
  process.exit(1);
});
