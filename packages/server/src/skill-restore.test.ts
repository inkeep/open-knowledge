import { describe, expect, test } from 'vitest';
import { isGitObjectNotFound } from './skill-restore.ts';

describe('isGitObjectNotFound', () => {
  test('classifies a genuinely-missing object/revision as not-found (→ 404)', () => {
    for (const msg of [
      "fatal: not a valid object name 'abc123'",
      'fatal: bad revision',
      'unknown revision or path not in the working tree',
      'fatal: Not a valid object name HEAD~5',
      'fatal: invalid object name deadbeef',
      'fatal: not a tree object',
    ]) {
      expect(isGitObjectNotFound(msg)).toBe(true);
    }
  });

  test('does NOT match genuine git I/O / server faults (→ 500)', () => {
    for (const msg of [
      'fatal: unable to read source tree',
      'git binary not found',
      'fatal: object file is empty',
      'repository is corrupt',
      'fatal: unable to read tree',
      'EACCES: permission denied',
      'spawn git ENOENT',
    ]) {
      expect(isGitObjectNotFound(msg)).toBe(false);
    }
  });
});
