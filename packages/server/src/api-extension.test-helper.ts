import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiExtensionOptions } from './api-extension.ts';
import { createApiExtension as createApiExtensionBase } from './api-extension.ts';
import type { BacklinkIndex } from './backlink-index.ts';
import type {
  DerivedDocumentIndexApiPort,
  DerivedDocumentIndexMutation,
} from './derived-document-index.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import type { TagIndex } from './tag-index.ts';

export * from './api-extension.ts';

interface LegacyIndexOptions {
  backlinkIndex?: BacklinkIndex | null;
  tagIndex?: TagIndex | null;
}

type LegacySignalChannel = (
  channel: 'files' | 'backlinks' | 'graph' | 'tags' | 'lint-config' | 'comments',
) => void;

export function createDerivedDocumentIndexApiPortStub(
  overrides: Partial<DerivedDocumentIndexApiPort> = {},
): DerivedDocumentIndexApiPort {
  return {
    async recordDirectMutations() {},
    async recordDirectDocument() {},
    async recordDirectDelete() {},
    async recordDirectRename() {},
    async recordLinkRewrite() {},
    async getBacklinks() {
      return [];
    },
    async getBacklinkCount() {
      return 0;
    },
    async getBacklinkCounts(documentNames) {
      return Object.fromEntries(documentNames.map((documentName) => [documentName, 0]));
    },
    async getForwardLinkEntries() {
      return [];
    },
    async getLinkGraphNeighborhood() {
      return { nodes: [], links: [] };
    },
    async getLinkGraph() {
      return { nodes: [], links: [] };
    },
    async getHubs() {
      return [];
    },
    async getOrphans() {
      return [];
    },
    async getDeadLinks() {
      return [];
    },
    async getLocalTargetAssessmentsForSources() {
      return [];
    },
    async getIndexedDocNames() {
      return [];
    },
    async getAllTags() {
      return [];
    },
    async getDocsForTagWithMatches() {
      return [];
    },
    ...overrides,
  };
}

