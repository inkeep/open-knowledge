import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const APPIMAGE_HANDLER_DESKTOP_NAME = 'openknowledge-url-handler.desktop';

export function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9/._+:@%-]+$/.test(arg)) return arg;
  return `"${arg.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
}

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
  writeFileImpl?: typeof writeFile;
  mkdirImpl?: typeof mkdir;
  execFileImpl?: (cmd: string, args: string[], cb: (err: Error | null) => void) => void;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

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
      execFile(cmd, args, { timeout: 5_000, windowsHide: true }, (err) => cb(err));
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
