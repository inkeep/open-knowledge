import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  createRestartableServer,
  createTestClient,
  pollUntil,
  schema,
  seedPoolServerInstanceId,
} from './test-harness';

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

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('restart-with-embed-doc: server restart preserves single PM image with resolved src', () => {
  test('![[photo.png]] doc survives restart-recycle with exactly one image and /assets/ src', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-embed-restart-'));
    writeRel(contentDir, 'photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    writeRel(contentDir, 'test-doc.md', '# Heading\n\n![[photo.png]]\n');

    let server = await createRestartableServer({ contentDir });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const preState = await createTestClient(server.port, 'test-doc', { resetOnCleanup: false });
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
    expect(prePropsRecord?.target).toBe('photo.png');
    await preState.cleanup();

    await wait(500);
    const previousProvider = pool.getActive()?.provider;

    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider !== previousProvider, 15_000, 50);
    try {
      await pollUntil(
        () => {
          const active = pool.getActive();
          if (active?.provider.isSynced !== true) return false;
          const json = yXmlFragmentToProseMirrorRootNode(
            active.provider.document.getXmlFragment('default'),
            schema,
          ).toJSON() as PmJsonNode;
          const embeds = collectNodes(json, 'jsxComponent').filter(
            (node) => node.attrs?.componentName === 'WikiEmbedImage',
          );
          const props = embeds[0]?.attrs?.props as Record<string, unknown> | undefined;
          return embeds.length === 1 && props?.src === '/photo.png';
        },
        15_000,
        50,
      );
    } catch (cause) {
      const active = pool.getActive();
      throw new Error(
        `Restarted embed failed to settle: ${JSON.stringify({
          disk: readFileSync(join(contentDir, 'test-doc.md'), 'utf8'),
          source: pool.getActive()?.provider.document.getText('source').toString(),
          fragment: pool.getActive()?.provider.document.getXmlFragment('default').toJSON(),
          isSynced: pool.getActive()?.provider.isSynced,
          freshProvider: pool.getActive()?.provider !== previousProvider,
          epoch: server.serverInstanceId,
          pm:
            active === undefined
              ? null
              : yXmlFragmentToProseMirrorRootNode(
                  active.provider.document.getXmlFragment('default'),
                  schema,
                ).toJSON(),
        })}`,
        { cause },
      );
    }
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    const entry = pool.getActive();
    if (!entry) throw new Error('pool has no active entry after recycle');
    const clientFragment = entry.provider.document.getXmlFragment('default');
    const clientJson = yXmlFragmentToProseMirrorRootNode(
      clientFragment,
      schema,
    ).toJSON() as PmJsonNode;
    const clientEmbeds = collectNodes(clientJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(clientEmbeds.length).toBe(1);
    const clientPropsRecord = clientEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(clientPropsRecord?.src).toBe('/photo.png');

    const clientSource = entry.provider.document.getText('source').toString();
    expect((clientSource.match(/!\[\[photo\.png\]\]/g) ?? []).length).toBe(1);

    const postState = await createTestClient(server.port, 'test-doc');
    cleanups.push(() => postState.cleanup());
    const postJson = yXmlFragmentToProseMirrorRootNode(
      postState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const postEmbeds = collectNodes(postJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(postEmbeds.length).toBe(1);
    const postPropsRecord = postEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(postPropsRecord?.src).toBe('/photo.png');
  }, 30_000);
});
