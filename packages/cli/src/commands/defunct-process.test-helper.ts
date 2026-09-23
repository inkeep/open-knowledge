import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DefunctProcess {
  pid: number;
  state: string;
}

const HOLDER_SOURCE = [
  "const { spawn, spawnSync } = require('node:child_process');",
  "const { writeSync } = require('node:fs');",
  "const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });",
  "let state = '';",
  'const deadline = Date.now() + 10000;',
  'while (Date.now() < deadline) {',
  "  const ps = spawnSync('ps', ['-p', String(child.pid), '-o', 'stat='], { encoding: 'utf-8' });",
  "  state = (ps.stdout || '').trim();",
  "  if (state.startsWith('Z')) break;",
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
  '}',
  "writeSync(1, JSON.stringify({ pid: child.pid, state }) + '\\n');",
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
  '',
].join('\n');

export async function startDefunctProcess(
  scratchDir: string,
  children: ChildProcess[],
): Promise<DefunctProcess> {
  const holderPath = join(scratchDir, 'defunct-holder.cjs');
  mkdirSync(dirname(holderPath), { recursive: true });
  writeFileSync(holderPath, HOLDER_SOURCE);
  const holder = spawn(process.execPath, [holderPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(holder);
  return await new Promise<DefunctProcess>((resolve, reject) => {
    let buffered = '';
    holder.stdout?.on('data', (chunk) => {
      buffered += String(chunk);
      const newline = buffered.indexOf('\n');
      if (newline !== -1) resolve(JSON.parse(buffered.slice(0, newline)) as DefunctProcess);
    });
    holder.once('exit', (code) =>
      reject(new Error(`Defunct-process holder exited before reporting (code ${code})`)),
    );
  });
}
