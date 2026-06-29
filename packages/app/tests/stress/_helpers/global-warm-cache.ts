import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  APP_PACKAGE_ROOT,
  closeServerLog,
  getFreePort,
  killGracefully,
  openServerLog,
  tailServerLog,
  VITE_E2E_SEED_DIR,
  waitForHttpReady,
} from './server-process.ts';

const SEED_KEY_FILENAME = '.seed-key';
const OPTIMIZER_SETTLE_BUDGET_MS = 90_000;
const WARM_ATTEMPTS = 2;

function computeSeedKey(): string {
  const inputs = [
    join(APP_PACKAGE_ROOT, '..', '..', 'bun.lock'),
    join(APP_PACKAGE_ROOT, 'vite.config.ts'),
    join(APP_PACKAGE_ROOT, 'vite.dedupe.ts'),
    join(APP_PACKAGE_ROOT, 'vite.react-babel.ts'),
    join(APP_PACKAGE_ROOT, 'package.json'),
  ];
  const hash = createHash('sha256');
  for (const file of inputs) {
    hash.update(file);
    hash.update(existsSync(file) ? readFileSync(file) : 'absent');
  }
  return hash.digest('hex');
}

function depsDirSignature(depsDir: string): string {
  try {
    return readdirSync(depsDir)
      .map((name) => {
        try {
          return `${name}:${statSync(join(depsDir, name)).size}`;
        } catch {
          return `${name}:?`;
        }
      })
      .sort()
      .join('|');
  } catch {
    return 'absent';
  }
}

async function buildSeedOnce(key: string): Promise<void> {
  const port = await getFreePort();
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-warm-cache-content-'));
  mkdirSync(join(APP_PACKAGE_ROOT, 'node_modules'), { recursive: true });
  const buildDir = mkdtempSync(join(APP_PACKAGE_ROOT, 'node_modules', '.vite-e2e-seed-building-'));
  const log = openServerLog('warm-cache');
  const proc = spawn('bun', ['run', '--silent', 'dev', '--host', '127.0.0.1'], {
    cwd: APP_PACKAGE_ROOT,
    env: {
      ...process.env,
      VITE_PORT: String(port),
      OK_TEST_CONTENT_DIR: contentDir,
      OK_TEST_VITE_CACHE_DIR: buildDir,
      NO_COLOR: process.env.NO_COLOR ?? '1',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  proc.on('error', (err) => {
    console.warn('[e2e warm-cache] spawn error:', err);
  });
  let succeeded = false;
  try {
    await waitForHttpReady(`http://127.0.0.1:${port}`, 60_000);
    const depsDir = join(buildDir, 'deps');
    const metaPath = join(depsDir, '_metadata.json');
    const deadline = Date.now() + OPTIMIZER_SETTLE_BUDGET_MS;
    let lastSignature = '';
    let stablePolls = 0;
    while (Date.now() < deadline) {
      if (existsSync(metaPath)) {
        const signature = depsDirSignature(depsDir);
        if (signature === lastSignature) {
          stablePolls += 1;
          if (stablePolls >= 2) break;
        } else {
          stablePolls = 0;
          lastSignature = signature;
        }
      }
      await wait(1_000);
    }
    if (!existsSync(metaPath)) {
      throw new Error(
        `optimizer metadata never appeared within ${OPTIMIZER_SETTLE_BUDGET_MS}ms — server log tail:\n${tailServerLog(log)}`,
      );
    }
    if (stablePolls < 2) {
      throw new Error(
        `optimizer deps dir did not stabilize within ${OPTIMIZER_SETTLE_BUDGET_MS}ms (stablePolls=${stablePolls}) — server log tail:\n${tailServerLog(log)}`,
      );
    }
    writeFileSync(join(buildDir, SEED_KEY_FILENAME), key, 'utf-8');
    succeeded = true;
  } finally {
    try {
      await killGracefully(proc);
    } finally {
      closeServerLog(log);
      rmSync(contentDir, { recursive: true, force: true });
      if (!succeeded) {
        rmSync(buildDir, { recursive: true, force: true });
      }
    }
  }
  try {
    rmSync(VITE_E2E_SEED_DIR, { recursive: true, force: true });
    renameSync(buildDir, VITE_E2E_SEED_DIR);
    rmSync(log.path, { force: true });
  } catch (promoteErr) {
    rmSync(buildDir, { recursive: true, force: true });
    rmSync(log.path, { force: true });
    throw promoteErr;
  }
}

export default async function globalWarmViteCache(): Promise<void> {
  const key = computeSeedKey();
  const keyPath = join(VITE_E2E_SEED_DIR, SEED_KEY_FILENAME);
  const metaPath = join(VITE_E2E_SEED_DIR, 'deps', '_metadata.json');
  if (existsSync(keyPath) && existsSync(metaPath) && readFileSync(keyPath, 'utf-8') === key) {
    return;
  }
  for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt += 1) {
    try {
      await buildSeedOnce(key);
      return;
    } catch (err) {
      console.warn(
        `[e2e warm-cache] seed build attempt ${attempt}/${WARM_ATTEMPTS} failed${
          attempt === WARM_ATTEMPTS
            ? ' — workers will boot with a cold optimizer cache'
            : ', retrying'
        }: ${String(err)}`,
      );
    }
  }
}
