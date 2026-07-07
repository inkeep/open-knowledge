/**
 * C12: Multi-client nested frontmatter convergence + bridge invariant at depth.
 *
 * Validates that two clients editing nested frontmatter (objects, arrays-of-
 * objects) converge under the server-authoritative observer bridge, with the
 * precedent #38 invariant
 *
 *   normalizeBridge(ytext) === normalizeBridge(prependFrontmatter(fm, serialize(fragment)))
 *
 * holding at arbitrary nesting depth. Panel-side
 * edits go through `bindFrontmatterDoc.patchPath` (LOCAL path-addressed,
 * single-leaf), which writes a byte-range replace of the fenced FM region in
 * `Y.Text('source')` under FORM_WRITE_ORIGIN. The body bytes are untouched,
 * so server Observer B (Y.Text → XmlFragment) is a no-op for pure FM edits;
 * the invariant still holds because Y.Text's FM region encodes the new fm
 * and `prependFrontmatter(extractFm(ytext), serialize(fragment))` recomposes
 * to the same bytes.
 *
 * Per-test docName isolation via createTestClients(port, { count }) default.
 * Client lifecycle in try/finally (not afterEach).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import {
  bindFrontmatterDoc,
  type FrontmatterBinding,
  type FrontmatterDocProvider,
  normalizeBridge,
  prependFrontmatter,
  readFmMap,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  createTestClients,
  createTestServer,
  pollUntil,
  serializeFragment,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/** Seed full source (FM + body) onto a client's Y.Text. */
function seedSource(client: TestClient, source: string): void {
  client.doc.transact(() => {
    client.ytext.insert(0, source);
  });
}

/** Append a paragraph with the given text to a client's XmlFragment. */
function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

/**
 * HocuspocusProvider has a wider `on(event, listener)` signature than the
 * structural FrontmatterDocProvider expects ('synced' only). Wrap explicitly
 * rather than asserting through — the binding only listens for 'synced'.
 */
function makeFmProvider(client: TestClient): FrontmatterDocProvider {
  return {
    document: client.doc,
    on: (event, listener) => {
      client.provider.on(event, listener);
    },
    off: (event, listener) => {
      client.provider.off(event, listener);
    },
  };
}

function attachBinding(client: TestClient): { binding: FrontmatterBinding; dispose: () => void } {
  const binding = bindFrontmatterDoc(makeFmProvider(client));
  return {
    binding,
    dispose: () => binding.dispose(),
  };
}

/**
 * FM-aware bridge invariant: Y.Text bytes (containing FM region + body) must
 * equal `prependFrontmatter(extractedFm, serialize(fragment))` after the
 * normalizeBridge tolerance set. Mirrors the watcher in
 * `attachBridgeInvariantWatcher` at the post-converged steady state.
 */
function assertNestedBridgeInvariant(client: TestClient): void {
  const ytextStr = client.ytext.toString();
  const fm = stripFrontmatter(ytextStr).frontmatter;
  const fragBody = serializeFragment(client.fragment);
  const reconstituted = prependFrontmatter(fm, fragBody);
  const ytextNorm = normalizeBridge(ytextStr);
  const fragNorm = normalizeBridge(reconstituted);
  if (ytextNorm !== fragNorm) {
    throw new Error(
      `Nested bridge invariant violated.\n  Y.Text:        ${ytextNorm.slice(0, 400)}\n  Reconstituted: ${fragNorm.slice(0, 400)}`,
    );
  }
}

/**
 * Poll until every marker appears in every client's Y.Text, then assert
 * cross-client Y.Text + fragment identity and the FM-aware bridge invariant.
 * Drop-in replacement for `assertAllConverged` that handles FM-region edits
 * (which body-only `assertBridgeInvariant` cannot).
 */
async function assertConvergedAtDepth(
  clients: TestClient[],
  ytextMarkers: string[],
): Promise<void> {
  for (const marker of ytextMarkers) {
    for (let i = 0; i < clients.length; i++) {
      await pollUntil(() => clients[i].ytext.toString().includes(marker), 5000);
    }
  }
  await wait(500);

  const ytexts = clients.map((c) => c.ytext.toString());
  for (let i = 1; i < ytexts.length; i++) {
    expect(ytexts[i]).toBe(ytexts[0]);
  }
  const fragMds = clients.map((c) => serializeFragment(c.fragment));
  for (let i = 1; i < fragMds.length; i++) {
    expect(fragMds[i]).toBe(fragMds[0]);
  }

  for (const c of clients) {
    assertNestedBridgeInvariant(c);
  }
}

const SKILL_SHAPED_FM = [
  '---',
  'name: c12-skill',
  'description: a sample skill',
  'metadata:',
  '  version: 1.0.0',
  '  author: original',
  '---',
  '# C12 Body',
  '',
  'Body content for c12.',
  '',
].join('\n');

const ARRAY_OF_OBJECTS_FM = [
  '---',
  'name: c12-array',
  'plugins:',
  '  - name: alpha',
  '    version: 1',
  '  - name: beta',
  '    version: 2',
  '---',
  '# C12 array body',
  '',
].join('\n');

