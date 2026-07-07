import type { ReactElement } from 'react';
import { App } from '@/App';
import { NavigatorApp } from '@/components/NavigatorApp';
import { TerminalWindowApp } from '@/components/TerminalWindowApp';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/**
 * Pick the root surface for the current window from the desktop bridge's mode.
 * `terminal` and `navigator` are dedicated Electron window types; everything
 * else — editor windows, and the web / CLI distribution where `bridge` is
 * undefined — renders the full editor shell.
 */
export function selectDesktopRootApp(bridge: OkDesktopBridge | undefined): ReactElement {
  if (bridge?.config.mode === 'terminal') return <TerminalWindowApp bridge={bridge} />;
  if (bridge?.config.mode === 'navigator') return <NavigatorApp bridge={bridge} />;
  return <App />;
}
