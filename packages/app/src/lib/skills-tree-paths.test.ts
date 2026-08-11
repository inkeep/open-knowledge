import type { CatalogSkill, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import {
  buildSkillsTreePaths,
  detectedId,
  EMPTY_SCOPE_SENTINEL,
  isSkillDocActive,
  type SkillsTreePathsInput,
} from './skills-tree-paths';

const scopeLabel = { project: 'PROJECT', global: 'GLOBAL' } as const;

function skill(over: Partial<SkillsListEntry> & Pick<SkillsListEntry, 'name'>): SkillsListEntry {
  return { scope: 'project', hosts: [], installed: false, ...over } as SkillsListEntry;
}

function detectedSkill(name: string, scope: 'project' | 'user' = 'user'): CatalogSkill {
  return { name, provenance: { scope }, files: { skillMd: `/x/${name}/SKILL.md` } } as CatalogSkill;
}

function build(over: Partial<SkillsTreePathsInput> = {}) {
  return buildSkillsTreePaths({
    skills: [],
    detected: null,
    scopeLabel,
    filesByKey: {},
    detectedFilesById: {},
    userExpanded: new Set(),
    hostQualifierOf: () => undefined,
    rowKeyFor: (s) => `${s.scope}:${s.name}`,
    isSkillMdActive: () => false,
    isFileActive: () => false,
    isDetectedActive: () => false,
    ...over,
  });
}

describe('scope rows', () => {
  it('always emits both scope folders, expanded', () => {
    const r = build();
    expect(r.paths).toContain('PROJECT/');
    expect(r.paths).toContain('GLOBAL/');
    expect(r.expanded).toEqual(expect.arrayContaining(['PROJECT/', 'GLOBAL/']));
  });

  it('gives an EMPTY scope a sentinel child so its folder + Add menu survive', () => {
    // A childless directory is dropped from the visible tree, taking the scope
    // header (and its only entry point for creating a skill) with it.
    const r = build({ skills: [skill({ name: 'a' })] });
    expect(r.paths).toContain(`GLOBAL/${EMPTY_SCOPE_SENTINEL}`);
    expect(r.paths).not.toContain(`PROJECT/${EMPTY_SCOPE_SENTINEL}`);
  });

  it('drops the sentinel when only a DETECTED skill occupies the scope', () => {
    const r = build({ detected: [detectedSkill('found')] });
    expect(r.paths).not.toContain(`GLOBAL/${EMPTY_SCOPE_SENTINEL}`);
    expect(r.paths).toContain(`PROJECT/${EMPTY_SCOPE_SENTINEL}`);
  });
});

describe('segment disambiguation', () => {
  it('uses the stripped display name when it is unique', () => {
    const r = build({ skills: [skill({ name: 'open-knowledge-pack-trip-log' })] });
    expect([...r.skillByPrefix.keys()]).toEqual(['PROJECT/trip-log']);
  });

  it('falls back to the FULL name for two skills that strip to the same thing', () => {
    // A shared segment collapses both into one row and hides one outright.
    const r = build({
      skills: [skill({ name: 'trip-log' }), skill({ name: 'open-knowledge-pack-trip-log' })],
    });
    expect([...r.skillByPrefix.keys()].sort()).toEqual([
      'PROJECT/open-knowledge-pack-trip-log',
      'PROJECT/trip-log',
    ]);
  });

  it('falls back to the host dir when even the full names are identical', () => {
    const r = build({
      skills: [
        skill({ name: 'trip-log', hosts: ['claude'] }),
        skill({ name: 'trip-log', hosts: ['agents'] }),
      ],
      hostQualifierOf: (s) => s.hosts[0],
    });
    expect([...r.skillByPrefix.keys()].sort()).toEqual([
      'PROJECT/trip-log (.agents)',
      'PROJECT/trip-log (claude)',
    ]);
  });

  it('does not disambiguate ACROSS scopes — the label already separates them', () => {
    const r = build({
      skills: [skill({ name: 'trip-log' }), skill({ name: 'trip-log', scope: 'global' })],
    });
    expect([...r.skillByPrefix.keys()].sort()).toEqual(['GLOBAL/trip-log', 'PROJECT/trip-log']);
  });
});

describe('detected skills', () => {
  it('nests a detected skill under the scope its PROVENANCE names', () => {
    const r = build({ detected: [detectedSkill('found', 'project')] });
    expect([...r.detectedByPrefix.keys()]).toEqual(['PROJECT/found']);
  });

  it('skips one already managed — it is the same skill, seen through its symlink', () => {
    const r = build({ skills: [skill({ name: 'dup' })], detected: [detectedSkill('dup')] });
    expect(r.detectedByPrefix.size).toBe(0);
  });

  it('skips a managed skill detected at the OTHER scope', () => {
    const r = build({
      skills: [skill({ name: 'dup', scope: 'global' })],
      detected: [detectedSkill('dup', 'project')],
    });
    expect(r.detectedByPrefix.size).toBe(0);
  });

  it("skips OK's own product skills — managing them with OK is circular", () => {
    const r = build({ detected: [detectedSkill('open-knowledge')] });
    expect(r.detectedByPrefix.size).toBe(0);
  });

  it('adopts OK shipped PACK skills, which are fair game', () => {
    const r = build({ detected: [detectedSkill('open-knowledge-pack-notes')] });
    expect(r.detectedByPrefix.size).toBe(1);
  });

  it('falls back to the full name when the display name is already taken', () => {
    const r = build({
      skills: [skill({ name: 'notes', scope: 'global' })],
      detected: [detectedSkill('open-knowledge-pack-notes')],
    });
    expect([...r.detectedByPrefix.keys()]).toEqual(['GLOBAL/open-knowledge-pack-notes']);
  });

  it('drops a hard collision rather than stealing the row that got there first', () => {
    // Both tiers exhausted: the display name is taken and the full name IS the
    // display name, so there is no third spelling left to fall back to.
    const r = build({ detected: [detectedSkill('notes'), detectedSkill('notes')] });
    expect([...r.detectedByPrefix.keys()]).toEqual(['GLOBAL/notes']);
  });

  it('marks a detected skill active and expands its ancestors', () => {
    // The whole point of extracting this was testability; this branch drives the
    // sidebar highlight for an un-managed skill whose editable buffer is open.
    const r = build({
      detected: [detectedSkill('found')],
      isDetectedActive: (s) => s.name === 'found',
    });
    expect(r.activePath).toBe('GLOBAL/found/SKILL.md');
    expect(r.expanded).toContain('GLOBAL/found/');
    expect(r.expanded).toContain('GLOBAL/');
  });

  it('lets an active MANAGED skill win over an active detected one', () => {
    // Managed rows are emitted first and the detected branch is `!activePath`
    // guarded, so two actives must not fight over the highlight.
    const r = build({
      skills: [skill({ name: 'trip-log' })],
      detected: [detectedSkill('found')],
      isSkillMdActive: () => true,
      isDetectedActive: () => true,
    });
    expect(r.activePath).toBe('PROJECT/trip-log/SKILL.md');
  });

  it('nests a detected skill’s loaded bundle files and keeps it expanded', () => {
    const s = detectedSkill('found');
    const r = build({ detected: [s], detectedFilesById: { [detectedId(s)]: ['references/x.md'] } });
    expect(r.paths).toContain('GLOBAL/found/references/x.md');
    expect(r.expanded).toContain('GLOBAL/found/');
  });
});

describe('bundle files and active row', () => {
  it('nests a managed skill’s bundle files under it', () => {
    const s = skill({ name: 'trip-log' });
    const r = build({
      skills: [s],
      filesByKey: { 'project:trip-log': [{ path: 'scripts/go.sh' }] },
    });
    expect(r.paths).toContain('PROJECT/trip-log/scripts/go.sh');
  });

  it('marks SKILL.md active and expands its ancestors', () => {
    const r = build({ skills: [skill({ name: 'trip-log' })], isSkillMdActive: () => true });
    expect(r.activePath).toBe('PROJECT/trip-log/SKILL.md');
    expect(r.expanded).toContain('PROJECT/trip-log/');
  });

  it('lets SKILL.md win over a bundle file, never both', () => {
    const r = build({
      skills: [skill({ name: 'trip-log' })],
      filesByKey: { 'project:trip-log': [{ path: 'references/x.md' }] },
      isSkillMdActive: () => true,
      isFileActive: () => true,
    });
    expect(r.activePath).toBe('PROJECT/trip-log/SKILL.md');
  });

  it('marks a bundle file active when SKILL.md is not', () => {
    const r = build({
      skills: [skill({ name: 'trip-log' })],
      filesByKey: { 'project:trip-log': [{ path: 'references/x.md' }] },
      isFileActive: (_s, f) => f === 'references/x.md',
    });
    expect(r.activePath).toBe('PROJECT/trip-log/references/x.md');
  });
});

describe('user-expanded restore', () => {
  it('restores folders the user opened by hand', () => {
    const r = build({
      skills: [skill({ name: 'trip-log' })],
      userExpanded: new Set(['PROJECT/trip-log/']),
    });
    expect(r.expanded).toContain('PROJECT/trip-log/');
  });

  it('drops a remembered path that no longer names a real folder', () => {
    // A renamed/deleted skill leaves a stale entry; re-expanding it would
    // resurrect a row that is not in the tree.
    const r = build({ userExpanded: new Set(['PROJECT/gone/']) });
    expect(r.expanded).not.toContain('PROJECT/gone/');
  });
});

describe('isSkillDocActive', () => {
  const docName = '.claude/skills/demo/SKILL';

  it('is active when a real open tab backs it', () => {
    expect(
      isSkillDocActive({
        activeTargetKind: 'doc',
        activeDocName: docName,
        openTabs: [docName],
        docName,
      }),
    ).toBe(true);
  });

  it('is NOT active when the name matches but no tab is open', () => {
    // The retry case: an open that never landed leaves `activeDocName` pointing
    // at a doc with no tab. Reading that as active makes the row highlighted and
    // the tree's click guard swallow the click that would open it.
    expect(
      isSkillDocActive({
        activeTargetKind: 'doc',
        activeDocName: docName,
        openTabs: [],
        docName,
      }),
    ).toBe(false);
  });

  it('is NOT active while a non-doc target owns the surface', () => {
    // A skill-file viewer or preview carries no docName, so `activeDocName`
    // stays stale on the last doc tab — often this very skill.
    expect(
      isSkillDocActive({
        activeTargetKind: 'skill-preview',
        activeDocName: docName,
        openTabs: [docName],
        docName,
      }),
    ).toBe(false);
  });

  it('is NOT active for a different skill', () => {
    expect(
      isSkillDocActive({
        activeTargetKind: 'doc',
        activeDocName: '.claude/skills/other/SKILL',
        openTabs: ['.claude/skills/other/SKILL'],
        docName,
      }),
    ).toBe(false);
  });
});
