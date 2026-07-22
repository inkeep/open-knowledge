/**
 * AppImage deep-link self-registration (windows-linux-port deep-link posture).
 *
 * AppImages have no install step, so nothing registers a `.desktop` entry
 * with `MimeType=x-scheme-handler/openknowledge` — `openknowledge://` links
 * silently go nowhere (electron-builder#4035; deb installs get the entry
 * from the package instead). The AppImage runtime exports `APPIMAGE` (the
 * absolute path of the running image), which lets the app self-register at
 * every boot: write a user-scope handler entry pointing at the current
 * image path and (best-effort) refresh the desktop database + MIME default.
 *
 * Self-heal per boot is deliberate (matches the MCP-wiring reclaim
 * posture): the user may move or rename the AppImage between runs — each
 * boot rewrites the entry to the current path, so the handler is correct
 * for the most recently launched copy.
 *
 * Everything here is best-effort: a headless box without xdg-utils still
 * boots fine, deep links just stay unregistered (they already were).
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Basename of the handler entry under `~/.local/share/applications`. */
export const APPIMAGE_HANDLER_DESKTOP_NAME = 'openknowledge-url-handler.desktop';

/**
 * Quote one Exec argument per the freedesktop Desktop Entry spec: wrap in
 * double quotes when it contains reserved characters, escaping the four
 * characters that need a backslash inside a quoted argument (`"`, `` ` ``,
 * `$`, `\`).
 */
export function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9/._+:@%-]+$/.test(arg)) return arg;
  return `"${arg.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
}

/**
 * The handler entry body. `NoDisplay=true` keeps it out of app launchers —
 * it exists solely as the x-scheme-handler target (launchers show the
 * AppImage itself, or whatever integration tool the user runs). `%U` hands
 * the clicked URL to the argv deep-link path (`url-scheme.ts` scans argv +
 * second-instance on non-mac).
 */
export function buildAppImageHandlerDesktopEntry(appImagePath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=OpenKnowledge URL Handler',
    `Exec=${quoteExecArg(appImagePath)} %U`,
    'Terminal=false',
    'NoDisplay=true',
    'MimeType=x-scheme-handler/openknowledge;',
    'StartupWMClass=OpenKnowledge',
    '',
  ].join('\n');
}

export type AppImageRegistrationResult =
  | { status: 'registered'; desktopFilePath: string }
  | { status: 'skipped'; reason: 'not-linux' | 'not-packaged' | 'not-appimage' | 'no-home' }
  | { status: 'failed'; error: string };

export interface AppImageRegistrationDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  homeDir: string;
  /** Injectable fs/exec seams for tests. Defaults are the real implementations. */
  writeFileImpl?: typeof writeFile;
  mkdirImpl?: typeof mkdir;
  execFileImpl?: (cmd: string, args: string[], cb: (err: Error | null) => void) => void;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

/**
 * Write the handler entry + refresh the databases. The two xdg refresh
 * calls are fire-and-forget best-effort — `update-desktop-database` only
 * exists where desktop-file-utils is installed, and GNOME/KDE pick up new
 * entries without it (they inotify-watch the applications dir).
 */
export async function registerAppImageDeepLinks(
  deps: AppImageRegistrationDeps,
): Promise<AppImageRegistrationResult> {
  const { platform, isPackaged, env, homeDir } = deps;
  if (platform !== 'linux') return { status: 'skipped', reason: 'not-linux' };
  if (!isPackaged) return { status: 'skipped', reason: 'not-packaged' };
  const appImagePath = env.APPIMAGE;
  if (!appImagePath) return { status: 'skipped', reason: 'not-appimage' };
  if (!homeDir) return { status: 'skipped', reason: 'no-home' };

  const applicationsDir =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
      ? join(env.XDG_DATA_HOME, 'applications')
      : join(homeDir, '.local', 'share', 'applications');
  const desktopFilePath = join(applicationsDir, APPIMAGE_HANDLER_DESKTOP_NAME);

  const writeFileFn = deps.writeFileImpl ?? writeFile;
  const mkdirFn = deps.mkdirImpl ?? mkdir;
  const execFileFn =
    deps.execFileImpl ??
    ((cmd: string, args: string[], cb: (err: Error | null) => void) => {
      execFile(cmd, args, { timeout: 5_000 }, (err) => cb(err));
    });

  try {
    await mkdirFn(applicationsDir, { recursive: true });
    await writeFileFn(desktopFilePath, buildAppImageHandlerDesktopEntry(appImagePath), 'utf8');
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }

  for (const [cmd, args] of [
    ['update-desktop-database', [applicationsDir]],
    ['xdg-mime', ['default', APPIMAGE_HANDLER_DESKTOP_NAME, 'x-scheme-handler/openknowledge']],
  ] as const) {
    execFileFn(cmd, [...args], (err) => {
      if (err) {
        deps.log?.warn(
          { cmd, err },
          '[appimage-integration] xdg refresh failed (deep links may need a relog)',
        );
      }
    });
  }

  deps.log?.info(
    { desktopFilePath, appImagePath },
    '[appimage-integration] openknowledge:// handler entry written',
  );
  return { status: 'registered', desktopFilePath };
}
