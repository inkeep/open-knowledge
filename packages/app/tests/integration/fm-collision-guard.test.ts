import { setTimeout as wait } from 'node:timers/promises';
import { normalizeBridge, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertAllConverged,
  attachBridgeInvariantWatcher,
  awaitDocQuiescence,
  createTestClient,
  createTestClients,
  createTestServer,
  getServerState,
  pollUntil,
  readTestDoc,
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

function appendRule(client: TestClient): void {
  client.fragment.push([new Y.XmlElement('thematicBreak')]);
}

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const inner = new Y.XmlText();
  inner.applyDelta([{ insert: text }]);
  paragraph.insert(0, [inner]);
  client.fragment.push([paragraph]);
}

function mintRulePair(client: TestClient): void {
  client.doc.transact(() => {
    appendRule(client);
    appendParagraph(client, 'x');
    appendRule(client);
    appendParagraph(client, 'y');
  });
}

async function settled(client: TestClient): Promise<string> {
  await awaitDocQuiescence(client.doc);
  await pollUntil(() => getServerState(server, client.docName) !== null, 5_000);
  await awaitDocQuiescence(client.doc);
  return getServerState(server, client.docName)?.ytext.toString() ?? '';
}

describe('Observer A drain', () => {
  test('a minted rule pair survives its own re-derivation', async () => {
    const client = await createTestClient(server.port);
    try {
      mintRulePair(client);
      const ytext = await settled(client);

      expect(stripFrontmatter(ytext).frontmatter).toBe('');
      expect(ytext.startsWith('***')).toBe(true);
      expect(ytext).toContain('x');
      expect(ytext).toContain('y');

      const state = getServerState(server, client.docName);
      expect(state?.md).toContain('x');
      expect(state?.md).toContain('y');
      expect(state?.fragment.length).toBe(4);
    } finally {
      await client.cleanup();
    }
  });

  test('does not fire on a frontmatter-bearing document', async () => {
    const client = await createTestClient(server.port);
    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(client.doc, {
      onViolation: (info) => violations.push(info),
    });
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '---\ntitle: t\n---\nseed\n');
      });
      await settled(client);
      mintRulePair(client);
      const ytext = await settled(client);

      expect(stripFrontmatter(ytext).frontmatter).toBe('---\ntitle: t\n---\n');
      expect(ytext).not.toContain('***');
      expect(violations).toEqual([]);
    } finally {
      detach();
      await client.cleanup();
    }
  });

  test('adding frontmatter churns no body bytes', async () => {
    const client = await createTestClient(server.port);
    try {
      mintRulePair(client);
      const guarded = await settled(client);
      expect(guarded).toContain('***');

      client.doc.transact(() => {
        client.ytext.insert(0, '---\ntitle: t\n---\n');
      });
      const withFm = await settled(client);
      expect(withFm).toBe(`---\ntitle: t\n---\n${guarded}`);
      expect(await settled(client)).toBe(withFm);
      expect(stripFrontmatter(withFm).body).toContain('x');
    } finally {
      await client.cleanup();
    }
  });
});

describe('guard consistency', () => {
  test('sustained editing on a guarded document mints no defer-exhaustion checkpoint', async () => {
    const client = await createTestClient(server.port);
    try {
      mintRulePair(client);
      await settled(client);

      for (let i = 0; i < 12; i++) {
        appendParagraph(client, `edit ${i}`);
        await wait(15);
      }
      const ytext = await settled(client);

      expect(ytext.startsWith('***')).toBe(true);
      for (let i = 0; i < 12; i++) expect(ytext).toContain(`edit ${i}`);

      const state = getServerState(server, client.docName);
      expect(normalizeBridge(stripFrontmatter(ytext).body)).toBe(normalizeBridge(state?.md ?? ''));

      const events = await fetch(
        `http://127.0.0.1:${server.port}/api/timeline?docName=${encodeURIComponent(client.docName)}`,
      )
        .then((r) => (r.ok ? r.json() : { entries: [] }))
        .catch(() => ({ entries: [] }));
      const entries = (events as { entries?: Array<{ kind?: string }> }).entries ?? [];
      expect(entries.filter((e) => e.kind === 'derive-timing-defer-exhausted')).toEqual([]);
    } finally {
      await client.cleanup();
    }
  });

  test('a remote peer converges raw-byte-equal on a guard-active edit', async () => {
    const [author, peer] = await createTestClients(server.port, { count: 2 });
    try {
      mintRulePair(author);
      await settled(author);
      await assertAllConverged([author, peer]);

      const authorBytes = author.ytext.toString();
      expect(authorBytes.startsWith('***')).toBe(true);
      expect(peer.ytext.toString()).toBe(authorBytes);
      expect(peer.ytext.toString()).toContain('x');
    } finally {
      await Promise.all([author.cleanup(), peer.cleanup()]);
    }
  });
});

describe('byte-sacred paths stay untouched', () => {
  test('an agent write of rule-leading content lands verbatim', async () => {
    const client = await createTestClient(server.port);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
      originalWarn(...(args as []));
    };
    try {
      const payload = '---\n\nx\n\n---\n\ny\n';
      await agentWriteMd(server.port, payload, {
        docName: client.docName,
        position: 'replace',
      }).catch((err: Error & { status?: number }) => {
        expect(err.status).toBe(400);
      });

      await agentWriteMd(server.port, '***\n\nx\n\n---\n\ny\n', {
        docName: client.docName,
        position: 'replace',
      });
      await settled(client);
      expect(getServerState(server, client.docName)?.ytext.toString()).toBe(
        '***\n\nx\n\n---\n\ny\n',
      );
      expect(warnings.filter((w) => w.includes('content-divergence'))).toEqual([]);
    } finally {
      console.warn = originalWarn;
      await client.cleanup();
    }
  });
});

