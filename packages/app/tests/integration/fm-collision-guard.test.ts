/**
 * Frontmatter-collision guard — end-to-end pins on the real server rigs.
 *
 * A document whose body OPENS with a `---` fence pair and carries no
 * frontmatter satisfies `FRONTMATTER_RE`, so the span between the rules is
 * read as YAML and never reaches the fragment: the bytes on disk stay perfect
 * while the content disappears from the editor. Observer A composes those
 * bytes, so it is the mint site and the fix site.
 *
 * The composition contract itself is unit-pinned alongside `core`'s bridge
 * compose module; this file pins the behaviours only the running server can
 * show — the drain,
 * the derive-timing defer bookkeeping, remote-peer convergence, the property
 * panel's HTTP surface, and the byte-sacred agent paths that must stay
 * untouched.
 */

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

/** Append a `thematicBreak` node — the WYSIWYG mint that opens the collision. */
function appendRule(client: TestClient): void {
  client.fragment.push([new Y.XmlElement('thematicBreak')]);
}

/** Append a paragraph carrying `text`. */
function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const inner = new Y.XmlText();
  inner.applyDelta([{ insert: text }]);
  paragraph.insert(0, [inner]);
  client.fragment.push([paragraph]);
}

/** Build the family's canonical shape in the fragment: rule, x, rule, y. */
function mintRulePair(client: TestClient): void {
  client.doc.transact(() => {
    appendRule(client);
    appendParagraph(client, 'x');
    appendRule(client);
    appendParagraph(client, 'y');
  });
}

/**
 * Wait for Observer A to drain, then read the SERVER's Y.Text — the bytes
 * persistence writes and every witness compares against.
 */
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

      // The guard re-spelled the leading rule, so the partition finds no
      // frontmatter and the whole body reaches Observer B.
      expect(stripFrontmatter(ytext).frontmatter).toBe('');
      expect(ytext.startsWith('***')).toBe(true);
      expect(ytext).toContain('x');
      expect(ytext).toContain('y');

      // The view survives: all four nodes are still there after the round trip.
      const state = getServerState(server, client.docName);
      expect(state?.md).toContain('x');
      expect(state?.md).toContain('y');
      expect(state?.fragment.length).toBe(4);
    } finally {
      await client.cleanup();
    }
  });

  /**
   * The cell the withdrawn attempt failed. With real frontmatter the
   * composition is already unambiguous, so a re-spell here would be a
   * gratuitous rewrite of an authored rule AND a false positive in the
   * bridge-invariant channel — `normalizeBridge`'s doc-start step is anchored
   * at offset 0 and reaches only the frontmatter's own fence.
   *
   */
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
      // The authored `---` spelling is untouched — no `***` anywhere.
      expect(ytext).not.toContain('***');
      expect(violations).toEqual([]);
    } finally {
      detach();
      await client.cleanup();
    }
  });

  /**
   * Adding frontmatter makes the composition unambiguous again, so the guard
   * stops firing — but the re-spelled rule does NOT churn back. The serializer
   * preserves the current spelling through `sourceRaw`, so the guarded rule is
   * simply what the document now says, and a frontmatter edit costs zero body
   * bytes. The transition is where a naive guard would oscillate, so the pin
   * is that the bytes settle and stay settled.
   *
   */
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
      // Settled: a second quiescence pass moves nothing — no oscillation.
      expect(await settled(client)).toBe(withFm);
      // …and the content is all still reachable through the partition.
      expect(stripFrontmatter(withFm).body).toContain('x');
    } finally {
      await client.cleanup();
    }
  });
});

describe('guard consistency', () => {
  /**
   * The derive-timing defer predicate is a raw line-count three-way with no
   * `normalizeBridge` pass. If the drain composes the re-spelled rule while a
   * witness or the fresh-fragment comparand composes the original, the surplus
   * line reads as pending content: every drain defers, and at the bound the
   * document is force-resolved with a checkpoint and a ring event it never
   * earned. Sustained editing on a guarded document must produce neither.
   *
   */
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

      // Y.Text carries the guarded spelling while the fragment still holds the
      // rule the user minted — the exact difference `doc-start-thematic`
      // exists to absorb, and the bridge invariant is stated modulo the
      // tolerance set, not on raw bytes.
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

  /**
   * Layer-A unit tests run with `transaction.local = true`, which is not the
   * production path — a remote peer receives the guarded write over the wire
   * with `local = false`. Both surfaces must land the same bytes.
   *
   */
  test('a remote peer converges raw-byte-equal on a guard-active edit', async () => {
    const [author, peer] = await createTestClients(server.port, { count: 2 });
    try {
      mintRulePair(author);
      await settled(author);
      await assertAllConverged([author, peer]);

      const authorBytes = author.ytext.toString();
      expect(authorBytes.startsWith('***')).toBe(true);
      // Raw bytes, not normalized — the peer must not hold a different
      // spelling that only agrees within tolerance.
      expect(peer.ytext.toString()).toBe(authorBytes);
      expect(peer.ytext.toString()).toContain('x');
    } finally {
      await Promise.all([author.cleanup(), peer.cleanup()]);
    }
  });
});

