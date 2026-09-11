import { isAbsolute } from 'node:path';
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  type UninstallScreenSpec,
} from '@inkeep/open-knowledge-core';

export const UNINSTALL_PROGRESS_READY_TIMEOUT_MS = 30_000;

export const UNINSTALL_RESULT_ARG = '--ok-uninstall-result';
export const UNINSTALL_PROGRESS_ARG = '--ok-uninstall-progress';

export interface DesktopUninstallResultOptions {
  profile: string;
  locale?: SupportedLocale;
  title: string;
  text: string;
  actionLabel: 'Reveal in Finder' | 'Close';
}

export type DesktopUninstallWindowOptions =
  | (DesktopUninstallResultOptions & { kind: 'result' })
  | { profile: string; kind: 'progress'; locale?: SupportedLocale };

export function parseDesktopUninstallResultArgs(
  argv: readonly string[],
): DesktopUninstallWindowOptions | null {
  const profile = argv.find((arg) => arg.startsWith('--user-data-dir='))?.slice(16);
  if (!profile || !isAbsolute(profile)) return null;
  const rawLocale = argv.find((arg) => arg.startsWith('--ok-uninstall-locale='))?.slice(22);
  const locale = SUPPORTED_LOCALES.find((value) => value === rawLocale);
  if (rawLocale !== undefined && locale === undefined) return null;
  const language = locale === undefined ? {} : { locale };
  if (argv.includes(UNINSTALL_PROGRESS_ARG)) {
    return argv.includes(UNINSTALL_RESULT_ARG) ? null : { profile, kind: 'progress', ...language };
  }
  const index = argv.indexOf(UNINSTALL_RESULT_ARG);
  if (index < 0) return null;
  const result = parseDesktopUninstallResultMessage(`${argv.slice(index + 1).join('\0')}\0`);
  return result === null ? null : { ...result, profile, kind: 'result', ...language };
}

export function parseDesktopUninstallResultMessage(
  message: string,
): Omit<DesktopUninstallResultOptions, 'profile'> | null {
  const fields = message.split('\0');
  const [title, text, actionLabel, end] = fields;
  if (
    fields.length !== 4 ||
    end !== '' ||
    !title ||
    !text ||
    (actionLabel !== 'Reveal in Finder' && actionLabel !== 'Close')
  )
    return null;
  return { title, text, actionLabel };
}

export function desktopUninstallResultCommand(
  executable: string,
  isPackaged: boolean,
  appPath: string,
  locale?: SupportedLocale,
): string[] {
  const command = isPackaged ? [executable] : [executable, appPath];
  return locale === undefined ? command : [...command, `--ok-uninstall-locale=${locale}`];
}

export function desktopUninstallResultScreen(
  options: Pick<DesktopUninstallResultOptions, 'actionLabel'>,
): UninstallScreenSpec {
  return { kind: 'result', outcome: options.actionLabel === 'Close' ? 'failure' : 'success' };
}
