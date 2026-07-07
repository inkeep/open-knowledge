import { describe, expect, test } from 'bun:test';
import { isGitObjectNotFound } from './skill-restore.ts';

/**
 * The `isGitObjectNotFound` boundary is what keeps a corrupt-repo / missing-git
 * failure from being masked as a stale-version 404 in `restoreSkillVersion`'s
 * `ls-tree` catch (→ HTTP 500 vs 404). Pin both sides so the regex can't
 * silently broaden to swallow genuine server faults as not-found.
 */
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
