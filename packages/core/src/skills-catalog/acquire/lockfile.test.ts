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

  // Post-rename a fresh pack install is short-named. Gating the retrofit on the
  // old prefix alone left those installs with no way back if their lock entry
  // went missing — Update answered "no recorded import source" and nothing in
  // the product could repair it.
  test('retrofits a post-rename pack skill name when the bundle proves it is ours', () => {
    const entry = retrofitPackLockEntry('note-taking', 'a'.repeat(64), '2026-08-04T00:00:00.000Z', {
      selfIdentifiesAsPack: true,
    });
    expect(entry?.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
    expect(entry?.skill).toBe('note-taking');
  });

  // The published short names are generic enough that a user may own one.
  // Without a witness we would stamp our provenance onto their skill, and the
  // next Update would offer to overwrite it with ours.
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

  // The witness alone must not grant retrofit: the name still has to be one we
  // actually publish. A user's own skill that happens to carry a `metadata.pack`
  // line — a doc about packs, a copied bundle — is not ours to claim.
  test('a name we do not publish is refused even with a witness', () => {
    for (const name of ['my-own-skill', 'code-review', 'open-knowledge']) {
      expect(
        retrofitPackLockEntry(name, 'a'.repeat(64), '2026-08-04T00:00:00.000Z', {
          selfIdentifiesAsPack: true,
        }),
      ).toBeNull();
    }
  });

  // The old prefixed names are namespaced — nobody else can hold them — so
  // presence alone stays sufficient there.
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
