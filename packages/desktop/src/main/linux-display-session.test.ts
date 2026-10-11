import { describe, expect, test } from 'vitest';
import { describeLinuxDisplaySession } from './linux-display-session.ts';

describe('describeLinuxDisplaySession', () => {
  test('names the compositor session and the display backend Chromium was steered to', () => {
    const switches: Record<string, string> = { 'ozone-platform-hint': 'auto' };

    expect(
      describeLinuxDisplaySession({
        platform: 'linux',
        env: {
          XDG_SESSION_TYPE: 'wayland',
          XDG_CURRENT_DESKTOP: 'Hyprland',
          WAYLAND_DISPLAY: 'wayland-1',
          DISPLAY: ':0',
          HOME: '/home/someone',
        },
        getSwitchValue: (name) => switches[name] ?? '',
      }),
    ).toEqual({
      event: 'desktop.linux-display-session',
      sessionType: 'wayland',
      currentDesktop: 'Hyprland',
      waylandDisplaySet: true,
      x11DisplaySet: true,
      ozonePlatform: null,
      ozonePlatformHint: 'auto',
    });
  });

  test('falls back to the Electron hint variable and reports an X11-only session', () => {
    expect(
      describeLinuxDisplaySession({
        platform: 'linux',
        env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':1', ELECTRON_OZONE_PLATFORM_HINT: 'x11' },
        getSwitchValue: () => '',
      }),
    ).toMatchObject({
      sessionType: 'x11',
      currentDesktop: null,
      waylandDisplaySet: false,
      x11DisplaySet: true,
      ozonePlatformHint: 'x11',
    });
  });

  test('bounds a desktop name and records nothing off Linux', () => {
    const session = describeLinuxDisplaySession({
      platform: 'linux',
      env: { XDG_CURRENT_DESKTOP: 'x'.repeat(500) },
      getSwitchValue: () => '',
    });
    expect(session?.currentDesktop).toHaveLength(64);
    expect(
      describeLinuxDisplaySession({ platform: 'darwin', env: {}, getSwitchValue: () => '' }),
    ).toBeNull();
  });
});
