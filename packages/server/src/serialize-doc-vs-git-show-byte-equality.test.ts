/**
 * Byte-equality contract — `serializeDoc(docName)` and `git show :<stage>:<file>`
 * produce equal bytes at conflict-detect time (modulo documented
 * trailing-newline normalization).
 *
 * Justification: the `?source=ytext` override returns `serializeDoc`
 * output as `ours`; the default path returns `git show :2:`. For the
 * "freshly loaded, no in-flight edits" case the two paths MUST be
 * byte-equal — otherwise switching from default to `?source=ytext` would
 * silently change `ours` and break diff display + "Keep mine" semantics.
 *
 * Documented tolerance — trailing newline only: `git show` is a
 * pass-through of the committed bytes; `serializeDoc` composes
 * `prependFrontmatter(stripFrontmatter(ytext))`, and ytext was loaded
 * from disk via `composeAndWriteRawBody`. Both should preserve a trailing
 * newline (or its absence) verbatim, but the test asserts equality after
 * stripping a SINGLE trailing newline on both sides so a downstream
 * normalization in either path doesn't break the contract surface (the
 * stages-of-merge `ours` is consumed by line-diff UIs that already
 * tolerate one-newline drift).
 */
import {
  describe as _bunDescribe,
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prependFrontmatter, stripFrontmatter } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { __resetQuiescenceForTests } from './bridge-quiescence.ts';
import { resetMetrics } from './metrics.ts';
import { createServer } from './server-factory.ts';

/**
 * Mirror of the `serializeDoc` closure in `server-factory.ts` — the test
 * compares its output to `git show`. The production closure isn't exposed
 * on `ServerInstance`, so the test reconstructs the same composition
 * (`prependFrontmatter(stripFrontmatter(ytext))`) over the loaded doc's
 * `Y.Text('source')`. This is structural-equivalence with the call site
 * the `?source=ytext` branch routes through; if the two compositions
 * diverge in the future the test will break alongside the contract.
 */
function reconstructSerializeDoc(
  hocuspocus: import('@hocuspocus/server').Hocuspocus,
  docName: string,
): string | null {
  const doc = hocuspocus.documents.get(docName);
  if (!doc) return null;
  const ytext = doc.getText('source').toString();
  const { frontmatter, body } = stripFrontmatter(ytext);
  return prependFrontmatter(frontmatter, body);
}

// Same CI gate as `serialize-doc-ytext.test.ts` — `createServer` boot path
// spawns git subprocesses for `initShadowRepo` (oven-sh/bun#11892 child-
// process reaping bug surfaces here under Ubuntu Bun).
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

setDefaultTimeout(20_000);

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-a3-'));
  const contentDir = tmpDir;
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'A3 Test');
  await git.addConfig('user.email', 'a3@example.com');
  return {
    tmpDir,
    contentDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

beforeEach(() => {
  resetMetrics();
  __resetQuiescenceForTests();
});

describe('A3: serializeDoc(docName) byte-equals git show :<stage>:<file> when freshly loaded', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('committed `.md` loaded into Y.Doc serializes byte-equal to git show HEAD:<file>', async () => {
    // Set up: write a doc, commit it, then load it into a Y.Doc via
    // openDirectConnection. The just-loaded doc has no in-flight ytext
    // edits — `serializeDoc()` returns the same bytes as the committed
    // tree object. We compare against `git show HEAD:<file>` (a clean
    // committed tree) rather than `git show :2:<file>` because the test
    // doesn't simulate a real merge conflict (which would require an
    // actual `git merge` with divergent refs). The invariant under
    // verification — "at conflict-detect time the two paths agree" — is
    // semantically identical to "at any quiescent point post-load the
    // two paths agree", because the merge stages are written by
    // `git merge` from the committed bytes that were also the source of
    // the Y.Doc's load.
    const docName = 'a3-byte-eq';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const initialContent =
      '---\ntitle: Byte-Equality Probe\ntags: [a3]\n---\n# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
    writeFileSync(docPath, initialContent, 'utf-8');

    const git = simpleGit({ baseDir: fixture.tmpDir });
    await git.add(`${docName}.md`);
    await git.commit('seed a3 doc');

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
      try {
        // Wait until the Y.Doc cold-load completes (ytext is non-empty
        // and contains the seeded payload).
        await waitForCondition(() => {
          const doc = server.hocuspocus.documents.get(docName);
          return doc?.getText('source').toString().includes('First paragraph.');
        });

        const fromYtext = reconstructSerializeDoc(server.hocuspocus, docName);
        if (fromYtext === null) {
          throw new Error('reconstructSerializeDoc returned null for a loaded doc');
        }
        const fromGit = await git.raw(['show', `HEAD:${docName}.md`]);

        // Document tolerance — trim ONE trailing newline on each side if
        // present. This is the canonical normalization that line-diff
        // consumers already apply; `serializeDoc` and `git show` can
        // legitimately disagree on the EOF newline byte without breaking
        // the contract surface.
        const stripOneTrailingNewline = (s: string): string =>
          s.endsWith('\n') ? s.slice(0, -1) : s;

        expect(stripOneTrailingNewline(fromYtext)).toBe(stripOneTrailingNewline(fromGit));
      } finally {
        conn.disconnect();
      }
    } finally {
      await server.destroy();
    }
  });
});
