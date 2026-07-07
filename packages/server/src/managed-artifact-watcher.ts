/**
 * Chokidar watcher for the managed-artifact skills tree
 * (`<root>/.ok/skills/<name>/SKILL.md`).
 *
 * Why a dedicated watcher and not the file index: `.ok/` is excluded from the
 * content file-watcher by default, so a hand/CLI/cross-instance edit to a
 * `SKILL.md` would otherwise never reconcile into a live `__skill__/...` doc.
 * This is the explicit watch that closes that blind spot.
 *
 * Unlike `startConfigFileWatcher` (single known file) and
 * `startMultiPathConfigFileWatcher` (a fixed set of files), the skill set is
 * OPEN — one `<name>/SKILL.md` per skill, created/removed at runtime — so this
 * watches the skills ROOT dir(s) at `depth: 1` and filters child events to the
 * `SKILL.md` leaf. The caller maps the leaf path back to a doc name via
 * `managedArtifactDocNameForPath`.
 *
 * `usePolling` is the only mode that behaves uniformly across macOS FSEvents,
 * Linux inotify, and sandboxed CI — same rationale as the config watchers. The
 * skills tree is shallow and low-churn, so the poll cost is negligible.
 *
 * Self-write feedback loop is broken downstream by
 * `applyExternalManagedArtifactChange`'s LKG-equality short-circuit (persistence
 * sets `lkgCache[doc]` to the bytes it just wrote); the per-path `lastContent`
 * dedup here is a cheaper first line of defense.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tracedMkdirSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';

/** Cleanup function returned by `startManagedArtifactWatcher`. Idempotent. */
export type ManagedArtifactWatcherUnsubscribe = () => Promise<void>;

export interface ManagedArtifactWatchOptions {
  /**
   * chokidar `depth` for the watched roots. Skills nest one level
   * (`<name>/SKILL.md`, depth 1); templates are flat (`<name>.md` directly in
   * the watched `.ok/templates` dir, depth 0).
   */
  depth: number;
  /** True for a path that is a managed-artifact leaf (e.g. `SKILL.md` / `*.md`). */
  acceptLeaf: (absPath: string) => boolean;
}

/** Skills: nested `<name>/SKILL.md` (the default). */
const SKILL_WATCH_OPTIONS: ManagedArtifactWatchOptions = {
  depth: 1,
  acceptLeaf: (p) => basename(p) === 'SKILL.md',
};

/** Templates: flat `<name>.md` directly in a `.ok/templates` dir. */
export const TEMPLATE_WATCH_OPTIONS: ManagedArtifactWatchOptions = {
  depth: 0,
  // Skip atomic-write temp files (`<name>.md.tmp.<pid>.<ts>`) — they end in a
  // numeric suffix, not `.md`.
  acceptLeaf: (p) => basename(p).endsWith('.md'),
};

/**
 * Watch one or more managed-artifact root directories for leaf-file changes.
 * Resolves once chokidar's initial scan completes (`ready`), so callers/tests
 * can write immediately without racing the first event.
 *
 * On `add` / `change` of a leaf (per `opts.acceptLeaf`): reads the file and
 * fires `onChange(absPath, content)`. `unlink` is logged but does NOT fire
 * `onChange` (the live doc retains its current state — deletion is a separate,
 * explicit surface). Read errors and handler throws are logged + dropped so one
 * bad event can't tear down the watcher.
 */
export async function startManagedArtifactWatcher(
  roots: ReadonlyArray<string>,
  onChange: (absPath: string, content: string) => void,
  opts: ManagedArtifactWatchOptions = SKILL_WATCH_OPTIONS,
): Promise<ManagedArtifactWatcherUnsubscribe> {
  const log = getLogger('managed-artifact-watcher');
  const { watch } = await import('chokidar');

  const watchRoots = Array.from(new Set(roots));
  for (const dir of watchRoots) {
    // mkdir -p the root so chokidar has something to watch before the first
    // artifact is created (the dir is lazy — only `store` materializes the leaf
    // file). Cheap + idempotent.
    try {
      tracedMkdirSync(dir, { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        log.warn({ err, dir }, 'failed to create watch root; watcher may be inert');
      }
    }
  }

  // Leaf filtering happens in the handler (atomic-write `.tmp.<uuid>` siblings
  // are dropped by `acceptLeaf`).
  const watcher = watch(watchRoots, {
    ignoreInitial: true,
    depth: opts.depth,
    usePolling: true,
    interval: 200,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', resolve);
  });

  const lastContent = new Map<string, string | null>();

  const handlePath = (path: string): void => {
    if (!opts.acceptLeaf(path)) return;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.debug({ path }, 'managed-artifact leaf disappeared between event and read; dropping');
        return;
      }
      log.warn({ err, path }, 'managed-artifact leaf read failed; dropping event');
      return;
    }
    if (content === lastContent.get(path)) return;
    lastContent.set(path, content);
    try {
      onChange(path, content);
    } catch (err) {
      log.warn({ err, path }, 'managed-artifact change handler threw');
    }
  };
  const handler = (path: string): void => handlePath(path);

  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', (path) => {
    if (!opts.acceptLeaf(path)) return;
    lastContent.delete(path);
    log.debug({ path }, 'managed-artifact leaf unlinked; live doc retained at current state');
  });
  watcher.on('error', (err) => {
    log.warn({ err, watchRoots }, '[managed-artifact-watcher] chokidar error');
  });

  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await watcher.close();
  };
}
