/**
 * Shared rig for the map-driven splice parse-economy tests.
 *
 * Wraps a `MarkdownManager` so every `parseToEditorMdast` call is counted.
 * `computeMapDrivenBodySplice` is the only caller of that method on the
 * Observer A drain path, so the count IS the drain's full-document parse
 * count — which is what the economy pins assert. Counts, not milliseconds:
 * a parse count is identical on a quiet laptop and a saturated CI runner,
 * so these tests cannot go flaky under load the way a wall-clock budget can.
 */
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';

export interface CountingManager {
  /** The instrumented manager. Pass this wherever a `MarkdownManager` is wanted. */
  readonly manager: MarkdownManager;
  /** Full-document `parseToEditorMdast` calls so far. */
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
