import pc from 'picocolors';

export const error = (s: string): string => pc.red(s);

export const warning = (s: string): string => pc.yellow(s);

export const success = (s: string): string => pc.green(s);

export const info = (s: string): string => pc.cyan(s);

export const dim = (s: string): string => pc.gray(s);

export const accent = (s: string): string => pc.bold(s);

export const isColorEnabled = (): boolean => pc.isColorSupported;

export function link(text: string, url: string): string {
  if (!pc.isColorSupported) return text;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}
