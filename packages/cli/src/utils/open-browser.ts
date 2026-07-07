/**
 * Cross-platform browser launcher used by `open-knowledge start --open`.
 *
 * Picks the platform-native launcher (`open` on macOS, `xdg-open` on Linux,
 * `cmd /c start` on Windows) and shells out via `execFile`. Failure is
 * non-fatal: the caller has already printed the URL, so we surface a hint
 * and let the user open it manually rather than crashing the server.
 *
 * **URL validation is mandatory** before passing the value to any launcher.
 * On Windows the launcher path goes through `cmd.exe`, which interprets
 * `&`, `|`, `<`, `>`, `^`, `(`, `)`, and quote characters as control
 * tokens — a host or port string smuggled in via `--host`, `HOST`, or
 * `.ok/config.yml` could otherwise be parsed as additional commands. The
 * URL parser alone does not reject these (e.g. `http://localhost&calc:3000`
 * parses cleanly with host `localhost&calc`), so we apply an explicit
 * scheme allowlist and a metacharacter denylist before spawning.
 */
import { execFile } from 'node:child_process';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Reject any URL containing characters that have meaning to a shell
 * (cmd.exe in particular) or that have no business appearing in a launcher
 * URL (whitespace, control codes). The URLs this function opens are
 * constructed by the CLI as `http(s)://host:port` with no query/fragment,
 * so legitimate values are a strict subset of unreserved URI characters;
 * anything else indicates either a malicious config value or a
 * serialization bug upstream.
 *
 * Unicode ranges cover C0 controls + space and DEL + C1 controls;
 * explicit chars cover shell metacharacters across cmd.exe and POSIX
 * shells.
 */
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
  execFile(cmd, args, (err) => {
    if (err) console.warn(`Could not auto-open browser (${err.message}); visit ${url} manually`);
  });
}
