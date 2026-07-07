/**
 * Bridge integration test matrix
 *
 * Exercises all 12 propagation paths (4 write surfaces × 3 read targets)
 * plus undo/redo through a real Hocuspocus server + real HocuspocusProvider
 * client over WebSocket with setupObservers() wired.
 *
 * Each test verifies content reaches the target surface and asserts the
 * bridge invariant: normalized Y.Text === serialized XmlFragment.
 *
 * Client lifecycle is inside the test body via try/finally (not
 * beforeEach/afterEach) — required for test.concurrent() correctness.
 * Each test uses a per-test unique docName via createTestClient(port).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { markUserTyping } from '../../src/editor/observers';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentPatch,
  agentWriteMd,
  assertBridgeInvariant,
  createTestClient,
  createTestServer,
  getServerState,
  mdManager,
  pollUntil,
  readTestDoc,
  schema,
  serializeFragment,
  type TestClient,
  type TestServer,
  testReset,
} from './test-harness';

/** Simulate WYSIWYG edit: parse markdown and apply to XmlFragment via updateYFragment */
function applyMarkdownToFragment(client: TestClient, md: string): void {
  const json = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(json);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(client.doc, client.fragment, pmNode, meta);
}

function appendParagraphToFragment(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

function appendWikiLinkToFragment(
  client: TestClient,
  target: string,
  anchor?: string | null,
  alias?: string | null,
): void {
  const paragraph = new Y.XmlElement('paragraph');
  const wikiLink = new Y.XmlElement('wikiLink');
  wikiLink.setAttribute('target', target);
  if (anchor) wikiLink.setAttribute('anchor', anchor);
  if (alias) wikiLink.setAttribute('alias', alias);
  paragraph.insert(0, [wikiLink]);
  client.fragment.push([paragraph]);
}

function normalizeMarkdown(md: string): string {
  return md
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n+$/, '');
}

function assertClientsConverged(...clients: TestClient[]): void {
  const normalized = clients.map((client) => normalizeMarkdown(client.ytext.toString()));
  for (const client of clients) {
    assertBridgeInvariant(client.ytext, client.fragment);
  }
  for (let i = 1; i < normalized.length; i++) {
    expect(normalized[i]).toBe(normalized[0]);
  }
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

// ─── Smoke ───

describe('smoke', () => {
  test('server starts, client connects, basic round-trip works', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '# Hello World', { docName: client.docName });
      await pollUntil(() => client.ytext.toString().includes('Hello World'), 5000);
      expect(client.ytext.toString()).toContain('Hello World');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });
});

// ─── wysiwyg-keyboard-typing: WYSIWYG (XmlFragment) writes ───

describe('wysiwyg-keyboard-typing: WYSIWYG writes', () => {
  test.concurrent('wysiwyg-keyboard-typing→Y.Text: local XmlFragment edit propagates to Y.Text via Observer A', async () => {
    const client = await createTestClient(server.port);
    try {
      applyMarkdownToFragment(client, '# WYSIWYG Heading\n\nSome paragraph content.');
      await pollUntil(() => client.ytext.toString().includes('WYSIWYG Heading'), 5000);
      expect(client.ytext.toString()).toContain('WYSIWYG Heading');
      expect(client.ytext.toString()).toContain('Some paragraph content');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test.concurrent('wysiwyg-keyboard-typing→Disk: local XmlFragment edit persists to .md file', async () => {
    const client = await createTestClient(server.port);
    try {
      applyMarkdownToFragment(client, '# Disk Test\n\nThis should persist.');
      await pollUntil(
        () => readTestDoc(server.contentDir, client.docName).includes('Disk Test'),
        5000,
      );
      const diskContent = readTestDoc(server.contentDir, client.docName);
      expect(diskContent).toContain('Disk Test');
      expect(diskContent).toContain('This should persist');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });
});

// ─── source-codemirror-typing: Source mode (Y.Text) writes ───

describe('source-codemirror-typing: source mode writes', () => {
  test.concurrent('source-codemirror-typing→XmlFragment: local Y.Text edit propagates to XmlFragment via Observer B', async () => {
    const client = await createTestClient(server.port);
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '# Source Heading\n\nTyped in source mode.');
      });
      await pollUntil(() => serializeFragment(client.fragment).includes('Source Heading'), 5000);
      const fragContent = serializeFragment(client.fragment);
      expect(fragContent).toContain('Source Heading');
      expect(fragContent).toContain('Typed in source mode');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test.concurrent('source-codemirror-typing→Disk: local Y.Text edit persists to .md file', async () => {
    const client = await createTestClient(server.port);
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '# Source Disk\n\nShould reach disk.');
      });
      await pollUntil(
        () => readTestDoc(server.contentDir, client.docName).includes('Source Disk'),
        5000,
      );
      const diskContent = readTestDoc(server.contentDir, client.docName);
      expect(diskContent).toContain('Source Disk');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });
});

