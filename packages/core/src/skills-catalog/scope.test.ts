import { describe, expect, it } from 'vitest';
import type { SkillProvenance } from './schema.ts';
import {
  catalogRawScopeToOkScope,
  isDetectedSkillInProject,
  isSkillOutsideOpenProject,
} from './scope.ts';

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

describe('isSkillOutsideOpenProject', () => {
  const prov = (p: Partial<SkillProvenance>): SkillProvenance => p;
  // The worktree shape: the OPEN tree is the linked worktree, while enumeration
  // resolved identity to the parent checkout that actually holds the files.
  const WORKTREE = '/Users/me/inkeep/wt-blog';
  const PARENT = '/Users/me/inkeep/agents-private';

  it('flags a project skill whose files live in another checkout', () => {
    expect(
      isSkillOutsideOpenProject(
        prov({ scope: 'project', projectPath: PARENT }),
        `${PARENT}/.codex/skills/stories`,
        WORKTREE,
      ),
    ).toBe(true);
  });

  it('clears a project skill inside the open tree', () => {
    expect(
      isSkillOutsideOpenProject(
        prov({ scope: 'project', projectPath: WORKTREE }),
        `${WORKTREE}/.agents/skills/consolidate-notes`,
        WORKTREE,
      ),
    ).toBe(false);
  });

  // The regression this guards: a global skill sits outside contentDir BY
  // DEFINITION, so a locality-only test would condemn every global row and
  // send working skills down the read-only copy-in path.
  it('never flags a global skill, however far outside it sits', () => {
    for (const scope of ['user', 'something-else', undefined]) {
      expect(
        isSkillOutsideOpenProject(prov({ scope }), '/Users/me/.claude/skills/x', WORKTREE),
      ).toBe(false);
    }
  });

  it('flags a sibling that merely shares a path prefix, and clears a trailing slash', () => {
    expect(
      isSkillOutsideOpenProject(
        prov({ scope: 'project' }),
        `${WORKTREE}-other/.codex/skills/x`,
        WORKTREE,
      ),
    ).toBe(true);
    expect(
      isSkillOutsideOpenProject(
        prov({ scope: 'project' }),
        `${WORKTREE}/.codex/skills/x`,
        `${WORKTREE}/`,
      ),
    ).toBe(false);
  });

  it('clears a skill nested deeper inside the open tree', () => {
    expect(
      isSkillOutsideOpenProject(
        prov({ scope: 'project' }),
        `${WORKTREE}/subdir/.codex/skills/x`,
        WORKTREE,
      ),
    ).toBe(false);
  });

  it('is inert when the open tree is unknown', () => {
    expect(
      isSkillOutsideOpenProject(prov({ scope: 'project' }), '/anywhere/skills/x', undefined),
    ).toBe(false);
  });
});
