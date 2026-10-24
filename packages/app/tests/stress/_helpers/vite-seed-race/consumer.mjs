import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';

const consumerReady = process.env.VITE_RACE_CONSUMER_READY;
const producerIntent = process.env.VITE_RACE_PRODUCER_INTENT;
const producerPublished = process.env.VITE_RACE_PRODUCER_PUBLISHED;
const consumerAfterPublish = process.env.VITE_RACE_CONSUMER_AFTER_PUBLISH;
const consumerCopyDone = process.env.VITE_RACE_CONSUMER_COPY_DONE;
const seedDir = process.env.OK_TEST_VITE_SEED_DIR;
const consumerCacheToken = process.env.VITE_RACE_CONSUMER_CACHE_TOKEN;
const pointerPath = `${seedDir}.current`;
const expectedSource = existsSync(pointerPath) ? readFileSync(pointerPath, 'utf8').trim() : seedDir;
const deadline = Date.now() + Number(process.env.VITE_RACE_WAIT_MS ?? '180000');
const waitForProducer = () => {
  while (!existsSync(producerPublished)) {
    if (Date.now() >= deadline) throw new Error('producer publication did not complete');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};

if (
  !consumerReady ||
  !producerIntent ||
  !producerPublished ||
  !consumerAfterPublish ||
  !consumerCopyDone ||
  !seedDir ||
  !consumerCacheToken
)
  throw new Error('race harness inputs missing');
mkdirSync(dirname(consumerReady), { recursive: true });
const fs = (await import('node:fs')).default;
const originalCpSync = fs.cpSync;
fs.cpSync = (...args) => {
  if (args[0] !== expectedSource) return originalCpSync(...args);
  writeFileSync(consumerReady, 'ready\n');
  waitForProducer();
  writeFileSync(consumerAfterPublish, `${existsSync(expectedSource)}\n`);
  try {
    return originalCpSync(...args);
  } finally {
    writeFileSync(consumerCopyDone, 'copy-done\n');
  }
};
syncBuiltinESMExports();

try {
  const { prepareViteCacheDir } = await import(new URL('../server-process.ts', import.meta.url));
  const dir = prepareViteCacheDir(`race-${consumerCacheToken}`);
  const copiedMetadata = existsSync(join(dir, 'deps', '_metadata.json'));
  writeFileSync(
    process.env.VITE_RACE_RESULT,
    JSON.stringify({ status: copiedMetadata ? 'passed' : 'failed', dir, copiedMetadata }),
  );
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
