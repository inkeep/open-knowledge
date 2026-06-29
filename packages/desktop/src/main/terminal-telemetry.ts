import { withSpanSync } from '@inkeep/open-knowledge-server';

export function recordShellExit(info: { crashed: boolean }): void {
  withSpanSync(
    'ok.desktop.shellExit',
    { attributes: { 'ok.desktop.shell_crashed': info.crashed } },
    () => undefined,
  );
}

export function recordTerminalSession(): void {
  withSpanSync('ok.desktop.terminalSession', {}, () => undefined);
}

export function recordConcurrentSessions(info: { count: number }): void {
  withSpanSync(
    'ok.desktop.terminalConcurrentSessions',
    { attributes: { 'ok.desktop.concurrent_sessions': info.count } },
    () => undefined,
  );
}
