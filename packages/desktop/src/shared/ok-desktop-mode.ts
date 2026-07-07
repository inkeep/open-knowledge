import type { OkDesktopConfig } from './bridge-contract.ts';

/**
 * Resolve the `--ok-mode=<value>` argv flag the main process injects into a
 * window's preload into a render mode. Unknown or absent values fall back to
 * `editor` so a malformed launch still yields a usable editor window rather
 * than a blank one.
 */
export function resolveOkDesktopMode(raw: string | undefined): OkDesktopConfig['mode'] {
  if (raw === 'navigator') return 'navigator';
  if (raw === 'terminal') return 'terminal';
  return 'editor';
}
