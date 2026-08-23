import type { CatalogSkill, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import {
  buildSkillsTreePaths,
  detectedId,
  EMPTY_SCOPE_SENTINEL,
  isSkillDocActive,
  type SkillsTreePathsInput,
  sanitizePathSegment,
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

// ── provenance grouping (appearance.sidebar.showSkillGroups) ──────────────────────

const OKS = 'inkeep/open-knowledge-skills';
const PLUGIN_DIR = '/home/u/.claude/plugins/cache/mkt/eng/4.0.0/skills/pr';

function imported(name: string, source: string, over: Partial<SkillsListEntry> = {}) {
  return skill({ name, origin: { source, importedAt: 'now' }, ...over } as never);
}

function pluginDetected(name: string, plugin: string, scope: 'project' | 'user' = 'project') {
  return {
    name,
    provenance: { scope, plugin },
    files: { skillMd: `/x/${name}/SKILL.md` },
  } as CatalogSkill;
}

describe('same repo TAIL from different owners never merges', () => {
  it('anthropics/skills and mattpocock/skills form two distinct, owner-labeled groups', () => {
    // The group id is the repo TAIL, so without the publisher in the identity
    // (and, on collision, in the visible segment) two unrelated grab-bag repos
    // merged into one folder ambiguously named "skills".
    const r = build({
      skills: [
        imported('frontend-design', 'anthropics/skills'),
        imported('brand-guidelines', 'anthropics/skills'),
        imported('tdd', 'mattpocock/skills'),
        imported('evals', 'mattpocock/skills'),
      ],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/anthropics/frontend-design/SKILL.md');
    expect(r.paths).toContain('PROJECT/mattpocock/tdd/SKILL.md');
    expect(r.groupByPrefix.get('PROJECT/anthropics')?.publisher).toBe('anthropics');
    expect(r.groupByPrefix.get('PROJECT/mattpocock')?.publisher).toBe('mattpocock');
    expect(r.groupByPrefix.has('PROJECT/skills')).toBe(false);
  });

  it('a generic tail labels by owner even uncontested — the label never flips later', () => {
    // "skills" is the conventional repo name, so the owner IS the identity;
    // labeling by tail would also RENAME the folder the day a second owner's
    // skills repo arrives.
    const r = build({
      skills: [imported('a', 'anthropics/skills'), imported('b', 'anthropics/skills')],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/anthropics/a/SKILL.md');
    expect(r.groupByPrefix.get('PROJECT/anthropics')?.publisher).toBe('anthropics');
  });
});

describe('two-level provenance nesting (repo parent over pack/plugin child)', () => {
  const packed = (name: string, pack: string) => imported(name, OKS, { pack } as never);

  it('two packs from one repo nest: repo parent, pack children, skills inside', () => {
    const r = build({
      skills: [
        packed('a', 'alpha'),
        packed('b', 'alpha'),
        packed('c', 'beta'),
        packed('d', 'beta'),
      ],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/alpha/a/SKILL.md');
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/beta/c/SKILL.md');
    expect(r.groupByPrefix.get('PROJECT/open-knowledge-skills')?.kind).toBe('source');
    expect(r.groupByPrefix.get('PROJECT/open-knowledge-skills/alpha')?.kind).toBe('plugin');
    expect(r.skillByPrefix.get('PROJECT/open-knowledge-skills/alpha/a')?.name).toBe('a');
  });

  it('a pack plus a loose import from the same repo: pack nests, loose sits under the parent', () => {
    const r = build({
      skills: [packed('a', 'alpha'), packed('b', 'alpha'), imported('loose', OKS)],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/alpha/a/SKILL.md');
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/loose/SKILL.md');
    expect(r.skillByPrefix.get('PROJECT/open-knowledge-skills/loose')?.name).toBe('loose');
  });

  it('a one-skill pack beside a loose repo sibling nests the full hierarchy', () => {
    // The seeded-starter-pack shape: the pack ships one skill and the platform
    // skill shares the repo. The pack is a plugin identity, so it earns its
    // cube even with one member, and the repo parent holds cube + loose row.
    const r = build({
      skills: [packed('note-taking', 'plain-notes'), imported('open-knowledge', OKS)],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/plain-notes/note-taking/SKILL.md');
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/open-knowledge/SKILL.md');
    expect(r.groupByPrefix.get('PROJECT/open-knowledge-skills')?.kind).toBe('source');
    expect(r.groupByPrefix.get('PROJECT/open-knowledge-skills/plain-notes')?.kind).toBe('plugin');
  });

  it('a single pack with no repo siblings collapses the parent away', () => {
    // A parent of one row is noise — the pack group renders alone at scope
    // level, exactly as a group of one collapses to a flat skill.
    const r = build({
      skills: [packed('a', 'alpha'), packed('b', 'alpha')],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/alpha/a/SKILL.md');
    expect(r.groupByPrefix.has('PROJECT/open-knowledge-skills')).toBe(false);
    expect(r.groupByPrefix.get('PROJECT/alpha')?.kind).toBe('plugin');
  });

  it('detected plugins from one marketplace nest under it', () => {
    const mkt = (name: string, plugin: string) =>
      ({
        name,
        provenance: { scope: 'project', plugin, marketplace: 'team' },
        files: { skillMd: `/x/${name}/SKILL.md` },
      }) as CatalogSkill;
    const r = build({
      detected: [mkt('pr', 'eng'), mkt('review', 'eng'), mkt('ship', 'gtm'), mkt('brief', 'gtm')],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/team/eng/pr/SKILL.md');
    expect(r.paths).toContain('PROJECT/team/gtm/ship/SKILL.md');
    expect(r.groupByPrefix.get('PROJECT/team')?.kind).toBe('source');
    expect(r.detectedByPrefix.get('PROJECT/team/eng/pr')?.name).toBe('pr');
  });

  it('one marketplace never splits when only some populations know its owner', () => {
    // A detected plugin carries the marketplace repo URL (owner derivable);
    // a skill copied out of the plugin cache does not. Unknown is not an
    // owner — the URL-less population adopts the single known one, or the
    // marketplace renders as (?) and (inkeep) twin folders.
    const mkt = (name: string, plugin: string) =>
      ({
        name,
        provenance: {
          scope: 'project',
          plugin,
          marketplace: 'inkeep-team-skills',
          repositoryUrl: 'https://github.com/inkeep/team-skills',
        },
        files: { skillMd: `/x/${name}/SKILL.md` },
      }) as CatalogSkill;
    const r = build({
      skills: [
        imported(
          'codie',
          '/Users/x/.claude/plugins/cache/inkeep-team-skills/applied-ai/1.0/skills/codie',
        ),
      ],
      detected: [mkt('pr', 'eng'), mkt('review', 'eng'), mkt('ship', 'gtm'), mkt('brief', 'gtm')],
      showSkillGroups: true,
    });
    const parents = [...r.groupByPrefix.keys()].filter((k) => k.split('/').length === 2);
    expect(parents).toEqual(['PROJECT/inkeep-team-skills']);
    expect(r.paths).toContain('PROJECT/inkeep-team-skills/applied-ai/codie/SKILL.md');
    expect(r.paths).toContain('PROJECT/inkeep-team-skills/eng/pr/SKILL.md');
  });

  it('a bare-URL import never adopts the owner of a same-tail repo', () => {
    // Only the marketplace registry key proves sameness. A URL whose tail
    // happens to be "skills" is NOT provably anthropics/skills — labeling it
    // "anthropics" would silently file corp skills under a stranger.
    const r = build({
      skills: [
        imported('frontend-design', 'anthropics/skills'),
        imported('brand-guidelines', 'anthropics/skills'),
        imported('corp-a', 'https://git.corp.example/skills.git'),
        imported('corp-b', 'https://git.corp.example/skills.git'),
      ],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/anthropics/frontend-design/SKILL.md');
    expect(r.paths).toContain('PROJECT/skills/corp-a/SKILL.md');
    expect(r.groupByPrefix.get('PROJECT/anthropics')?.publisher).toBe('anthropics');
    expect(r.groupByPrefix.get('PROJECT/skills')?.publisher).toBe(null);
  });
});

describe('grouping is opt-in', () => {
  it('is off by default, so the tree is byte-identical to the flat one', () => {
    const skills = [imported('a', OKS), imported('b', OKS)];
    expect(build({ skills }).paths).toEqual(build({ skills, showSkillGroups: false }).paths);
  });

  it('emits no group rows when nothing has provenance', () => {
    const r = build({ skills: [skill({ name: 'mine' })], showSkillGroups: true });
    expect(r.groupByPrefix.size).toBe(0);
    expect(r.paths).toContain('PROJECT/mine/SKILL.md');
  });
});

describe('bucket size decides the shape', () => {
  it('groups a source contributing two or more to a scope', () => {
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS)],
      showSkillGroups: true,
    });
    expect([...r.groupByPrefix.keys()]).toEqual(['PROJECT/open-knowledge-skills']);
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/a/SKILL.md');
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/b/SKILL.md');
  });

  it('flattens a bucket of one onto the skill row — no group row', () => {
    const r = build({ skills: [imported('lonely', OKS)], showSkillGroups: true });
    expect(r.groupByPrefix.size).toBe(0);
    expect(r.paths).toContain('PROJECT/lonely/SKILL.md');
  });

  it('counts per scope, so one source can group in PROJECT and flatten in GLOBAL', () => {
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS), imported('c', OKS, { scope: 'global' })],
      showSkillGroups: true,
    });
    expect([...r.groupByPrefix.keys()]).toEqual(['PROJECT/open-knowledge-skills']);
    expect(r.paths).toContain('GLOBAL/c/SKILL.md');
  });
});

describe('built-ins are not a population', () => {
  it('buckets under their source beside ordinary imports from it', () => {
    // Verified against a real `~/.ok/skills-lock.json`: the global built-ins
    // carry `inkeep/open-knowledge-skills`, so nothing special-cases them here.
    const r = build({
      skills: [
        imported('open-knowledge-discovery', OKS, { scope: 'global' }),
        imported('open-knowledge-write-skill', OKS, { scope: 'global' }),
      ],
      showSkillGroups: true,
    });
    expect([...r.groupByPrefix.keys()]).toEqual(['GLOBAL/open-knowledge-skills']);
    expect(r.paths).toContain('GLOBAL/open-knowledge-skills/open-knowledge-discovery/SKILL.md');
  });
});

describe('plugins', () => {
  it('groups detected plugin residents by their plugin', () => {
    const r = build({
      detected: [pluginDetected('pr', 'eng'), pluginDetected('review', 'eng')],
      showSkillGroups: true,
    });
    expect([...r.groupByPrefix.keys()]).toEqual(['PROJECT/eng']);
    expect(r.paths).toContain('PROJECT/eng/pr/SKILL.md');
  });

  it('counts a copied-out plugin skill WITH its still-detected siblings', () => {
    // The copy is managed while the siblings are detected. Counting the halves
    // separately would strand it in a group of one beside the group it belongs to.
    const r = build({
      skills: [imported('pr', PLUGIN_DIR)],
      detected: [pluginDetected('review', 'eng')],
      showSkillGroups: true,
    });
    expect([...r.groupByPrefix.keys()]).toEqual(['PROJECT/eng']);
    expect(r.paths).toContain('PROJECT/eng/pr/SKILL.md');
    expect(r.paths).toContain('PROJECT/eng/review/SKILL.md');
  });

  it('keeps a resident visible when the user has ALSO copied it out', () => {
    // The copy is a separate file, so both are real rows — the resident belongs
    // to the group (which promises to list what the plugin ships) and the copy
    // sits wherever its own provenance puts it. Suppressing by name hid the
    // resident and left the group short of the skills it actually carries.
    const r = build({
      skills: [imported('pr', PLUGIN_DIR)],
      detected: [pluginDetected('pr', 'eng'), pluginDetected('review', 'eng')],
      showSkillGroups: true,
    });
    expect(r.paths).toContain('PROJECT/eng/pr/SKILL.md');
    expect(r.paths).toContain('PROJECT/eng/review/SKILL.md');
    // The copy holds the plain segment; the resident takes the qualified one.
    // Redundant-looking inside a group already named for the plugin, and kept
    // that way deliberately: the alternative is a new translated word in the
    // path, and the plugin name is already the right answer at scope level.
    expect([...r.detectedByPrefix.keys()]).toContain('PROJECT/eng/pr (eng)');
  });

  it('a lone plugin resident still groups under its plugin cube', () => {
    // A plugin is an installable identity, so even one resident earns the
    // cube — and nesting is what disambiguates it from the same-named copy
    // beside it, with no name-mangling needed.
    const r = build({
      skills: [skill({ name: 'pr' })],
      detected: [pluginDetected('pr', 'eng')],
      showSkillGroups: true,
    });
    expect([...r.skillByPrefix.keys()]).toEqual(['PROJECT/pr']);
    expect([...r.detectedByPrefix.keys()]).toEqual(['PROJECT/eng/pr']);
    expect(r.groupByPrefix.get('PROJECT/eng')?.kind).toBe('plugin');
  });

  it('still drops a NON-plugin detection of a managed skill', () => {
    // Unchanged: that one really is OK's own file seen through its symlink.
    const r = build({ skills: [skill({ name: 'dup' })], detected: [detectedSkill('dup')] });
    expect(r.detectedByPrefix.size).toBe(0);
  });

  it('off Claude there is no plugin provenance, so nothing groups', () => {
    const r = build({
      detected: [detectedSkill('a', 'project'), detectedSkill('b', 'project')],
      showSkillGroups: true,
    });
    expect(r.groupByPrefix.size).toBe(0);
  });
});

describe('grouped rows stay navigable', () => {
  it('expands the group folder on the way to the active skill', () => {
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS)],
      showSkillGroups: true,
      isSkillMdActive: (s) => s.name === 'a',
    });
    expect(r.activePath).toBe('PROJECT/open-knowledge-skills/a/SKILL.md');
    expect(r.expanded).toEqual(
      expect.arrayContaining(['PROJECT/', 'PROJECT/open-knowledge-skills/']),
    );
  });

  it('keys skillByPrefix on the grouped path so row lookup still resolves', () => {
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS)],
      showSkillGroups: true,
    });
    expect(r.skillByPrefix.get('PROJECT/open-knowledge-skills/a')?.name).toBe('a');
  });
});

describe('group ids and skill names share a level', () => {
  it('does not form a group whose id collides with a sibling skill segment', () => {
    // Both are folder rows at the same depth, so one prefix would serve two rows
    // and the lookups would resolve to whichever map is consulted first. Renaming
    // either side is worse than not grouping — the group id is the publisher name
    // a user recognises, the skill segment is what it installs as — so the bucket
    // stays flat and degrades to the pre-grouping tree.
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS), skill({ name: 'open-knowledge-skills' })],
      showSkillGroups: true,
    });
    expect(r.groupByPrefix.size).toBe(0);
    expect(r.paths).toContain('PROJECT/a/SKILL.md');
    expect(r.paths).toContain('PROJECT/b/SKILL.md');
    expect(r.skillByPrefix.get('PROJECT/open-knowledge-skills')?.name).toBe(
      'open-knowledge-skills',
    );
  });

  it('still groups when no skill segment claims the id', () => {
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS)],
      showSkillGroups: true,
    });
    expect([...r.groupByPrefix.keys()]).toEqual(['PROJECT/open-knowledge-skills']);
  });

  it('groups a plugin named after one of its OWN skills', () => {
    // The common shape, not a corner case: a plugin ships a flagship skill under
    // its own name plus variants. That member nests INSIDE the group, so it can
    // never share a level with the group row — counting it as a collision made
    // every such plugin refuse to group and render as a flat run of siblings.
    const r = build({
      detected: [
        pluginDetected('ponytail', 'ponytail', 'user'),
        pluginDetected('ponytail-audit', 'ponytail', 'user'),
        pluginDetected('ponytail-debt', 'ponytail', 'user'),
      ],
      showSkillGroups: true,
    });
    expect([...r.groupByPrefix.keys()]).toEqual(['GLOBAL/ponytail']);
    expect(r.paths).toContain('GLOBAL/ponytail/ponytail/SKILL.md');
    expect(r.paths).toContain('GLOBAL/ponytail/ponytail-audit/SKILL.md');
    // The flagship is a MEMBER, not a second row beside the group.
    expect(r.detectedByPrefix.get('GLOBAL/ponytail')).toBeUndefined();
  });

  it('still refuses when the colliding skill is OUTSIDE the bucket', () => {
    // Same id, but the claimant does not nest under the group — it would sit
    // beside it at scope level, which is the collision the guard exists for.
    const r = build({
      skills: [skill({ name: 'ponytail', scope: 'global' })],
      detected: [
        pluginDetected('ponytail-audit', 'ponytail', 'user'),
        pluginDetected('ponytail-debt', 'ponytail', 'user'),
      ],
      showSkillGroups: true,
    });
    expect(r.groupByPrefix.size).toBe(0);
    expect(r.paths).toContain('GLOBAL/ponytail-audit/SKILL.md');
  });
});

