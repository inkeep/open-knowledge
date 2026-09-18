import { randomUUID } from 'node:crypto';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { sharedExtensions } from './extensions/shared';
import { createProjectionBinding, type ProjectionBinding } from './projection-binding';

interface SeededProjectionProvider {
  docName: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  provider: HocuspocusProvider;
  projection: ProjectionBinding;
  cleanup: () => void;
}

const seedMd = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

export function buildSeededProjectionProvider(
  docNamePrefix: string,
  source = 'hello world\n',
): SeededProjectionProvider {
  const docName = `${docNamePrefix}-${randomUUID()}`;
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ydoc.transact(() => ytext.insert(0, source), 'seed');
  const awareness = new Awareness(ydoc);
  const provider = {
    document: ydoc,
    configuration: { name: docName },
    awareness,
  } as unknown as HocuspocusProvider;
  const projection = createProjectionBinding({ ytext, md: seedMd });
  const cleanup = () => {
    awareness.destroy();
    ydoc.destroy();
  };
  return { docName, ydoc, ytext, awareness, provider, projection, cleanup };
}
