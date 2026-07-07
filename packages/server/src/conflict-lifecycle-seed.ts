/**
 * Hocuspocus extension that seeds `lifecycle.status='conflict'` on a Y.Doc
 * being loaded if the underlying file is tracked in the SyncEngine's
 * ConflictStore.
 *
 * Closes the runtime gap left by `case 'conflict'` in `server-factory.ts`'s
 * `handleDiskEvent` — that branch early-returns when `hocuspocus.documents.get(
 * docName)` is undefined, so a conflict landing on disk before any client
 * opens the doc never reaches the per-doc Y.Map. Once the user clicked the
 * entry in the Conflicts tab, the doc loaded with lifecycle unset and the
 * editor mounted instead of `<DiffViewBoundary>`.
 *
 * Complements `restoreLifecycleFromConflictsJson` in `boot.ts`: that helper
 * closes the server-restart race (in-memory lifecycle lost on shutdown,
 * file-watcher cannot re-emit because mtime didn't change). This extension
 * closes the mid-session race (conflict appears while a doc is unloaded;
 * client connects later). The two helpers are NOT bit-for-bit symmetric —
 * see the TODO at `boot.ts` noting that the boot path's docName mapping
 * does not re-root through `contentDir` and would misroute on projects
 * configured with `content.dir` set to a subdirectory of the project root.
 *
 * Idempotent: skips writes when `lifecycle.status` is already `'conflict'`.
 * Synthetic docs short-circuit at entry per the documentName-keyed STOP rule.
 * The guard is `isSystemDoc(name) || isConfigDoc(name)`; `isConfigDoc`
 * matches the bounded set in `CONFIG_DOC_NAMES` (`__config__/project`,
 * `__local__/project`, `__user__/config.yml`, `__config__/okignore`) —
 * NOT arbitrary `__config__/*` / `__user__/*` / `__local__/*` names. Such
 * names cannot reach the ConflictStore anyway (ContentFilter rejects those
 * prefixes at admission), so the narrower gate is benign — the docstring
 * just names the precise set.
 *
 * Failure isolation: the seeding logic runs inside a try/catch so a
 * ConflictStore read failure or a Y.Map write race cannot propagate through
 * Hocuspocus's `afterLoadDocument` chain and close the WebSocket via the
 * outer ResetConnection path.
 */

import { join, relative } from 'node:path';
import type { Extension } from '@hocuspocus/server';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import type { ConflictEntry } from './conflict-storage.ts';
import { stripDocExtension } from './doc-extensions.ts';
import { toPosix } from './path-utils.ts';
import type { SyncEngine } from './sync-engine.ts';

interface ConflictLifecycleSeedOptions {
  /** Getter for the active SyncEngine instance (may be null when dormant). */
  getSyncEngine: () => SyncEngine | null;
  /** Absolute path to the project's git root — matches `SyncEngine.projectDir`. */
  projectDir: string;
  /** Absolute path to the markdown content root — matches `SyncEngine.contentDir`. */
  contentDir: string;
}

/**
 * True when the ConflictStore entry refers to the same file the Y.Doc tracks.
 *
 * ConflictEntry.file is project-relative (git root); docName is contentDir-
 * relative with the supported doc extension stripped. The two coincide when
 * `projectDir === contentDir` (the dominant case), but a project with
 * `contentDir` nested inside `projectDir` would otherwise misroute.
 */
function entryMatchesDocName(
  entry: ConflictEntry,
  docName: string,
  projectDir: string,
  contentDir: string,
): boolean {
  const absPath = join(projectDir, entry.file);
  const contentRelPath = toPosix(relative(contentDir, absPath));
  if (contentRelPath.startsWith('..')) return false;
  return stripDocExtension(contentRelPath) === docName;
}

export function createConflictLifecycleSeedExtension(
  options: ConflictLifecycleSeedOptions,
): Extension {
  const { getSyncEngine, projectDir, contentDir } = options;
  return {
    async afterLoadDocument({ documentName, document }) {
      if (isSystemDoc(documentName) || isConfigDoc(documentName)) return;
      try {
        const engine = getSyncEngine();
        if (!engine) return;
        const conflicts = engine.getConflicts();
        if (conflicts.length === 0) return;
        const hit = conflicts.some((entry) =>
          entryMatchesDocName(entry, documentName, projectDir, contentDir),
        );
        if (!hit) return;
        const lifecycleMap = document.getMap('lifecycle');
        if (lifecycleMap.get('status') === 'conflict') return;
        // Raw Y.Map.set, no transact — matches the boot-restore helper and the
        // file-watcher `case 'conflict'` branch in server-factory.ts.
        lifecycleMap.set('status', 'conflict');
        lifecycleMap.set('reason', 'conflict-markers');
        console.warn(
          JSON.stringify({
            event: 'lifecycle-seeded-on-load-from-conflict-store',
            'doc.name': documentName,
          }),
        );
      } catch (err) {
        console.warn(
          `[conflict-lifecycle-seed] failed to seed lifecycle on load (doc=${documentName}):`,
          err instanceof Error ? err : String(err),
        );
      }
    },
  };
}
