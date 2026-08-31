export type HiddenWindowsConsoleOptions<T extends object> = T & { windowsHide: true };

/**
 * The piped local-op spawn stdio shape (stdin ignored, stdout + stderr piped
 * for capture) — the one member of the extension's stdio-shape family that
 * grew a second consumer when the share family lifted out. Shared from here —
 * the module both `api-extension.ts` and `http/share-routes.ts` already
 * import for {@link withHiddenWindowsConsole} — so the shape has one
 * declaration rather than per-call-site copies that can silently drift. The
 * extension's other stdio shapes (stderr-only, fully-ignored) stay local to
 * their single call sites.
 */
export const LOCAL_OP_PIPE_STDIO_OPTIONS: { stdio: ['ignore', 'pipe', 'pipe'] } = {
  stdio: ['ignore', 'pipe', 'pipe'],
};

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
