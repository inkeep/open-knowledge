
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  installHostReaping,
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureSpawnHelperExecutable();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pty-reap-')));
  process.on('exit', () => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
    }
  });

  let data = '';
  let handler: ((event: { data: unknown }) => void) | null = null;
  const handle = setupPtyHost({
    parentPort: {
      on(_event, h) {
        handler = h;
      },
      postMessage(msg: PtyHostOutgoingMessage) {
        if (msg.type === 'data') data += msg.data;
      },
    },
    spawn,
    env: process.env,
  });
  installHostReaping(handle, process);
  const send = (msg: PtyHostIncomingMessage): void => handler?.({ data: msg });

  send({ type: 'create', ptyId: 'reap', cwd: tmp, cols: 80, rows: 24 });

  const deadline = Date.now() + 15000;
  while (data.length === 0 && Date.now() < deadline) await sleep(15);
  send({ type: 'input', ptyId: 'reap', data: 'echo SHELLPID=$$\r' });
  let pid: number | null = null;
  while (pid === null && Date.now() < deadline) {
    const match = data.match(/SHELLPID=(\d+)/);
    if (match) pid = Number(match[1]);
    else await sleep(15);
  }
  if (pid === null) {
    console.error('reap-harness: shell never reported its pid');
    process.exit(1);
  }

  process.stdout.write(`SHELLPID=${pid}\n`);

  await sleep(30000);
  handle.killActive();
  process.exit(2);
}

void main().catch((err) => {
  console.error(`reap-harness fatal: ${(err as Error).message}`);
  process.exit(1);
});
