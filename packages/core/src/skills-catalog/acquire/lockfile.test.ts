import { describe, expect, test } from 'vitest';
import { OPENKNOWLEDGE_SKILLS_REPO, PACK_SKILL_PREFIX } from '../../constants/skills.ts';
import { retrofitPackLockEntry } from './lockfile.ts';

describe('retrofitPackLockEntry', () => {
  test('synthesizes a deterministic entry for a pack-prefixed skill with no lock entry', () => {
    const name = `${PACK_SKILL_PREFIX}getting-started`;
    const entry = retrofitPackLockEntry(name, 'a'.repeat(64), '2026-07-15T00:00:00.000Z');
    expect(entry).toEqual({
      source: OPENKNOWLEDGE_SKILLS_REPO,
      skill: name,
      contentHash: 'a'.repeat(64),
      importedAt: '2026-07-15T00:00:00.000Z',
    });
  });

  test('returns null for a non-pack (authored/imported) skill name', () => {
    expect(retrofitPackLockEntry('my-authored-skill', 'deadbeef', '2026-07-15T00:00:00.000Z')).toBe(
      null,
    );
  });
});
