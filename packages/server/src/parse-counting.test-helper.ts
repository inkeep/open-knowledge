import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';

export interface CountingManager {
  readonly manager: MarkdownManager;
  readonly parses: () => number;
  readonly serializes: () => number;
}

export function createCountingManager(): CountingManager {
  const manager = new MarkdownManager({ extensions: sharedExtensions });
  let calls = 0;
  let serializeCalls = 0;
  const original = manager.parseToEditorMdast.bind(manager);
  manager.parseToEditorMdast = (markdown: string) => {
    calls += 1;
    return original(markdown);
  };
  const originalSerialize = manager.serialize.bind(manager);
  manager.serialize = (json, opts) => {
    serializeCalls += 1;
    return originalSerialize(json, opts);
  };
  return { manager, parses: () => calls, serializes: () => serializeCalls };
}