function createLegacyDerivedIndexPort(
  backlinkIndex: BacklinkIndex | null | undefined,
  tagIndex: TagIndex | null | undefined,
  signalChannel: LegacySignalChannel | undefined,
): DerivedDocumentIndexApiPort | undefined {
  if (!backlinkIndex && !tagIndex) return undefined;

  const signalBacklinks = (): void => {
    signalChannel?.('backlinks');
    signalChannel?.('graph');
  };
  const signalAll = (): void => {
    signalBacklinks();
    signalChannel?.('tags');
  };
  const saveAll = async (): Promise<void> => {
    await Promise.allSettled([backlinkIndex?.saveToDisk(), tagIndex?.saveToDisk()]);
  };
  const updateAll = (documentName: string, markdown: string): void => {
    backlinkIndex?.updateDocumentFromMarkdown(documentName, markdown);
    tagIndex?.updateDocumentFromMarkdown(documentName, markdown);
  };
  const deleteAll = (documentName: string): void => {
    backlinkIndex?.deleteDocument(documentName);
    tagIndex?.deleteDocument(documentName);
  };
  const recordDirectMutations = async (
    mutations: readonly DerivedDocumentIndexMutation[],
  ): Promise<void> => {
    if (mutations.length === 0) return;
    let tagsChanged = false;
    for (const mutation of mutations) {
      switch (mutation.kind) {
        case 'upsert':
          updateAll(mutation.documentName, mutation.markdown);
          tagsChanged = true;
          break;
        case 'delete':
          deleteAll(mutation.documentName);
          tagsChanged = true;
          break;
        case 'rename':
          backlinkIndex?.renameDocument(
            mutation.oldDocumentName,
            mutation.newDocumentName,
            mutation.markdown,
          );
          tagIndex?.renameDocument(
            mutation.oldDocumentName,
            mutation.newDocumentName,
            mutation.markdown,
          );
          tagsChanged = true;
          break;
        case 'link-rewrite':
          backlinkIndex?.updateDocumentFromMarkdown(mutation.documentName, mutation.markdown);
          break;
      }
    }
    if (tagsChanged) {
      await saveAll();
      signalAll();
    } else {
      await Promise.allSettled([backlinkIndex?.saveToDisk()]);
      signalBacklinks();
    }
  };

  return {
    recordDirectMutations,
    testOnly: {
      async resetDocumentForTest(documentName) {
        deleteAll(documentName);
        await saveAll();
        signalAll();
      },
      async rescanBacklinksForTest() {
        await backlinkIndex?.rebuildFromDisk();
        await backlinkIndex?.saveToDisk();
        signalBacklinks();
      },
    },
    async recordDirectDocument(documentName, markdown) {
      await recordDirectMutations([{ kind: 'upsert', documentName, markdown }]);
    },
    async recordDirectDelete(documentName) {
      await recordDirectMutations([{ kind: 'delete', documentName }]);
    },
    async recordDirectRename(oldDocumentName, newDocumentName, markdown) {
      await recordDirectMutations([{ kind: 'rename', oldDocumentName, newDocumentName, markdown }]);
    },
    async recordLinkRewrite(documentName, markdown) {
      await recordDirectMutations([{ kind: 'link-rewrite', documentName, markdown }]);
    },
    async getBacklinks(documentName) {
      return backlinkIndex?.getBacklinks(documentName) ?? [];
    },
    async getBacklinkCount(documentName) {
      return backlinkIndex?.getBacklinkCount(documentName) ?? 0;
    },
    async getBacklinkCounts(documentNames) {
      return Object.fromEntries(
        documentNames.map((documentName) => [
          documentName,
          backlinkIndex?.getBacklinkCount(documentName) ?? 0,
        ]),
      );
    },
    async getForwardLinkEntries(documentName) {
      return backlinkIndex?.getForwardLinkEntries(documentName) ?? [];
    },
    async getLinkGraphNeighborhood(documentName, degrees) {
      return (
        backlinkIndex?.getLinkGraphNeighborhood(documentName, degrees) ?? {
          nodes: [],
          links: [],
        }
      );
    },
    async getLinkGraph() {
      return backlinkIndex?.getLinkGraph() ?? { nodes: [], links: [] };
    },
    async getHubs(limit) {
      return backlinkIndex?.getHubs(limit) ?? [];
    },
    async getOrphans(documentNames, mode) {
      return backlinkIndex?.getOrphans(documentNames, mode) ?? [];
    },
    async getDeadLinks(admittedDocuments, sourceDocumentNames) {
      return backlinkIndex?.getDeadLinks(admittedDocuments, sourceDocumentNames) ?? [];
    },
    // This legacy port wraps only the backlink + tag indexes; the local-target
    // assessment index is not part of it, so there are no local-target findings.
    async getLocalTargetAssessmentsForSources() {
      return [];
    },
    async getIndexedDocNames() {
      return backlinkIndex?.getIndexedDocNames() ?? [];
    },
    async getAllTags() {
      return tagIndex?.getAllTags() ?? [];
    },
    async getDocsForTagWithMatches(tag) {
      return tagIndex?.getDocsForTagWithMatches(tag) ?? [];
    },
  };
}

export function createApiExtension(
  options: Omit<ApiExtensionOptions, 'durabilityState' | 'derivedDocumentIndex' | 'signalChannel'> &
    LegacyIndexOptions & {
      derivedDocumentIndex?: DerivedDocumentIndexApiPort;
      signalChannel?: LegacySignalChannel;
    },
): ReturnType<typeof createApiExtensionBase> {
  const { backlinkIndex, tagIndex, derivedDocumentIndex, ...apiOptions } = options;
  const extension = createApiExtensionBase({
    ...apiOptions,
    durabilityState: new DocumentDurabilityState(),
    derivedDocumentIndex:
      derivedDocumentIndex ??
      createLegacyDerivedIndexPort(backlinkIndex, tagIndex, options.signalChannel),
  });
  // Mirror the production composition (Hono native mount ABOVE the strangler
  // catch-all): natively-routed groups dispatch first, everything else flows
  // through the legacy onRequest hook. Tests that drive `ext.onRequest`
  // directly keep reaching ported routes through the same shared pipeline.
  const legacyOnRequest = extension.onRequest?.bind(extension);
  return {
    ...extension,
    async onRequest(payload: { request: IncomingMessage; response: ServerResponse }) {
      if (await extension.nativeApi.dispatch(payload.request, payload.response)) return;
      // biome-ignore lint/suspicious/noExplicitAny: Hocuspocus `onRequest` has no exported payload type
      await legacyOnRequest?.(payload as any);
    },
  };
}
