import * as Y from 'yjs';
import type { DocumentDurabilityState } from './document-durability-state.ts';
import type { createPersistenceExtension } from './persistence.ts';

export const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

export function replaceDocParagraphs(document: Y.Doc, texts: string[]): void {
  const body = `${texts.join('\n\n')}\n`;
  const fragment = document.getXmlFragment('default');
  const ytext = document.getText('source');
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
  fragment.insert(
    0,
    texts.map((text) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(text)]);
      return paragraph;
    }),
  );
  if (ytext.length > 0) {
    ytext.delete(0, ytext.length);
  }
  ytext.insert(0, body);
}

function hookStorePayload(document: Y.Doc, documentName: string) {
  return {
    document,
    documentName,
    lastTransactionOrigin: BROWSER_ORIGIN,
    lastContext: {},
  };
}

export async function runHookStore(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onStoreDocument?.(hookStorePayload(document, documentName) as never);
}

export async function queueDeferredStore(
  persistence: ReturnType<typeof createPersistenceExtension>,
  durabilityState: DocumentDurabilityState,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  durabilityState.setBatchInProgress(true);
  await runHookStore(persistence, document, documentName);
  durabilityState.setBatchInProgress(false);
}
