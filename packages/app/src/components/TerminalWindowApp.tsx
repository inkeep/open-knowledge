import { useTheme } from 'next-themes';
import { useState } from 'react';
import { ReportBugMenuTrigger } from '@/components/ReportBugMenuTrigger';
import { useInstalledClis } from '@/hooks/use-installed-clis';
import { ConfigProvider } from '@/lib/config-provider';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { SessionsHost } from './SessionsHost';
import { useLiveXtermTheme } from './use-live-xterm-theme';

interface TerminalWindowAppProps {
  readonly bridge: OkDesktopBridge;
}

export function TerminalWindowApp({ bridge }: TerminalWindowAppProps) {
  const collabUrl = bridge.config.collabUrl ? bridge.config.collabUrl : null;
  return (
    <ConfigProvider collabUrl={collabUrl}>
      <TerminalWindowBody bridge={bridge} />
      {}
      <ReportBugMenuTrigger systemWide={collabUrl === null} />
    </ConfigProvider>
  );
}

function TerminalWindowBody({ bridge }: TerminalWindowAppProps) {
  const { resolvedTheme } = useTheme();
  const xtermTheme = useLiveXtermTheme(resolvedTheme);
  const installedClis = useInstalledClis();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  return (
    <>
      {}
      <div
        ref={setContainer}
        className="flex h-screen min-h-0 flex-col"
        style={{ backgroundColor: xtermTheme.background }}
      />
      <SessionsHost
        bridge={bridge}
        surface="terminal-window"
        terminalCapable
        visible
        onVisibleChange={(nextVisible: boolean) => {
          if (!nextVisible) window.close();
        }}
        installedClis={installedClis}
        container={container}
        isShowing
        onRequestEditorFocus={() => {}}
      />
    </>
  );
}
