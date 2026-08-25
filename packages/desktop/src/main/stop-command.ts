/**
 * The `ok stop <path>` command string the failed-open dialog tells a user to
 * paste. Its own module because the dialog lives in `index.ts`, which
 * bootstraps Electron at import and so cannot be reached from a test.
 */

/**
 * POSIX single-quote escaping: wrap in `'…'`, embedded single quotes become
 * `'\''`. Nothing is interpreted inside single quotes, so spaces, `$`,
 * backticks, `;` and newlines are all covered by construction.
 */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Windows double-quoting. `"` groups in both `cmd.exe` and PowerShell and is a
 * reserved character in Windows filenames, so there is nothing inside to
 * escape — except a trailing backslash run, which is not about the shell at
 * all. `CommandLineToArgvW` treats backslashes as special only immediately
 * before a `"`: an even run toggles quote mode, an odd run yields a literal
 * `"` and stays in it. So `"C:\"` reaches the process as the single argument
 * `C:"`. Doubling the trailing run restores the even count.
 *
 * A drive root is exactly that shape and is a supported project location —
 * `folder-admission.ts` warns on `C:\` and admits it.
 */
function windowsQuote(value: string): string {
  return `"${value.replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Quote a project path for a command the USER will paste into their own shell.
 *
 * The shell is not ours to choose, so this is a per-platform best answer rather
 * than a universally correct one: POSIX gets single quotes, which are fully
 * literal; Windows gets double quotes, which group in both of its shells.
 *
 * Two known gaps remain on Windows, and this list is the set that has been
 * looked for rather than a proof there are no others. Both need a character
 * that is legal in a Windows path AND special inside double quotes:
 *
 * - PowerShell expands `$` and a backtick inside `"…"`. Backtick-escaping them
 *   would fix PowerShell and corrupt the identical path under `cmd.exe`, where
 *   a backtick is an ordinary character, so there is no single string correct
 *   in both shells.
 * - `cmd.exe` substitutes `%name%` inside double quotes, because quoting
 *   governs space-grouping there, not `%` expansion. `%%` escapes only in a
 *   batch file, not at an interactive prompt.
 *
 * Both fail toward the same place: `ok stop` resolves a path that does not
 * exist and reports no running processes at exit 0. That success-shaped no-op
 * is the outcome this module exists to stop producing, which is why the
 * reachable trailing-backslash case is fixed rather than listed here.
 */
export function quoteStopCommandPath(projectPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? windowsQuote(projectPath) : posixQuote(projectPath);
}
