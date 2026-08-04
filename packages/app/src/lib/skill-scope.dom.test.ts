import { describe, expect, test } from 'vitest';
import { skillDisplayName } from './skill-scope';

describe('skillDisplayName', () => {
  // Load-bearing precisely BECAUSE existing installs are never renamed: the long
  // prefixed names live indefinitely, and without the strip they render in full
  // in the sidebar and tab labels — the overflow this helper exists to prevent.
  test('strips the pack prefix from a pre-rename install', () => {
    expect(skillDisplayName('open-knowledge-pack-software-lifecycle')).toBe('software-lifecycle');
    expect(skillDisplayName('open-knowledge-pack-knowledge-base-research')).toBe(
      'knowledge-base-research',
    );
  });

  test('leaves post-rename and user-authored names alone', () => {
    for (const name of ['note-taking', 'research-with-sources', 'my-own-skill', 'open-knowledge']) {
      expect(skillDisplayName(name)).toBe(name);
    }
  });

  test('does not strip a name that merely contains the prefix', () => {
    expect(skillDisplayName('my-open-knowledge-pack-thing')).toBe('my-open-knowledge-pack-thing');
  });
});
