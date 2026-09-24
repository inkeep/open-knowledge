import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const runDir = process.env.OK_BOOT_VERDICT_RUN_DIR;
if (runDir !== undefined) {
  appendFileSync(join(runDir, 'boot-failure-injected'), `${process.pid}\n`);
}

throw new Error('OK_BOOT_VERDICT: injected dev-server boot failure before the server could bind');
