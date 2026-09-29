/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint directly, outside Turbo. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function refusalKey({ verdict, stable, fixRefs, survivingRefs, failures, day }) {
  const files = [...new Set(failures.map((failure) => failure.split(' > ')[0]))].sort();
  const identity =
    verdict === 'fail' && files.length > 0
      ? [verdict, stable, files, day]
      : [verdict, fixRefs, survivingRefs];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(
    refusalKey({
      verdict: process.env.VERDICT,
      stable: process.env.STABLE,
      fixRefs: process.env.FIX_REFS,
      survivingRefs: process.env.SURVIVING_REFS,
      failures: JSON.parse(process.env.FAILURES || '[]'),
      day: new Date().toISOString().slice(0, 10),
    }),
  );
}
