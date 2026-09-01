import type { SkillLockEntry } from '@inkeep/open-knowledge-core/skills-catalog';
import { describe, expect, it } from 'vitest';
import { groupReimportNamesBySource, pickReimportDir, planReimportDiff } from './skill-reimport.ts';

const noFrontmatter = () => undefined;

describe('pickReimportDir', () => {
  const dirs = [
    { name: 'alpha', dir: '/tmp/src/alpha' },
    { name: 'beta', dir: '/tmp/src/beta' },
    { name: 'note-taking', dir: '/tmp/src/note-taking' },
  ];

  it('prefers the recorded upstream dir over the local name', () => {
    const pick = pickReimportDir(dirs, {
      recordedSkill: 'beta',
      localName: 'alpha',
      frontmatterNameOf: noFrontmatter,
    });
    expect(pick?.name).toBe('beta');
  });

  it('falls back to the local name when nothing was recorded', () => {
    const pick = pickReimportDir(dirs, { localName: 'alpha', frontmatterNameOf: noFrontmatter });
    expect(pick?.name).toBe('alpha');
  });

  it('matches a bundle whose frontmatter name differs from its directory', () => {
    const pick = pickReimportDir(dirs, {
      localName: 'vercel-react-native-skills',
      frontmatterNameOf: (dir) =>
        dir === '/tmp/src/beta' ? 'vercel-react-native-skills' : undefined,
    });
    expect(pick?.name).toBe('beta');
  });

  it('resolves a pre-rename install against the renamed bundle', () => {
    const pick = pickReimportDir(dirs, {
      recordedSkill: 'open-knowledge-pack-plain-notes',
      localName: 'open-knowledge-pack-plain-notes',
      frontmatterNameOf: noFrontmatter,
    });
    expect(pick?.name).toBe('note-taking');
  });

  it('takes the sole skill of a single-skill source', () => {
    const pick = pickReimportDir([{ name: 'whatever', dir: '/tmp/src/whatever' }], {
      localName: 'renamed-locally',
      frontmatterNameOf: noFrontmatter,
    });
    expect(pick?.name).toBe('whatever');
  });

  it('declines rather than guessing in a multi-skill source', () => {
    expect(
      pickReimportDir(dirs, { localName: 'absent', frontmatterNameOf: noFrontmatter }),
    ).toBeUndefined();
  });
});

describe('planReimportDiff', () => {
  const entry = (over: Partial<SkillLockEntry>): SkillLockEntry => ({
    source: 'owner/repo',
    contentHash: 'upstream-1',
    importedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('is up to date when the upstream hash matches and nothing was dropped', () => {
    const plan = planReimportDiff({
      upstreamHash: 'upstream-1',
      upstreamFiles: ['references/a.md'],
      entry: entry({ files: ['references/a.md'] }),
      local: { contentHash: 'local-1', files: ['references/a.md'] },
    });
    expect(plan).toEqual({ upToDate: true, removedUpstream: [] });
  });

  it('is NOT up to date when the hash matches but upstream dropped a file', () => {
    const plan = planReimportDiff({
      upstreamHash: 'upstream-1',
      upstreamFiles: [],
      entry: entry({ files: ['references/gone.md'] }),
      local: { contentHash: 'local-1', files: ['references/gone.md'] },
    });
    expect(plan).toEqual({ upToDate: false, removedUpstream: ['references/gone.md'] });
  });

  it('prunes only files the recorded manifest says upstream owned', () => {
    const plan = planReimportDiff({
      upstreamHash: 'upstream-2',
      upstreamFiles: ['references/a.md'],
      entry: entry({ files: ['references/a.md', 'references/gone.md'] }),
      local: {
        contentHash: 'local-1',
        files: ['references/a.md', 'references/gone.md', 'my-own-notes.md'],
      },
    });
    expect(plan.removedUpstream).toEqual(['references/gone.md']);
  });

  it('ignores a recorded file that is already off disk', () => {
    const plan = planReimportDiff({
      upstreamHash: 'upstream-2',
      upstreamFiles: [],
      entry: entry({ files: ['references/gone.md'] }),
      local: { contentHash: 'local-1', files: [] },
    });
    expect(plan).toEqual({ upToDate: false, removedUpstream: [] });
  });

  it('treats the whole clean bundle as upstream-owned for a legacy entry', () => {
    const plan = planReimportDiff({
      upstreamHash: 'upstream-2',
      upstreamFiles: [],
      entry: entry({ localHash: 'local-1' }),
      local: { contentHash: 'local-1', files: ['references/legacy.md'] },
    });
    expect(plan.removedUpstream).toEqual(['references/legacy.md']);
  });

  it('infers no ownership for a legacy entry once local bytes diverged', () => {
    const plan = planReimportDiff({
      upstreamHash: 'upstream-2',
      upstreamFiles: [],
      entry: entry({ localHash: 'local-1' }),
      local: { contentHash: 'local-EDITED', files: ['references/maybe-mine.md'] },
    });
    expect(plan.removedUpstream).toEqual([]);
  });

  it('infers no ownership for a legacy entry with no baseline at all', () => {
    const plan = planReimportDiff({
      upstreamHash: 'upstream-2',
      upstreamFiles: [],
      entry: entry({}),
      local: { contentHash: 'local-1', files: ['references/maybe-mine.md'] },
    });
    expect(plan.removedUpstream).toEqual([]);
  });
});

describe('groupReimportNamesBySource', () => {
  const lock: Record<string, SkillLockEntry> = {
    one: { source: 'inkeep/open-knowledge-skills', contentHash: 'a', importedAt: 'x' },
    two: { source: 'inkeep/open-knowledge-skills', contentHash: 'b', importedAt: 'x' },
    other: { source: 'mattpocock/skills', contentHash: 'c', importedAt: 'x' },
  };
  const entryFor = (name: string) => lock[name] ?? null;

  it('collapses one source to a single clone', () => {
    const grouped = groupReimportNamesBySource(['one', 'two'], entryFor);
    expect(grouped.bySource).toEqual([
      { source: 'inkeep/open-knowledge-skills', names: ['one', 'two'] },
    ]);
    expect(grouped.unrecorded).toEqual([]);
  });

  it('keeps distinct sources apart so neither is fetched from the wrong repo', () => {
    const grouped = groupReimportNamesBySource(['one', 'other', 'two'], entryFor);
    expect(grouped.bySource).toEqual([
      { source: 'inkeep/open-knowledge-skills', names: ['one', 'two'] },
      { source: 'mattpocock/skills', names: ['other'] },
    ]);
  });

  it('reports names with no recorded upstream instead of fetching for them', () => {
    const grouped = groupReimportNamesBySource(['one', 'authored-here'], entryFor);
    expect(grouped.unrecorded).toEqual(['authored-here']);
    expect(grouped.bySource).toEqual([{ source: 'inkeep/open-knowledge-skills', names: ['one'] }]);
  });

  it('de-duplicates a repeated name', () => {
    const grouped = groupReimportNamesBySource(['one', 'one'], entryFor);
    expect(grouped.bySource).toEqual([{ source: 'inkeep/open-knowledge-skills', names: ['one'] }]);
  });
});
