import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { createBasenameIndex } from './path-resolve';

describe('createBasenameIndex — single-match lookup', () => {
  test('returns the single indexed path', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    expect(idx.resolveEmbed('photo.png', 'notes/meeting.md')).toBe('docs/photo.png');
  });

  test('returns null for unknown basename', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    expect(idx.resolveEmbed('missing.png', 'docs/meeting.md')).toBeNull();
  });

  test('returns null for empty basename', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    expect(idx.resolveEmbed('', 'docs/meeting.md')).toBeNull();
  });
});

describe('createBasenameIndex — case-insensitive lookup, case-preserving storage', () => {
  test('lookup is case-insensitive', () => {
    const idx = createBasenameIndex();
    idx.add('docs/Photo.PNG');
    expect(idx.resolveEmbed('photo.png', 'docs/a.md')).toBe('docs/Photo.PNG');
    expect(idx.resolveEmbed('PHOTO.PNG', 'docs/a.md')).toBe('docs/Photo.PNG');
  });

  test('original case preserved in bucket', () => {
    const idx = createBasenameIndex();
    idx.add('Attachments/FOO.png');
    const snap = idx.snapshot();
    expect(snap.get('foo.png')).toEqual(['Attachments/FOO.png']);
  });
});

describe('createBasenameIndex — path normalization', () => {
  test('./prefix stripped on add', () => {
    const idx = createBasenameIndex();
    idx.add('./docs/photo.png');
    expect(idx.resolveEmbed('photo.png', 'notes/a.md')).toBe('docs/photo.png');
  });

  test('leading / stripped on add', () => {
    const idx = createBasenameIndex();
    idx.add('/docs/photo.png');
    expect(idx.resolveEmbed('photo.png', 'notes/a.md')).toBe('docs/photo.png');
  });

  test('sourcePath normalization handled in resolveEmbed', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    idx.add('notes/photo.png');
    // './docs/meeting.md' and 'docs/meeting.md' should resolve the same way.
    expect(idx.resolveEmbed('photo.png', './docs/meeting.md')).toBe('docs/photo.png');
    expect(idx.resolveEmbed('photo.png', 'docs/meeting.md')).toBe('docs/photo.png');
  });

  test('root-level sourcePath treats everything as in-subtree', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    idx.add('attachments/photo.png');
    // dirnameOf('readme.md') === '' → every candidate is "in subtree".
    // Both are at depth 1; alphabetical tiebreak → 'attachments/photo.png' < 'docs/photo.png'.
    expect(idx.resolveEmbed('photo.png', 'readme.md')).toBe('attachments/photo.png');
  });
});

describe('createBasenameIndex — tiebreak #1: subtree preference, shallowest depth', () => {
  test('prefers path in sourcePath own dirname subtree over outside', () => {
    // docs/photo.png and attachments/photo.png coexist; sourcePath
    // is docs/meeting.md → docs/photo.png wins (inside sourceDir subtree).
    const idx = createBasenameIndex();
    idx.add('attachments/photo.png');
    idx.add('docs/photo.png');
    expect(idx.resolveEmbed('photo.png', 'docs/meeting.md')).toBe('docs/photo.png');
  });

  test('prefers shallowest within the subtree (same-dir beats deep subdir)', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    idx.add('docs/archive/2026/photo.png');
    expect(idx.resolveEmbed('photo.png', 'docs/meeting.md')).toBe('docs/photo.png');
  });

  test('equal depth inside subtree falls to alphabetical', () => {
    const idx = createBasenameIndex();
    idx.add('docs/b/photo.png');
    idx.add('docs/a/photo.png');
    // Both at depth 1 from 'docs'. Alphabetical → 'docs/a/photo.png' wins.
    expect(idx.resolveEmbed('photo.png', 'docs/meeting.md')).toBe('docs/a/photo.png');
  });

  test('subtree preference beats shorter relative hop from outside', () => {
    // 'sibling/photo.png' is 2 hops away from 'docs'; 'docs/sub/photo.png'
    // is 1 step deeper, but it's in subtree → wins.
    const idx = createBasenameIndex();
    idx.add('sibling/photo.png');
    idx.add('docs/deep/deeper/photo.png');
    expect(idx.resolveEmbed('photo.png', 'docs/meeting.md')).toBe('docs/deep/deeper/photo.png');
  });
});

describe('createBasenameIndex — tiebreak #2: shortest relative hops when no subtree match', () => {
  test('shortest hop wins when nothing is in the subtree', () => {
    // sourceDir = 'archive/old'; no in-subtree match.
    // Hops to 'docs/photo.png': up 2 ('archive', 'old') + down 1 ('docs') = 3.
    // Hops to 'attachments/deep/dir/photo.png': up 2 + down 3 = 5.
    const idx = createBasenameIndex();
    idx.add('attachments/deep/dir/photo.png');
    idx.add('docs/photo.png');
    expect(idx.resolveEmbed('photo.png', 'archive/old/meeting.md')).toBe('docs/photo.png');
  });

  test('equal hops from outside subtree → alphabetical tiebreak', () => {
    const idx = createBasenameIndex();
    idx.add('zulu/photo.png');
    idx.add('alpha/photo.png');
    // sourceDir = 'mid'; both candidates are 2 hops away (up 1 + down 1).
    expect(idx.resolveEmbed('photo.png', 'mid/a.md')).toBe('alpha/photo.png');
  });
});

