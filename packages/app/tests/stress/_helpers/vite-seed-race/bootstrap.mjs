import { writeFileSync } from 'node:fs';

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
