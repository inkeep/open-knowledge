import { lazy, type ReactElement, Suspense } from 'react';
import { App } from '@/App';
import { NavigatorApp } from '@/components/NavigatorApp';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

const TerminalWindowApp = lazy(() =>
  import('@/components/TerminalWindowApp').then((mod) => ({ default: mod.TerminalWindowApp })),
);

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
