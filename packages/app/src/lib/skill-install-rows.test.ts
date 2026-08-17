import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { deriveSkillInstallRows, type SkillInstallMenuSkill } from './skill-install-rows';

/** A listed skill with only the fields the derivation reads set. */
function entry(over: Partial<SkillsListEntry> & Pick<SkillsListEntry, 'name'>): SkillsListEntry {
  return {
    scope: 'project',
    hosts: [],
    installed: false,
    path: `.claude/skills/${over.name}/SKILL.md`,
    ...over,
  } as SkillsListEntry;
}

function derive(
  skill: SkillInstallMenuSkill | undefined,
  opts: {
    allSkills?: readonly SkillsListEntry[] | null;
    hosts?: readonly string[];
    sourceHostOverlay?: string;
    linkMode?: boolean;
  } = {},
) {
  return deriveSkillInstallRows({
    skill,
    allSkills: opts.allSkills ?? null,
    hostSet: new Set(opts.hosts ?? skill?.hosts ?? []),
    sourceHostOverlay: opts.sourceHostOverlay,
    linkMode: opts.linkMode ?? false,
  });
}

const base: SkillInstallMenuSkill = {
  scope: 'project',
  name: 'trip-log',
  hosts: ['claude'],
  path: '.claude/skills/trip-log/SKILL.md',
};

describe('host rows', () => {
  it('offers every install editor and omits the hub until the project adopts it', () => {
    const rows = derive(base).rows;
    expect(rows).toContain('claude');
    expect(rows).not.toContain('agents');
  });

  it('activates the hub row when ANY same-scope skill lives under .agents/', () => {
    const withHub = derive(base, {
      allSkills: [entry({ name: 'other', path: '.agents/skills/other/SKILL.md' })],
    });
    expect(withHub.rows).toContain('agents');
    // The hub sorts LAST, under the concrete host rows: it is a vendor-neutral
    // fallback, not where most installs go.
    expect(withHub.rows.at(-1)).toBe('agents');
  });

  it('activates the hub row when the skill itself lists it as a host', () => {
    expect(derive({ ...base, hosts: ['agents'] }).rows).toContain('agents');
  });

  it('gives an alias-covered host NO row of its own', () => {
    // Checking it could only write through the alias, so the row would lie.
    const r = derive({ ...base, hostAliases: { cursor: '.claude/skills' } });
    expect(r.rows).not.toContain('cursor');
    expect(r.rows).toContain('claude');
  });

  it('hides editors that are not installable here, but never one the skill is in', () => {
    const r = derive({ ...base, hosts: ['codex'], installableEditors: ['claude'] });
    expect(r.rows).toContain('claude');
    expect(r.rows).toContain('codex');
    expect(r.rows).not.toContain('cursor');
  });

  it('offers everything when installability is unknown (never over-hide)', () => {
    expect(derive(base).rows.length).toBeGreaterThan(1);
  });
});

describe('source disclosure', () => {
  it('badges the host row when the skill lives in a standard editor dir', () => {
    const r = derive(base);
    expect(r.sourceRow).toBeNull();
    expect(r.sourceHost).toBe('claude');
  });

  it('gives a non-standard folder its own source row and NO host badge', () => {
    // Two source marks in one menu is the bug this split prevents.
    const r = derive({ ...base, path: '.ok/skills/trip-log/SKILL.md' });
    expect(r.sourceRow).toBe('.ok/skills/trip-log');
    expect(r.sourceHost).toBeUndefined();
  });

  it('prefers the optimistic overlay over the server host order', () => {
    expect(derive(base, { sourceHostOverlay: 'codex' }).sourceHost).toBe('codex');
  });

  it('skips a placeholder entry with no directory', () => {
    expect(derive({ ...base, path: 'SKILL.md' }).sourceRow).toBeNull();
  });

  it('prefixes global-scope paths with ~/', () => {
    const r = derive({ ...base, scope: 'global', path: '.ok/skills/trip-log/SKILL.md' });
    expect(r.sourceRow).toBe('~/.ok/skills/trip-log');
  });
});

