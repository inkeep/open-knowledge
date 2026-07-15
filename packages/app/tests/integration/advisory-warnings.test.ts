/**
 * L1 integration coverage for the unified advisory channel on the agent
 * write path: `POST /api/agent-write-md` and `POST /api/agent-patch` report
 * post-write mermaid parse failures (and co-occurring write-integrity
 * advisories) as `warnings` entries without affecting the write itself
 * (storage stays byte-faithful; advisory only). The deprecated single-valued
 * `warning` field never carries render entries.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AdvisoryWarning } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, getServerState, type TestServer } from './test-harness.ts';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

interface WriteResponse {
  timestamp?: string;
  warning?: { kind?: string };
  warnings?: AdvisoryWarning[];
  [key: string]: unknown;
}

async function writeMd(
  markdown: string,
  docName: string,
  position: 'append' | 'prepend' | 'replace' = 'replace',
): Promise<{ status: number; body: WriteResponse }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, position, docName }),
  });
  return { status: res.status, body: (await res.json()) as WriteResponse };
}

async function patchDoc(
  docName: string,
  find: string,
  replace: string,
): Promise<{ status: number; body: WriteResponse }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, find, replace }),
  });
  return { status: res.status, body: (await res.json()) as WriteResponse };
}

const uniqueDoc = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

const INVALID_SEQUENCE_FENCE =
  '# Doc\n\n```mermaid\nsequenceDiagram\n    A->>B: payload + nonce; cookie cleared\n```\n';
const VALID_FENCE = '# Doc\n\n```mermaid\ngraph LR\n  A-->B\n```\n';

describe('advisory warnings on POST /api/agent-write-md', () => {
  test('an invalid mermaid fence yields a locator + line-numbered warning', async () => {
    const docName = uniqueDoc('rw-invalid');
    const { status, body } = await writeMd(INVALID_SEQUENCE_FENCE, docName);
    expect(status).toBe(200);
    expect(body.warnings).toHaveLength(1);
    const w = body.warnings?.[0];
    expect(w?.kind).toBe('mermaid-parse-error');
    if (w?.kind !== 'mermaid-parse-error') throw new Error('unreachable');
    expect(w.fenceIndex).toBe(1);
    expect(w.fenceFirstLine).toBe('sequenceDiagram');
    expect(w.message).toContain('Parse error');
    expect(w.line).toBeGreaterThan(0);
    // Render entries never ride the deprecated single-valued `warning` slot.
    expect(body.warning).toBeUndefined();
  });

  test('valid fences and fence-less docs carry no render warnings', async () => {
    // Filter to render entries: lint-violation advisories (e.g. MD047 on a
    // fixture without a trailing newline) legitimately ride the same array.
    const valid = await writeMd(VALID_FENCE, uniqueDoc('rw-valid'));
    expect(valid.status).toBe(200);
    expect((valid.body.warnings ?? []).filter((w) => w.kind === 'mermaid-parse-error')).toEqual([]);

    const plain = await writeMd('# Plain\n\nNo diagrams.', uniqueDoc('rw-plain'));
    expect(plain.status).toBe(200);
    expect((plain.body.warnings ?? []).filter((w) => w.kind === 'mermaid-parse-error')).toEqual([]);
  });

  test('append composition is validated on the post-write state', async () => {
    const docName = uniqueDoc('rw-append');
    // An unclosed fence is valid mermaid on its own (CommonMark runs it to
    // EOF) — the appended prose lands INSIDE the fence body and breaks it.
    const first = await writeMd('```mermaid\ngraph LR\n  A-->B', docName);
    expect((first.body.warnings ?? []).filter((w) => w.kind === 'mermaid-parse-error')).toEqual([]);

    const second = await writeMd('\nplain prose now inside the fence', docName, 'append');
    expect(second.status).toBe(200);
    const render = (second.body.warnings ?? []).filter((w) => w.kind === 'mermaid-parse-error');
    expect(render).toHaveLength(1);
    const w = render[0];
    expect(w?.kind === 'mermaid-parse-error' && w.fenceFirstLine).toBe('graph LR');
  });

  test('the write lands byte-faithfully regardless of warnings (advisory only)', async () => {
    const docName = uniqueDoc('rw-faithful');
    const { status, body } = await writeMd(INVALID_SEQUENCE_FENCE, docName);
    expect(status).toBe(200);
    expect(typeof body.timestamp).toBe('string');
    const state = getServerState(server, docName);
    // The invalid fence is stored exactly as written — the `;` that breaks
    // the grammar is preserved (storage never sanitizes).
    expect(state?.ytext.toString()).toContain('A->>B: payload + nonce; cookie cleared');
    expect(state?.ytext.toString()).toBe(INVALID_SEQUENCE_FENCE);
  });
});

describe('advisory warnings on POST /api/frontmatter-patch', () => {
  test('a reconciled out-of-band edit reaches warnings[] alongside the deprecated slot', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const docName = uniqueDoc('rw-fm');
    await writeMd('---\ntitle: v1\n---\n\n# Doc\n\nbody-v1\n', docName);
    const pollDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100; i++) {
      if (getServerState(server, docName)?.ytext.toString().includes('body-v1')) break;
      await pollDelay(20);
    }
    writeFileSync(
      join(server.contentDir, `${docName}.md`),
      '---\ntitle: v1\n---\n\n# Doc\n\nbody-v2-native\n',
      'utf-8',
    );
    const res = await fetch(`http://127.0.0.1:${server.port}/api/frontmatter-patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, patch: { status: 'draft' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WriteResponse;
    expect(body.warning?.kind).toBe('disk-edit-reconciled');
    expect(body.warnings?.map((w) => w.kind)).toEqual(['disk-edit-reconciled']);
  });
});

describe('advisory co-occurrence (the unification win: no masking)', () => {
  test('a reconciled out-of-band edit and a broken fence surface together', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const docName = uniqueDoc('rw-cooccur');
    await writeMd('# V1\n\nbody-v1\n', docName);
    // Wait for the L1 store so the doc exists on disk before the native edit.
    const pollDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100; i++) {
      if (getServerState(server, docName)?.ytext.toString().includes('body-v1')) break;
      await pollDelay(20);
    }
    // Native out-of-band edit straight to disk, bypassing OK; the next agent
    // write must reconcile it (disk-edit-reconciled advisory).
    writeFileSync(
      join(server.contentDir, `${docName}.md`),
      '# V2 NATIVE OUT-OF-BAND EDIT\n\nbody-v2-native\n',
      'utf-8',
    );
    // The agent append also carries a grammar-broken mermaid fence.
    const { status, body } = await writeMd(
      '\n```mermaid\nsequenceDiagram\n  A->>B: hi; there\n```\n',
      docName,
      'append',
    );
    expect(status).toBe(200);
    const kinds = (body.warnings ?? []).map((w) => w.kind).sort();
    expect(kinds).toEqual(['disk-edit-reconciled', 'mermaid-parse-error']);
    // The deprecated single slot carries only its highest-precedence
    // integrity entry — the render entry exists ONLY in `warnings`.
    expect(body.warning?.kind).toBe('disk-edit-reconciled');
  });
});

describe('advisory warnings on POST /api/agent-patch', () => {
  test('a body edit that breaks a fence yields a warning', async () => {
    const docName = uniqueDoc('rw-patch');
    await writeMd(VALID_FENCE, docName);
    const { status, body } = await patchDoc(docName, 'A-->B', 'A[unclosed --> B');
    expect(status).toBe(200);
    expect(body.warnings).toHaveLength(1);
    const w = body.warnings?.[0];
    expect(w?.kind === 'mermaid-parse-error' && w.fenceFirstLine).toBe('graph LR');
  });

  test('an unrelated edit surfaces a pre-existing broken fence with its locator', async () => {
    const docName = uniqueDoc('rw-preexisting');
    await writeMd(`${INVALID_SEQUENCE_FENCE}\nTrailing prose paragraph.\n`, docName);
    // Edit only the prose — the broken fence predates this edit, and the
    // locator fields point the agent at it (deliberate surfacing semantics).
    const { status, body } = await patchDoc(docName, 'Trailing prose', 'Edited prose');
    expect(status).toBe(200);
    expect(body.warnings).toHaveLength(1);
    const w = body.warnings?.[0];
    expect(w?.kind === 'mermaid-parse-error' && w.fenceIndex).toBe(1);
    expect(w?.kind === 'mermaid-parse-error' && w.fenceFirstLine).toBe('sequenceDiagram');
  });

  test('an edit fixing the only broken fence clears the warning', async () => {
    const docName = uniqueDoc('rw-fix');
    await writeMd(INVALID_SEQUENCE_FENCE, docName);
    const { body } = await patchDoc(docName, 'nonce; cookie cleared', 'nonce, cookie cleared');
    expect(body.warnings).toBeUndefined();
  });
});

describe('content-rule (lint) violations on the agent write path', () => {
  test('markdownlint violations ride warnings[] so agents see what the GUI shows', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // markdownlint is opt-in (off by default); enable it for this project so the
    // write-path advisory surfaces the violation the GUI would show. The base
    // config is read fresh per request, so writing it here takes effect on the
    // write below. Restore it afterward so sibling tests keep the default (off).
    const cfgPath = join(server.contentDir, '.ok', 'config.yml');
    writeFileSync(cfgPath, 'contentRules:\n  markdownlint:\n    enabled: true\n', 'utf-8');
    try {
      const docName = uniqueDoc('rw-lint-style');
      // The body carries a hard tab (markdownlint MD010). Agent writes surface
      // the same content-rule violations the editor GUI shows — whole-doc,
      // advisory only, capped — so an MCP client learns about them without a
      // separate `lint` round-trip.
      const { status, body } = await writeMd(
        '---\ntitle: Hi\n---\n\n# Doc\n\n\tindented\n',
        docName,
      );
      expect(status).toBe(200);
      const lint = (body.warnings ?? []).filter((w) => w.kind === 'lint-violation');
      expect(lint.length).toBeGreaterThan(0);
      const md010 = lint.find((w) => w.kind === 'lint-violation' && w.code === 'MD010');
      expect(md010?.kind === 'lint-violation' && md010.source).toBe('markdownlint');
      expect(md010?.kind === 'lint-violation' && md010.line).toBe(7);
    } finally {
      writeFileSync(cfgPath, '', 'utf-8');
    }
  });
});
