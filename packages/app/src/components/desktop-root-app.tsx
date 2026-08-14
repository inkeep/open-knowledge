import { lazy, type ReactElement, Suspense } from 'react';
import { App } from '@/App';
import { NavigatorApp } from '@/components/NavigatorApp';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

// Lazy-loaded: the terminal window statically imports SessionsHost
// (and through it the ACP thread-client chain), which must stay out of the
// entry chunk — editor windows and the web distribution never render it.
const TerminalWindowApp = lazy(() =>
  import('@/components/TerminalWindowApp').then((mod) => ({ default: mod.TerminalWindowApp })),
);

/**
 * Pick the root surface for the current window from the desktop bridge's mode.
 * `terminal` and `navigator` are dedicated Electron window types; everything
 * else — editor windows, popped-out `note` windows, and the web / CLI
 * distribution where `bridge` is undefined — renders the full editor shell.
 *
 * `note` deliberately shares the editor root rather than getting a dedicated
 * one. Its reduced chrome comes from a flag read inside the tree
 * (`isNoteWindow`), the same shape single-file mode uses, which keeps the
 * pooled hybrid render tree and the DocumentContext machinery (tab remap,
 * rename following, delete reconciliation) intact instead of hand-composing
 * around them.
 */
export function selectDesktopRootApp(bridge: OkDesktopBridge | undefined): ReactElement {
  if (bridge?.config.mode === 'terminal') {
    return (
      <Suspense fallback={null}>
        <TerminalWindowApp bridge={bridge} />
      </Suspense>
    );
  }
  if (bridge?.config.mode === 'navigator') return <NavigatorApp bridge={bridge} />;
  return <App />;
}
