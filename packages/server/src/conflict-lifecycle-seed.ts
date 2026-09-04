import { join, relative } from 'node:path';
import type { Extension } from '@hocuspocus/server';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import type { ConflictEntry } from './conflict-storage.ts';
import { stripDocExtension } from './doc-extensions.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';
import type { SyncEngine } from './sync-engine.ts';

interface ConflictLifecycleSeedOptions {
  getSyncEngine: () => SyncEngine | null;
  projectDir: string;
  contentDir: string;
}

export function entryMatchesDocName(
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
        lifecycleMap.set('status', 'conflict');
        lifecycleMap.set('reason', 'conflict-markers');
        console.warn(
          JSON.stringify({
            event: 'lifecycle-seeded-on-load-from-conflict-store',
            'doc.name': documentName,
          }),
        );
      } catch (err) {
        getLogger('conflict-lifecycle-seed').warn(
          { docName: documentName, err: err instanceof Error ? err : new Error(String(err)) },
          `failed to seed lifecycle on load (doc=${documentName})`,
        );
      }
    },
  };
}
