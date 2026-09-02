import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, getServerState, mdManager, type TestServer } from './test-harness.ts';

const schema = getSchema(sharedExtensions);
const freshMdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const STALE_LINE = 'Step one bod';
const PENDING_LINE = 'Step one body.';

function mutateFirstText(node: JSONContent, from: string, to: string): boolean {
  if (typeof node.text === 'string' && node.text === from) {
    node.text = to;
    return true;
  }
  for (const child of node.content ?? []) {
    if (mutateFirstText(child, from, to)) return true;
  }
  return false;
}

function serializeFragment(fragment: Y.XmlFragment): string {
  return freshMdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

function guardDisabledContentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-defer-guard-off-'));
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), 'bridge:\n  deferGuard:\n    enabled: false\n');
  writeFileSync(join(dir, 'test-doc.md'), '', 'utf-8');
  return dir;
}

describe('derive-timing guard — full-flow on a booted server', () => {
  let server: TestServer;
  let ownedContentDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await server.cleanup();
    if (ownedContentDir) rmSync(ownedContentDir, { recursive: true, force: true });
    ownedContentDir = undefined;
  });

  test(
    'the config-wired guard preserves an un-propagated keystroke on the real server',
    async () => {
      server = await createTestServer();
      const docName = `defer-full-${crypto.randomUUID().slice(0, 8)}`;
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
      });
      expect(res.status).toBe(200);

      const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
      expect(doc).toBeTruthy();
      const state = getServerState(server, docName);
      expect(state?.ytext.toString()).toContain(STALE_LINE);
      const ytext = state?.ytext as Y.Text;
      const fragment = state?.fragment as Y.XmlFragment;

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10_000);

      doc.transact(() => {
        ytext.insert(ytext.length, '\nTrailing.\n');
      }, 'external-peer');

      const echo = mdManager.parse(ytext.toString()) as JSONContent;
      expect(mutateFirstText(echo, STALE_LINE, PENDING_LINE)).toBe(true);
      doc.transact(() => {
        updateYFragment(doc, fragment, schema.nodeFromJSON(echo), {
          mapping: new Map(),
          isOMark: new Map(),
        });
      }, 'wysiwyg-echo');
      expect(serializeFragment(fragment)).toContain(PENDING_LINE);
      expect(ytext.toString()).not.toContain(PENDING_LINE);

      doc.transact(() => {
        ytext.insert(ytext.length, '\nAnother source line.\n');
      }, 'external-peer');

      expect(serializeFragment(fragment)).toContain(PENDING_LINE);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'with the guard config-disabled the same staging stomps the keystroke',
    async () => {
      ownedContentDir = guardDisabledContentDir();
      server = await createTestServer({ contentDir: ownedContentDir, keepContentDir: true });
      ownedContentDir = server.contentDir;
      const docName = `defer-off-${crypto.randomUUID().slice(0, 8)}`;
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
      });
      expect(res.status).toBe(200);

      const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
      const state = getServerState(server, docName);
      const ytext = state?.ytext as Y.Text;
      const fragment = state?.fragment as Y.XmlFragment;

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10_000);
      doc.transact(() => {
        ytext.insert(ytext.length, '\nTrailing.\n');
      }, 'external-peer');
      const echo = mdManager.parse(ytext.toString()) as JSONContent;
      expect(mutateFirstText(echo, STALE_LINE, PENDING_LINE)).toBe(true);
      doc.transact(() => {
        updateYFragment(doc, fragment, schema.nodeFromJSON(echo), {
          mapping: new Map(),
          isOMark: new Map(),
        });
      }, 'wysiwyg-echo');
      expect(serializeFragment(fragment)).toContain(PENDING_LINE);
      expect(ytext.toString()).not.toContain(PENDING_LINE);

      doc.transact(() => {
        ytext.insert(ytext.length, '\nAnother source line.\n');
      }, 'external-peer');

      const afterOff = serializeFragment(fragment);
      expect(afterOff).not.toContain(PENDING_LINE);
      expect(afterOff).toContain(STALE_LINE);
      expect(afterOff).toContain('Another source line.');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
