/// <reference types="vite/client" />
/// <reference types="bun-types" />

interface ImportMetaEnv {
  /**
   * PROD-build override for `installColdMountInstrumentation()`. Set to the
   * literal string `'1'` to install the prototype monkey-patches and per-
   * component instrumentation in PROD builds; any other value (including
   * unset) leaves the existing PROD short-circuit intact. Matches Vite's
   * env-var serialization (string, not boolean). Lives under the default
   * `VITE_` envPrefix alongside the other `VITE_OK_PERF_*` rollout flags so
   * no custom prefix entry is needed in `vite.config.ts`.
   */
  readonly VITE_OK_PERF_INSTRUMENT?: string;
}

declare module 'lucide-react/dist/esm/icons/bot' {
  export const __iconNode: [string, Record<string, string>][];
}

declare module 'lucide-react/dist/esm/icons/link-2' {
  export const __iconNode: [string, Record<string, string>][];
}

declare module 'lucide-react/dist/esm/icons/lock' {
  export const __iconNode: [string, Record<string, string>][];
}

declare module 'lucide-react/dist/esm/icons/package' {
  export const __iconNode: [string, Record<string, string>][];
}

declare module 'lucide-react/dist/esm/icons/pin' {
  export const __iconNode: [string, Record<string, string>][];
}

declare namespace globalThis {
  import type { HocuspocusProvider } from '@hocuspocus/provider';
  import type { Editor } from '@tiptap/core';
  import type { GraphNodeVisualState } from '@/components/graph-view-utils';
  import type { ProviderPool } from '@/editor/provider-pool';
  import type { AcpThreadHarness } from '@/lib/acp/dev-thread-harness';

  var __graphHarness:
    | {
        clickDoc: (docName: string) => boolean;
        clickBackground: () => boolean;
        clickExternal: (url: string) => boolean;
        getNodeVisualState: (docName: string) => GraphNodeVisualState | null;
        getNodeClickPoint: (nodeKey: string) => {
          x: number;
          y: number;
        } | null;
        getLayoutMetrics: () => {
          graphHeight: number;
          containerHeight: number;
          availableHeight: number;
        };
        getLinkClickPoint: (
          sourceDocName: string,
          targetDocName: string,
        ) => { x: number; y: number } | null;
        isSimulationSettled: () => boolean;
      }
    | undefined;
  /**
   * DEV-only: injects synthetic ACP thread frames at the socket boundary so a
   * browser test can drive the real client, fold, and transcript renderer
   * without an agent process. Tree-shaken from production bundles by the
   * `import.meta.env.DEV` guard in `AgentThreadClientBinder.tsx`.
   */
  var __acpThreadHarness: AcpThreadHarness | undefined;
  var __providerPool: ProviderPool | undefined;
  var __activeProvider: HocuspocusProvider | null;
  /**
   * DEV-only: TipTap `Editor` instance of the currently-active pooled doc.
   * Playwright reads `editor.state.selection` to close the PM-selection-sync
   * race. Tree-shaken from production
   * bundles by the `import.meta.env.DEV` guard in `DocumentContext.tsx`.
   */
  var __activeEditor: Editor | null;
  /**
   * Test-only hook: force-reject the cached syncPromise for a docName.
   * Returns true if an entry was rejected, false otherwise.
   */
  var __test_rejectSyncPromise:
    | ((docName: string, kind?: 'timeout' | 'disconnect') => boolean)
    | undefined;
  /**
   * Test-only hook: arm a rejection to fire on the NEXT syncPromise creation
   * for `docName`. Race-free alternative to `__test_rejectSyncPromise` for
   * localhost where the real sync completes in <10ms and a post-hoc polling
   * loop cannot reliably observe the pending entry before it resolves.
   * See sync-promise.ts for timing rationale.
   */
  var __test_armPendingRejection:
    | ((docName: string, kind?: 'timeout' | 'predisconnect') => void)
    | undefined;
  /**
   * Test-only hook: close the active HocuspocusProvider's WebSocket to exercise
   * post-sync reconnect paths.
   */
  var __test_closeActiveWebSocket: (() => boolean) | undefined;
}
