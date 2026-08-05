/**
 * `showItemInFolder` containment: the reveal gate admits paths under the
 * caller's project OR an explicit trusted `allowedRoots` entry (the
 * `~/.ok/bug-reports/` dir the report dialog reveals from), and refuses
 * everything else.
 *
 * Regression guard: before `allowedRoots`, the report dialog's "Reveal in
 * Finder" was silently refused for every bug-report zip — the zip lives
 * outside every project, so an editor window hit `out-of-project` and a
 * Navigator window hit `no-project-bound`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { userGlobalSkillRoots } from '@inkeep/open-knowledge-core/skills-catalog';
import { describe, expect, test } from 'vitest';
import { revealAllowedRoots, showItemInFolder } from './ipc-handlers.ts';

const HOME = '/Users/tester';
const BUG_REPORTS = '/Users/tester/.ok/bug-reports';
const PROJECT = '/Users/tester/projects/demo';
/** The roots main passes for skill reveals — same derivation as `main/index.ts`. */
const SKILL_ROOTS = userGlobalSkillRoots(HOME);

/**
 * The POLICY the handler feeds its predicate. Asserted independently of the
 * predicate because the main-process wiring is not reachable from tests: with
 * the roots built inline at the call site, dropping them was a silent no-op
 * that every predicate test still passed.
 */
describe('revealAllowedRoots — the policy the reveal handler passes in', () => {
  test('carries the bug-report dir and every user-global skill root', () => {
    const roots = revealAllowedRoots();
    const home = homedir();

    expect(roots).toContain(join(home, '.ok', 'bug-reports'));
    // Spelled out rather than derived from `userGlobalSkillRoots`: an assertion
    // built from the function under test shrinks with it and passes vacuously.
    expect(roots).toContain(join(home, '.claude', 'skills'));
    expect(roots).toContain(join(home, '.agents', 'skills'));
    expect(roots).toContain(join(home, '.claude', 'plugins'));
    expect(roots).toContain(join(home, '.ok', 'skills'));
  });

  test('admits a real global skill path and still refuses a sibling home dir', () => {
    const home = homedir();
    const reveal = (p: string) =>
      showItemInFolder(
        {
          platform: process.platform,
          projectPath: join(home, 'projects', 'demo'),
          allowedRoots: revealAllowedRoots(),
          showItemInFolder: () => {},
        },
        p,
      );

    expect(reveal(join(home, '.claude', 'skills', 'build-ok-dmg', 'SKILL.md'))).toEqual({
      ok: true,
    });
    expect(reveal(join(home, '.ssh', 'id_rsa'))).toEqual({ ok: false, reason: 'out-of-project' });
  });
});

describe('showItemInFolder — allowedRoots for bug-report zips', () => {
  test('editor window (project bound) reveals a bug-report zip via allowedRoots', () => {
    const zip = join(BUG_REPORTS, '2026-07-10T00-00-00-bugreport.zip');
    const revealed: string[] = [];
    const outcome = showItemInFolder(
      {
        platform: 'darwin',
        projectPath: PROJECT,
        allowedRoots: [BUG_REPORTS],
        showItemInFolder: (p) => revealed.push(p),
      },
      zip,
    );
    expect(outcome).toEqual({ ok: true });
    expect(revealed).toEqual([zip]);
  });

  test('Navigator window (no project) still reveals a bug-report zip via allowedRoots', () => {
    const zip = join(BUG_REPORTS, 'report.zip');
    const revealed: string[] = [];
    const outcome = showItemInFolder(
      {
        platform: 'darwin',
        projectPath: undefined,
        allowedRoots: [BUG_REPORTS],
        showItemInFolder: (p) => revealed.push(p),
      },
      zip,
    );
    expect(outcome).toEqual({ ok: true });
    expect(revealed).toEqual([zip]);
  });

  test('a project file is still revealed (unchanged behavior)', () => {
    const file = join(PROJECT, 'notes.md');
    const revealed: string[] = [];
    const outcome = showItemInFolder(
      {
        platform: 'darwin',
        projectPath: PROJECT,
        allowedRoots: [BUG_REPORTS],
        showItemInFolder: (p) => revealed.push(p),
      },
      file,
    );
    expect(outcome).toEqual({ ok: true });
    expect(revealed).toEqual([file]);
  });

  test('an arbitrary out-of-project, out-of-allowed path is still refused', () => {
    const revealed: string[] = [];
    const outcome = showItemInFolder(
      {
        platform: 'darwin',
        projectPath: PROJECT,
        allowedRoots: [BUG_REPORTS],
        showItemInFolder: (p) => revealed.push(p),
      },
      '/etc/passwd',
    );
    expect(outcome).toEqual({ ok: false, reason: 'out-of-project' });
    expect(revealed).toEqual([]);
  });

  test('without allowedRoots, a bug-report zip is refused (the pre-fix regression)', () => {
    const zip = join(BUG_REPORTS, 'report.zip');
    const revealed: string[] = [];
    const outcome = showItemInFolder(
      { platform: 'darwin', projectPath: PROJECT, showItemInFolder: (p) => revealed.push(p) },
      zip,
    );
    expect(outcome).toEqual({ ok: false, reason: 'out-of-project' });
    expect(revealed).toEqual([]);
  });

  test('a global skill in a harness home is revealed via allowedRoots', () => {
    // Regression guard: global skills live outside every project, so before
    // their roots joined `allowedRoots` the Skills panel's Reveal rendered but
    // did nothing for every one of them.
    const skillMd = join(SKILL_ROOTS[0] ?? '', 'migrate-to-codex', 'SKILL.md');
    const revealed: string[] = [];
    const outcome = showItemInFolder(
      {
        platform: 'darwin',
        projectPath: PROJECT,
        allowedRoots: [BUG_REPORTS, ...SKILL_ROOTS],
        showItemInFolder: (p) => revealed.push(p),
      },
      skillMd,
    );
    expect(outcome).toEqual({ ok: true });
    expect(revealed).toEqual([skillMd]);
  });

  test('every user-global skill root is admitted', () => {
    for (const root of SKILL_ROOTS) {
      const dir = join(root, 'some-skill', 'references');
      expect(
        showItemInFolder(
          {
            platform: 'darwin',
            projectPath: PROJECT,
            allowedRoots: [BUG_REPORTS, ...SKILL_ROOTS],
            showItemInFolder: () => {},
          },
          dir,
        ),
      ).toEqual({ ok: true });
    }
  });

  test('a non-skill path in the same home is still refused', () => {
    const outcome = showItemInFolder(
      {
        platform: 'darwin',
        projectPath: PROJECT,
        allowedRoots: [BUG_REPORTS, ...SKILL_ROOTS],
        showItemInFolder: () => {},
      },
      '/Users/tester/.ssh/id_rsa',
    );
    expect(outcome).toEqual({ ok: false, reason: 'out-of-project' });
  });

  test('Navigator window with no project and no allowedRoots refuses', () => {
    const revealed: string[] = [];
    const outcome = showItemInFolder(
      { platform: 'darwin', projectPath: undefined, showItemInFolder: (p) => revealed.push(p) },
      join(BUG_REPORTS, 'report.zip'),
    );
    expect(outcome).toEqual({ ok: false, reason: 'no-project-bound' });
    expect(revealed).toEqual([]);
  });
});