describe('pinned skills', () => {
  const pins = (project: string[] = [], global_: string[] = []) => ({
    project: new Set(project),
    global: new Set(global_),
  });

  it('a GROUPED pinned skill keeps its group row AND floats a marked twin', () => {
    // The group's promise (list everything from its source) survives the pin;
    // the floated twin at scope level is the shortcut, and it carries the mark.
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS), skill({ name: 'mine' })],
      showSkillGroups: true,
      pinnedByScope: pins(['a']),
    });
    expect(r.paths).toContain('PROJECT/a/SKILL.md');
    expect(r.paths).toContain('PROJECT/open-knowledge-skills/a/SKILL.md');
    expect(r.pinnedPrefixes.has('PROJECT/a')).toBe(true);
    expect(r.pinnedPrefixes.has('PROJECT/open-knowledge-skills/a')).toBe(false);
  });

  it('an ungrouped pinned skill keeps its row, marked', () => {
    const r = build({ skills: [skill({ name: 'mine' })], pinnedByScope: pins(['mine']) });
    expect(r.paths).toContain('PROJECT/mine/SKILL.md');
    expect(r.pinnedPrefixes.has('PROJECT/mine')).toBe(true);
  });

  it('its bundle files stay under the row', () => {
    const r = build({
      skills: [skill({ name: 'mine' })],
      filesByKey: { 'project:mine': [{ path: 'references/x.md' }] },
      pinnedByScope: pins(['mine']),
    });
    expect(r.paths).toContain('PROJECT/mine/references/x.md');
  });

  it('both rows resolve to the same skill so either opens it', () => {
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS)],
      showSkillGroups: true,
      pinnedByScope: pins(['a']),
    });
    expect(r.skillByPrefix.get('PROJECT/a')?.name).toBe('a');
    expect(r.skillByPrefix.get('PROJECT/open-knowledge-skills/a')?.name).toBe('a');
  });

  it('a pinned DETECTED plugin resident keeps its group row and floats a twin too', () => {
    const r = build({
      detected: [pluginDetected('pr', 'eng'), pluginDetected('review', 'eng')],
      showSkillGroups: true,
      pinnedByScope: pins(['pr']),
    });
    expect(r.paths).toContain('PROJECT/pr/SKILL.md');
    expect(r.paths).toContain('PROJECT/eng/pr/SKILL.md');
    expect(r.pinnedPrefixes.has('PROJECT/pr')).toBe(true);
    // The sibling stays in the intact group.
    expect(r.paths).toContain('PROJECT/eng/review/SKILL.md');
  });

  it('the active highlight lands on the pinned row', () => {
    const r = build({
      skills: [skill({ name: 'mine' })],
      pinnedByScope: pins(['mine']),
      isSkillMdActive: () => true,
    });
    expect(r.activePath).toBe('PROJECT/mine/SKILL.md');
  });

  it('a DETECTED pinned skill carries its loaded bundle files', () => {
    const d = detectedSkill('found');
    const r = build({
      detected: [d],
      detectedFilesById: { [detectedId(d)]: ['references/x.md'] },
      pinnedByScope: pins([], ['found']),
    });
    expect(r.paths).toContain('GLOBAL/found/SKILL.md');
    expect(r.paths).toContain('GLOBAL/found/references/x.md');
    expect(r.pinnedPrefixes.has('GLOBAL/found')).toBe(true);
  });

  it('no pins → no pinned prefixes', () => {
    const r = build({ skills: [skill({ name: 'mine' })] });
    expect(r.pinnedPrefixes.size).toBe(0);
  });
});

