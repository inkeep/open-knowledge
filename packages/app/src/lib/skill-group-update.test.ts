import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { groupDeletableSkills, groupUpdatableSkills } from './skill-group-update';
import type { ProvenanceBucket } from './skill-provenance-bucket';

function skill(name: string, source?: string): SkillsListEntry {
  return {
    name,
    scope: 'project',
    hosts: [],
    installed: false,
    path: name,
    ...(source ? { origin: { source, importedAt: 'now' } } : {}),
  } as SkillsListEntry;
}

const sourceBucket: ProvenanceBucket = {
  kind: 'source',
  id: 'open-knowledge-skills',
  publisher: 'inkeep',
  url: 'https://www.skills.sh/inkeep/open-knowledge-skills',
};
const pluginBucket: ProvenanceBucket = {
  kind: 'plugin',
  id: 'eng',
  publisher: null,
  url: 'https://github.com/inkeep/team-skills',
};

const GROUP = 'PROJECT/open-knowledge-skills';

describe('groupUpdatableSkills', () => {
  it('returns the group members that record a fetchable source', () => {
    const map = new Map([
      [`${GROUP}/a`, skill('a', 'inkeep/open-knowledge-skills')],
      [`${GROUP}/b`, skill('b', 'inkeep/open-knowledge-skills')],
    ]);
    const members = groupUpdatableSkills({
      groupPrefix: GROUP,
      bucket: sourceBucket,
      skillByPrefix: map,
    });
    expect(members.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('declines a PLUGIN group outright', () => {
    const map = new Map([['PROJECT/eng/x', skill('x', 'inkeep/team-skills')]]);
    expect(
      groupUpdatableSkills({
        groupPrefix: 'PROJECT/eng',
        bucket: pluginBucket,
        skillByPrefix: map,
      }),
    ).toEqual([]);
  });

  it('declines when the bucket is unknown', () => {
    const map = new Map([[`${GROUP}/a`, skill('a', 'inkeep/open-knowledge-skills')]]);
    expect(
      groupUpdatableSkills({ groupPrefix: GROUP, bucket: undefined, skillByPrefix: map }),
    ).toEqual([]);
  });

  it('skips a member with no recorded source, and one adopted from a harness', () => {
    const map = new Map([
      [`${GROUP}/a`, skill('a', 'inkeep/open-knowledge-skills')],
      [`${GROUP}/hand-written`, skill('hand-written')],
      [`${GROUP}/adopted`, skill('adopted', 'adopt:cursor')],
    ]);
    const members = groupUpdatableSkills({
      groupPrefix: GROUP,
      bucket: sourceBucket,
      skillByPrefix: map,
    });
    expect(members.map((s) => s.name)).toEqual(['a']);
  });

  it('ignores rows outside the group, including a prefix that merely starts the same', () => {
    const map = new Map([
      [`${GROUP}/a`, skill('a', 'inkeep/open-knowledge-skills')],
      ['PROJECT/open-knowledge-skills-extra/b', skill('b', 'someone/else')],
      ['PROJECT/loose', skill('loose', 'someone/else')],
    ]);
    const members = groupUpdatableSkills({
      groupPrefix: GROUP,
      bucket: sourceBucket,
      skillByPrefix: map,
    });
    expect(members.map((s) => s.name)).toEqual(['a']);
  });

  it('returns empty for a group whose members are all unfetchable', () => {
    const map = new Map([[`${GROUP}/adopted`, skill('adopted', 'adopt:claude')]]);
    expect(
      groupUpdatableSkills({ groupPrefix: GROUP, bucket: sourceBucket, skillByPrefix: map }),
    ).toEqual([]);
  });
});

describe('groupDeletableSkills', () => {
  it('includes every non-managed member, recorded source or not', () => {
    const map = new Map([
      [`${GROUP}/a`, skill('a', 'inkeep/open-knowledge-skills')],
      [`${GROUP}/b`, skill('b')],
      [`${GROUP}/c`, skill('c', 'adopt:claude')],
    ]);
    const members = groupDeletableSkills({
      groupPrefix: GROUP,
      bucket: sourceBucket,
      skillByPrefix: map,
    });
    expect(members.map((m) => m.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('excludes managed built-ins', () => {
    const managed = { ...skill('builtin'), managed: true } as SkillsListEntry;
    const map = new Map([
      [`${GROUP}/builtin`, managed],
      [`${GROUP}/plain`, skill('plain')],
    ]);
    const members = groupDeletableSkills({
      groupPrefix: GROUP,
      bucket: sourceBucket,
      skillByPrefix: map,
    });
    expect(members.map((m) => m.name)).toEqual(['plain']);
  });

  it('offers nothing for a harness plugin group — its members are vendor state', () => {
    const map = new Map([[`${GROUP}/a`, skill('a', 'inkeep/team-skills')]]);
    const members = groupDeletableSkills({
      groupPrefix: GROUP,
      bucket: pluginBucket,
      skillByPrefix: map,
    });
    expect(members).toEqual([]);
  });

  it('ignores rows outside the group prefix', () => {
    const map = new Map([
      [`${GROUP}/a`, skill('a')],
      ['PROJECT/other-group/b', skill('b')],
    ]);
    const members = groupDeletableSkills({
      groupPrefix: GROUP,
      bucket: sourceBucket,
      skillByPrefix: map,
    });
    expect(members.map((m) => m.name)).toEqual(['a']);
  });
});
