import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PACKAGE_ROOT } from '../seed-key.ts';

const CONSUMER_CACHE_PARENT = join(APP_PACKAGE_ROOT, 'node_modules');

export function consumerCacheTokenIdentifiesOneRun(consumerCacheToken: string): boolean {
  return consumerCacheToken.trim() !== '';
}

export function removeRaceArtifacts(run: {
  runDir: string | undefined;
  consumerCacheToken: string;
}): string[] {
  const failures: string[] = [];
  const remove = (path: string) => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      failures.push(`${path}: ${String(error)}`);
    }
  };
  if (!consumerCacheTokenIdentifiesOneRun(run.consumerCacheToken)) {
    failures.push(
      `the consumer cache token ${JSON.stringify(run.consumerCacheToken)} is blank and cannot identify one run, so nothing under ${CONSUMER_CACHE_PARENT} was removed`,
    );
  } else {
    try {
      for (const name of readdirSync(CONSUMER_CACHE_PARENT)) {
        if (name.includes(run.consumerCacheToken)) remove(join(CONSUMER_CACHE_PARENT, name));
      }
    } catch (error) {
      failures.push(`${CONSUMER_CACHE_PARENT}: ${String(error)}`);
    }
  }
  if (run.runDir !== undefined) remove(run.runDir);
  return failures;
}
