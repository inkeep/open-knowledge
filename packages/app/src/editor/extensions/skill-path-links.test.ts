import { describe, expect, test } from 'vitest';
import { hashFromSkillFile } from '@/lib/doc-hash';
import { skillEntryFileLiveDocName } from '@/lib/managed-artifact-doc-name';
import {
  BUNDLE_PATH_RE,
  isSkillRefCandidate,
  SKILL_REF_RE,
  skillBundlePathNavHash,
  skillDocTarget,
} from './skill-path-links.ts';

describe('BUNDLE_PATH_RE', () => {
  test('matches bundle-relative reference/script paths, normalizing ./', () => {
    expect(BUNDLE_PATH_RE.exec('references/epistemics.md')?.[1]).toBe('references/epistemics.md');
    expect(BUNDLE_PATH_RE.exec('./scripts/extract-stylometry.py')?.[1]).toBe(
      'scripts/extract-stylometry.py',
    );
    expect(BUNDLE_PATH_RE.exec('references/deep/nested-file.md')?.[1]).toBe(
      'references/deep/nested-file.md',
    );
  });

  test('stays inert for everything else', () => {
    // Whole-span anchoring: a path mentioned mid-span is not a link.
    expect(BUNDLE_PATH_RE.test('see references/x.md for detail')).toBe(false);
    // Only the two bundle roots; no escapes; no bare filenames or flags.
    expect(BUNDLE_PATH_RE.test('assets/logo.png')).toBe(false);
    expect(BUNDLE_PATH_RE.test('references/../secrets')).toBe(false);
    expect(BUNDLE_PATH_RE.test('../../../../scripts/lume-bake/')).toBe(false);
    expect(BUNDLE_PATH_RE.test('--check-deps')).toBe(false);
    expect(BUNDLE_PATH_RE.test('references/')).toBe(false);
  });
});

describe('skillDocTarget', () => {
  test('resolves in-place project bundle docs and managed skill artifacts', () => {
    expect(skillDocTarget('.agents/skills/analyze-stylometry/SKILL')).toEqual({
      scope: 'project',
      name: 'analyze-stylometry',
    });
    expect(skillDocTarget('__skill__/global/my-skill/SKILL')).toEqual({
      scope: 'global',
      name: 'my-skill',
    });
    expect(skillDocTarget('docs/ordinary-page')).toBeNull();
  });
});

describe('SKILL_REF_RE + isSkillRefCandidate', () => {
  function refs(text: string): string[] {
    SKILL_REF_RE.lastIndex = 0;
    const out: string[] = [];
    for (let m = SKILL_REF_RE.exec(text); m !== null; m = SKILL_REF_RE.exec(text)) {
      const slug = m[2] as string;
      if (isSkillRefCandidate(slug)) out.push(slug);
    }
    return out;
  }

  test('matches standalone /skill-name tokens in prose', () => {
    expect(refs('Load /structured-thinking skill first.')).toEqual(['structured-thinking']);
    expect(refs('(see /grilling) or /grill-me.')).toEqual(['grilling', 'grill-me']);
    expect(refs('/analyze')).toEqual(['analyze']);
  });

  test('paths, urls, and stop-listed roots stay inert', () => {
    expect(refs('read /api/skill or scripts/run.sh')).toEqual([]);
    expect(refs('stored under /tmp and /usr today')).toEqual([]);
    expect(refs('https://x.com/foo')).toEqual([]);
    expect(refs('half/way is not a ref')).toEqual([]);
  });
});

describe('skillBundlePathNavHash (PRD-7607)', () => {
  const projectSkillDoc = '.claude/skills/foo/SKILL';

  test('an editable .md/.mdx reference opens the live editable doc, not the read-only viewer', () => {
    const target = { scope: 'project' as const, name: 'foo' };
    const editableDoc = skillEntryFileLiveDocName(
      { scope: 'project', name: 'foo', path: `${projectSkillDoc}.md` },
      'references/bar.md',
    );
    // Same buffer the sidebar's openFile targets — a plain `#/<docName>` hash.
    expect(skillBundlePathNavHash(target, projectSkillDoc, 'references/bar.md')).toBe(
      `#/${editableDoc}`,
    );
  });

  test('a script (non-md) keeps the read-only skill-file viewer', () => {
    const target = { scope: 'project' as const, name: 'foo' };
    expect(skillBundlePathNavHash(target, projectSkillDoc, 'scripts/run.sh')).toBe(
      hashFromSkillFile({ ...target, path: 'scripts/run.sh' }),
    );
  });

  test('a built-in (open-knowledge*) skill stays read-only even for a .md reference', () => {
    const target = { scope: 'project' as const, name: 'open-knowledge-write-skill' };
    expect(
      skillBundlePathNavHash(
        target,
        '.claude/skills/open-knowledge-write-skill/SKILL',
        'references/x.md',
      ),
    ).toBe(hashFromSkillFile({ ...target, path: 'references/x.md' }));
  });
});
