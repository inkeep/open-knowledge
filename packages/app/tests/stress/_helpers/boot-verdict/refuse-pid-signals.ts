import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const runDir = process.env.OK_BOOT_VERDICT_RUN_DIR;

process.kill = (pid: number, signal?: string | number): true => {
  if (runDir !== undefined) {
    appendFileSync(
      join(runDir, 'refused-signals.jsonl'),
      `${JSON.stringify({ caller: process.pid, worker: process.env.TEST_WORKER_INDEX, pid, signal })}\n`,
    );
  }
  throw Object.assign(new Error('the boot-verdict run refuses every pid-addressed signal'), {
    code: 'ESRCH',
  });
};
