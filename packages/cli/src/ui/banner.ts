import cliBoxes from 'cli-boxes';
import { accent, dim, info, link } from './colors.ts';

const box = cliBoxes.round;

interface BannerOptions {
  name: string;
  version: string;
  localUrl: string;
  networkUrl?: string;
  apiUrl?: string;
  nextSteps?: string[];
}

export function renderBanner(opts: BannerOptions): string {
  const lines: Array<{ plain: string; colored: string }> = [];

  const title = `${opts.name} v${opts.version}`;
  lines.push({ plain: title, colored: accent(title) });

  lines.push({ plain: '', colored: '' });

  const localLabel = opts.apiUrl ? 'Editor:  ' : 'Local:   ';
  lines.push({
    plain: `${localLabel}${opts.localUrl}`,
    colored: `${localLabel}${link(info(opts.localUrl), opts.localUrl)}`,
  });

  if (opts.apiUrl) {
    const apiLabel = 'API:     ';
    lines.push({
      plain: `${apiLabel}${opts.apiUrl}`,
      colored: `${apiLabel}${dim(link(opts.apiUrl, opts.apiUrl))}`,
    });
  }

  if (opts.networkUrl) {
    const netLabel = 'Network: ';
    lines.push({
      plain: `${netLabel}${opts.networkUrl}`,
      colored: `${netLabel}${link(info(opts.networkUrl), opts.networkUrl)}`,
    });
  }

  if (opts.nextSteps && opts.nextSteps.length > 0) {
    lines.push({ plain: '', colored: '' });
    for (const step of opts.nextSteps) {
      lines.push({ plain: step, colored: dim(step) });
    }
  }

  lines.push({ plain: '', colored: '' });
  const hint = 'Press Ctrl+C to stop';
  lines.push({ plain: hint, colored: dim(hint) });

  const padding = 2;
  const maxContentWidth = Math.max(...lines.map((l) => l.plain.length));
  const innerWidth = maxContentWidth + padding * 2;

  const topBorder = `  ${box.topLeft}${box.top.repeat(innerWidth)}${box.topRight}`;
  const bottomBorder = `  ${box.bottomLeft}${box.bottom.repeat(innerWidth)}${box.bottomRight}`;

  const contentLines = lines.map((line) => {
    const rightPad = maxContentWidth - line.plain.length;
    return `  ${box.left}${' '.repeat(padding)}${line.colored}${' '.repeat(rightPad + padding)}${box.right}`;
  });

  return ['', topBorder, ...contentLines, bottomBorder, ''].join('\n');
}