describe('expectedMode', () => {
  it('falls back to the server preference when there is nothing to compare against', () => {
    expect(derive(base, { linkMode: true }).expectedMode).toBe('link');
    expect(derive(base, { linkMode: false }).expectedMode).toBe('copy');
  });

  it('takes the majority of the OTHER locations, ignoring the source', () => {
    // claude is the source; codex+cursor are copies, so a NEW location copies.
    const copies = derive({ ...base, hosts: ['claude', 'codex', 'cursor'] });
    expect(copies.expectedMode).toBe('copy');

    const links = derive({
      ...base,
      hosts: ['claude', 'codex', 'cursor'],
      symlinkedHosts: ['codex', 'cursor'],
    });
    expect(links.expectedMode).toBe('link');
  });

  it('breaks a tie toward link', () => {
    const r = derive({
      ...base,
      hosts: ['claude', 'codex', 'cursor'],
      symlinkedHosts: ['codex'],
    });
    expect(r.expectedMode).toBe('link');
  });

  it('ignores conflicted and alias-covered hosts in the vote', () => {
    // A conflicted slot holds a DIFFERENT skill, so its form is not evidence.
    const r = derive({
      ...base,
      hosts: ['claude', 'codex', 'cursor'],
      symlinkedHosts: ['codex'],
      conflictHosts: ['cursor'],
      linkMode: false,
    });
    expect(r.convertible.map((c) => c.target)).toEqual(['codex']);
    expect(r.expectedMode).toBe('link');
  });

  it('counts custom placements alongside host locations', () => {
    const r = derive({
      ...base,
      customPlacements: [
        { path: '.team/skills/trip-log', mode: 'link' },
        { path: '.vendor/skills/trip-log', mode: 'link' },
      ],
    } as SkillInstallMenuSkill);
    expect(r.expectedMode).toBe('link');
  });
});

describe('convertible locations', () => {
  it('never includes the source — it is the folder the others point at', () => {
    const r = derive({ ...base, hosts: ['claude', 'codex'] });
    expect(r.convertible.map((c) => c.target)).toEqual(['codex']);
  });

  it('reports each location with the form it is actually in', () => {
    const r = derive({ ...base, hosts: ['claude', 'codex'], symlinkedHosts: ['codex'] });
    expect(r.convertible[0]).toMatchObject({ target: 'codex', mode: 'link' });
    expect(r.convertible[0]?.display).toContain('codex');
  });
});

describe('custom root rows', () => {
  const placed: SkillInstallMenuSkill = {
    ...base,
    customPlacements: [{ path: '.team/skills/trip-log', mode: 'copy' }],
  } as SkillInstallMenuSkill;

  it('marks a root this skill is placed under as occupied', () => {
    const r = derive(placed);
    expect(r.customRootRows).toEqual([
      { root: '.team/skills', display: '.team/skills/trip-log', placed: expect.anything() },
    ]);
  });

  it('offers a root ANOTHER same-scope skill uses, unchecked', () => {
    const r = derive(base, {
      allSkills: [
        entry({ name: 'other', customPlacements: [{ path: '.team/skills/other', mode: 'copy' }] }),
      ],
    });
    expect(r.customRootRows).toEqual([
      { root: '.team/skills', display: '.team/skills/trip-log', placed: null },
    ]);
  });

  it('ignores custom roots from a DIFFERENT scope', () => {
    const r = derive(base, {
      allSkills: [
        entry({
          name: 'other',
          scope: 'global',
          customPlacements: [{ path: '.team/skills/other', mode: 'copy' }],
        }),
      ],
    });
    expect(r.customRootRows).toEqual([]);
  });

  it('drops a root that is alias-covered or already a host/source row', () => {
    const aliased = derive({ ...placed, hostAliases: { '.team/skills': '.claude/skills' } });
    expect(aliased.customRootRows).toEqual([]);

    const isSource = derive({
      ...placed,
      path: '.team/skills/trip-log/SKILL.md',
    });
    expect(isSource.customRootRows).toEqual([]);
  });
});

describe('no skill', () => {
  it('derives an empty, non-throwing shape', () => {
    const r = derive(undefined);
    expect(r.customRootRows).toEqual([]);
    expect(r.sourceRow).toBeNull();
    expect(r.pathFor('claude')).toBeNull();
  });
});
