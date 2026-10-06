import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { createInspectableServer, createTestClient, pollUntil } from './test-harness';

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

describe('branch switch with a document that became a link into private state', () => {
  test.runIf(process.platform !== 'win32')(
    'does not reseed the open document from the private file it now points at',
    async () => {
      const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-branch-switch-private-')));
      cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));
      await ensureProjectGit(contentDir);
      configureTestGitRepository(contentDir);
      git(contentDir, 'config user.name test');
      git(contentDir, 'config user.email test@test.local');
      mkdirSync(join(contentDir, '.ok', 'local'), { recursive: true });
      writeFileSync(join(contentDir, '.ok', 'local', 'secret.md'), '# Secret\n\nPRIVATE-BYTES\n');
      writeFileSync(join(contentDir, 'leak.md'), '# Leak\n\nOn main.\n', 'utf-8');
      writeFileSync(join(contentDir, 'other.md'), '# Other\n\nOn main.\n', 'utf-8');
      git(contentDir, 'add leak.md other.md');
      git(contentDir, 'commit -m main');
      git(contentDir, 'checkout -b feature');
      git(contentDir, 'rm -q leak.md');
      symlinkSync('.ok/local/secret.md', join(contentDir, 'leak.md'));
      writeFileSync(join(contentDir, 'other.md'), '# Other\n\nOn feature.\n', 'utf-8');
      git(contentDir, 'add leak.md other.md');
      git(contentDir, 'commit -m feature');
      git(contentDir, 'checkout main');

      const server = await createInspectableServer({
        contentDir,
        keepContentDir: true,
        gitEnabled: true,
        commitDebounceMs: 500,
      });
      cleanups.push(() => server.shutdown());

      const leak = await createTestClient(server.port, 'leak');
      cleanups.push(() => leak.cleanup());
      const other = await createTestClient(server.port, 'other');
      cleanups.push(() => other.cleanup());
      await pollUntil(() => leak.ytext.toString().includes('On main.'), 10_000, 50);
      await pollUntil(() => other.ytext.toString().includes('On main.'), 10_000, 50);

      git(contentDir, 'checkout feature');

      const serverText = (docName: string): string =>
        server.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverText('other').includes('On feature.'), 15_000, 50);
      await wait(1000);

      expect(serverText('leak')).not.toContain('PRIVATE-BYTES');
      expect(leak.ytext.toString()).not.toContain('PRIVATE-BYTES');
      expect(
        server.instance.hocuspocus.documents.get('leak')?.getMap('lifecycle').get('status'),
      ).toBe('deleted-upstream');
    },
    45_000,
  );
});
