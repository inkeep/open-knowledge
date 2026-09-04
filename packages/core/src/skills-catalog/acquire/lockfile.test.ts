import { describe, expect, test } from 'vitest';
import { OPENKNOWLEDGE_SKILLS_REPO, PACK_SKILL_PREFIX } from '../../constants/skills.ts';
import { packMarkerOf, retrofitPackLockEntry } from './lockfile.ts';

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

  test('retrofits a post-rename pack skill name when the bundle proves it is ours', () => {
    const entry = retrofitPackLockEntry('note-taking', 'a'.repeat(64), '2026-08-04T00:00:00.000Z', {
      selfIdentifiesAsPack: true,
    });
    expect(entry?.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
    expect(entry?.skill).toBe('note-taking');
  });

  test('refuses a post-rename name with no pack witness', () => {
    for (const name of ['note-taking', 'write-a-spec', 'knowledge-base']) {
      expect(retrofitPackLockEntry(name, 'a'.repeat(64), '2026-08-04T00:00:00.000Z')).toBeNull();
      expect(
        retrofitPackLockEntry(name, 'a'.repeat(64), '2026-08-04T00:00:00.000Z', {
          selfIdentifiesAsPack: false,
        }),
      ).toBeNull();
    }
  });

  test('a name we do not publish is refused even with a witness', () => {
    for (const name of ['my-own-skill', 'code-review', 'open-knowledge']) {
      expect(
        retrofitPackLockEntry(name, 'a'.repeat(64), '2026-08-04T00:00:00.000Z', {
          selfIdentifiesAsPack: true,
        }),
      ).toBeNull();
    }
  });

  test('an old prefixed name needs no witness', () => {
    const entry = retrofitPackLockEntry(
      `${PACK_SKILL_PREFIX}plain-notes`,
      'a'.repeat(64),
      '2026-08-04T00:00:00.000Z',
    );
    expect(entry?.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
  });

  test('still returns null for a name that is not a pack skill', () => {
    expect(
      retrofitPackLockEntry('my-own-skill', 'a'.repeat(64), '2026-08-04T00:00:00.000Z'),
    ).toBeNull();
  });
});

describe('packMarkerOf', () => {
  test('reads the upstream pack identity a starter-pack bundle ships', () => {
    expect(packMarkerOf({ name: 'note-taking', metadata: { pack: 'plain-notes' } })).toBe(
      'plain-notes',
    );
  });

  test('is undefined for a bundle that claims nothing', () => {
    expect(packMarkerOf({ name: 'write-a-spec', description: 'mine' })).toBeUndefined();
    expect(packMarkerOf({ metadata: {} })).toBeUndefined();
    expect(packMarkerOf({ metadata: { pack: '   ' } })).toBeUndefined();
    expect(packMarkerOf(null)).toBeUndefined();
    expect(packMarkerOf('not an object')).toBeUndefined();
  });

  test('a non-string marker is not a claim', () => {
    expect(packMarkerOf({ metadata: { pack: 42 } })).toBeUndefined();
  });
});
