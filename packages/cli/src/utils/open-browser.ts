import { execFile } from 'node:child_process';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional rejection of control characters in URL launcher input
const UNSAFE_URL_CHARS_RE = /[\u0000-\u0020\u007F-\u009F"'`\\&|<>^()$;{}[\]*?!~]/;

function rejectUrl(url: string, reason: string): void {
  console.warn(`Could not auto-open browser (${reason}); visit ${url} manually`);
}

export function openBrowser(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    rejectUrl(url, 'invalid URL');
    return;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    rejectUrl(url, `unsupported scheme '${parsed.protocol}'`);
    return;
  }
  if (UNSAFE_URL_CHARS_RE.test(url)) {
    rejectUrl(url, 'URL contains unsafe characters');
    return;
  }

  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, withHiddenWindowsConsole({}), (err) => {
    if (err) console.warn(`Could not auto-open browser (${err.message}); visit ${url} manually`);
  });
}
