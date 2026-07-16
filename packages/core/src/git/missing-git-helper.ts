/**
 * Classifier for git stderr that means "git spawned a configured helper
 * program and the OS couldn't find it" — the failure shape a minimal GUI
 * PATH produces for git-lfs filters, credential helpers, `core.sshCommand`,
 * `core.fsmonitor`, gpg, and `core.hooksPath` interpreters. Distinguishing
 * this class from generic git failures lets the UI say WHICH tool is missing
 * ("Git needs git-lfs…") instead of a retry-blind generic error.
 *
 * Matching assumes English-locale stderr — every OK git spawn pins
 * `LANG=C`/`LC_ALL=C` (see the desktop git spawn env and the server's
 * `buildGitEnv`), the same discipline `git-checkout.ts` relies on for its
 * stderr classification.
 */

/**
 * stderr shapes, one per spawn-failure surface:
 *
 * 1. Shell 127 phrasing — a filter/helper command line run via `sh -c`:
 *    `git-lfs filter-process: git-lfs: command not found`   (bash)
 *    `sh: gpg: command not found`                           (bash)
 *    `sh: 1: git-lfs: not found`                            (dash — Linux)
 *    The token immediately before ": [command] not found" is the command the
 *    shell failed to resolve (earlier `<label>:` prefixes are the reporting
 *    program, not the missing one). Requiring the colon directly after the
 *    token keeps prose like `fatal: remote ref not found` from matching.
 *
 * 2. git's own start_command failure (helpers git execs directly):
 *    `error: cannot run gpg: No such file or directory`
 *    `fatal: cannot run ssh: No such file or directory`
 *
 * 3. exec failure with a quoted path (hooks, sendemail helpers):
 *    `fatal: cannot exec '.husky/post-checkout': No such file or directory`
 *
 * 4. credential-helper dispatch through the git command namespace:
 *    `git: 'credential-manager' is not a git command. See 'git --help'.`
 */
const MISSING_HELPER_PATTERNS: readonly RegExp[] = [
  /([^\s:'"]+): (?:command )?not found/,
  /cannot run ([^:\n]+): No such file or directory/,
  /cannot exec '([^']+)': No such file or directory/,
  /git: '(credential-[^']+)' is not a git command/,
];

/**
 * Extract the missing command from git stderr, or `null` when the failure is
 * not the missing-helper class. Returns the command as reported (a bare name
 * for PATH lookups, a path for hook exec failures); callers display it
 * verbatim. First matching pattern wins.
 */
export function detectMissingGitHelper(stderr: string): string | null {
  for (const pattern of MISSING_HELPER_PATTERNS) {
    const match = pattern.exec(stderr);
    const command = match?.[1]?.trim();
    if (command !== undefined && command.length > 0) return command;
  }
  return null;
}
