import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { initContent, OK_OKIGNORE_TEMPLATE } from './init-project.ts';

function findCommittedDogfoodFile(relativePath: string): string | null {
  let dir = import.meta.dirname;
  while (dir !== '/' && !existsSync(join(dir, relativePath))) {
    dir = dirname(dir);
  }
  return dir === '/' ? null : join(dir, relativePath);
}

const COMMITTED_OK_GITIGNORE = findCommittedDogfoodFile(join('.ok', '.gitignore'));
const COMMITTED_OKIGNORE = findCommittedDogfoodFile('.okignore');

describe.runIf(COMMITTED_OK_GITIGNORE !== null)(
  'committed .ok/.gitignore matches scaffold output',
  () => {
    it('matches OK_GITIGNORE_CONTENT byte-for-byte', () => {
      const tmp = resolve(
        tmpdir(),
        `gitignore-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tmp, { recursive: true });
      try {
        initContent(tmp);
        const scaffolded = readFileSync(join(tmp, OK_DIR, '.gitignore'), 'utf-8');
        const committed = readFileSync(COMMITTED_OK_GITIGNORE as string, 'utf-8');
        expect(committed).toBe(scaffolded);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);

describe.runIf(COMMITTED_OKIGNORE !== null)('committed .okignore matches scaffold output', () => {
  it('starts with OK_OKIGNORE_TEMPLATE byte-for-byte', () => {
    const tmp = resolve(
      tmpdir(),
      `okignore-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    try {
      initContent(tmp);
      const scaffolded = readFileSync(join(tmp, '.okignore'), 'utf-8');
      expect(scaffolded).toBe(OK_OKIGNORE_TEMPLATE);
      const committed = readFileSync(COMMITTED_OKIGNORE as string, 'utf-8');
      expect(
        committed.startsWith(OK_OKIGNORE_TEMPLATE),
        `committed .okignore (${COMMITTED_OKIGNORE}) must start with OK_OKIGNORE_TEMPLATE ` +
          'byte-for-byte; repo-local exclusions may only be appended below the scaffold block',
      ).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
