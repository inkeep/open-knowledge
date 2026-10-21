import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DOC_NAME_PROJECT } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
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
let home: string | undefined;

afterEach(async () => {
  await client?.cleanup();
  client = undefined;
  await server?.cleanup();
  server = undefined;
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

const SAVED = 'contentRules:\n  markdownlint:\n    enabled: true\n';
const PENDING = `${SAVED}# a note being typed\n`;

function liveText(s: TestServer): string | null {
  return (
    s.instance.hocuspocus.documents.get(CONFIG_DOC_NAME_PROJECT)?.getText('source').toString() ??
    null
  );
}

async function openWithPendingEdit(
  options: { historyFails?: boolean; home?: string } = {},
): Promise<{ s: TestServer; path: string }> {
  const s = await createTestServer({
    gitEnabled: true,
    configHomedirOverride: options.home,
    mergeHistoryWriter: options.historyFails
      ? () => Promise.reject(new Error('history is unavailable'))
      : undefined,
    seedProjectConfigYml: SAVED,
    watcherBackend: createWatcherDouble().backend,
    debounce: 300_000,
    maxDebounce: 600_000,
  });
  server = s;
  const c = await createTestClient(s.port, CONFIG_DOC_NAME_PROJECT, { skipInvariantWatcher: true });
  client = c;
  await pollUntil(() => c.ytext.toString() === SAVED, 10_000, 25, 'the settings to load');
  c.ytext.insert(c.ytext.length, '# a note being typed\n');
  await pollUntil(() => liveText(s) === PENDING, 10_000, 25, 'the edit to reach the server');
  return { s, path: join(s.contentDir, '.ok', 'config.yml') };
}

async function settingsHistory(
  s: TestServer,
): Promise<Array<{ side: unknown; fileType: unknown; content: string }>> {
  const docName = encodeURIComponent(CONFIG_DOC_NAME_PROJECT);
  const res = await fetch(`${s.baseUrl}/api/history?docName=${docName}&type=checkpoint&limit=100`);
  const body = (await res.json()) as {
    entries?: Array<{ sha: string; checkpoint?: { metadata?: Record<string, unknown> } }>;
  };
  const versions: Array<{ side: unknown; fileType: unknown; content: string }> = [];
  for (const row of body.entries ?? []) {
    const content = await fetch(`${s.baseUrl}/api/history/${row.sha}?docName=${docName}`).then(
      (r) => r.json() as Promise<{ content: string }>,
    );
    versions.push({
      side: row.checkpoint?.metadata?.side,
      fileType: row.checkpoint?.metadata?.fileType,
      content: content.content,
    });
  }
  return versions;
}

async function settingsNotices(s: TestServer): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${s.baseUrl}/api/doc-notices`);
  const body = (await res.json()) as { notices?: Array<Record<string, unknown>> };
  return (body.notices ?? []).filter((notice) => notice.docName === CONFIG_DOC_NAME_PROJECT);
}

describe('an outside change to the project settings under an unsaved edit', () => {
  test('a valid outside version applies, and the unsaved edit goes to history with a notice', async () => {
    const { s, path } = await openWithPendingEdit();
    const outside = 'contentRules:\n  markdownlint:\n    enabled: false\n';
    writeFileSync(path, outside, 'utf-8');

    await pollUntil(() => liveText(s) === outside, 10_000, 25, 'the polled intake to apply');
    expect(readFileSync(path, 'utf-8')).toBe(outside);
    await pollUntil(async () => (await settingsNotices(s)).length === 1, 10_000, 25, 'the notice');
    expect(await settingsHistory(s)).toEqual([
      { side: 'ours', fileType: 'config', content: PENDING },
    ]);
    expect(await settingsNotices(s)).toEqual([
      expect.objectContaining({
        kind: 'moved-to-history',
        side: 'ours',
        reason: 'outside-settings-applied',
        file: '.ok/config.yml',
      }),
    ]);
  });

  test('an invalid outside version never wins: it goes to history and the edit is written', async () => {
    const { s, path } = await openWithPendingEdit();
    const invalid = 'contentRules: [unclosed\n';
    writeFileSync(path, invalid, 'utf-8');
    const id = `onStoreDocument-${CONFIG_DOC_NAME_PROJECT}`;
    if (s.instance.hocuspocus.debouncer.isDebounced(id)) {
      await s.instance.hocuspocus.debouncer.executeNow(id);
    }

    await pollUntil(() => readFileSync(path, 'utf-8') === PENDING, 10_000, 25, 'the edit on disk');
    expect(liveText(s)).toBe(PENDING);
    expect(await settingsHistory(s)).toEqual([
      { side: 'theirs', fileType: 'config', content: invalid },
    ]);
    expect(await settingsNotices(s)).toEqual([
      expect.objectContaining({ reason: 'outside-settings-invalid', file: '.ok/config.yml' }),
    ]);
  });

  test('when history cannot take the unsaved edit, a valid outside version applies once the edit is in the backup folder', async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-settings-home-')));
    const { s, path } = await openWithPendingEdit({ historyFails: true, home });
    const outside = 'contentRules:\n  markdownlint:\n    enabled: false\n';
    writeFileSync(path, outside, 'utf-8');

    await pollUntil(() => liveText(s) === outside, 10_000, 25, 'the polled intake to apply');
    await pollUntil(async () => (await settingsNotices(s)).length === 1, 10_000, 25, 'the notice');
    const backups = join(home, '.ok', 'edit-backups', 'discarded');
    expect(existsSync(backups)).toBe(true);
    expect(
      readdirSync(backups, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8')),
    ).toEqual([PENDING]);
    expect(await settingsNotices(s)).toEqual([
      expect.objectContaining({
        kind: 'moved-to-backup',
        side: 'ours',
        reason: 'outside-settings-applied',
        file: '.ok/config.yml',
        backup: expect.stringMatching(
          /^~\/\.ok\/edit-backups\/discarded\/projects\/[0-9a-f]{8}\/[^/]+\/[^/]+\.yml$/,
        ),
      }),
    ]);
  });
});
