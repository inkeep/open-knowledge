import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('share contract corpus cache wiring', () => {
  test('the nested cross-release oracle invalidates every Turbo task cache', () => {
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8'));
    const corpusPath = 'test-support/fixtures/share-url-v1-v2.json';

    expect(turbo.globalDependencies).toContain(corpusPath);
    expect(turbo.globalDependencies.filter((entry) => entry === corpusPath)).toHaveLength(1);
  });

  test('the static docs manifest deployment identity invalidates the docs build cache', () => {
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8'));
    const docsBuild = turbo.tasks['@inkeep/open-knowledge-docs#build'];

    expect(docsBuild.env).toEqual([
      'VERCEL_GIT_COMMIT_SHA',
      'GITHUB_SHA',
      'VERCEL_ENV',
      'OK_ALLOW_BLOGLESS_LLMS_TXT',
      'CI',
      'VERCEL',
    ]);
  });
});