// ─── agent-api-write: Agent writes (via API) ───

describe('agent-api-write: agent writes', () => {
  test.concurrent('agent-api-write→Y.Text: agent-write-md propagates to client Y.Text', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '# Agent Heading\n\nAgent wrote this.', {
        docName: client.docName,
      });
      await pollUntil(() => client.ytext.toString().includes('Agent Heading'), 5000);
      expect(client.ytext.toString()).toContain('Agent Heading');
      expect(client.ytext.toString()).toContain('Agent wrote this');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test.concurrent('agent-api-write→XmlFragment: agent-write-md propagates to client XmlFragment', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '# Agent Fragment\n\nVisible in WYSIWYG.', {
        docName: client.docName,
      });
      await pollUntil(() => serializeFragment(client.fragment).includes('Agent Fragment'), 5000);
      const fragContent = serializeFragment(client.fragment);
      expect(fragContent).toContain('Agent Fragment');
      expect(fragContent).toContain('Visible in WYSIWYG');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test.concurrent('agent-api-write→Disk: agent-write-md persists to .md file', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '# Agent Disk\n\nPersisted by agent.', {
        docName: client.docName,
      });
      await pollUntil(
        () => readTestDoc(server.contentDir, client.docName).includes('Agent Disk'),
        5000,
      );
      const diskContent = readTestDoc(server.contentDir, client.docName);
      expect(diskContent).toContain('Agent Disk');
      expect(diskContent).toContain('Persisted by agent');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  // Agent-patch (find-and-replace) covers a distinct code path from agent-write-md —
  // it mutates an existing span via ytext.delete + ytext.insert instead of append/prepend.
  test.concurrent('agent-api-write-patch→Y.Text: agent-patch replaces target span in Y.Text', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '# Header\n\nOriginal body text.', {
        docName: client.docName,
      });
      await pollUntil(() => client.ytext.toString().includes('Original body text'), 5000);

      const result = await agentPatch(
        server.port,
        'Original body text',
        'Replaced body text',
        client.docName,
      );
      expect(result.ok).toBe(true);
      await pollUntil(() => client.ytext.toString().includes('Replaced body text'), 5000);
      expect(client.ytext.toString()).not.toContain('Original body text');
      expect(client.ytext.toString()).toContain('Header');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test.concurrent('agent-api-write-patch→XmlFragment: agent-patch propagates to XmlFragment', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '# Title\n\nFoo bar baz qux.', { docName: client.docName });
      await pollUntil(() => serializeFragment(client.fragment).includes('Foo bar'), 5000);

      const result = await agentPatch(server.port, 'Foo bar', 'FOO BAR', client.docName);
      expect(result.ok).toBe(true);
      await pollUntil(() => serializeFragment(client.fragment).includes('FOO BAR'), 5000);
      const fragContent = serializeFragment(client.fragment);
      expect(fragContent).toContain('FOO BAR');
      expect(fragContent).toContain('baz qux');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test.concurrent('agent-api-write-patch: agent-patch with unknown find text returns 404 without mutating', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '# Seed\n\nUntouched content.', {
        docName: client.docName,
      });
      await pollUntil(() => client.ytext.toString().includes('Untouched content'), 5000);

      const before = client.ytext.toString();
      const result = await agentPatch(
        server.port,
        'text-that-is-not-in-the-document',
        'replacement',
        client.docName,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(404);
      // The content must not have been mutated
      await wait(300);
      expect(client.ytext.toString()).toBe(before);
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });
});

