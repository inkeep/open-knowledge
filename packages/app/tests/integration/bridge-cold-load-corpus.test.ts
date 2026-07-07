/**
 * Pins the bridge-equivalence invariant on cold `onLoadDocument` for three
 * in-repo docs captured firing `bridge-invariant-violation` events:
 *
 *   - CM6-ELEMENTS.md (ytextLen=28234 vs fragmentLen=28231, +3-byte symmetric)
 *   - agent-markdown-writes SPEC (-25 bytes)
 *   - bidirectional-observer-sync SPEC (-162 bytes)
 *
 * The watchdog contract per `packages/server/src/bridge-watchdog.ts` is that
 * `normalizeBridge(ytext) === normalizeBridge(prependFrontmatter(fm,
 * serialize(fragment)))` must hold OR the difference must match a named
 * tolerance class in `BRIDGE_TOLERANCE_CLASSES`. The `untracked` fallback
 * must NEVER fire on vanilla in-repo content — empirically, three files
 * demonstrate three distinct byte-delta patterns the current tolerance set
 * does not collapse.
 *
 * Test approach. `createTestServer` allocates a fresh tmpdir contentDir, the
 * corpus file is copied in BEFORE `createTestClient` triggers `onLoadDocument`
 * on the server, then `console.warn` is captured during sync + a settle window
 * sufficient for `onStoreDocument`'s debounce-fired bridge assertion in
 * `persistence.ts` to land. The assertion is on the absence of the
 * `bridge-invariant-violation` structured-log event for our specific docName
 * — `suppressDevThrow: true` at the persistence call site means the watchdog
 * EMITS via console.warn under NODE_ENV=test rather than throwing.
 *
 * Why tmpdir and a unique-per-test docName:
 *   - tmpdir avoids Observer A Path B's disk-rewrite side effect on the
 *     worktree's actual SPEC files.
 *   - unique docName means the bridge-watchdog rate-limiter never suppresses
 *     across tests sharing this Bun process — each test deterministically
 *     sees the first emission for its own (site, docName) tuple.
 *
 * Why integration tier (not unit). The bug is wired to the persistence call
 * path: only `onStoreDocument` invokes the watchdog with `site: 'persistence'`.
 * Reproducing it without the full cold-load → settle → store flow would mean
 * mocking the wiring and losing fidelity. The harness already has
 * `createTestServer` doing exactly the cold-load path the bug reproduced on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { createTestClient, createTestServer, type TestServer } from './test-harness';

// ────────────────────────────────────────────────────────────────────────────
// Worktree corpus sources — the exact files that captured violations. The
// bytes on disk must remain representative; if the worktree mutates them
// (e.g., a markdown re-flow that happens to byte-stabilize the round-trip),
// this test would drift from the observed regression.
// ────────────────────────────────────────────────────────────────────────────

const WORKTREE_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const CORPUS_FILES = [
  {
    label: 'CM6-ELEMENTS',
    source: join(WORKTREE_ROOT, 'CM6-ELEMENTS.md'),
    // Symmetric +3-byte delta; no Observer A Path B fires; no disk rewrite —
    // but the `bridge-invariant-violation` event still pollutes telemetry.
  },
  {
    label: 'agent-markdown-writes/SPEC',
    source: join(WORKTREE_ROOT, 'specs', '2026-04-07-agent-markdown-writes', 'SPEC.md'),
    // -25-byte delta; Observer A Path B fires and re-normalizes the file on
    // disk.
  },
  {
    label: 'bidirectional-observer-sync/SPEC',
    source: join(WORKTREE_ROOT, 'specs', '2026-04-07-bidirectional-observer-sync', 'SPEC.md'),
    // -162-byte delta; same Path B disk-rewrite shape as the smaller SPEC.
  },
];

// ────────────────────────────────────────────────────────────────────────────
// console.warn capture helper — the watchdog emits the violation event via
// `console.warn(JSON.stringify(...))` in `bridge-watchdog.ts`. The same
// channel carries other structured events (tolerance-applied, observer-a-
// path-b-fired, etc.), so we filter on event + site + docName.
// ────────────────────────────────────────────────────────────────────────────

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
      // Non-JSON warnings (e.g., "[file-watcher] ...") are operational
      // diagnostics — forward them to the original sink so a failing test
      // keeps the surrounding lifecycle log visible. Only structured JSON
      // events are assertion targets here.
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

// ────────────────────────────────────────────────────────────────────────────
// One test per corpus file — distinct byte-delta patterns. Each fails
// independently so a reader sees which patterns the fix collapses and which it
// still leaves untracked.
// ────────────────────────────────────────────────────────────────────────────

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
      // Pre-populate the contentDir BEFORE the server boots. Doing this after
      // server start lets the @parcel/watcher fire a "file added" event that
      // races onLoadDocument and routes the bytes through external-change's
      // bridge-intake path instead — a different write surface with different
      // observer-settlement timing. The live dev electron evidence shows the
      // violation firing ~2 s after `[persistence] Loaded …` for a file that
      // pre-existed when the server started — pre-populating reproduces that
      // sequence exactly.
      prepopulatedDir = mkdtempSync(join(tmpdir(), 'ok-bridge-corpus-'));
      const uniqueDocName = `${corpus.label.replace(/[\\/]/g, '-')}-${crypto.randomUUID()}`;
      const targetPath = join(prepopulatedDir, `${uniqueDocName}.md`);
      copyFileSync(corpus.source, targetPath);

      server = await createTestServer({
        contentDir: prepopulatedDir,
        keepContentDir: true,
      });

      // Connect — triggers onLoadDocument on the server. The violation fires
      // ~2 s after onLoadDocument completes (persistence debounce + Observer
      // settlement + onStoreDocument → pre-write `assertBridgeInvariant` in
      // `persistence.ts`). The post-mutation poll below has a 3 s upper bound
      // to comfortably cover that window.
      const client = await createTestClient(server.port, uniqueDocName, {
        skipInvariantWatcher: true,
      });
      try {
        // After cold load + sync, force an onStoreDocument cycle so the
        // persistence pre-write `assertBridgeInvariant` in `persistence.ts`
        // runs over the loaded ytext bytes. The cold load itself uses
        // `FILE_WATCHER_ORIGIN` with `skipStoreHooks: true`, so the load alone
        // doesn't trigger persistence. In production a follow-up write
        // (Observer A Path B's settle-dispatched write-back for the two SPEC
        // files; a different write surface for CM6-ELEMENTS) is what unblocks
        // the assertion ~2 s post-load. We emulate that here with a
        // 1-character append+delete client mutation — non-paired, does not
        // skip store hooks, but leaves ytext bytes net-unchanged so the
        // assertion sees the same byte sequences as on the cold load.
        // Client-side watcher is disabled (`skipInvariantWatcher: true`) so
        // divergence reported by the server doesn't double-trigger here.
        await wait(500);
        client.doc.transact(() => {
          client.ytext.insert(client.ytext.length, ' ');
          client.ytext.delete(client.ytext.length - 1, 1);
        });
        // Poll for the persistence-site signal (either a tolerance-applied
        // event for the corpus's known round-trip delta, or a violation for
        // the regression case) up to 3 s — same upper bound as the prior
        // fixed wait, but exits within ~100 ms once the watchdog ran. The
        // `bridge-tolerance-applied` event omits `doc.name` (only `event +
        // site + class`) by design, so the per-doc signal is the
        // `bridge-invariant-violation` event; the corpus files all hit
        // tolerance post-fix, so the cross-doc tolerance-applied signal
        // suffices to confirm the persistence cycle ran in test conditions.
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
          // Surface the violation shape in the assertion failure for
          // diagnostic value — the test must report not just "fired" but
          // "fired with this particular tolerance-class-attempted + byte
          // counts" so the fix path (extend tolerance / fix round-trip / fix
          // prependFrontmatter) is informed.
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
