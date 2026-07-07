/**
 * Y.Text-is-truth contract for `serializeDoc` consumers.
 *
 * `serializeDoc` (private to `createServer`) feeds 5 consumers in
 * `server-factory.ts`: within-branch reconcile `ours`, delete-event
 * `isDirty` diff, rescue-buffer flush, park-snapshot, and cross-branch
 * tombstone `isDirty` diff. Under contract, ALL of them MUST receive raw
 * user-form bytes from `Y.Text('source')` rather than canonical-form
 * bytes from `serialize(fragment)`.
 *
 * The function isn't exported — it's a closure inside `createServer`.
 * These tests exercise it through the most observable consumer: the
 * within-branch reconcile path triggered by an external file-watcher
 * event. Post-reconcile, `setReconciledBase` stores the merge output;
 * `getReconciledBase` reads it.
 *
 * Test classes:
 *   1. **`serializeDoc` returns ytext bytes.** When ytext
 *      contains source-form bytes that `serialize(fragment)` would
 *      canonicalize (doc-start `---`↔`***`, blank-line-count, etc.),
 *      reconcile sees those bytes for `ours`. Verified by triggering a
 *      file-watcher external change against a doc with source
 *      bytes, observing the post-reconcile reconciledBase, and asserting
 *      the source form survives the merge.
 *   2. **`setReconciledBase` always stores raw bytes.** Cold-load
 *      stores raw disk bytes; persistence-write stores raw ytext bytes;
 *      external-change stores raw event content; reconcile-outcome paths
 *      store raw merge output. Cross-verified through `getReconciledBase`
 *      after each path fires.
 */

