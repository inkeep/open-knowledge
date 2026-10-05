import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./lifetime-server.cjs', import.meta.url));

export default async function lifetimeGlobalSetup(): Promise<() => Promise<void>> {
  const runDir = process.env.OK_PORT_OWNERSHIP_RUN_DIR;
  if (!runDir) throw new Error('lifetime setup needs a run directory');
  const nonce = randomUUID();
  const child = spawn(process.execPath, [serverPath, nonce], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const [message] = await once(child, 'message');
  const receipt = message as { port: number; nonce: string; pid: number };
  const response = await fetch(`http://127.0.0.1:${receipt.port}/identity`);
  if ((await response.text()) !== nonce) throw new Error('owned lifetime endpoint did not serve');
  writeFileSync(join(runDir, 'lifetime-receipt.json'), JSON.stringify(receipt));

  if (process.env.OK_PORT_OWNERSHIP_CALLER !== 'lifetime-normal') {
    await new Promise<never>(() => {});
  }

  return async () => {
    const exited = once(child, 'exit');
    child.send('release');
    await exited;
  };
}
