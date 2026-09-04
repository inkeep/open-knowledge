import { HocuspocusAuthRejection } from './auth-token-schema.ts';
import { isReservedForUserTree } from './cc1-broadcast.ts';
import {
  incrementAuthDocDeleted,
  incrementAuthRemovalGuardError,
  incrementAuthRenameRedirect,
  incrementRemovalRedirectChainCycle,
} from './metrics.ts';
import type { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import { setActiveSpanAttributes } from './telemetry.ts';

export interface RemovalRedirectGuardDeps {
  recentlyRemovedDocs: RecentlyRemovedDocs;
  resolveFilePath: (docName: string) => string | null;
  fileExists: (filePath: string) => boolean;
}

function fileExistsForDocName(deps: RemovalRedirectGuardDeps, docName: string): boolean {
  const filePath = deps.resolveFilePath(docName);
  return filePath !== null && deps.fileExists(filePath);
}

export async function runRemovalRedirectGuard(
  documentName: string,
  deps: RemovalRedirectGuardDeps,
): Promise<void> {
  try {
    if (isReservedForUserTree(documentName)) return;

    const originEntry = deps.recentlyRemovedDocs.get(documentName);
    if (originEntry === undefined) {
      return;
    }

    if (originEntry.kind === 'deleted') {
      if (fileExistsForDocName(deps, documentName)) {
        deps.recentlyRemovedDocs.delete(documentName);
        return;
      }
      incrementAuthDocDeleted();
      setActiveSpanAttributes({ 'auth.reason': 'doc-deleted' });
      throw new HocuspocusAuthRejection(
        'doc-deleted',
        `removed-doc rejection for deleted ${documentName}`,
      );
    }

    const visited = new Set<string>([documentName]);
    let target = originEntry.newDocName;
    while (true) {
      if (visited.has(target)) {
        incrementRemovalRedirectChainCycle();
        console.warn(
          JSON.stringify({
            event: 'removal-redirect-chain-cycle',
            documentName,
            target,
          }),
        );
        return;
      }
      visited.add(target);

      const nextEntry = deps.recentlyRemovedDocs.get(target);
      if (nextEntry === undefined) {
        incrementAuthRenameRedirect();
        setActiveSpanAttributes({ 'auth.reason': 'rename-redirect' });
        throw new HocuspocusAuthRejection(
          'rename-redirect',
          `removed-doc redirect for ${documentName} → ${target}`,
          target,
        );
      }

      if (nextEntry.kind === 'deleted') {
        if (fileExistsForDocName(deps, target)) {
          deps.recentlyRemovedDocs.delete(target);
          incrementAuthRenameRedirect();
          setActiveSpanAttributes({ 'auth.reason': 'rename-redirect' });
          throw new HocuspocusAuthRejection(
            'rename-redirect',
            `removed-doc redirect for ${documentName} → ${target}`,
            target,
          );
        }
        incrementAuthDocDeleted();
        setActiveSpanAttributes({ 'auth.reason': 'doc-deleted' });
        throw new HocuspocusAuthRejection(
          'doc-deleted',
          `removed-doc rejection for deleted ${documentName}`,
        );
      }

      target = nextEntry.newDocName;
    }
  } catch (err) {
    if (err instanceof HocuspocusAuthRejection) throw err;
    incrementAuthRemovalGuardError();
    console.warn(
      JSON.stringify({
        event: 'removal-redirect-extension-error',
        documentName,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