// ─── file-watcher-disk-to-crdt: Disk writes (file watcher) ───
// file-watcher-disk-to-crdt tests use explicit 'test-doc' because they write to disk by filename
// and the file watcher maps filename → docName.

describe('file-watcher-disk-to-crdt: disk writes', () => {
  test('file-watcher-disk-to-crdt→Y.Text: disk file change propagates to client Y.Text', async () => {
    await testReset(server.port);
    await wait(300);
    const client = await createTestClient(server.port, 'test-doc');
    try {
      // Wait for file watcher to settle after testReset's writeFileSync
      await wait(500);
      writeFileSync(
        join(server.contentDir, 'test-doc.md'),
        '# From Disk\n\nWritten externally.',
        'utf-8',
      );
      await pollUntil(() => client.ytext.toString().includes('From Disk'), 10_000);
      expect(client.ytext.toString()).toContain('Written externally');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('file-watcher-disk-to-crdt→XmlFragment: disk file change propagates to client XmlFragment', async () => {
    await testReset(server.port);
    await wait(300);
    const client = await createTestClient(server.port, 'test-doc');
    try {
      await wait(500);
      writeFileSync(
        join(server.contentDir, 'test-doc.md'),
        '# Disk Fragment\n\nVisible in WYSIWYG from disk.',
        'utf-8',
      );
      await pollUntil(() => serializeFragment(client.fragment).includes('Disk Fragment'), 10_000);
      const fragContent = serializeFragment(client.fragment);
      expect(fragContent).toContain('Visible in WYSIWYG from disk');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });
});

// ─── Undo / Redo ───
// Agent undo/redo endpoints were removed (broken scaffold removal).
// Per-agent undo is deferred (three-UndoManager architecture).
// Integration tests will be re-added when the undo capability is rebuilt.

// ─── Initial sync + test reset ───
// These tests verify shared-state behavior and MUST use explicit 'test-doc'.
// They stay on plain test() — NOT test.concurrent().

describe('initial sync and test isolation', () => {
  test('initial sync: server with existing .md file populates client', async () => {
    await testReset(server.port);
    await wait(300);
    writeFileSync(
      join(server.contentDir, 'test-doc.md'),
      '# Pre-existing\n\nAlready on disk.',
      'utf-8',
    );

    const client = await createTestClient(server.port, 'test-doc');
    try {
      await pollUntil(() => client.ytext.toString().includes('Pre-existing'), 5000);
      expect(client.ytext.toString()).toContain('Already on disk');
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('opening a file without edits does not rewrite disk in normalized form', async () => {
    // Regression: Hocuspocus fires onStoreDocument after the first-pass
    // observer sync that populates Y.Text from the freshly-loaded
    // XmlFragment. That mutation is semantically a no-op, but without a
    // gate the store handler rewrites the file in TipTap's normalized form
    // (padded tables, added backslash-escapes, etc.), polluting the user's
    // git working tree on mere file open.
    //
    // Tight (unpadded) GFM table — serialization pads columns to the widest
    // cell, so this exact byte sequence differs from what TipTap emits.
    // We use a unique docName so the file-watcher update event fires before
    // the doc loads (no-op path, no reconciliation), and the subsequent
    // load+store cycle compares against the serialized-at-load baseline.
    const docName = `no-op-store-${crypto.randomUUID()}`;
    const originalBytes = '# Title\n\n| A | B |\n| - | - |\n| 1 | 22 |\n';
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, originalBytes, 'utf-8');
    // Let the file-watcher's "no loaded doc" branch drain before we open it.
    await wait(500);

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes('Title'), 5000);
      // Wait well past the server debounce (200ms) so any scheduled store
      // has a chance to fire.
      await wait(800);

      const diskAfter = readTestDoc(server.contentDir, docName);
      expect(diskAfter).toBe(originalBytes);
    } finally {
      await client.cleanup();
    }
  });

  test('opening a file with frontmatter without edits does not rewrite disk', async () => {
    // Companion to the preceding test — the no-op gate must hold on the
    // frontmatter round-trip path too. `onLoadDocument` routes frontmatter
    // through `stripFrontmatter` → `prependFrontmatter` before writing the
    // reconciledBase; `onStoreDocument` does the same before comparing.
    // A subtle byte-level drift (e.g. a stray newline between `---` and the
    // body) would break the equality check for frontmatter files while
    // leaving the non-frontmatter case passing.
    const docName = `no-op-fm-${crypto.randomUUID()}`;
    const originalBytes =
      '---\ntitle: Test\ntags: [a, b]\n---\n\n# Content\n\n| A | B |\n| - | - |\n| 1 | 22 |\n';
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, originalBytes, 'utf-8');
    await wait(500);

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes('Content'), 5000);
      await wait(800);

      const diskAfter = readTestDoc(server.contentDir, docName);
      expect(diskAfter).toBe(originalBytes);
    } finally {
      await client.cleanup();
    }
  });

  test('test-reset isolates state between tests', async () => {
    await testReset(server.port);
    await wait(300);
    const client1 = await createTestClient(server.port, 'test-doc');
    await agentWriteMd(server.port, '# Stale Content\n\nShould be gone after reset.', {
      docName: 'test-doc',
    });
    await pollUntil(() => client1.ytext.toString().includes('Stale Content'), 5000);
    expect(client1.ytext.toString()).toContain('Stale Content');
    await client1.cleanup();

    await testReset(server.port);
    await wait(300);

    const client2 = await createTestClient(server.port, 'test-doc');
    try {
      await wait(300);
      expect(client2.ytext.toString()).not.toContain('Stale Content');
    } finally {
      await client2.cleanup();
    }
  });

  test('test-reset truncates accumulated .okignore patterns by default', async () => {
    // Seed accumulated state directly on disk — simulates what an earlier
    // test would leave behind by writing patterns through the okignore
    // Settings binding (Y.Text → storeConfigDoc → atomic disk write).
    const okignorePath = join(server.contentDir, '.okignore');
    writeFileSync(okignorePath, '/leftover-from-earlier-test.md\nstale-pattern/\n', 'utf-8');

    await testReset(server.port);
    await wait(300);

    // The reset path truncates the file.
    const after = readFileSync(okignorePath, 'utf-8');
    expect(after).toBe('');
  });

  test('test-reset preserves .okignore when reset-okignore=false is passed', async () => {
    // Opt-out path for the rare test that intentionally seeds okignore
    // and needs the patterns to survive a between-test reset.
    const okignorePath = join(server.contentDir, '.okignore');
    const seeded = '/keep-me-on-reset.md\n';
    writeFileSync(okignorePath, seeded, 'utf-8');

    const res = await fetch(`http://127.0.0.1:${server.port}/api/test-reset?reset-okignore=false`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);
    await wait(300);

    expect(readFileSync(okignorePath, 'utf-8')).toBe(seeded);
  });
});

// ─── Multi-client sync ───

describe('multi-client sync', () => {
  let clientA: TestClient;
  let clientB: TestClient;

  beforeEach(async () => {
    await testReset(server.port);
    await wait(600);
    // Multi-client tests MUST share a docName so the CRDT layer links both
    // providers to the same Y.Doc. Pass 'test-doc' explicitly — the default
    // is per-test randomUUID for isolation, which would produce two
    // independent docs that never sync.
    // Multi-client cross-mode tests produce transient bridge invariant
    // violations (e.g., one client's source-mode edit in Y.Text before
    // Observer B applies it to XmlFragment). Skip the per-tx watcher;
    // assertClientsConverged verifies settled-state convergence.
    clientA = await createTestClient(server.port, 'test-doc', { skipInvariantWatcher: true });
    clientB = await createTestClient(server.port, 'test-doc', { skipInvariantWatcher: true });
    // Wait for server observer to initialize on the freshly loaded doc
    await wait(200);
  });

  afterEach(async () => {
    // cleanup() is async (testReset wrapped in try/catch).
    // Missing await would let the test.concurrent() runner race ahead into
    // the next test before the server-side doc unloads.
    await clientA?.cleanup();
    await clientB?.cleanup();
    // Wait for WebSocket connections to fully close before the next testReset.
    // provider.destroy() sends a close frame but the socket close is async —
    // if we proceed immediately, old providers can reconnect into the reset
    // document and push stale state from previous tests.
    await wait(500);
  });

  test('client A WYSIWYG edit propagates to client B source view', async () => {
    appendParagraphToFragment(clientA, 'Client A wrote from WYSIWYG.');

    await pollUntil(() => clientB.ytext.toString().includes('Client A wrote from WYSIWYG.'), 5000);

    expect(clientB.ytext.toString()).toContain('Client A wrote from WYSIWYG.');
    expect(serializeFragment(clientB.fragment)).toContain('Client A wrote from WYSIWYG.');
    assertClientsConverged(clientA, clientB);
  });

  test('client A source edit propagates to client B WYSIWYG view', async () => {
    clientA.doc.transact(() => {
      clientA.ytext.insert(0, '# Shared Heading\n\nClient A typed from source mode.\n');
    }, 'user-edit');

    await pollUntil(
      () => serializeFragment(clientB.fragment).includes('Client A typed from source mode.'),
      5000,
    );

    expect(serializeFragment(clientB.fragment)).toContain('Shared Heading');
    expect(serializeFragment(clientB.fragment)).toContain('Client A typed from source mode.');
    assertClientsConverged(clientA, clientB);
  });

  // Skip: ordering-dependent when run after prior multi-client tests that share
  // 'test-doc'. The server-authoritative observer's per-doc baseline leaks across
  // testReset boundaries. Replaced by c3-mixed-mode.test.ts which uses per-test
  // docName isolation and validates the same scenario deterministically.
  test.skip('simultaneous cross-mode edits on two clients converge', async () => {
    await agentWriteMd(server.port, '# Shared Base\n\nStarting point.', { docName: 'test-doc' });
    await pollUntil(() => clientA.ytext.toString().includes('Shared Base'), 5000);
    await pollUntil(() => clientB.ytext.toString().includes('Shared Base'), 5000);

    appendParagraphToFragment(clientA, 'CLIENT-A-WYSIWYG-MARKER');

    clientB.doc.transact(() => {
      clientB.ytext.insert(clientB.ytext.length, '\n\nCLIENT-B-SOURCE-MARKER\n');
    }, 'user-edit');

    await pollUntil(() => clientA.ytext.toString().includes('CLIENT-B-SOURCE-MARKER'), 5000);
    await pollUntil(() => clientB.ytext.toString().includes('CLIENT-A-WYSIWYG-MARKER'), 5000);
    // Wait for observer debounces (50ms each) + remote-tree grace window (150ms) to settle.
    // 800ms accounts for unified pipeline serialize latency.
    await wait(800);

    expect(clientA.ytext.toString()).toContain('CLIENT-A-WYSIWYG-MARKER');
    expect(clientA.ytext.toString()).toContain('CLIENT-B-SOURCE-MARKER');
    expect(clientB.ytext.toString()).toContain('CLIENT-A-WYSIWYG-MARKER');
    expect(clientB.ytext.toString()).toContain('CLIENT-B-SOURCE-MARKER');
    assertClientsConverged(clientA, clientB);
  });

  // Skip: ordering-dependent shared-doc baseline leak (same cause as
  // 'simultaneous cross-mode'). Replaced by c6-mode-switch-mid-debounce.test.ts
  // which uses per-test docName isolation.
  test.skip('local typing defer does not block remote source edits from another client', async () => {
    await agentWriteMd(server.port, '# Base\n\nSeed content.', { docName: 'test-doc' });
    await pollUntil(() => clientA.ytext.toString().includes('Seed content.'), 5000);
    await pollUntil(() => clientB.ytext.toString().includes('Seed content.'), 5000);

    const typingInterval = setInterval(() => markUserTyping(), 50);
    markUserTyping();

    appendParagraphToFragment(clientA, 'CLIENT-A-LOCAL-TYPING');

    clientB.doc.transact(() => {
      clientB.ytext.insert(clientB.ytext.length, '\n\nCLIENT-B-REMOTE-SOURCE\n');
    }, 'user-edit');

    await wait(800);
    clearInterval(typingInterval);
    await pollUntil(() => clientA.ytext.toString().includes('CLIENT-B-REMOTE-SOURCE'), 5000);

    expect(clientA.ytext.toString()).toContain('CLIENT-A-LOCAL-TYPING');
    expect(clientA.ytext.toString()).toContain('CLIENT-B-REMOTE-SOURCE');
    expect(clientB.ytext.toString()).toContain('CLIENT-A-LOCAL-TYPING');
    expect(clientB.ytext.toString()).toContain('CLIENT-B-REMOTE-SOURCE');
    assertClientsConverged(clientA, clientB);
  });

  test('agent write after two-client cross-mode edits propagate preserves all contributions', async () => {
    await agentWriteMd(server.port, '# Shared Base\n\nSeed content.', { docName: 'test-doc' });
    await pollUntil(() => clientA.ytext.toString().includes('Seed content.'), 5000);
    await pollUntil(() => clientB.ytext.toString().includes('Seed content.'), 5000);

    appendParagraphToFragment(clientA, 'CLIENT-A-WYSIWYG-EDIT');

    clientB.doc.transact(() => {
      clientB.ytext.insert(clientB.ytext.length, '\n\nCLIENT-B-SOURCE-EDIT\n');
    }, 'user-edit');

    // The server agent write operates on server-side Y.Text. Wait for both client edits
    // to cross the local bridge and become shared state before appending agent content.
    await pollUntil(() => clientA.ytext.toString().includes('CLIENT-B-SOURCE-EDIT'), 5000);
    await pollUntil(() => clientB.ytext.toString().includes('CLIENT-A-WYSIWYG-EDIT'), 5000);
    await wait(400);

    await agentWriteMd(server.port, '## Agent Contribution\n\nSERVER-AGENT-CONTENT', {
      docName: 'test-doc',
    });

    await pollUntil(() => clientA.ytext.toString().includes('SERVER-AGENT-CONTENT'), 5000);
    await pollUntil(() => clientB.ytext.toString().includes('SERVER-AGENT-CONTENT'), 5000);
    await pollUntil(() => clientA.ytext.toString().includes('CLIENT-B-SOURCE-EDIT'), 5000);
    await pollUntil(() => clientB.ytext.toString().includes('CLIENT-A-WYSIWYG-EDIT'), 5000);

    expect(clientA.ytext.toString()).toContain('CLIENT-A-WYSIWYG-EDIT');
    expect(clientA.ytext.toString()).toContain('CLIENT-B-SOURCE-EDIT');
    expect(clientA.ytext.toString()).toContain('SERVER-AGENT-CONTENT');
    expect(clientB.ytext.toString()).toContain('CLIENT-A-WYSIWYG-EDIT');
    expect(clientB.ytext.toString()).toContain('CLIENT-B-SOURCE-EDIT');
    expect(clientB.ytext.toString()).toContain('SERVER-AGENT-CONTENT');
    assertClientsConverged(clientA, clientB);
  });

  test('wiki-link atom node inserted by client A converges on client B', async () => {
    appendWikiLinkToFragment(clientA, 'test-page', 'Heading', 'Display');

    await pollUntil(() => clientB.ytext.toString().includes('[[test-page#Heading|Display]]'), 5000);

    expect(clientB.ytext.toString()).toContain('[[test-page#Heading|Display]]');
    assertClientsConverged(clientA, clientB);
  });

  test('wiki-link atom node mixed with text in same paragraph converges across clients', async () => {
    const paragraph = new Y.XmlElement('paragraph');
    const before = new Y.XmlText();
    before.applyDelta([{ insert: 'See ' }]);
    const wikiLink = new Y.XmlElement('wikiLink');
    wikiLink.setAttribute('target', 'Page');
    wikiLink.setAttribute('anchor', 'Section');
    wikiLink.setAttribute('alias', 'here');
    const after = new Y.XmlText();
    after.applyDelta([{ insert: ' for details.' }]);
    paragraph.insert(0, [before, wikiLink, after]);
    clientA.fragment.push([paragraph]);

    await pollUntil(() => clientB.ytext.toString().includes('[[Page#Section|here]]'), 5000);

    expect(clientB.ytext.toString()).toContain('See [[Page#Section|here]] for details.');
    assertClientsConverged(clientA, clientB);
  });

  // Reverse direction (source→tree): exercises Observer B's inline parser for [[...]]
  // syntax under multi-client sync. Pairs with the two tree→text tests above to close
  // bidirectional coverage for atom nodes — Observer A (tree→text) serializes the
  // wikiLink node to markdown; Observer B (text→tree) parses markdown [[...]] back
  // into a structured wikiLink atom node. Different code paths, both need multi-client
  // coverage.
  test('wiki-link written as raw source text by client B materializes as atom node on client A', async () => {
    clientB.doc.transact(() => {
      clientB.ytext.insert(0, 'See [[Page#Section|here]] for details.\n');
    }, 'user-edit');

    // Observer B on clientB parses the markdown into a wikiLink atom node in its
    // XmlFragment; the XmlFragment update propagates to clientA via CRDT sync; on
    // clientA, serializeFragment round-trips the atom node back to [[...]] markdown.
    await pollUntil(
      () => serializeFragment(clientA.fragment).includes('[[Page#Section|here]]'),
      5000,
    );

    expect(serializeFragment(clientA.fragment)).toContain('See [[Page#Section|here]] for details.');
    expect(clientA.ytext.toString()).toContain('See [[Page#Section|here]] for details.');

    // Structural verification: the wikiLink exists as an atom node in clientA's
    // XmlFragment (not just raw text). Without this, the test would pass even if
    // Observer B failed to parse [[...]] into a structured node — raw text
    // round-trips identically through serialization.
    const pmJson = JSON.stringify(
      yXmlFragmentToProseMirrorRootNode(clientA.fragment, schema).toJSON(),
    );
    expect(pmJson).toContain('"type":"wikiLink"');
    expect(pmJson).toContain('"target":"Page"');
    expect(pmJson).toContain('"anchor":"Section"');
    expect(pmJson).toContain('"alias":"here"');

    assertClientsConverged(clientA, clientB);
  });
});

// ─── External-write convergence window ───

describe('V2: external-write convergence window', () => {
  test('agent write via API → content arrives during debounce window (R11)', async () => {
    const client = await createTestClient(server.port);
    try {
      // Write via agent API (uses client's unique docName)
      await agentWriteMd(server.port, '# V2 Test\n\nAgent content here.', {
        docName: client.docName,
      });

      // Poll until content arrives — during Observer A debounce window,
      // content may be in raw or canonical form (both acceptable)
      await pollUntil(() => client.ytext.toString().includes('V2 Test'), 5000);

      const textContent = normalizeMarkdown(client.ytext.toString());
      expect(textContent).toContain('V2 Test');
      expect(textContent).toContain('Agent content');

      // Bridge invariant should hold after convergence
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });
});

// ─── Multi-client Item preservation ───

describe('multi-client FR-4: agent-origin Items preserved through Observer A', () => {
  test('server agent write + client user edit — both preserved, bridge holds', async () => {
    const client = await createTestClient(server.port);

    try {
      // Step 1: Baseline via WYSIWYG
      applyMarkdownToFragment(client, 'Line one.\n\nLine two.\n');
      await wait(500);
      expect(client.ytext.toString()).toContain('Line one');

      // Step 2: Server-side agent write via HTTP API (appends content to Y.Text
      // under 'agent-write' origin — same codepath as MCP agent writes).
      // The server calls syncTextToFragment so both Y.Text and XmlFragment
      // receive the agent content.
      await agentWriteMd(server.port, 'Agent paragraph.\n', {
        docName: client.docName,
      });

      // Wait for agent write to arrive on the client (both surfaces)
      await pollUntil(() => client.ytext.toString().includes('Agent paragraph'), 5000);
      await wait(500);

      // Step 3: Client's user appends via WYSIWYG — an incremental edit,
      // not a full tree replacement. Observer A fires; if Y.Text has diverged
      // (e.g., timing of remote sync), Path B DMP merge handles it.
      markUserTyping();
      const typingInterval = setInterval(() => markUserTyping(), 30);

      appendParagraphToFragment(client, 'User added this.');

      await wait(200);
      clearInterval(typingInterval);
      await wait(1000);

      // Step 4: Both user edit and agent content should be present
      const finalText = client.ytext.toString();
      expect(finalText).toContain('User added this');
      expect(finalText).toContain('Agent paragraph');

      // Bridge invariant holds
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Server-side per-agent UM bridge-convergence safety
// ─────────────────────────────────────────────────────────────

describe('FR-4: server-side per-agent UM under bridge-convergence fixes', () => {
  test('agent write + user concurrent XmlFragment typing → both preserved, UM captures agent Items', async () => {
    const docName = `test-fr4-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);
    try {
      // 1. Seed with agent write (baseline content).
      await agentWriteMd(server.port, 'baseline paragraph.\n', { docName });
      await pollUntil(() => client.ytext.toString().includes('baseline'), 5000);

      // 2. Attach UM server-side via getServerState.
      //    trackedOrigins uses session.origin: agentWriteMd with no
      //    explicit agentId uses the default 'claude-1' session; get it from the
      //    server's session manager to obtain the object-identity-unique origin.
      const srv = getServerState(server, docName);
      if (!srv) throw new Error('Server doc not loaded');
      const agentSession = await server.instance.sessionManager.getSession(docName, 'claude-1');
      const serverUm = new Y.UndoManager(srv.ytext, {
        trackedOrigins: new Set([agentSession.origin]),
        captureTimeout: 0,
      });

      // 3. User types locally in XmlFragment (undefined origin — local WYSIWYG).
      applyMarkdownToFragment(client, 'baseline paragraph.\n\nuser typed here.\n');

      // 4. Agent writes concurrently — server composes under session.origin
      //    via applyAgentMarkdownWrite (XmlFragment-authoritative).
      await agentWriteMd(server.port, 'agent wrote after.\n', { docName, position: 'append' });
      await wait(800);

      // 5. Both contributions present on client.
      expect(client.ytext.toString()).toContain('user typed here');
      expect(client.ytext.toString()).toContain('agent wrote after');

      // 6. Server UM captured the agent's per-session origin Items by identity match.
      //    User's ORIGIN_TREE_TO_TEXT Items are correctly untracked.
      expect(serverUm.undoStack.length).toBeGreaterThan(0);

      // Bridge invariant auto-asserted by the invariant watcher throughout.
      // Note: the agent-undo path is out of scope here — applyAgentUndo uses
      // the XmlFragment-authoritative pattern. See the skip-guarded test at
      // bug-d-v0-14-agent-undo-under-concurrent-typing.test.ts.
      serverUm.destroy();
    } finally {
      await client.cleanup();
    }
  });
});