describe('byte-sacred paths stay untouched', () => {
  /**
   * The agent write path is byte-faithful by contract (precedent #57) and
   * `evaluateContentDivergence` re-reads Y.Text after every write. A guard
   * leaking into it would trip that tripwire on the first `---`-leading
   * payload, so its silence is the regression signal.
   *
   */
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
        // The composed FM span is a non-mapping, so replace already refuses
        // it — that refusal IS the byte-sacred contract holding.
        expect(err.status).toBe(400);
      });

      // A payload that carries no ambiguity lands byte-for-byte.
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
  /**
   * A frontmatter region captured at end-of-string has no trailing newline, so
   * the drain's composition used to glue the closing fence onto the body's
   * first line and destroy the block — corrupt bytes reaching disk.
   *
   */
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

  /**
   * Deleting the last property removes the whole block. Over a body that opens
   * with a rule pair that hands the body's own bytes to the next partition —
   * the family-3 loss, minted from the frontmatter side where a serialize-side
   * guard can never see it, and reaching disk through HTTP.
   *
   */
  test('keeps an explicit block when removing it would re-partition the body', async () => {
    const client = await createTestClient(server.port);
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '---\ntitle: t\n---\n---\n\nx\n\n---\n\ny\n');
      });
      await settled(client);

      expect(await patchFrontmatter(client.docName, { title: null })).toBe(200);
      const ytext = await settled(client);

      // The body is byte-identical and still partitions off cleanly.
      const partition = stripFrontmatter(ytext);
      expect(partition.frontmatter).toBe('---\n\n---\n');
      expect(partition.body).toBe('---\n\nx\n\n---\n\ny\n');
      // The content the old behaviour ate is still in the view.
      expect(getServerState(server, client.docName)?.md).toContain('x');

      // The panel path reaches disk — B13's loss was observed there, so the
      // fix has to be observed there too.
      await pollUntil(() => readTestDoc(server.contentDir, client.docName).includes('x'), 5_000);
    } finally {
      await client.cleanup();
    }
  });

  /**
   * The retention is narrow — an ordinary document must still lose the block
   * completely, or every property deletion would leave an artifact.
   *
   */
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

  /**
   * The verdict follows the COMPOSED DOCUMENT, not the payload's shape.
   *
   * This file's whole thesis is a document whose body OPENS with a `---` fence
   * pair — offset 0 is what makes the span satisfy `FRONTMATTER_RE` and vanish
   * into the YAML region. `replace` puts the payload at offset 0 by
   * definition, and `prepend` puts it there whenever the document carries no
   * frontmatter, so both still refuse. An `append` onto a non-empty body
   * cannot reach offset 0: the same bytes compose into a document with no
   * frontmatter region at all, where the fence pair is an ordinary thematic
   * break. Refusing that was the bug this pins against — it left the agent no
   * move but a whole-document rewrite, which clobbers concurrent writers.
   *
   * The earlier reading judged the payload in isolation and called the
   * position split an asymmetry. It is one rule ("may the composed document
   * end up with a frontmatter region the agent never asked for?") reaching
   * three different composed documents. Same anchor the sibling WYSIWYG guard
   * above uses: `normalizeBridge`'s doc-start step is anchored at offset 0.
   *
   */
  test('an ambiguous payload is refused where it would land at offset 0', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, 'seed\n', {
        docName: client.docName,
        position: 'replace',
      });
      await settled(client);

      const ambiguous = '---\n\nx\n\n---\n\ny\n';
      // `replace` makes the payload the whole document: the fence pair IS the
      // frontmatter region, and it is not a mapping.
      expect(await writeRaw(client.docName, ambiguous, 'replace')).toBe(400);
      // `prepend` onto a frontmatter-less document lands at offset 0 too.
      expect(await writeRaw(client.docName, ambiguous, 'prepend')).toBe(400);

      // Both refusals leave the document untouched.
      expect(getServerState(server, client.docName)?.ytext.toString()).toBe('seed\n');
    } finally {
      await client.cleanup();
    }
  });

  /**
   * The other side of the same rule, and the case the bug report was filed
   * about. Appending onto a non-empty body puts the fence pair mid-document,
   * where it is a thematic break and nothing is claimed as frontmatter — so
   * the write lands, and the content survives all the way into the fragment
   * rather than disappearing into a YAML region.
   *
   */
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

      // No frontmatter region was created — the document still opens with its
      // own body, so the fence pair never reaches offset 0.
      expect(stripFrontmatter(ytext).frontmatter).toBe('');
      expect(ytext.startsWith('seed')).toBe(true);

      // The agent's bytes are intact: no re-spell, no dropped span. This is
      // the byte-sacred agent path, not the WYSIWYG mint.
      expect(ytext).toContain('---');
      expect(ytext).toContain('x');
      expect(ytext).toContain('y');

      // And the content reached the fragment rather than vanishing into a
      // YAML region — the collision this file exists to catch did not happen.
      const state = getServerState(server, client.docName);
      expect(state?.md).toContain('x');
      expect(state?.md).toContain('y');
      expect(violations).toEqual([]);
    } finally {
      detach();
      await client.cleanup();
    }
  });

  /**
   * The offset-0 sibling of the append case: with an EMPTY body there is
   * nothing in front of the payload, so append lands at offset 0 exactly like
   * prepend and refuses on the same rule.
   *
   */
  test('append onto an EMPTY body refuses — it lands at offset 0 too', async () => {
    const client = await createTestClient(server.port);
    try {
      expect(await writeRaw(client.docName, '---\n\nx\n\n---\n\ny\n', 'append')).toBe(400);
      expect(getServerState(server, client.docName)?.ytext.toString() ?? '').toBe('');
    } finally {
      await client.cleanup();
    }
  });

  /**
   * A well-formed frontmatter payload keeps its documented silent drop: the
   * span parses as a mapping, the body still lands, and the bound is specified.
   * Only the unparseable case — body content being destroyed — became a
   * refusal.
   *
   */
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