describe('createBasenameIndex — tiebreak #3: alphabetical ascending is the final stable tiebreak', () => {
  test('cross-rebuild determinism for insertion order differences', () => {
    const idx1 = createBasenameIndex();
    idx1.add('z/photo.png');
    idx1.add('a/photo.png');
    idx1.add('m/photo.png');

    const idx2 = createBasenameIndex();
    idx2.add('m/photo.png');
    idx2.add('a/photo.png');
    idx2.add('z/photo.png');

    const r1 = idx1.resolveEmbed('photo.png', 'sibling/notes.md');
    const r2 = idx2.resolveEmbed('photo.png', 'sibling/notes.md');
    expect(r1).toBe(r2);
    expect(r1).toBe('a/photo.png');
  });
});

describe('createBasenameIndex — add/remove/rename', () => {
  test('add idempotent for identical paths', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    idx.add('docs/photo.png');
    expect(idx.snapshot().get('photo.png')?.length).toBe(1);
  });

  test('add does not mutate siblings in same bucket', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    idx.add('attachments/photo.png');
    const bucket = idx.snapshot().get('photo.png');
    expect(bucket).toEqual(['docs/photo.png', 'attachments/photo.png']);
  });

  test('remove eliminates path from bucket; bucket deleted when empty', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    idx.add('attachments/photo.png');
    idx.remove('docs/photo.png');
    expect(idx.snapshot().get('photo.png')).toEqual(['attachments/photo.png']);
    idx.remove('attachments/photo.png');
    expect(idx.snapshot().get('photo.png')).toBeUndefined();
    expect(idx.size()).toBe(0);
  });

  test('remove not-present is a no-op', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    idx.remove('docs/nothing.png');
    idx.remove('unrelated/photo.png');
    expect(idx.snapshot().get('photo.png')).toEqual(['docs/photo.png']);
  });

  test('rename moves the path atomically', () => {
    const idx = createBasenameIndex();
    idx.add('docs/photo.png');
    idx.rename('docs/photo.png', 'attachments/photo.png');
    expect(idx.snapshot().get('photo.png')).toEqual(['attachments/photo.png']);
  });

  test('rename across basenames updates both keys', () => {
    const idx = createBasenameIndex();
    idx.add('docs/old.png');
    idx.rename('docs/old.png', 'docs/new.png');
    expect(idx.snapshot().get('old.png')).toBeUndefined();
    expect(idx.snapshot().get('new.png')).toEqual(['docs/new.png']);
  });

  test('add empty path is a no-op', () => {
    const idx = createBasenameIndex();
    idx.add('');
    expect(idx.size()).toBe(0);
  });
});

describe('createBasenameIndex — property-based tiebreak determinism', () => {
  test('resolveEmbed is insertion-order independent', () => {
    // For any multiset of paths sharing a basename, two indexes built by
    // inserting the paths in different orders must resolve to the same value.
    fc.assert(
      fc.property(
        fc
          .array(
            fc.tuple(
              fc.array(
                fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/).filter((s) => s.length > 0),
                { minLength: 0, maxLength: 3 },
              ),
              fc.stringMatching(/^[a-z][a-z0-9]{0,6}\.png$/).filter(Boolean),
            ),
            { minLength: 2, maxLength: 8 },
          )
          .map((entries) => {
            // Ensure all entries share the same basename for multi-candidate resolution.
            const sharedBase = entries[0][1];
            return entries.map(([dirs]) =>
              dirs.length === 0 ? sharedBase : `${dirs.join('/')}/${sharedBase}`,
            );
          })
          .filter((paths) => new Set(paths).size >= 1),
        fc.array(
          fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/).filter((s) => s.length > 0),
          { minLength: 0, maxLength: 3 },
        ),
        (paths, sourceDirs) => {
          const basename = paths[0].split('/').pop() ?? '';
          if (basename === '') return;
          const sourcePath =
            sourceDirs.length === 0 ? 'root.md' : `${sourceDirs.join('/')}/source.md`;

          const idx1 = createBasenameIndex();
          for (const p of paths) idx1.add(p);

          const idx2 = createBasenameIndex();
          for (const p of [...paths].reverse()) idx2.add(p);

          expect(idx1.resolveEmbed(basename, sourcePath)).toBe(
            idx2.resolveEmbed(basename, sourcePath),
          );
        },
      ),
      { numRuns: Number(process.env.STRESS_FIDELITY) === 1 ? 10_000 : 500 },
    );
  });
});

describe('createBasenameIndex — NFR-1 lookup performance', () => {
  test('10K lookups against a 1000-asset index finish well under 1s', () => {
    // basename-index lookup is O(1) amortized. Upper bound is generous
    // (100us/lookup) so this stays non-flaky across CI hardware; the actual
    // Map hit cost is microseconds.
    const idx = createBasenameIndex();
    for (let i = 0; i < 1000; i++) {
      const dir = i % 2 === 0 ? `dir${i % 10}` : `nested/sub/${i % 5}`;
      idx.add(`${dir}/asset-${i}.png`);
    }
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      idx.resolveEmbed(`asset-${i % 1000}.png`, `source/doc${i % 100}.md`);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});
