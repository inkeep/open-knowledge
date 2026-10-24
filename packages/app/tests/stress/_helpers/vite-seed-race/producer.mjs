import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';

const seedDir = process.env.OK_TEST_VITE_SEED_DIR;
const consumerReady = process.env.VITE_RACE_CONSUMER_READY;
const producerIntent = process.env.VITE_RACE_PRODUCER_INTENT;
const producerPublished = process.env.VITE_RACE_PRODUCER_PUBLISHED;
const producerRemoved = process.env.VITE_RACE_PRODUCER_REMOVED;
const consumerCopyDone = process.env.VITE_RACE_CONSUMER_COPY_DONE;
const pointerPath = `${seedDir}.current`;
const deadline = Date.now() + Number(process.env.VITE_RACE_WAIT_MS ?? '180000');
const waitForConsumer = () => {
  while (!existsSync(consumerReady)) {
    if (Date.now() >= deadline)
      throw new Error('consumer copy did not reach its synchronization gate');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};

if (
  !seedDir ||
  !consumerReady ||
  !producerIntent ||
  !producerPublished ||
  !producerRemoved ||
  !consumerCopyDone
)
  throw new Error('race harness inputs missing');
mkdirSync(dirname(producerIntent), { recursive: true });
const fs = (await import('node:fs')).default;
const originalRmSync = fs.rmSync;
const originalRenameSync = fs.renameSync;
const publish = (operation) => {
  writeFileSync(producerIntent, 'intent\n');
  waitForConsumer();
  operation();
  writeFileSync(producerRemoved, `${existsSync(seedDir)}\n`);
  writeFileSync(producerPublished, 'published\n');
  while (!existsSync(consumerCopyDone)) {
    if (Date.now() >= deadline) throw new Error('consumer copy did not settle');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
fs.rmSync = (target, ...args) => {
  if (target === seedDir) {
    publish(() => originalRmSync(target, ...args));
    return;
  }
  return originalRmSync(target, ...args);
};
fs.renameSync = (source, target) => {
  if (target === pointerPath) {
    publish(() => originalRenameSync(source, target));
    return;
  }
  return originalRenameSync(source, target);
};
syncBuiltinESMExports();

try {
  const { default: globalWarmViteCache } = await import(
    new URL('../global-warm-cache.ts', import.meta.url)
  );
  await globalWarmViteCache();
  writeFileSync(process.env.VITE_RACE_RESULT, JSON.stringify({ status: 'passed' }));
} catch (error) {
  writeFileSync(
    process.env.VITE_RACE_RESULT,
    JSON.stringify({
      status: 'failed',
      name: error?.name,
      message: String(error?.message ?? error),
    }),
  );
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
}
