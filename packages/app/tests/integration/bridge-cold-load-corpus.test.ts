import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { createTestClient, createTestServer, type TestServer } from './test-harness';

const WORKTREE_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const CORPUS_FILES = [
  {
    label: 'CM6-ELEMENTS',
    source: join(WORKTREE_ROOT, 'CM6-ELEMENTS.md'),
  },
  {
    label: 'agent-markdown-writes/SPEC',
    source: join(WORKTREE_ROOT, 'specs', '2026-04-07-agent-markdown-writes', 'SPEC.md'),
  },
  {
    label: 'bidirectional-observer-sync/SPEC',
    source: join(WORKTREE_ROOT, 'specs', '2026-04-07-bidirectional-observer-sync', 'SPEC.md'),
  },
];

interface ParsedWarning {
  raw: string;
  parsed: Record<string, unknown> | null;
}

let captured: ParsedWarning[] = [];
let originalWarn: typeof console.warn;

beforeEach(() => {
  captured = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const raw = args.map(String).join(' ');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      originalWarn(...args);
    }
    captured.push({ raw, parsed });
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

function findBridgeViolationsFor(docName: string): ParsedWarning[] {
  return captured.filter((w) => {
    const p = w.parsed;
    return (
      p !== null &&
      p.event === 'bridge-invariant-violation' &&
      p.site === 'persistence' &&
      p['doc.name'] === docName
    );
  });
}

describe('persistence-site bridge invariant — cold load of in-repo corpus (sub-bug 2)', () => {
  let server: TestServer | undefined;
  let prepopulatedDir: string | undefined;

  afterEach(async () => {
    await server?.cleanup();
    server = undefined;
    if (prepopulatedDir !== undefined) {
      rmSync(prepopulatedDir, { recursive: true, force: true });
      prepopulatedDir = undefined;
    }
  });

  for (const corpus of CORPUS_FILES) {
    test(`cold load of ${corpus.label} must NOT emit bridge-invariant-violation`, async () => {
      prepopulatedDir = mkdtempSync(join(tmpdir(), 'ok-bridge-corpus-'));
      const uniqueDocName = `${corpus.label.replace(/[\\/]/g, '-')}-${crypto.randomUUID()}`;
      const targetPath = join(prepopulatedDir, `${uniqueDocName}.md`);
      copyFileSync(corpus.source, targetPath);

      server = await createTestServer({
        contentDir: prepopulatedDir,
        keepContentDir: true,
      });

      const client = await createTestClient(server.port, uniqueDocName, {
        skipInvariantWatcher: true,
      });
      try {
        await wait(500);
        client.doc.transact(() => {
          client.ytext.insert(client.ytext.length, ' ');
          client.ytext.delete(client.ytext.length - 1, 1);
        });
        const pollDeadline = Date.now() + 3_000;
        while (Date.now() < pollDeadline) {
          const persistenceSignal = captured.some(
            (w) =>
              w.parsed?.site === 'persistence' &&
              (w.parsed?.event === 'bridge-tolerance-applied' ||
                (w.parsed?.event === 'bridge-invariant-violation' &&
                  w.parsed?.['doc.name'] === uniqueDocName)),
          );
          if (persistenceSignal) break;
          await wait(100);
        }

        const violations = findBridgeViolationsFor(uniqueDocName);

        if (violations.length > 0) {
          const summary = violations.map((v) => JSON.stringify(v.parsed, null, 2)).join('\n---\n');
          throw new Error(
            `Expected zero bridge-invariant-violation events for doc "${uniqueDocName}", got ${violations.length}:\n${summary}`,
          );
        }

        expect(violations).toHaveLength(0);
      } finally {
        await client.cleanup();
      }
    }, 15_000);
  }
});
