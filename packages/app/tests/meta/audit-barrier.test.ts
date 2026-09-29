import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pauseAuditAtDocument } from '../integration/audit-barrier.test-helper.ts';
import { HARNESS_BOOT_TIMEOUT_MS } from '../integration/harness-boot-timeout.ts';
import { createTestServer, type TestServer } from '../integration/test-harness.ts';

let server: TestServer;

const TABBED_SOURCE = '# Title\n\nParagraph with\ta hard tab.\n';
const DOC_COUNT = 3;

beforeAll(async () => {
  server = await createTestServer({ markdownlintEnabled: true });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function seedScope(scope: string): string {
  const folder = join(server.contentDir, scope);
  mkdirSync(folder, { recursive: true });
  for (let i = 0; i < DOC_COUNT; i += 1) {
    writeFileSync(join(folder, `doc-${i}.md`), TABBED_SOURCE, 'utf-8');
  }
  return folder;
}

function markdownlintOnConfig(): core.LinterConfig {
  const base = core.DEFAULT_LINTER_CONFIG;
  return {
    ...base,
    plugins: {
      ...base.plugins,
      markdownlint: { ...base.plugins.markdownlint, enabled: true },
    },
  };
}

describe('pauseAuditAtDocument', () => {
  test('holds the in-process server audit walk inside lintDocument and releases it', async () => {
    const scope = 'barrier-hold';
    const folder = seedScope(scope);
    const original = core.lintDocument;
    const barrier = pauseAuditAtDocument(`${scope}/doc-1.md`);
    let status = 0;
    try {
      const audit = fetch(`${server.baseUrl}/api/audit?path=${scope}`);
      await barrier.waitUntilStarted();
      const observedWhileHeld = barrier.observedDocuments();
      expect(observedWhileHeld).toContain(`${scope}/doc-0.md`);
      expect(observedWhileHeld.at(-1)).toBe(`${scope}/doc-1.md`);
      barrier.release();
      const res = await audit;
      status = res.status;
      await res.text();
    } finally {
      barrier.dispose();
      rmSync(folder, { recursive: true, force: true });
    }
    expect(status).toBe(200);
    expect(core.lintDocument).toBe(original);
  });

  test('does not fire for a document the audit never visits, and names that document when it gives up', async () => {
    const scope = 'barrier-miss';
    const folder = seedScope(scope);
    const original = core.lintDocument;
    const barrier = pauseAuditAtDocument('never-visited/doc.md');
    try {
      const res = await fetch(`${server.baseUrl}/api/audit?path=${scope}`);
      expect(res.status).toBe(200);
      await res.text();
      expect(barrier.observedDocuments()).toContain(`${scope}/doc-1.md`);
      await expect(barrier.waitUntilStarted(50)).rejects.toThrow(
        'the server-side audit walk to enter lintDocument for never-visited/doc.md',
      );
    } finally {
      barrier.dispose();
      rmSync(folder, { recursive: true, force: true });
    }
    expect(core.lintDocument).toBe(original);
  });

  test('refuses a release that comes before the audit walk reaches the held document', () => {
    const original = core.lintDocument;
    const barrier = pauseAuditAtDocument('barrier-early-release/doc.md');
    try {
      expect(() => barrier.release()).toThrow(
        'release() before the server-side audit walk entered lintDocument for barrier-early-release/doc.md',
      );
    } finally {
      barrier.dispose();
    }
    expect(core.lintDocument).toBe(original);
  });

  test('refuses a second barrier while an earlier one is still installed', () => {
    const original = core.lintDocument;
    const barrier = pauseAuditAtDocument('barrier-double-install/first.md');
    try {
      expect(() => pauseAuditAtDocument('barrier-double-install/second.md')).toThrow(
        'already mocked',
      );
    } finally {
      barrier.dispose();
    }
    expect(core.lintDocument).toBe(original);
  });

  test('delegates to the real lintDocument instead of standing in for it', async () => {
    const config = markdownlintOnConfig();
    const expected = await core.lintDocument(TABBED_SOURCE, config, 'barrier-delegation/free.md');
    expect(expected.length).toBeGreaterThan(0);

    const original = core.lintDocument;
    const barrier = pauseAuditAtDocument('barrier-delegation/held.md');
    try {
      const free = await core.lintDocument(TABBED_SOURCE, config, 'barrier-delegation/free.md');
      expect(free).toEqual(expected);

      const heldCall = core.lintDocument(TABBED_SOURCE, config, 'barrier-delegation/held.md');
      await barrier.waitUntilStarted();
      barrier.release();
      expect(await heldCall).toEqual(expected);
    } finally {
      barrier.dispose();
    }
    expect(core.lintDocument).toBe(original);
  });
});
