export type HiddenWindowsConsoleOptions<T extends object> = T & { windowsHide: true };

/**
 * GUI-launched Windows server processes have no inherited console. Without
 * `windowsHide`, console-subsystem children such as git.exe allocate a visible
 * conhost window for the duration of each subprocess.
 */
export function withHiddenWindowsConsole<T extends object>(
  options: T,
): HiddenWindowsConsoleOptions<T> {
  return { ...options, windowsHide: true };
}
