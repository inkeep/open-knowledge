import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PACKAGE_ROOT } from '../seed-key.ts';
import { consumerCacheTokenIdentifiesOneRun, removeRaceArtifacts } from './race-artifacts.ts';

const givenConsumerCacheToken = process.env.VITE_RACE_CONSUMER_CACHE_TOKEN;
if (
  givenConsumerCacheToken !== undefined &&
  !consumerCacheTokenIdentifiesOneRun(givenConsumerCacheToken)
)
  throw new Error(
    'VITE_RACE_CONSUMER_CACHE_TOKEN is set but blank, so it cannot identify this run; unset it to generate one',
  );
const consumerCacheToken = givenConsumerCacheToken ?? randomUUID();
const givenRunDir = process.env.VITE_RACE_RUN_DIR;
const runDir = givenRunDir ?? mkdtempSync(join(tmpdir(), 'ok-vite-warm-race-'));
const seedDir = join(runDir, 'seed');
const consumerReady = join(runDir, 'consumer-ready');
const producerIntent = join(runDir, 'producer-intent');
const producerPublished = join(runDir, 'producer-published');
const producerRemoved = join(runDir, 'producer-removed');
const consumerAfterPublish = join(runDir, 'consumer-after-publish');
const consumerCopyDone = join(runDir, 'consumer-copy-done');
const consumerResult = join(runDir, 'consumer-result.json');
const producerResult = join(runDir, 'producer-result.json');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const phase = (message) => {
  process.stderr.write(`[vite-seed-race] ${message}\n`);
};
const envBase = {
  ...process.env,
  OK_TEST_VITE_SEED_DIR: seedDir,
  VITE_RACE_CONSUMER_READY: consumerReady,
  VITE_RACE_PRODUCER_INTENT: producerIntent,
  VITE_RACE_PRODUCER_PUBLISHED: producerPublished,
  VITE_RACE_PRODUCER_REMOVED: producerRemoved,
  VITE_RACE_CONSUMER_AFTER_PUBLISH: consumerAfterPublish,
  VITE_RACE_CONSUMER_COPY_DONE: consumerCopyDone,
  VITE_RACE_CONSUMER_CACHE_TOKEN: consumerCacheToken,
  VITE_RACE_WAIT_MS: '180000',
};
const run = (label, script, result) =>
  new Promise((resolve, reject) => {
    phase(`${label} started`);
    const child = spawn('pnpm', ['exec', 'tsx', script], {
      cwd: APP_PACKAGE_ROOT,
      env: { ...envBase, VITE_RACE_RESULT: result },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      phase(`${label} exited with code ${String(code)} and signal ${String(signal)}`);
      resolve({ code, signal, stdout, stderr });
    });
  });

try {
  phase(`run directory ${runDir}, consumer cache token ${consumerCacheToken}`);
  const bootstrap = await run(
    'bootstrap warm build',
    join(scriptDir, 'bootstrap.mjs'),
    join(runDir, 'bootstrap-result.json'),
  );
  if (bootstrap.code !== 0) throw new Error(`bootstrap failed: ${bootstrap.stderr}`);
  const publishedSeed = existsSync(`${seedDir}.current`)
    ? readFileSync(`${seedDir}.current`, 'utf8').trim()
    : seedDir;
  writeFileSync(join(publishedSeed, '.seed-key'), 'stale-race-key\n');
  const consumerPromise = run('consumer copy', join(scriptDir, 'consumer.mjs'), consumerResult);
  const producerPromise = run(
    'producer warm build',
    join(scriptDir, 'producer.mjs'),
    producerResult,
  );
  const [consumer, producer] = await Promise.all([consumerPromise, producerPromise]);
  const publishedSeedAfterBootstrap = existsSync(`${seedDir}.current`)
    ? readFileSync(`${seedDir}.current`, 'utf8').trim()
    : seedDir;
  const result = {
    runDir,
    seedReadyAfterBootstrap: existsSync(
      join(publishedSeedAfterBootstrap, 'deps', '_metadata.json'),
    ),
    consumer,
    producer,
    consumerResult: existsSync(consumerResult)
      ? JSON.parse(readFileSync(consumerResult, 'utf8'))
      : null,
    producerResult: existsSync(producerResult)
      ? JSON.parse(readFileSync(producerResult, 'utf8'))
      : null,
    producerIntentReached: existsSync(producerIntent),
    producerPublished: existsSync(producerPublished),
    producerRemoved: existsSync(producerRemoved) ? readFileSync(producerRemoved, 'utf8') : null,
    consumerAfterPublish: existsSync(consumerAfterPublish)
      ? readFileSync(consumerAfterPublish, 'utf8')
      : null,
    consumerCopyDone: existsSync(consumerCopyDone),
    consumerReadyReached: existsSync(consumerReady),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    result.consumerResult?.status !== 'passed' ||
    result.producerResult?.status !== 'passed' ||
    !result.producerPublished
  )
    process.exitCode = 1;
} finally {
  const failures = removeRaceArtifacts({
    runDir: givenRunDir === undefined ? runDir : undefined,
    consumerCacheToken,
  });
  if (failures.length > 0) {
    phase(`cleanup could not remove:\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    phase('cleanup finished');
  }
}
