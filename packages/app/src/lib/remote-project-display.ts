import type { OkDesktopConfig } from '@/lib/desktop-bridge-types';

/**
 * Human-readable filesystem location for desktop project chrome.
 *
 * A remote window's `projectPath` is an opaque machine-scoped identity used by
 * desktop state (`ssh:<machine-id>:<encoded-path>`), not a path a user can act
 * on. Tooltips must therefore use the frozen SSH metadata instead.
 */
export function desktopProjectLocation(
  config: Pick<OkDesktopConfig, 'projectPath' | 'remote'>,
): string {
  const remote = config.remote;
  return remote ? `${remote.machineName} • ${remote.path}` : config.projectPath;
}
