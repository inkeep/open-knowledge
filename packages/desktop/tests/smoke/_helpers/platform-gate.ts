import { join } from 'node:path';
import { isTerminalPlatform } from '../../../src/shared/terminal-platform.ts';

export const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';

export const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'win32', 'linux']);

export const PLATFORM_SUPPORTED = SUPPORTED_PLATFORMS.has(process.platform);

export const PLATFORM_SKIP_REASON = `Smoke harness does not support platform "${process.platform}".`;

export const PTY_PLATFORM_SUPPORTED = isTerminalPlatform(process.platform);

export const PTY_PLATFORM_SKIP_REASON = `Desktop terminal does not support platform "${process.platform}".`;

export function homeEnv(tmpHome: string): Record<string, string> {
  if (process.platform !== 'win32') return { HOME: tmpHome };
  return { HOME: tmpHome, USERPROFILE: tmpHome };
}

export function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

export const SPEC_PLATFORM_GATES = {
  '_nav-empty-840x600.e2e.ts': ['!PLATFORM_SUPPORTED'],
  '_nav-size-screenshots.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'agent-patch-divergence-probe.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'background-throttle.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'cold-single-file-launch.e2e.ts': ['!DARWIN'],
  'consent-dialog.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'create-new-project.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'deep-link.e2e.ts': ['!DARWIN'],
  'external-link.e2e.ts': ['!DARWIN'],
  'mcp-wiring.e2e.ts': ['!PLATFORM_SUPPORTED', 'WINDOWS', "WINDOWS || TARGET.mode === 'packaged'"],
  'navigator-close-on-open.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'navigator-return.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'note-window.e2e.ts': ['!PLATFORM_SUPPORTED', '!DARWIN'],
  'okf-rule-toggle.e2e.ts': ['!DARWIN'],
  'qa-create-new-extended.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'rename-divergence-probe.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'report-bug.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'saved-theme-paint.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'share-receive-miss-terminal.e2e.ts': ['!PLATFORM_SUPPORTED'],
  'share-receive-multi-worktree.e2e.ts': ['!DARWIN'],
  'sidebar-create-rename-editable.e2e.ts': ['!DARWIN'],
  'sidebar-pill-lockstep-fade.e2e.ts': ['!DARWIN'],
  'skill-scope-roundtrip.e2e.ts': ['!DARWIN'],
  'skills-studio.e2e.ts': ['!DARWIN'],
  'terminal-dock-state.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-dock.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-links.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-movement.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-process-restart.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-tabs.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'terminal-window.e2e.ts': ['!PTY_PLATFORM_SUPPORTED'],
  'theme-sync.e2e.ts': ['!DARWIN'],
  'uninstall-ipc-bridge.e2e.ts': ['!DARWIN'],
  'uninstall-notice.e2e.ts': ['!DARWIN'],
  'uninstall-picker.e2e.ts': ['!DARWIN'],
  'uninstall-survey.e2e.ts': ['!DARWIN'],
  'uninstall-window-chrome.e2e.ts': ['!DARWIN'],
  'window-chrome.e2e.ts': ['!PLATFORM_SUPPORTED', 'DARWIN', '!PLATFORM_SUPPORTED'],
  'window-min-size.e2e.ts': ['!PLATFORM_SUPPORTED'],
} as const satisfies Record<string, readonly string[]>;
