import { describe, expect, it } from 'vitest';
import type { SkillProvenance } from './schema.ts';
import { catalogRawScopeToOkScope, isDetectedSkillInProject } from './scope.ts';

describe('catalogRawScopeToOkScope', () => {
  it('maps Claude project-bound scopes to project', () => {
    expect(catalogRawScopeToOkScope('project')).toBe('project');
    expect(catalogRawScopeToOkScope('local')).toBe('project');
  });

  it('maps user-global / unknown / absent scopes to global', () => {
    expect(catalogRawScopeToOkScope('user')).toBe('global');
    expect(catalogRawScopeToOkScope('something-else')).toBe('global');
    expect(catalogRawScopeToOkScope(undefined)).toBe('global');
  });
});

describe('isDetectedSkillInProject', () => {
  const prov = (p: Partial<SkillProvenance>): SkillProvenance => p;
  const DIR = '/Users/me/inkeep/bim-tools-2';

  it('keeps user-global installs regardless of project', () => {
    expect(isDetectedSkillInProject(prov({ scope: 'user' }), DIR)).toBe(true);
    expect(isDetectedSkillInProject(prov({}), DIR)).toBe(true);
  });

  it('keeps a project-scoped install bound to THIS project', () => {
    expect(isDetectedSkillInProject(prov({ scope: 'project', projectPath: DIR }), DIR)).toBe(true);
    // Trailing-slash-insensitive.
    expect(isDetectedSkillInProject(prov({ scope: 'project', projectPath: `${DIR}/` }), DIR)).toBe(
      true,
    );
  });

  it('drops a project-scoped install bound to a DIFFERENT project', () => {
    expect(
      isDetectedSkillInProject(
        prov({ scope: 'project', projectPath: '/Users/me/inkeep/agents-private' }),
        DIR,
      ),
    ).toBe(false);
  });

  it('keeps a project-scoped install that records no projectPath (unattributable)', () => {
    expect(isDetectedSkillInProject(prov({ scope: 'project' }), DIR)).toBe(true);
  });

  it('keeps everything when the open project dir is unknown', () => {
    expect(
      isDetectedSkillInProject(prov({ scope: 'project', projectPath: '/elsewhere' }), undefined),
    ).toBe(true);
  });

  // The server normalizes a linked worktree's own path to its parent-checkout
  // IDENTITY (resolveProjectIdentity) before calling in, so a parent-recorded
  // project install matches from inside the worktree while a genuinely different
  // project stays dropped. Here the caller passes that pre-resolved identity.
  it('matches a parent-recorded install when passed the resolved parent identity', () => {
    const MAIN = '/Users/me/inkeep/agents-private';
    // projectDir here is the worktree normalized to MAIN, so the parent's
    // project-scoped install (keyed on MAIN) is kept.
    expect(isDetectedSkillInProject(prov({ scope: 'project', projectPath: MAIN }), MAIN)).toBe(
      true,
    );
    // A different project's install is still dropped under the same identity.
    expect(
      isDetectedSkillInProject(prov({ scope: 'project', projectPath: '/Users/me/other' }), MAIN),
    ).toBe(false);
  });
});
