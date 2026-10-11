const MAX_DESKTOP_NAME_LENGTH = 64;

export interface LinuxDisplaySession {
  event: 'desktop.linux-display-session';
  sessionType: string | null;
  currentDesktop: string | null;
  waylandDisplaySet: boolean;
  x11DisplaySet: boolean;
  ozonePlatform: string | null;
  ozonePlatformHint: string | null;
}

export interface LinuxDisplaySessionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  getSwitchValue: (name: string) => string;
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed.slice(0, MAX_DESKTOP_NAME_LENGTH);
}

export function describeLinuxDisplaySession(
  deps: LinuxDisplaySessionDeps,
): LinuxDisplaySession | null {
  if (deps.platform !== 'linux') return null;
  return {
    event: 'desktop.linux-display-session',
    sessionType: present(deps.env.XDG_SESSION_TYPE),
    currentDesktop: present(deps.env.XDG_CURRENT_DESKTOP),
    waylandDisplaySet: present(deps.env.WAYLAND_DISPLAY) !== null,
    x11DisplaySet: present(deps.env.DISPLAY) !== null,
    ozonePlatform: present(deps.getSwitchValue('ozone-platform')),
    ozonePlatformHint:
      present(deps.getSwitchValue('ozone-platform-hint')) ??
      present(deps.env.ELECTRON_OZONE_PLATFORM_HINT),
  };
}
