import { withSpanSync } from '@inkeep/open-knowledge-server';

function platformAttributes(): { 'ok.platform': NodeJS.Platform } {
  return { 'ok.platform': process.platform };
}

export function recordShellExit(info: { crashed: boolean }): void {
  withSpanSync(
    'ok.desktop.shellExit',
    {
      attributes: {
        'ok.desktop.shell_crashed': info.crashed,
        ...platformAttributes(),
      },
    },
    () => undefined,
  );
}

export function recordTerminalSession(): void {
  withSpanSync('ok.desktop.terminalSession', { attributes: platformAttributes() }, () => undefined);
}

export function recordConcurrentSessions(info: { count: number }): void {
  withSpanSync(
    'ok.desktop.terminalConcurrentSessions',
    {
      attributes: {
        'ok.desktop.concurrent_sessions': info.count,
        ...platformAttributes(),
      },
    },
    () => undefined,
  );
}

export function recordTerminalWindowOpened(): void {
  withSpanSync(
    'ok.desktop.terminalWindowOpened',
    { attributes: platformAttributes() },
    () => undefined,
  );
}
