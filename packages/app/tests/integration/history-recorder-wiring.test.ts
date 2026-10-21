import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DOC_NAME_PROJECT } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type InMemoryCheckpointParams,
  saveInMemoryCheckpoint,
} from '../../../server/src/shadow-repo';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer | undefined;
const clients: TestClient[] = [];
const ownedDirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.cleanup();
  await server?.cleanup();
  server = undefined;
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function edit(c: TestClient, find: string, replace: string): void {
  c.doc.transact(() => {
    const at = c.ytext.toString().indexOf(find);
    c.ytext.delete(at, find.length);
    c.ytext.insert(at, replace);
  });
}

async function flushPendingStore(s: TestServer, docName: string): Promise<void> {
  const id = `onStoreDocument-${docName}`;
  if (s.instance.hocuspocus.debouncer.isDebounced(id)) {
    await s.instance.hocuspocus.debouncer.executeNow(id);
  }
}

describe('the server hands its history recorder to the stores that move versions to history', () => {
  test('engine-less, global skill and settings changes all write through the server recorder', async () => {
    const writes: Array<Pick<InMemoryCheckpointParams, 'kind' | 'docName'>> = [];
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-wiring-home-')));
    ownedDirs.push(home);
    const skillPath = join(home, '.claude', 'skills', 'demo', 'SKILL.md');
    mkdirSync(join(skillPath, '..'), { recursive: true });
    const skillSaved = '---\nname: demo\ndescription: d\n---\n\n# Demo\n\nFirst.\n';
    writeFileSync(skillPath, skillSaved, 'utf-8');
    const settingsSaved = 'contentRules:\n  markdownlint:\n    enabled: true\n';
    const s = await createTestServer({
      gitEnabled: true,
      configHomedirOverride: home,
      seedProjectConfigYml: settingsSaved,
      watcherBackend: createWatcherDouble().backend,
      debounce: 300_000,
      maxDebounce: 600_000,
      mergeHistoryWriter: (shadow, contentRoot, params) => {
        writes.push({ kind: params.kind, docName: params.docName });
        return saveInMemoryCheckpoint(shadow, contentRoot, params);
      },
    });
    server = s;

    const diagramPath = join(s.contentDir, 'flow.mmd');
    writeFileSync(diagramPath, 'graph TD\n  A-->B\n', 'utf-8');
    const diagram = await createTestClient(s.port, 'flow.mmd', { skipInvariantWatcher: true });
    clients.push(diagram);
    await pollUntil(
      () => diagram.ytext.toString() === 'graph TD\n  A-->B\n',
      10_000,
      25,
      'flow.mmd',
    );
    edit(diagram, 'A-->B', 'A-->C');
    await pollUntil(
      () =>
        s.instance.hocuspocus.documents.get('flow.mmd')?.getText('source').toString() ===
        'graph TD\n  A-->C\n',
      10_000,
      25,
      'the diagram edit to reach the server',
    );
    writeFileSync(diagramPath, 'graph TD\n  A-->D\n', 'utf-8');
    await flushPendingStore(s, 'flow.mmd');

    const skill = await createTestClient(s.port, '__skill__/global/demo', {
      skipInvariantWatcher: true,
    });
    clients.push(skill);
    await pollUntil(() => skill.ytext.toString() === skillSaved, 10_000, 25, 'the skill');
    edit(skill, 'First.', 'First, here.');
    await pollUntil(
      () =>
        s.instance.hocuspocus.documents
          .get('__skill__/global/demo')
          ?.getText('source')
          .toString()
          .includes('First, here.') === true,
      10_000,
      25,
      'the skill edit to reach the server',
    );
    writeFileSync(skillPath, skillSaved.replace('First.', 'First, outside.'), 'utf-8');
    await flushPendingStore(s, '__skill__/global/demo');

    const settings = await createTestClient(s.port, CONFIG_DOC_NAME_PROJECT, {
      skipInvariantWatcher: true,
    });
    clients.push(settings);
    await pollUntil(() => settings.ytext.toString() === settingsSaved, 10_000, 25, 'settings');
    settings.ytext.insert(settings.ytext.length, '# note\n');
    await pollUntil(
      () =>
        s.instance.hocuspocus.documents
          .get(CONFIG_DOC_NAME_PROJECT)
          ?.getText('source')
          .toString()
          .endsWith('# note\n') === true,
      10_000,
      25,
      'the settings edit to reach the server',
    );
    writeFileSync(
      join(s.contentDir, '.ok', 'config.yml'),
      'contentRules:\n  markdownlint:\n    enabled: false\n',
      'utf-8',
    );

    await pollUntil(
      () => writes.length >= 4,
      10_000,
      25,
      'four history writes through the server recorder',
    );
    expect(writes).toEqual(
      expect.arrayContaining([
        { kind: 'external-change-no-engine', docName: 'flow.mmd' },
        { kind: 'external-change-both-kept', docName: '__skill__/global/demo' },
        { kind: 'external-change-no-engine', docName: CONFIG_DOC_NAME_PROJECT },
      ]),
    );
  });
});
