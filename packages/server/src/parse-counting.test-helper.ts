import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';

export interface CountingManager {
  readonly manager: MarkdownManager;
  readonly parses: () => number;
}

export function createCountingManager(): CountingManager {
  const manager = new MarkdownManager({ extensions: sharedExtensions });
  let calls = 0;
  const original = manager.parseToEditorMdast.bind(manager);
  manager.parseToEditorMdast = (markdown: string) => {
    calls += 1;
    return original(markdown);
  };
  return { manager, parses: () => calls };
}
