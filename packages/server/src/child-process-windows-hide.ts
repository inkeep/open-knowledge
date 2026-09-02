export type HiddenWindowsConsoleOptions<T extends object> = T & { windowsHide: true };

export const LOCAL_OP_PIPE_STDIO_OPTIONS: { stdio: ['ignore', 'pipe', 'pipe'] } = {
  stdio: ['ignore', 'pipe', 'pipe'],
};

export function withHiddenWindowsConsole<T extends object>(
  options: T,
): HiddenWindowsConsoleOptions<T> {
  return { ...options, windowsHide: true };
}