describe('C12: multi-client nested frontmatter convergence', () => {
  /**
   * Client A edits a nested leaf; client B converges; bridge
   * invariant holds on both at depth.
   *
   */
  test('nested leaf edit on client A propagates to client B; bridge invariant holds at depth', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      seedSource(clients[0], SKILL_SHAPED_FM);
      await pollUntil(() => clients[1].ytext.toString().includes('version: 1.0.0'), 5000);
      await wait(200);

      const a = attachBinding(clients[0]);
      try {
        const result = a.binding.patchPath(['metadata', 'version'], '2.0.0');
        expect(result.ok).toBe(true);
      } finally {
        a.dispose();
      }

      await assertConvergedAtDepth(clients, ['version: 2.0.0', 'author: original', '# C12 Body']);

      const b = attachBinding(clients[1]);
      try {
        const snapshot = b.binding.current();
        expect(snapshot.parseError).toBeUndefined();
        expect(snapshot.map.metadata).toEqual({ version: '2.0.0', author: 'original' });
        expect(snapshot.map.name).toBe('c12-skill');
      } finally {
        b.dispose();
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  /**
   * Two clients edit sibling nested keys with a sync gate between commits
   * (the realistic panel UX — one binding commit per client at a time). Both
   * edits land; the whole-subtree byte-range replace does not clobber.
   *
   * The "without clobber" expectation is documented as sequential-with-sync;
   * truly concurrent FORM_WRITE_ORIGIN writes to the same FM region would
   * interleave under Y.Text RGA at byte position 0 (a known whole-region
   * tradeoff of the byte-range replace) — not exercised here.
   *
   */
  test('sibling nested key edits from two clients converge under whole-subtree merge', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      seedSource(clients[0], SKILL_SHAPED_FM);
      await pollUntil(() => clients[1].ytext.toString().includes('version: 1.0.0'), 5000);
      await wait(200);

      const a = attachBinding(clients[0]);
      const b = attachBinding(clients[1]);
      try {
        const aRes = a.binding.patchPath(['metadata', 'version'], '2.0.0');
        expect(aRes.ok).toBe(true);

        await pollUntil(() => clients[1].ytext.toString().includes('version: 2.0.0'), 5000);
        await wait(200);

        const bRes = b.binding.patchPath(['metadata', 'author'], 'Bob');
        expect(bRes.ok).toBe(true);

        await assertConvergedAtDepth(clients, ['version: 2.0.0', 'author: Bob', '# C12 Body']);

        const aSnapshot = a.binding.current();
        const bSnapshot = b.binding.current();
        expect(aSnapshot.map.metadata).toEqual({ version: '2.0.0', author: 'Bob' });
        expect(bSnapshot.map.metadata).toEqual({ version: '2.0.0', author: 'Bob' });
        expect(aSnapshot.map.name).toBe('c12-skill');
        expect(bSnapshot.map.name).toBe('c12-skill');
      } finally {
        a.dispose();
        b.dispose();
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  /**
   * Bridge-invariant-at-depth across the Observer A/B seam: client A edits the
   * body via XmlFragment (WYSIWYG); client B edits a nested FM leaf. Both
   * survive; the invariant holds at depth.
   *
   */
  test('body edit + nested-FM edit on two clients converge with bridge invariant at depth', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      seedSource(clients[0], SKILL_SHAPED_FM);
      await pollUntil(() => clients[1].ytext.toString().includes('version: 1.0.0'), 5000);
      await wait(200);

      appendParagraph(clients[0], 'C12-WYSIWYG-FROM-A');

      const b = attachBinding(clients[1]);
      try {
        const res = b.binding.patchPath(['metadata', 'version'], '3.0.0');
        expect(res.ok).toBe(true);
      } finally {
        b.dispose();
      }

      await assertConvergedAtDepth(clients, [
        'version: 3.0.0',
        'author: original',
        '# C12 Body',
        'C12-WYSIWYG-FROM-A',
      ]);

      const fragMd = serializeFragment(clients[0].fragment);
      expect(fragMd).toContain('C12-WYSIWYG-FROM-A');
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  /**
   * Array-of-objects seam at depth: client A appends a new object
   * item; client B receives the convergence + bridge invariant.
   *
   */
  test('array-of-objects item append on client A propagates and converges at depth', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      seedSource(clients[0], ARRAY_OF_OBJECTS_FM);
      await pollUntil(() => clients[1].ytext.toString().includes('name: beta'), 5000);
      await wait(200);

      const a = attachBinding(clients[0]);
      try {
        const seeded = a.binding.current();
        const plugins = seeded.map.plugins;
        expect(Array.isArray(plugins)).toBe(true);
        const length = (plugins as unknown[]).length;
        expect(length).toBe(2);

        const result = a.binding.patchPath(['plugins', length], {
          name: 'gamma',
          version: 3,
        });
        expect(result.ok).toBe(true);
      } finally {
        a.dispose();
      }

      await assertConvergedAtDepth(clients, ['name: gamma', 'name: alpha', 'name: beta']);

      const map = readFmMap(clients[1].ytext.toString());
      const plugins = map.plugins as Array<{ name: string; version: number }>;
      expect(plugins).toHaveLength(3);
      expect(plugins[2]).toEqual({ name: 'gamma', version: 3 });
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
