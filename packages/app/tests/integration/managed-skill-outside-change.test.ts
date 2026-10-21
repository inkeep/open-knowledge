import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  registerExternalSkill,
  unregisterExternalSkill,
} from '../../../server/src/external-skill-registry';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer | undefined;
let client: TestClient | undefined;
const ownedDirs: string[] = [];

afterEach(async () => {
  await client?.cleanup();
  client = undefined;
  await server?.cleanup();
  server = undefined;
  unregisterExternalSkill('ext-demo');
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SAVED =
  '---\nname: demo\ndescription: synthetic skill\n---\n\n# Demo\n\nFirst paragraph.\n\nSecond paragraph.\n';
const HERE = SAVED.replace('First paragraph.', 'First paragraph, edited here.');
const OUTSIDE = SAVED.replace('First paragraph.', 'First paragraph, edited outside.');
const BOTH_KEPT = SAVED.replace(
  'First paragraph.',
  'First paragraph, edited here.\n\nFirst paragraph, edited outside.',
);
const DOC = '__skill__/global/demo';

function ownedDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  ownedDirs.push(dir);
  return dir;
}

function liveText(s: TestServer, docName: string): string | null {
  return s.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? null;
}

async function startWithGlobalSkill(): Promise<{ s: TestServer; path: string }> {
  const home = ownedDir('ok-skill-home-');
  const path = join(home, '.claude', 'skills', 'demo', 'SKILL.md');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, SAVED, 'utf-8');
  const s = await createTestServer({
    gitEnabled: true,
    configHomedirOverride: home,
    watcherBackend: createWatcherDouble().backend,
    debounce: 300_000,
    maxDebounce: 600_000,
  });
  server = s;
  return { s, path };
}

async function openAndEdit(s: TestServer, docName: string, edit: boolean): Promise<TestClient> {
  const c = await createTestClient(s.port, docName, { skipInvariantWatcher: true });
  client = c;
  await pollUntil(() => c.ytext.toString() === SAVED, 10_000, 25, `${docName} to load`);
  if (edit) {
    c.doc.transact(() => {
      const at = c.ytext.toString().indexOf('First paragraph.');
      c.ytext.delete(at, 'First paragraph.'.length);
      c.ytext.insert(at, 'First paragraph, edited here.');
    });
    await pollUntil(
      () => liveText(s, docName) === HERE,
      10_000,
      25,
      'the edit to reach the server',
    );
  }
  return c;
}

async function flushPendingStore(s: TestServer, docName: string): Promise<void> {
  const id = `onStoreDocument-${docName}`;
  if (s.instance.hocuspocus.debouncer.isDebounced(id)) {
    await s.instance.hocuspocus.debouncer.executeNow(id);
  }
}

async function bothKeptHistory(s: TestServer, docName: string): Promise<string[]> {
  let rows: Array<{ sha: string; checkpoint?: { kind?: string } }> = [];
  await pollUntil(
    async () => {
      const res = await fetch(
        `${s.baseUrl}/api/history?docName=${encodeURIComponent(docName)}&type=checkpoint&limit=100`,
      );
      const body = (await res.json()) as { entries?: typeof rows };
      rows = (body.entries ?? []).filter(
        (row) => row.checkpoint?.kind === 'external-change-both-kept',
      );
      return rows.length >= 2;
    },
    10_000,
    50,
    'both pre-merge versions in history',
  );
  const contents: string[] = [];
  for (const row of rows) {
    const body = await fetch(
      `${s.baseUrl}/api/history/${row.sha}?docName=${encodeURIComponent(docName)}`,
    ).then((r) => r.json() as Promise<{ content: string }>);
    contents.push(body.content);
  }
  return contents.sort();
}

async function noticesFor(s: TestServer, docName: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${s.baseUrl}/api/doc-notices`);
  const body = (await res.json()) as { notices?: Array<Record<string, unknown>> };
  return (body.notices ?? []).filter((notice) => notice.docName === docName);
}

describe('an outside change to a global skill', () => {
  test('a same-block collision at the save keeps both versions live and on disk, with history and a notice', async () => {
    const { s, path } = await startWithGlobalSkill();
    await openAndEdit(s, DOC, true);
    writeFileSync(path, OUTSIDE, 'utf-8');

    await flushPendingStore(s, DOC);

    await pollUntil(
      () => readFileSync(path, 'utf-8') === BOTH_KEPT,
      10_000,
      25,
      'both kept on disk',
    );
    expect(liveText(s, DOC)).toBe(BOTH_KEPT);
    expect(await bothKeptHistory(s, DOC)).toEqual([HERE, OUTSIDE].sort());
    expect(await noticesFor(s, DOC)).toEqual([
      expect.objectContaining({ kind: 'both-kept', file: '~/.claude/skills/demo/SKILL.md' }),
    ]);
  });

  test('a same-block collision at the polled intake keeps both versions live and on disk', async () => {
    const { s, path } = await startWithGlobalSkill();
    await openAndEdit(s, DOC, true);
    writeFileSync(path, OUTSIDE, 'utf-8');

    await pollUntil(() => liveText(s, DOC) === BOTH_KEPT, 10_000, 25, 'the intake to keep both');
    await pollUntil(
      () => readFileSync(path, 'utf-8') === BOTH_KEPT,
      10_000,
      25,
      'both kept on disk',
    );
    expect(await bothKeptHistory(s, DOC)).toEqual([HERE, OUTSIDE].sort());
  });

  test('a refresh of a skill nobody edited applies with no notice', async () => {
    const { s, path } = await startWithGlobalSkill();
    await openAndEdit(s, DOC, false);
    const refreshed = SAVED.replace('Second paragraph.', 'Second paragraph, refreshed.');
    writeFileSync(path, refreshed, 'utf-8');

    await pollUntil(() => liveText(s, DOC) === refreshed, 10_000, 25, 'the refresh to apply');
    expect(readFileSync(path, 'utf-8')).toBe(refreshed);
    expect(await noticesFor(s, DOC)).toEqual([]);
  });
});

describe('an outside change to an external skill', () => {
  test('a same-block collision at the save keeps both versions', async () => {
    const skillDir = ownedDir('ok-ext-skill-');
    const path = join(skillDir, 'SKILL.md');
    writeFileSync(path, SAVED, 'utf-8');
    registerExternalSkill('ext-demo', skillDir);
    const s = await createTestServer({
      gitEnabled: true,
      configHomedirOverride: ownedDir('ok-ext-home-'),
      watcherBackend: createWatcherDouble().backend,
      debounce: 300_000,
      maxDebounce: 600_000,
    });
    server = s;
    const docName = '__extskill__/ext-demo';
    await openAndEdit(s, docName, true);
    writeFileSync(path, OUTSIDE, 'utf-8');

    await flushPendingStore(s, docName);

    await pollUntil(
      () => readFileSync(path, 'utf-8') === BOTH_KEPT,
      10_000,
      25,
      'both kept on disk',
    );
    expect(liveText(s, docName)).toBe(BOTH_KEPT);
    expect(await bothKeptHistory(s, docName)).toEqual([HERE, OUTSIDE].sort());
  });
});
