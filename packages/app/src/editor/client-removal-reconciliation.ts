import type { RenamedAssetMapping, RenamedDocMapping } from '@inkeep/open-knowledge-core';
import type { RenamedFolderMapping } from './editor-tabs';

export interface LocalRenameReconciliation {
  renamed: readonly RenamedDocMapping[];
  renamedFolders?: readonly RenamedFolderMapping[];
  renamedAssets?: readonly RenamedAssetMapping[];
  /** Source doc names removed outside `renamed`, such as doc-to-asset transitions. */
  additionalRemovedDocNames?: readonly string[];
}

export interface LocalRemovalReconciliation {
  tabIdsToClose: readonly string[];
  docNamesToClear: readonly string[];
}

interface AuthRenameReconciliation {
  fromDocName: string;
  toDocName: string;
}

interface AuthRemovalReconciliation {
  docName: string;
}

export interface ClientRemovalReconciler {
  reconcileLocalRename(input: LocalRenameReconciliation): Promise<void>;
  reconcileLocalRemoval(input: LocalRemovalReconciliation): Promise<void>;
  reconcileAuthRename(input: AuthRenameReconciliation): Promise<void>;
  reconcileAuthRemoval(input: AuthRemovalReconciliation): Promise<void>;
}

export interface ClientRemovalReconciliationPorts {
  captureRenameSnapshots(renamed: readonly RenamedDocMapping[]): void;
  getActivePoolDocName(): string | null;
  hasPooledDocument(docName: string): boolean;
  closeAndClear(docName: string): Promise<void>;
  openAndActivate(docName: string): void;
  remapTabs(input: {
    renamed: readonly RenamedDocMapping[];
    renamedFolders: readonly RenamedFolderMapping[];
    renamedAssets: readonly RenamedAssetMapping[];
  }): void;
  closeTabs(tabIds: readonly string[]): void;
  removeDocumentTab(docName: string): void;
  remapActiveTargetForRename(fromDocName: string, toDocName: string): boolean;
  clearActiveTargetForRemoval(docName: string): void;
  navigateToDocument(docName: string): void;
  navigateHome(): void;
}

function uniqueDocNames(docNames: readonly string[]): string[] {
  return [...new Set(docNames)];
}

export function createClientRemovalReconciler(
  ports: ClientRemovalReconciliationPorts,
): ClientRemovalReconciler {
  return {
    async reconcileLocalRename({
      renamed,
      renamedFolders = [],
      renamedAssets = [],
      additionalRemovedDocNames = [],
    }) {
      ports.captureRenameSnapshots(renamed);
      const activePoolDocName = ports.getActivePoolDocName();
      const cleanupDocNames: string[] = [];
      for (const { fromDocName, toDocName } of renamed) {
        cleanupDocNames.push(fromDocName);
        if (activePoolDocName !== toDocName && ports.hasPooledDocument(toDocName)) {
          cleanupDocNames.push(toDocName);
        }
      }
      cleanupDocNames.push(...additionalRemovedDocNames);
      await Promise.all(
        uniqueDocNames(cleanupDocNames).map((docName) => ports.closeAndClear(docName)),
      );
      ports.remapTabs({ renamed, renamedFolders, renamedAssets });
    },

    async reconcileLocalRemoval({ tabIdsToClose, docNamesToClear }) {
      ports.closeTabs(tabIdsToClose);
      await Promise.all(
        uniqueDocNames(docNamesToClear).map((docName) => ports.closeAndClear(docName)),
      );
    },

    async reconcileAuthRename({ fromDocName, toDocName }) {
      const wasActive = ports.getActivePoolDocName() === fromDocName;
      const renamed = [{ fromDocName, toDocName }];
      ports.captureRenameSnapshots(renamed);
      await Promise.all([ports.closeAndClear(fromDocName), ports.closeAndClear(toDocName)]);
      if (wasActive) ports.openAndActivate(toDocName);
      ports.remapTabs({ renamed, renamedFolders: [], renamedAssets: [] });
      const remappedActiveTarget = ports.remapActiveTargetForRename(fromDocName, toDocName);
      if (wasActive || remappedActiveTarget) ports.navigateToDocument(toDocName);
    },

    async reconcileAuthRemoval({ docName }) {
      const wasActive = ports.getActivePoolDocName() === docName;
      await ports.closeAndClear(docName);
      ports.removeDocumentTab(docName);
      ports.clearActiveTargetForRemoval(docName);
      if (wasActive) ports.navigateHome();
    },
  };
}
