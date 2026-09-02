import type { AdvisoryWarning } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
    expect(body.warning).toBeUndefined();
  });

  test('valid fences and fence-less docs carry no render warnings', async () => {
    const valid = await writeMd(VALID_FENCE, uniqueDoc('rw-valid'));
    expect(valid.status).toBe(200);
    expect((valid.body.warnings ?? []).filter((w) => w.kind === 'mermaid-parse-error')).toEqual([]);

    const plain = await writeMd('# Plain\n\nNo diagrams.', uniqueDoc('rw-plain'));
    expect(plain.status).toBe(200);
    expect((plain.body.warnings ?? []).filter((w) => w.kind === 'mermaid-parse-error')).toEqual([]);
  });

  test('append composition is validated on the post-write state', async () => {
    const docName = uniqueDoc('rw-append');
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
    const pollDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100; i++) {
      if (getServerState(server, docName)?.ytext.toString().includes('body-v1')) break;
      await pollDelay(20);
    }
    writeFileSync(
      join(server.contentDir, `${docName}.md`),
      '# V2 NATIVE OUT-OF-BAND EDIT\n\nbody-v2-native\n',
      'utf-8',
    );
    const { status, body } = await writeMd(
      '\n```mermaid\nsequenceDiagram\n  A->>B: hi; there\n```\n',
      docName,
      'append',
    );
    expect(status).toBe(200);
    const kinds = (body.warnings ?? []).map((w) => w.kind).sort();
    expect(kinds).toEqual(['disk-edit-reconciled', 'mermaid-parse-error']);
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
    const cfgPath = join(server.contentDir, '.ok', 'config.yml');
    writeFileSync(cfgPath, 'contentRules:\n  markdownlint:\n    enabled: true\n', 'utf-8');
    try {
      const docName = uniqueDoc('rw-lint-style');
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

  test('a dead link written by THIS write rides warnings[] immediately (no index-debounce race)', async () => {
    const docName = uniqueDoc('rw-dead-link');
    const target = `rw-ghost-${crypto.randomUUID().slice(0, 8)}`;
    const { status, body } = await writeMd(`# Doc\n\nSee [[${target}]].\n`, docName);
    expect(status).toBe(200);
    const dead = (body.warnings ?? []).find(
      (w) => w.kind === 'lint-violation' && w.code === 'dead-link',
    );
    expect(dead).toBeDefined();
    if (dead?.kind !== 'lint-violation') throw new Error('narrowed above');
    expect(dead.source).toBe('links');
    expect(dead.severity).toBe('warning');
    expect(dead.message).toContain(target);
    expect(dead.linkTarget).toBe(target);
    expect(dead.line).toBe(3);
  });

  test('a resolving link and validation.links=off both yield no dead-link advisory', async () => {
    const existing = uniqueDoc('rw-existing');
    await writeMd('# Exists\n', existing);
    const linker = uniqueDoc('rw-good-link');
    const good = await writeMd(`# Doc\n\nSee [[${existing}]].\n`, linker);
    expect(good.status).toBe(200);
    expect(
      (good.body.warnings ?? []).some((w) => w.kind === 'lint-violation' && w.code === 'dead-link'),
    ).toBe(false);

    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cfgPath = join(server.contentDir, '.ok', 'config.yml');
    writeFileSync(cfgPath, 'validation:\n  links: off\n', 'utf-8');
    try {
      const silenced = await writeMd(
        '# Doc\n\nSee [[definitely-missing-target]].\n',
        uniqueDoc('rw-off'),
      );
      expect(silenced.status).toBe(200);
      expect(
        (silenced.body.warnings ?? []).some(
          (w) => w.kind === 'lint-violation' && w.code === 'dead-link',
        ),
      ).toBe(false);
    } finally {
      writeFileSync(cfgPath, '', 'utf-8');
    }
  });
});
