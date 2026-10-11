import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import {
  DerivedDocumentIndex,
  type DerivedDocumentIndexBranchTransition,
} from '../../../server/src/derived-document-index.ts';
import { post } from './rename-rebinding.test-helper.ts';
import {
  createInspectableServer,
  createTestClient,
  type InspectableServer,
  pollUntil,
} from './test-harness';

const RESPONSE_GRACE_MS = 3000;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.local',
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

async function bootOnMainWithFeatureBranch(): Promise<{
  contentDir: string;
  server: InspectableServer;
}> {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-branch-switch-agent-write-')));
  cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));
  await ensureProjectGit(contentDir);
  configureTestGitRepository(contentDir);
  git(contentDir, 'config user.name test');
  git(contentDir, 'config user.email test@test.local');
  writeFileSync(join(contentDir, 'notes.md'), '# Notes\n\nOn main.\n', 'utf-8');
  writeFileSync(join(contentDir, 'other.md'), '# Other\n\nOn main.\n', 'utf-8');
  git(contentDir, 'add notes.md other.md');
  git(contentDir, 'commit -m main');
  git(contentDir, 'checkout -b feature');
  writeFileSync(join(contentDir, 'notes.md'), '# Notes\n\nOn feature.\n', 'utf-8');
  writeFileSync(join(contentDir, 'other.md'), '# Other\n\nOn feature.\n', 'utf-8');
  git(contentDir, 'add notes.md other.md');
  git(contentDir, 'commit -m feature');
  git(contentDir, 'checkout main');

  const server = await createInspectableServer({
    contentDir,
    keepContentDir: true,
    gitEnabled: true,
    commitDebounceMs: 500,
  });
  cleanups.push(() => server.shutdown());

  for (const docName of ['notes', 'other']) {
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    cleanups.push(() => client.cleanup());
    await pollUntil(() => client.ytext.toString().includes('On main.'), 15_000, 50);
  }
  return { contentDir, server };
}

function serverText(server: InspectableServer, docName: string): string {
  return server.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
}

function readNotes(contentDir: string): string {
  return readFileSync(join(contentDir, 'notes.md'), 'utf-8');
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), wait(ms).then(() => false)]);
}

describe('agent writes during a git branch switch', () => {
  test.runIf(process.platform !== 'win32')(
    'a patch sent after the reset but before the switch settles is written to the new branch',
    async () => {
      let releaseSettle: () => void = () => {};
      const settleHeld = new Promise<void>((resolve) => {
        releaseSettle = resolve;
      });
      const settleBranchFromDisk = DerivedDocumentIndex.prototype.settleBranchFromDisk;
      const settleSpy = vi
        .spyOn(DerivedDocumentIndex.prototype, 'settleBranchFromDisk')
        .mockImplementation(async function (
          this: DerivedDocumentIndex,
          transition: DerivedDocumentIndexBranchTransition,
        ) {
          await settleHeld;
          return settleBranchFromDisk.call(this, transition);
        });
      cleanups.push(() => {
        releaseSettle();
        settleSpy.mockRestore();
      });

      const { contentDir, server } = await bootOnMainWithFeatureBranch();

      git(contentDir, 'checkout feature');
      await pollUntil(
        () =>
          settleSpy.mock.calls.length > 0 && serverText(server, 'notes').includes('On feature.'),
        20_000,
        50,
        'the branch switch to reset the open document and reach the held settle',
      );
      expect(server.instance.durabilityState.isBatchInProgress()).toBe(true);

      const patch = post(server.port, '/api/agent-patch', {
        docName: 'notes',
        find: 'On feature.',
        replace: 'Edited on feature.',
        agentId: 'branch-switch-probe',
      });
      const ackedWhileSwitching = await settledWithin(patch, RESPONSE_GRACE_MS);

      releaseSettle();
      const response = await patch;
      expect(response.status).toBe(200);
      await pollUntil(
        () => !server.instance.durabilityState.isBatchInProgress(),
        20_000,
        50,
        'the branch switch batch to end',
      );
      await pollUntil(
        () => !server.instance.durabilityState.isWriteAdmissionHeld(),
        5_000,
        50,
        'the branch switch to release write admission',
      );
      await pollUntil(
        () => readNotes(contentDir).includes('Edited on feature.'),
        15_000,
        100,
      ).catch(() => {});

      expect(readNotes(contentDir)).toContain('Edited on feature.');
      expect(ackedWhileSwitching).toBe(false);

      const holds = vi.spyOn(server.instance.durabilityState, 'holdWriteAdmission');
      cleanups.push(() => holds.mockRestore());
      writeFileSync(join(contentDir, 'staged.txt'), 'staged\n', 'utf-8');
      git(contentDir, 'add staged.txt');
      await pollUntil(
        () => holds.mock.calls.length > 0,
        15_000,
        20,
        'the index change to start a batch',
      );
      await pollUntil(
        () => !server.instance.durabilityState.isWriteAdmissionHeld(),
        10_000,
        50,
        'the index-change batch to release write admission',
      );
    },
    90_000,
  );

  test.runIf(process.platform !== 'win32')(
    'a write whose deferred store is discarded by the switch is not acknowledged as saved',
    async () => {
      const { contentDir, server } = await bootOnMainWithFeatureBranch();
      const durability = server.instance.durabilityState;
      const notes = server.instance.hocuspocus.documents.get('notes');
      if (!notes) throw new Error('notes was not loaded');
      const source = notes.getText('source');
      let holding = false;
      const holdBatchOnceWritten = (): void => {
        if (holding || !source.toString().includes('Appended before the switch.')) return;
        holding = true;
        durability.setBatchInProgress(true);
        cleanups.push(durability.holdWriteAdmission());
      };
      source.observe(holdBatchOnceWritten);
      cleanups.push(() => source.unobserve(holdBatchOnceWritten));

      const write = post(server.port, '/api/agent-write-md', {
        docName: 'notes',
        markdown: 'Appended before the switch.\n',
        position: 'append',
        agentId: 'branch-switch-probe',
      });
      await pollUntil(() => durability.isBatchInProgress(), 15_000, 20, 'the write to land');
      const ackedBeforeSwitch = await settledWithin(write, RESPONSE_GRACE_MS);

      git(contentDir, 'checkout feature');
      const response = await write;
      await pollUntil(
        () =>
          !durability.isBatchInProgress() && serverText(server, 'notes').includes('On feature.'),
        20_000,
        50,
        'the branch switch to finish',
      );

      expect(response.status).toBe(409);
      expect((response.body as { type?: string } | null)?.type).toBe(
        'urn:ok:error:branch-switched',
      );
      expect(ackedBeforeSwitch).toBe(false);
      expect(readNotes(contentDir)).not.toContain('Appended before the switch.');
    },
    90_000,
  );
});