describe('restoring hand-expanded folders across a remount', () => {
  it('accepts a GROUP prefix the user opened', () => {
    // Group rows are real folder rows, so Pierre records them in `userExpanded`.
    // If the valid-path set left them out they would silently re-collapse on the
    // next remount — and a detected skill lazy-loading its files causes one.
    const r = build({
      skills: [imported('a', OKS), imported('b', OKS)],
      showSkillGroups: true,
      userExpanded: new Set(['PROJECT/open-knowledge-skills/']),
    });
    expect(r.expanded).toContain('PROJECT/open-knowledge-skills/');
  });

  it('ignores a stale prefix that no longer names anything', () => {
    // The group's members were uninstalled, so its row is gone. Restoring it
    // would expand a folder the tree does not have.
    const r = build({
      skills: [skill({ name: 'mine' })],
      userExpanded: new Set(['PROJECT/open-knowledge-skills/']),
    });
    expect(r.expanded).not.toContain('PROJECT/open-knowledge-skills/');
  });
});

describe('sanitizePathSegment', () => {
  it('strips both separators and both quote kinds from a hostile label', () => {
    // `/` and `\\` would split the segment into fake tree levels; quotes would
    // break out of the CSS selector the segment is interpolated into.
    expect(sanitizePathSegment('a/b\\c\'d"e', 'fb')).toBe('a b cde');
  });

  it('falls back when nothing printable survives', () => {
    expect(sanitizePathSegment('"\'', 'fb')).toBe('fb');
  });
});