describe('A1 — fence termination at the compose seam', () => {
  test('typing on a frontmatter-only document does not destroy the block', async () => {
    const client = await createTestClient(server.port);
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '---\ntitle: noeol\n---');
      });
      await settled(client);

      appendParagraph(client, 'typed after fm');
      const ytext = await settled(client);

      expect(stripFrontmatter(ytext).frontmatter).toBe('---\ntitle: noeol\n---\n');
      expect(stripFrontmatter(ytext).body).toContain('typed after fm');
      expect(ytext).not.toContain('---typed');
    } finally {
      await client.cleanup();
    }
  });

  test('an agent append to a frontmatter-only document does not destroy the block', async () => {
    const client = await createTestClient(server.port);
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '---\ntitle: noeol\n---');
      });
      await settled(client);

      await agentWriteMd(server.port, 'appended body\n', {
        docName: client.docName,
        position: 'append',
      });
      const ytext = await settled(client);

      expect(stripFrontmatter(ytext).frontmatter).toBe('---\ntitle: noeol\n---\n');
      expect(ytext).not.toContain('---appended');
    } finally {
      await client.cleanup();
    }
  });
});

describe('A2 — emptying the frontmatter region', () => {
  async function patchFrontmatter(
    docName: string,
    patch: Record<string, unknown>,
  ): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/frontmatter-patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, patch }),
    });
    return res.status;
  }

  test('keeps an explicit block when removing it would re-partition the body', async () => {
    const client = await createTestClient(server.port);
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '---\ntitle: t\n---\n---\n\nx\n\n---\n\ny\n');
      });
      await settled(client);

      expect(await patchFrontmatter(client.docName, { title: null })).toBe(200);
      const ytext = await settled(client);

      const partition = stripFrontmatter(ytext);
      expect(partition.frontmatter).toBe('---\n\n---\n');
      expect(partition.body).toBe('---\n\nx\n\n---\n\ny\n');
      expect(getServerState(server, client.docName)?.md).toContain('x');

      await pollUntil(() => readTestDoc(server.contentDir, client.docName).includes('x'), 5_000);
    } finally {
      await client.cleanup();
    }
  });

  test('an ordinary document still loses the block completely', async () => {
    const client = await createTestClient(server.port);
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '---\ntitle: t\n---\nhello\n');
      });
      await settled(client);

      expect(await patchFrontmatter(client.docName, { title: null })).toBe(200);
      const ytext = await settled(client);

      expect(stripFrontmatter(ytext).frontmatter).toBe('');
      expect(ytext).toContain('hello');
    } finally {
      await client.cleanup();
    }
  });
});

describe('A3 — append/prepend payload partition', () => {
  async function writeRaw(
    docName: string,
    markdown: string,
    position: 'append' | 'prepend' | 'replace',
  ): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown, position }),
    });
    return res.status;
  }

  test('an ambiguous payload is refused where it would land at offset 0', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, 'seed\n', {
        docName: client.docName,
        position: 'replace',
      });
      await settled(client);

      const ambiguous = '---\n\nx\n\n---\n\ny\n';
      expect(await writeRaw(client.docName, ambiguous, 'replace')).toBe(400);
      expect(await writeRaw(client.docName, ambiguous, 'prepend')).toBe(400);

      expect(getServerState(server, client.docName)?.ytext.toString()).toBe('seed\n');
    } finally {
      await client.cleanup();
    }
  });

  test('the same payload appended onto a non-empty body lands, with no collision', async () => {
    const client = await createTestClient(server.port);
    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(client.doc, {
      onViolation: (info) => violations.push(info),
    });
    try {
      await agentWriteMd(server.port, 'seed\n', {
        docName: client.docName,
        position: 'replace',
      });
      await settled(client);

      expect(await writeRaw(client.docName, '---\n\nx\n\n---\n\ny\n', 'append')).toBe(200);
      const ytext = await settled(client);

      expect(stripFrontmatter(ytext).frontmatter).toBe('');
      expect(ytext.startsWith('seed')).toBe(true);

      expect(ytext).toContain('---');
      expect(ytext).toContain('x');
      expect(ytext).toContain('y');

      const state = getServerState(server, client.docName);
      expect(state?.md).toContain('x');
      expect(state?.md).toContain('y');
      expect(violations).toEqual([]);
    } finally {
      detach();
      await client.cleanup();
    }
  });

  test('append onto an EMPTY body refuses — it lands at offset 0 too', async () => {
    const client = await createTestClient(server.port);
    try {
      expect(await writeRaw(client.docName, '---\n\nx\n\n---\n\ny\n', 'append')).toBe(400);
      expect(getServerState(server, client.docName)?.ytext.toString() ?? '').toBe('');
    } finally {
      await client.cleanup();
    }
  });

  test('a well-formed frontmatter payload keeps its documented drop', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, 'seed\n', {
        docName: client.docName,
        position: 'replace',
      });
      await settled(client);

      expect(await writeRaw(client.docName, '---\nsecond: fm\n---\ntail\n', 'append')).toBe(200);
      const ytext = await settled(client);
      expect(ytext).toContain('tail');
      expect(ytext).not.toContain('second: fm');
    } finally {
      await client.cleanup();
    }
  });
});
