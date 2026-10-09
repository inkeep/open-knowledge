export const DEV_GATED_WINDOW_WRITERS: Readonly<Record<string, readonly string[]>> = {
  'packages/app/src/components/GraphView.tsx': ['__graphHarness'],
  'packages/app/src/editor/DocumentContext.tsx': [
    '__activeEditor',
    '__activeProvider',
    '__providerPool',
    '__test_armPendingRejection',
    '__test_closeActiveWebSocket',
    '__test_rejectSyncPromise',
  ],
  'packages/app/src/editor/TiptapEditor.tsx': ['__agentFlashState'],
  'packages/app/src/lib/acp/dev-thread-harness.ts': ['__acpThreadHarness'],
};
