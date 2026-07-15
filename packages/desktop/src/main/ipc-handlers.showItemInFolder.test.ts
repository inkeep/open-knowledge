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
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { showItemInFolder } from './ipc-handlers.ts';

const BUG_REPORTS = '/Users/tester/.ok/bug-reports';
const PROJECT = '/Users/tester/projects/demo';

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
