
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { ProviderPool } from '../../src/editor/provider-pool';
import { createRestartableServer, getServerState, pollUntil, schema } from './test-harness';


interface PmJsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PmJsonNode[];
}

function collectNodes(json: PmJsonNode, type: string, out: PmJsonNode[] = []): PmJsonNode[] {
  if (json.type === type) out.push(json);
  for (const child of json.content ?? []) collectNodes(child, type, out);
  return out;
}

function writeRel(root: string, rel: string, body: string | Uint8Array): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DOC_BODY = '# Heading\n\n![[photo.png]]\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('asset-move embed re-resolution — head-watcher-independent fallback', () => {
  test('moving photo.png → assets/photo.png updates PM image src without git', async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-asset-move-')));
    cleanups.push(() => {
      try {
        rmSync(contentDir, { recursive: true, force: true });
      } catch {
      }
    });

    writeRel(contentDir, 'test-doc.md', DOC_BODY);
    writeRel(contentDir, 'photo.png', PNG_BYTES);
    writeRel(contentDir, 'assets/cover.md', '# Cover\n');
    await ensureProjectGit(contentDir);

    const server = await createRestartableServer({
      contentDir,
      keepContentDir: false,
      gitEnabled: true,
      commitDebounceMs: 500,
    });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const preState = getServerState(server, 'test-doc');
    if (!preState) throw new Error('server has no test-doc loaded pre-move');
    const preJson = yXmlFragmentToProseMirrorRootNode(
      preState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const preEmbeds = collectNodes(preJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(preEmbeds.length).toBe(1);
    const prePropsRecord = preEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(prePropsRecord?.src).toBe('/photo.png');

    await wait(300);

    rmSync(join(contentDir, 'photo.png'));
    writeRel(contentDir, 'assets/photo.png', PNG_BYTES);

    await pollUntil(
      () => {
        const state = getServerState(server, 'test-doc');
        if (!state) return false;
        const json = yXmlFragmentToProseMirrorRootNode(
          state.fragment,
          schema,
        ).toJSON() as PmJsonNode;
        const embeds = collectNodes(json, 'jsxComponent').filter(
          (n) => n.attrs?.componentName === 'WikiEmbedImage',
        );
        if (embeds.length !== 1) return false;
        const props = embeds[0]?.attrs?.props as Record<string, unknown> | undefined;
        return props?.src === '/assets/photo.png';
      },
      10_000,
      100,
    );

    const postState = getServerState(server, 'test-doc');
    if (!postState) throw new Error('server has no test-doc loaded post-move');
    const postJson = yXmlFragmentToProseMirrorRootNode(
      postState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const postEmbeds = collectNodes(postJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(postEmbeds.length).toBe(1);
    const postPropsRecord = postEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(postPropsRecord?.src).toBe('/assets/photo.png');
    expect(postPropsRecord?.target).toBe('photo.png');

    const postSource = postState.fragment.doc?.getText('source').toString() ?? '';
    expect((postSource.match(/!\[\[photo\.png\]\]/g) ?? []).length).toBe(1);
  }, 30_000);

  test('deleting photo.png without replacement re-renders embed with null src', async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-asset-delete-')));
    cleanups.push(() => {
      try {
        rmSync(contentDir, { recursive: true, force: true });
      } catch {
      }
    });

    writeRel(contentDir, 'test-doc.md', DOC_BODY);
    writeRel(contentDir, 'photo.png', PNG_BYTES);
    await ensureProjectGit(contentDir);

    const server = await createRestartableServer({
      contentDir,
      keepContentDir: false,
      gitEnabled: true,
      commitDebounceMs: 500,
    });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const preState = getServerState(server, 'test-doc');
    if (!preState) throw new Error('server has no test-doc loaded pre-delete');
    const preJson = yXmlFragmentToProseMirrorRootNode(
      preState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const preEmbeds = collectNodes(preJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(preEmbeds.length).toBe(1);
    expect((preEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined)?.src).toBe(
      '/photo.png',
    );

    await wait(300);

    rmSync(join(contentDir, 'photo.png'));

    await pollUntil(
      () => {
        const state = getServerState(server, 'test-doc');
        if (!state) return false;
        const json = yXmlFragmentToProseMirrorRootNode(
          state.fragment,
          schema,
        ).toJSON() as PmJsonNode;
        const embeds = collectNodes(json, 'jsxComponent').filter(
          (n) => n.attrs?.componentName === 'WikiEmbedImage',
        );
        if (embeds.length !== 1) return false;
        const src = (embeds[0]?.attrs?.props as Record<string, unknown> | undefined)?.src;
        return src !== '/photo.png';
      },
      10_000,
      100,
    );

    const postState = getServerState(server, 'test-doc');
    if (!postState) throw new Error('server has no test-doc loaded post-delete');
    const postJson = yXmlFragmentToProseMirrorRootNode(
      postState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const postEmbeds = collectNodes(postJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(postEmbeds.length).toBe(1);
    const postPropsRecord = postEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(postPropsRecord?.src).not.toBe('/photo.png');
    expect(postPropsRecord?.target).toBe('photo.png');

    const postSource = postState.fragment.doc?.getText('source').toString() ?? '';
    expect((postSource.match(/!\[\[photo\.png\]\]/g) ?? []).length).toBe(1);
  }, 30_000);
});
