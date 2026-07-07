/**
 * Reset the per-worker content directory to the boot-seeded fixture baseline.
 *
 * The `workerServer` fixture is shared across every e2e test that runs on a
 * Playwright worker, and `api.testReset()` only truncates the single `test-doc`
 * doc (see `handleTestReset` in `api-extension.ts`) — every other doc a prior
 * spec created on that worker persists. A spec whose assertions depend on the
 * tree's *geometry* or on a destination *name being free* therefore inherits
 * unbounded cross-spec pollution: under the full suite the sidebar fills past
 * the viewport, so the "empty area below the rows" the deselect test clicks
 * (`box.height - 8`) is actually a real row — clicking it selects that doc and
 * steals roving focus from the row under test — and a leftover root `note` from
 * an earlier drag-to-root promotion collides with the next promotion, leaving
 * two same-named rows. Clearing the visible top-level entries before each test
 * restores per-test isolation without paying for a per-test server.
 *
 * `REQUIRED_FIXTURE_ENTRY_NAMES` are preserved (skipped, never deleted): sibling
 * specs on the same worker depend on them at navigate time, and the content
 * filter's `dirCount[sidebar-folder]` precondition must stay warm. This is the
 * shared form of the per-spec `clearVisibleContentEntries` helpers already in
 * `file-tree-create.e2e.ts` and `editor-tabs.e2e.ts`.
 */

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_FIXTURE_ENTRY_NAMES } from './fixtures.ts';

async function deletePathIfExists(
  baseURL: string,
  kind: 'file' | 'folder',
  path: string,
): Promise<void> {
  const res = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, path }),
  });
  // 404 = already gone (a concurrent settle removed it first). Any other
  // non-ok status is a real teardown fault that must surface here rather than
  // silently leave the next test polluted.
  if (res.ok || res.status === 404) return;
  throw new Error(`delete-path failed for ${kind}:${path}: ${res.status} ${await res.text()}`);
}

/**
 * Delete every visible top-level entry in the worker `contentDir` except the
 * boot-seeded `REQUIRED_FIXTURE_ENTRY_NAMES` and dotfiles (`.ok` / `.git` /
 * `.okignore`). Folders cascade through `/api/delete-path`; markdown docs go
 * through the same route with the extension stripped to the docName; non-doc
 * files (assets) are removed from disk directly. Reads the directory rather
 * than `/api/documents` so a doc the file-watcher index has not yet caught up
 * to is still cleared.
 */
export async function resetContentToFixtureBaseline(
  baseURL: string,
  contentDir: string,
): Promise<void> {
  const preserved = new Set<string>(REQUIRED_FIXTURE_ENTRY_NAMES);
  for (const entry of readdirSync(contentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (preserved.has(entry.name)) continue;
    if (entry.isDirectory()) {
      await deletePathIfExists(baseURL, 'folder', entry.name);
      continue;
    }
    const docName = entry.name.replace(/\.(md|mdx)$/i, '');
    if (docName !== entry.name) {
      await deletePathIfExists(baseURL, 'file', docName);
      continue;
    }
    rmSync(join(contentDir, entry.name), { recursive: true, force: true });
  }
}
