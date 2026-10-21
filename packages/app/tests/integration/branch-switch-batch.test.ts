import { execSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { getLogger } from '../../../server/src/logger';
import { getMetrics } from '../../../server/src/metrics';
import {
  BRANCH_SWITCH_FOLLOW_UP_DELAY_MS,
  BRANCH_SWITCH_FOLLOW_UP_LIMIT,
} from '../../../server/src/server-factory';
import { createManualClock } from '../../../server/src/watcher-clock.test-helper';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import { createTestClient, createTestServer, pollUntil } from './test-harness';

const cleanups: Array<() => Promise<void> | void> = [];
const CAN_REVOKE_READ = process.platform !== 'win32' && process.getuid?.() !== 0;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.local',
    },
    stdio: 'ignore',
  });
}

async function openNotesTypedOnMain() {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-branch-switch-batch-')));
  cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));
  await ensureProjectGit(contentDir);
  configureTestGitRepository(contentDir);
  const notes = join(contentDir, 'notes.md');
  writeFileSync(notes, '# Notes\n\nShared line on main.\n\nTail.\n');
  git(contentDir, 'add notes.md');
  git(contentDir, 'commit -m main');
  git(contentDir, 'checkout -b feature');
  writeFileSync(notes, '# Notes\n\nShared line on feature.\n\nTail.\n');
  git(contentDir, 'commit -am feature');
  git(contentDir, 'checkout main');

  const double = createWatcherDouble();
  const clock = createManualClock(Date.now());
  const server = await createTestServer({
    contentDir,
    keepContentDir: true,
    gitEnabled: true,
    watcherBackend: double.backend,
    watcherClock: clock,
    debounce: 300_000,
    maxDebounce: 600_000,
  });
  cleanups.push(() => server.cleanup());
  const client = await createTestClient(server.port, 'notes', { skipInvariantWatcher: true });
  cleanups.push(() => client.cleanup());
  await pollUntil(() => client.ytext.toString().includes('on main.'), 10_000, 25, 'the load');
  const liveText = () =>
    server.instance.hocuspocus.documents.get('notes')?.getText('source').toString() ?? '';

  client.doc.transact(() => {
    const at = client.ytext.toString().indexOf('Shared line on main.');
    client.ytext.delete(at, 'Shared line on main.'.length);
    client.ytext.insert(at, 'Shared line on main, typed here.');
  });
  await pollUntil(() => liveText().includes('typed here'), 10_000, 25, 'the typing');

  const switchTo = async (branch: 'feature' | 'main', clockStepMs: number): Promise<void> => {
    git(contentDir, `checkout -f ${branch}`);
    expect(readFileSync(notes, 'utf-8')).toContain(`on ${branch}.`);
    double
      .subscriptionFor(join(contentDir, '.git'))
      .deliver([{ type: 'update', path: join(contentDir, '.git', 'HEAD') }]);
    await pollUntil(
      () => server.instance.durabilityState.isBatchInProgress(),
      10_000,
      25,
      'the switch to open a batch',
    );
    double.subscriptionFor(contentDir).deliver([{ type: 'update', path: notes }]);
    await pollUntil(
      () => {
        clock.advance(clockStepMs);
        return (
          !server.instance.durabilityState.isBatchInProgress() &&
          liveText().includes(`on ${branch}.`)
        );
      },
      15_000,
      25,
      `the switch to ${branch} to end and take in its file`,
    );
  };

  return {
    contentDir,
    clock,
    liveText,
    lifecycleStatus: () =>
      server.instance.hocuspocus.documents.get('notes')?.getMap('lifecycle').get('status'),
    switchToFeature: () => switchTo('feature', 100),
    switchBackToMain: () => switchTo('main', 1),
  };
}

describe('a git branch switch is taken in like any other outside change', () => {
  test.runIf(process.platform !== 'win32')(
    'unsaved typing in the block the other branch changed keeps both versions',
    async () => {
      const rig = await openNotesTypedOnMain();
      const shortfallsBefore = getMetrics().branchSwitchRecheckShortfalls;

      await rig.switchToFeature();

      expect(rig.liveText()).toContain('Shared line on main, typed here.');
      expect(rig.liveText()).toContain('Shared line on feature.');
      expect(rig.liveText()).not.toContain('<<<<<<<');
      expect(rig.lifecycleStatus()).toBeUndefined();
      expect(getMetrics().branchSwitchRecheckShortfalls - shortfallsBefore).toBe(0);
    },
    60_000,
  );

  test.runIf(CAN_REVOKE_READ)(
    'a switch whose re-check cannot read the whole tree is checked again a bounded number of times',
    async () => {
      const rig = await openNotesTypedOnMain();
      const locked = join(rig.contentDir, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'inside.md'), '# Inside\n');
      chmodSync(locked, 0o000);
      cleanups.push(() => chmodSync(locked, 0o755));
      const shortfallsBefore = getMetrics().branchSwitchRecheckShortfalls;
      const shortfalls = () => getMetrics().branchSwitchRecheckShortfalls - shortfallsBefore;

      await rig.switchToFeature();
      expect(rig.liveText()).toContain('Shared line on main, typed here.');

      await pollUntil(
        () => {
          rig.clock.advance(1_000);
          return shortfalls() >= 1 + BRANCH_SWITCH_FOLLOW_UP_LIMIT;
        },
        15_000,
        25,
        'the switch re-check and every follow-up to fall short',
      );
      for (let tick = 0; tick < 20; tick++) {
        rig.clock.advance(BRANCH_SWITCH_FOLLOW_UP_DELAY_MS);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(shortfalls()).toBe(1 + BRANCH_SWITCH_FOLLOW_UP_LIMIT);
    },
    60_000,
  );

  test.runIf(CAN_REVOKE_READ)(
    'a later switch that observes the whole tree ends the follow-up re-checks of an earlier one',
    async () => {
      const rig = await openNotesTypedOnMain();
      const locked = join(rig.contentDir, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'inside.md'), '# Inside\n');
      chmodSync(locked, 0o000);
      cleanups.push(() => chmodSync(locked, 0o755));
      const shortfallsBefore = getMetrics().branchSwitchRecheckShortfalls;
      const shortfalls = () => getMetrics().branchSwitchRecheckShortfalls - shortfallsBefore;

      await rig.switchToFeature();
      await pollUntil(
        () => {
          rig.clock.advance(1);
          return shortfalls() >= 2;
        },
        15_000,
        25,
        'the switch re-check and its first follow-up to fall short',
      );
      chmodSync(locked, 0o755);
      await rig.switchBackToMain();
      expect(shortfalls()).toBe(2);

      chmodSync(locked, 0o000);
      const serverLog = getLogger('server');
      const followUpLines: string[] = [];
      const capture = (...args: unknown[]) => {
        for (const arg of args) {
          if (typeof arg === 'string' && arg.includes('after switching to feature')) {
            followUpLines.push(arg);
          }
        }
      };
      const info = vi.spyOn(serverLog, 'info').mockImplementation(capture);
      const warn = vi.spyOn(serverLog, 'warn').mockImplementation(capture);
      cleanups.push(() => {
        info.mockRestore();
        warn.mockRestore();
      });
      for (let tick = 0; tick < 20; tick++) {
        rig.clock.advance(BRANCH_SWITCH_FOLLOW_UP_DELAY_MS);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(followUpLines).toEqual([]);
      expect(shortfalls()).toBe(2);
    },
    60_000,
  );
});
