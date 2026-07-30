import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  type CC1DerivedViewPayload,
  CC1DerivedViewPayloadSchema,
  SYSTEM_DOC_NAME,
} from '@inkeep/open-knowledge-core';
import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { createTestServer, pollUntil, waitForSync } from './test-harness.ts';

type RelationChannel = 'backlinks' | 'graph' | 'tags';
const RELATION_CHANNELS: readonly RelationChannel[] = ['backlinks', 'graph', 'tags'];

function connectRelationSignals(port: number): {
  provider: HocuspocusProvider;
  signals: CC1DerivedViewPayload[];
  destroy: () => void;
} {
  const document = new Y.Doc();
  const signals: CC1DerivedViewPayload[] = [];
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: SYSTEM_DOC_NAME,
    document,
    connect: true,
    onStateless: ({ payload }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return;
      }
      const parsed = CC1DerivedViewPayloadSchema.safeParse(raw);
      if (parsed.success && RELATION_CHANNELS.includes(parsed.data.ch as RelationChannel)) {
        signals.push(parsed.data);
      }
    },
  });
  return {
    provider,
    signals,
    destroy: () => {
      provider.destroy();
      document.destroy();
    },
  };
}

async function expectRelationSignalsAfter<T>(
  signals: readonly CC1DerivedViewPayload[],
  action: () => Promise<T>,
): Promise<T> {
  const baseline = new Map(
    RELATION_CHANNELS.map((channel) => [
      channel,
      signals.filter((signal) => signal.ch === channel).length,
    ]),
  );
  const result = await action();
  await pollUntil(
    () =>
      RELATION_CHANNELS.every(
        (channel) =>
          signals.filter((signal) => signal.ch === channel).length > (baseline.get(channel) ?? 0),
      ),
    5000,
    20,
  );
  return result;
}

async function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  method = 'POST',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function tagDocuments(baseUrl: string, tag: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/api/tags/${encodeURIComponent(tag)}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { docs: Array<{ docName: string }> };
  return body.docs.map((entry) => entry.docName).sort();
}

async function backlinkSources(baseUrl: string, docName: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/api/backlinks?docName=${encodeURIComponent(docName)}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { backlinks: Array<{ source: string }> };
  return body.backlinks.map((entry) => entry.source).sort();
}

test('direct create, duplicate, rename, and delete keep links and tags in lockstep', async () => {
  const server = await createTestServer();
  const relationSignals = connectRelationSignals(server.port);
  const templateDir = join(server.contentDir, '.ok', 'templates');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    join(templateDir, 'lifecycle.md'),
    '---\ntemplate:\n  title: Lifecycle\ntags: [lifecycle]\n---\n\nSee [[target]].\n',
    'utf-8',
  );

  try {
    await waitForSync(relationSignals.provider);
    await wait(300);

    const created = await expectRelationSignalsAfter(relationSignals.signals, () =>
      postJson(server.baseUrl, '/api/create-page', {
        path: 'folder/item.md',
        template: 'lifecycle',
      }),
    );
    expect(created.status).toBe(200);
    expect(await tagDocuments(server.baseUrl, 'lifecycle')).toEqual(['folder/item']);
    expect(await backlinkSources(server.baseUrl, 'target')).toEqual(['folder/item']);

    const fileDuplicate = await expectRelationSignalsAfter(relationSignals.signals, () =>
      postJson(server.baseUrl, '/api/duplicate-path', {
        kind: 'file',
        path: 'folder/item',
      }),
    );
    expect(fileDuplicate.status).toBe(200);
    expect(await tagDocuments(server.baseUrl, 'lifecycle')).toEqual([
      'folder/item',
      'folder/item copy',
    ]);

    const folderDuplicate = await expectRelationSignalsAfter(relationSignals.signals, () =>
      postJson(server.baseUrl, '/api/duplicate-path', {
        kind: 'folder',
        path: 'folder',
      }),
    );
    expect(folderDuplicate.status).toBe(200);
    expect(await tagDocuments(server.baseUrl, 'lifecycle')).toEqual([
      'folder copy/item',
      'folder copy/item copy',
      'folder/item',
      'folder/item copy',
    ]);

    const renamed = await expectRelationSignalsAfter(relationSignals.signals, () =>
      postJson(server.baseUrl, '/api/rename-path', {
        kind: 'folder',
        fromPath: 'folder copy',
        toPath: 'archive',
      }),
    );
    expect(renamed.status).toBe(200);
    expect(await tagDocuments(server.baseUrl, 'lifecycle')).toEqual([
      'archive/item',
      'archive/item copy',
      'folder/item',
      'folder/item copy',
    ]);
    expect(await backlinkSources(server.baseUrl, 'target')).toEqual([
      'archive/item',
      'archive/item copy',
      'folder/item',
      'folder/item copy',
    ]);

    const deleted = await expectRelationSignalsAfter(relationSignals.signals, () =>
      postJson(server.baseUrl, '/api/delete-path', {
        kind: 'folder',
        path: 'archive',
      }),
    );
    expect(deleted.status).toBe(200);
    expect(await tagDocuments(server.baseUrl, 'lifecycle')).toEqual([
      'folder/item',
      'folder/item copy',
    ]);
    expect(await backlinkSources(server.baseUrl, 'target')).toEqual([
      'folder/item',
      'folder/item copy',
    ]);
  } finally {
    relationSignals.destroy();
    await server.cleanup();
  }
});

test('project skill moves refresh backlinks and tags at the relocated content doc name', async () => {
  const server = await createTestServer();
  const relationSignals = connectRelationSignals(server.port);

  try {
    await waitForSync(relationSignals.provider);
    await wait(300);

    const created = await expectRelationSignalsAfter(relationSignals.signals, () =>
      postJson(
        server.baseUrl,
        '/api/skill',
        {
          scope: 'project',
          name: 'lifecycle-skill',
          frontmatter: {
            name: 'lifecycle-skill',
            description: 'Exercises derived relationship views.',
          },
          body: 'See [[skill-target]]. #skill-lifecycle\n',
        },
        'PUT',
      ),
    );
    expect(created.status).toBe(200);

    await pollUntil(async () => {
      const tags = await tagDocuments(server.baseUrl, 'skill-lifecycle');
      const backlinks = await backlinkSources(server.baseUrl, 'skill-target');
      return (
        tags.includes('.ok/skills/lifecycle-skill/SKILL') &&
        backlinks.includes('.ok/skills/lifecycle-skill/SKILL')
      );
    });

    const moved = await expectRelationSignalsAfter(relationSignals.signals, () =>
      postJson(server.baseUrl, '/api/skill', {
        scope: 'project',
        fromName: 'lifecycle-skill',
        toName: 'relocated-skill',
      }),
    );
    expect(moved.status).toBe(200);

    await pollUntil(async () => {
      const expected = '.ok/skills/relocated-skill/SKILL';
      const old = '.ok/skills/lifecycle-skill/SKILL';
      const tags = await tagDocuments(server.baseUrl, 'skill-lifecycle');
      const backlinks = await backlinkSources(server.baseUrl, 'skill-target');
      return tags.includes(expected) && !tags.includes(old) && backlinks.includes(expected);
    });
  } finally {
    relationSignals.destroy();
    await server.cleanup();
  }
});
