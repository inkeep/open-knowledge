/**
 * Semantic color helpers wrapping picocolors.
 *
 * picocolors natively checks process.argv for --no-color/--color and
 * respects NO_COLOR/FORCE_COLOR env vars at module evaluation time.
 * cli.ts also propagates --no-color/--color to env vars for other
 * libraries in the dependency tree.
 */
import pc from 'picocolors';

/** Red — errors and failures */
export const error = (s: string): string => pc.red(s);

/** Yellow — warnings */
export const warning = (s: string): string => pc.yellow(s);

/** Green — success messages */
export const success = (s: string): string => pc.green(s);

/** Cyan — informational highlights and paths */
export const info = (s: string): string => pc.cyan(s);

/** Gray — secondary/dim text */
export const dim = (s: string): string => pc.gray(s);

/** Bold — emphasis and accents */
export const accent = (s: string): string => pc.bold(s);

/** Whether color output is currently supported/enabled */
export const isColorEnabled = (): boolean => pc.isColorSupported;

/** Wrap text in an OSC 8 clickable hyperlink (supported by most modern terminals) */
export function link(text: string, url: string): string {
  if (!pc.isColorSupported) return text;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}