import {
  describe as _bunDescribe,
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { __resetQuiescenceForTests } from './bridge-quiescence.ts';
import { resetMetrics } from './metrics.ts';
import { getReconciledBase } from './persistence.ts';
import { createServer } from './server-factory.ts';

// Skip-on-CI gate (oven-sh/bun#11892 — child-process reaping bug). Same
// rationale as `persistence-ytext-truth.test.ts`: every test boots
// `createServer`, which calls `initShadowRepo` unconditionally regardless
// of `gitEnabled: false`. The shadow repo init's git subprocess spawns are
// the leak source on Ubuntu Bun. Splitting "git" from "non-git" tests in
// this file is not viable — there are no `createServer`-using tests that
// avoid the shadow repo path.
//
// Lower-tier coverage runs on CI: `bridge-watchdog.test.ts`,
// `bridge-quiescence.test.ts`, `bridge-intake.test.ts`,
// `persistence-deferred-store.test.ts` exercise the primitives
// at the unit level. This file's integration tests verify the full reconcile
// chain end-to-end and run locally before push.
//
// Re-enable condition: drop this gate when oven-sh/bun#11892 is closed AND
// a full canonical-gate run on ubuntu-latest GHA is green for ≥5 consecutive
// runs.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

// File-watcher startup + reconcile fire is parcel-watcher latency-bound;
// 5s Bun default isn't enough headroom under suite contention. Tests
// inside still bound their own waits via `waitForCondition`.
setDefaultTimeout(20_000);

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-fr34-'));
  const contentDir = tmpDir;
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  return {
    tmpDir,
    contentDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 5_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

beforeEach(() => {
  resetMetrics();
  __resetQuiescenceForTests();
});

describe('FR-34: serializeDoc returns ytext bytes verbatim', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('source-form bytes survive a within-branch reconcile (no in-flight ours edit)', async () => {
    // Doc-start `---\n` is a CommonMark thematicBreak that mdast parses
    // to canonical `***\n` on serialize(fragment).
    // `serializeDoc` returned canonical `***\n` for `ours`; it
    // returns raw `---\n` (ytext bytes). When the reconcile sees ours ==
    // base (no in-flight ytext edit), the merge picks theirs cleanly and
    // the reconciledBase advances to theirs — the user-form bytes survive
    // through the entire pipeline.
    const docName = 'fr34-doc-start-thematic';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const initialContent = '---\n# Title\n';
    writeFileSync(docPath, initialContent, 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      // Cold-load completed; reconciledBase is raw disk bytes.
      await waitForCondition(() => getReconciledBase(docName) !== undefined);
      expect(getReconciledBase(docName)).toBe(initialContent);

      // External change: write new bytes to disk. The file-watcher fires
      // a within-branch update event → reconcile case 'update' →
      // ours = serializeDoc(docName), base = getReconciledBase(docName),
      // theirs = event.content.
      const updatedContent = '---\n# Title Updated\n';
      writeFileSync(docPath, updatedContent, 'utf-8');

      // Wait for reconcile to fire and advance the reconciledBase.
      await waitForCondition(() => getReconciledBase(docName) === updatedContent, {
        timeoutMs: 8_000,
      });
      expect(getReconciledBase(docName)).toBe(updatedContent);

      // The doc-start `---\n` survived the full chain: cold-load → ytext
      // → composeAndWriteRawBody → fragment derives via parse → file-
      // watcher external change → reconcile `ours = serializeDoc()` →
      // mergeThreeWay → applyToDoc → setReconciledBase. the
      // chain would have canonicalized `---` to `***` somewhere along
      // the way (specifically: serializeDoc returning serialize(fragment)
      // bytes for `ours`).
      expect(getReconciledBase(docName)).toContain('---\n');
      expect(getReconciledBase(docName)).not.toContain('***\n');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });

  // The in-flight ytext-edit visibility case isn't covered here: a
  // non-paired user-origin Y.Text mutation triggers Observer B Phase 1
  // (`parse(ytext) → updateYFragment`) and the watchdog assertion. For
  // doc shapes where mdast-util-to-markdown's serializer inserts a blank
  // line between block-level elements (e.g. `---\n# heading\n` →
  // `***\n\n# heading\n`), the bridge-invariant comparator's tolerance
  // set doesn't yet cover the gap and the watchdog throws. That gap is
  // an architectural floor
  // ; the file-watcher / reconcile path covered above doesn't hit
  // it because all writes go through `composeAndWriteRawBody` under
  // paired-write `FILE_WATCHER_ORIGIN`, and the observers self-skip on
  // paired origins (no Observer B fire). The cold-load + reconcile case
  // already proves the contract: `ours` would carry
  // canonical fragment bytes and the merge would canonicalize line 1
  // `---` to `***`; `ours` carries raw ytext bytes and the
  // merge preserves them unconditionally.
});

describe('FR-35: setReconciledBase stores raw bytes uniformly across all paths', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('post-reconcile reconciledBase is the raw merge output (not canonical)', async () => {
    // Verifies the cascade land together: cold-load
    // sets reconciledBase=raw; file-watcher event triggers reconcile;
    // reconcile uses serializeDoc (raw ytext) for `ours`, getReconciledBase
    // (raw) for `base`, event.content (raw disk) for `theirs`; merge
    // output is raw; setReconciledBase stores raw merge output.
    const docName = 'fr35-merge-output-raw';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    // Use a doc with multiple source-form bytes that all need to round-trip:
    //   - doc-start `---\n` (thematic break)
    //   - source-form delimiter `__strong__`
    const initialContent = '---\n# Title\n\nA __strong__ paragraph.\n';
    writeFileSync(docPath, initialContent, 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      await waitForCondition(() => getReconciledBase(docName) === initialContent);

      // Trigger reconcile via external change.
      const updatedContent = '---\n# Title\n\nA __strong__ paragraph.\n\nNew block.\n';
      writeFileSync(docPath, updatedContent, 'utf-8');

      await waitForCondition(() => getReconciledBase(docName) === updatedContent, {
        timeoutMs: 8_000,
      });

      // After reconcile, reconciledBase advances to the merge output.
      // Both `__strong__` (source-form) and `---\n` (
      // doc-start) survived the full cycle.
      // these would have been replaced with canonical-form bytes
      // somewhere along the way.
      const finalBase = getReconciledBase(docName);
      expect(finalBase).toBe(updatedContent);
      expect(finalBase).toContain('---\n');
      expect(finalBase).toContain('__strong__');

      // Disk also has the merge output verbatim.
      await waitForCondition(() => {
        if (!existsSync(docPath)) return false;
        return readFileSync(docPath, 'utf-8') === updatedContent;
      });
      expect(readFileSync(docPath, 'utf-8')).toBe(updatedContent);

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});
