/**
 * Vite-style boxed startup banner using cli-boxes + picocolors.
 *
 * Box-drawing characters are Unicode (always visible). Colors are applied
 * via the lazy color helpers, so NO_COLOR is respected automatically.
 */
import cliBoxes from 'cli-boxes';
import { accent, dim, info, link } from './colors.ts';

const box = cliBoxes.round;

interface BannerOptions {
  name: string;
  version: string;
  /** Primary URL — displayed as "Editor:" when set, else "Local:" (API). */
  localUrl: string;
  networkUrl?: string;
  /**
   * Secondary URL for the collab/API server. When set, the primary `localUrl`
   * is labeled "Editor:" (pointing at `ok ui`) and this field is rendered as
   * "API:" (pointing at `ok start`). this gives operators
   * the URL they actually want to click.
   */
  apiUrl?: string;
  /**
   * Optional "what to do now" lines rendered (dimmed) below the URLs and above
   * the Ctrl+C hint. Each entry is its own line inside the box. Keep them
   * short — they drive the box width. Omit for the bare URL banner.
   */
  nextSteps?: string[];
}

/**
 * Render a boxed startup banner. Returns a multi-line string for console.log().
 */
export function renderBanner(opts: BannerOptions): string {
  // Build content lines as [plain text, colored text] pairs.
  // Plain text is used for width calculation; colored text for display.
  const lines: Array<{ plain: string; colored: string }> = [];

  // Product name + version (bold)
  const title = `${opts.name} v${opts.version}`;
  lines.push({ plain: title, colored: accent(title) });

  // Blank separator
  lines.push({ plain: '', colored: '' });

  // Primary URL (clickable via OSC 8 hyperlink). When both UI + API exist,
  // label the primary as "Editor:" so operators click the user-facing URL.
  const localLabel = opts.apiUrl ? 'Editor:  ' : 'Local:   ';
  lines.push({
    plain: `${localLabel}${opts.localUrl}`,
    colored: `${localLabel}${link(info(opts.localUrl), opts.localUrl)}`,
  });

  // Secondary API URL — the collab/HTTP server. Dimmed to de-emphasize.
  if (opts.apiUrl) {
    const apiLabel = 'API:     ';
    lines.push({
      plain: `${apiLabel}${opts.apiUrl}`,
      colored: `${apiLabel}${dim(link(opts.apiUrl, opts.apiUrl))}`,
    });
  }

  // Network URL (optional, clickable)
  if (opts.networkUrl) {
    const netLabel = 'Network: ';
    lines.push({
      plain: `${netLabel}${opts.networkUrl}`,
      colored: `${netLabel}${link(info(opts.networkUrl), opts.networkUrl)}`,
    });
  }

  // Next-steps section (optional) — a blank separator then one dimmed line per
  // step, so the user sees what to do once the server is up.
  if (opts.nextSteps && opts.nextSteps.length > 0) {
    lines.push({ plain: '', colored: '' });
    for (const step of opts.nextSteps) {
      lines.push({ plain: step, colored: dim(step) });
    }
  }

  // Blank separator + Ctrl+C hint
  lines.push({ plain: '', colored: '' });
  const hint = 'Press Ctrl+C to stop';
  lines.push({ plain: hint, colored: dim(hint) });

  // Compute box width from plain text
  const padding = 2;
  const maxContentWidth = Math.max(...lines.map((l) => l.plain.length));
  const innerWidth = maxContentWidth + padding * 2;

  // Assemble box
  const topBorder = `  ${box.topLeft}${box.top.repeat(innerWidth)}${box.topRight}`;
  const bottomBorder = `  ${box.bottomLeft}${box.bottom.repeat(innerWidth)}${box.bottomRight}`;

  const contentLines = lines.map((line) => {
    const rightPad = maxContentWidth - line.plain.length;
    return `  ${box.left}${' '.repeat(padding)}${line.colored}${' '.repeat(rightPad + padding)}${box.right}`;
  });

  return ['', topBorder, ...contentLines, bottomBorder, ''].join('\n');
}
