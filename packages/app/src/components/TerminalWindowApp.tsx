import { useTheme } from 'next-themes';
import { useState } from 'react';
import { useInstalledClis } from '@/hooks/use-installed-clis';
import { ConfigProvider } from '@/lib/config-provider';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { TerminalSessionsHost } from './TerminalSessionsHost';
import { xtermThemeForMode } from './terminal-theme';

interface TerminalWindowAppProps {
  /** Desktop bridge — the terminal window renders only on the Electron host. */
  readonly bridge: OkDesktopBridge;
}

/**
 * Full-window multi-session terminal — the renderer for a `--ok-mode=terminal`
 * window. Mounts the SAME {@link TerminalSessionsHost} the docked terminal uses
 * (window variant), so the window is purely a placement: new-chat split button,
 * OSC tab titles, menu actions, ⌘1–9, liveness reporting, and reload
 * rehydration are the dock's, by construction. The window-shaped differences
 * live in the host's `variant: 'window'`: closing the last tab closes the
 * window instead of collapsing a panel, the tab row doubles as the macOS title
 * bar, there are no dock/collapse controls, and ⌘1–9 needs no focus-scope gate.
 *
 * Establishes its own {@link ConfigProvider} — the terminal-consent hooks under
 * TerminalGate (`useTerminalConsentState` / `useTerminalEnabledWriter`) read
 * the project-local ConfigBinding via `useConfigContext`, and this window has
 * no editor/document tree to inherit the provider from (unlike `App.tsx`).
 * The collab URL is the project's, surfaced through the bridge (attach-mode).
 * A project-less terminal window carries an empty `collabUrl`; normalize it to
 * `null` so `ConfigProvider` skips binding creation and the consent hooks
 * fail-open (terminal allowed unless `terminal.enabled: false`).
 */
export function TerminalWindowApp({ bridge }: TerminalWindowAppProps) {
  const collabUrl = bridge.config.collabUrl ? bridge.config.collabUrl : null;
  return (
    <ConfigProvider collabUrl={collabUrl}>
      <TerminalWindowBody bridge={bridge} />
    </ConfigProvider>
  );
}

function TerminalWindowBody({ bridge }: TerminalWindowAppProps) {
  const { resolvedTheme } = useTheme();
  const installedClis = useInstalledClis();
  // The host portals its session subtree into this container (a callback-ref
  // state so the host re-renders once the div mounts).
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  return (
    <>
      {/* Paint the full window with the xterm canvas color so the tab strip and
          canvas read as one continuous surface (mirrors the dock). */}
      <div
        ref={setContainer}
        className="flex h-screen min-h-0 flex-col"
        style={{ backgroundColor: xtermThemeForMode(resolvedTheme).background }}
      />
      <TerminalSessionsHost
        bridge={bridge}
        variant="window"
        // The window is its own always-on terminal surface: visibility never
        // toggles, and the host's close-last "hide" report means the surface is
        // done — close the window (the dock collapses a panel instead).
        visible
        onVisibleChange={(nextVisible) => {
          if (!nextVisible) window.close();
        }}
        installedClis={installedClis}
        container={container}
        isShowing
        // No editor to return focus to — the window IS the terminal, and after
        // close-last it is closing anyway.
        onRequestEditorFocus={() => {}}
      />
    </>
  );
}
