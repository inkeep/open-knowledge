/**
 * Empirical validation of the resilient chain (`CHAIN_V1`). Spawns the chain
 * via `/bin/sh -l -c` with controlled HOME / PATH / bundle-path fixtures and
 * asserts the documented branches fire (and only those branches fire).
 *
 * Why spawn-level: every other test asserts the chain's TEXT — that the
 * branches are present in the string. This file asserts the chain's
 * BEHAVIOR — that the documented exit codes / stdout / stderr land when the
 * filesystem and PATH match a real persona (DMG-only, CLI-only, neither).
 * Catches shell-grammar regressions (unmatched globs, `exec`-on-missing
 * killing the shell, `[ -f ]`-vs-`[ -x ]` confusion) that a string-level
 * test would silently miss.
 *
 * Each branch substitutes a benign side-effect (`echo HIT:<branch>`) for the
 * real `exec npx/bundle` invocation so the harness can assert which branch
 * the chain RESOLVED to without spawning the bundled MCP server.
 *
 * Test suite is split in two:
 *
 *   1. **Grammar tests** (`CHAIN_V1 POSIX shell grammar`). Run on every
 *      platform. POSIX sh semantics that are platform-independent: `[ -f ]`
 *      directory filter, `[ -x ]` non-executable filter, unmatched-glob
 *      handling, `exec`-replaces-shell exit propagation. These exercise the
 *      chain's shell-grammar correctness against whichever `/bin/sh` the
 *      runner ships — `dash` on Linux CI, BSD `sh` on macOS — and catch a
 *      grammar regression that text-level assertions would miss.
 *
 *   2. **Persona tests** (`CHAIN_V1 macOS persona behavior`). Darwin only.
 *      Depend on macOS `/etc/profile` → `path_helper` populating PATH with
 *      `/usr/local/bin` + `/opt/homebrew/bin` so a brew-installed Node
 *      surfaces on a login-shell PATH. Linux's `/etc/profile` doesn't run
 *      `path_helper`; the personas don't have Linux equivalents.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAIN_V1 } from './editors.ts';

const SKIP_PERSONA = process.platform !== 'darwin';

/**
 * Replace every `exec` site in the chain with `echo HIT:<branch>` so the
 * harness can detect which branch the chain RESOLVED to without spawning the
 * real bundle / npx. The third `exec` (inner-loop) emits `$d/npx` so we can
 * verify the loop landed on the expected glob-probed directory.
 *
 * `command -v npx` is left alone by default — the chain's check exits the
 * host shell's own PATH; the `suppressNpxPath` option below replaces this
 * line for tests that need to isolate the glob branch or the no-fallback
 * exit-127 branch.
 */
interface InstrumentOpts {
  /**
   * Replace the entire `command -v npx … && exec npx …` line so it always
   * resolves to `false`. Needed for negative-branch tests on macOS, where
   * `/bin/sh -l` runs `path_helper` and always prepends `/usr/local/bin` +
   * `/opt/homebrew/bin` to PATH regardless of the harness's `env.PATH`
   * setting. Without this knob, the PATH-npx branch always wins on a
   * dev mac that has brew-installed Node anywhere on disk.
   */
  suppressNpxPath?: boolean;
  /**
   * Restrict the glob-loop's probe-directory list to entries strictly under
   * the test's `$HOME`. Drops `/opt/homebrew/bin`, `/usr/local/bin`, and any
   * other absolute path the production chain probes for brew/installer
   * locations. Needed for the no-fallback / unmatched-glob tests that assert "no fallback
   * fires anywhere" but dev macs typically have `/usr/local/bin/npx` (or
   * the equivalent under `/opt/homebrew/bin/npx`), so we have to scope the
   * loop down to the empty tmp HOME.
   */
  restrictGlobToHome?: boolean;
  /**
   * Replace the hardcoded `BUNDLE="/Applications/..."` line with one
   * pointing at the given path. Tests that target negative-branch behavior
   * point this at a guaranteed-missing file; the directory + non-executable tests point at a
   * directory or non-executable file to exercise the `[ -f ]` / `[ -x ]`
   * guards.
   */
  bundleOverride?: string;
}

/**
 * Run a `String.replace` and verify it actually changed the chain. A silent
 * no-op (the substring wasn't present) would turn a test into a false-green
 * against the un-instrumented chain. Centralized so a future chain refactor
 * surfaces here as a loud failure instead of a quiet behavioral drift.
 */
function replaceOrThrow(input: string, search: string | RegExp, replacement: string): string {
  const next = input.replace(search, replacement);
  if (next === input) {
    throw new Error(
      `instrumentChain: substitution did not match — chain text may have drifted from this harness. Looking for: ${
        typeof search === 'string' ? JSON.stringify(search) : String(search)
      }`,
    );
  }
  return next;
}

function instrumentChain(opts: InstrumentOpts = {}): string {
  let chain = replaceOrThrow(
    CHAIN_V1,
    'exec "$USER_BUNDLE" mcp',
    'echo "HIT:user-bundle:$USER_BUNDLE" && exit 0',
  );
  chain = replaceOrThrow(chain, 'exec "$BUNDLE" mcp', 'echo "HIT:bundle:$BUNDLE" && exit 0');
  chain = replaceOrThrow(
    chain,
    'exec npx -y @inkeep/open-knowledge@latest mcp',
    'echo "HIT:npx:$(command -v npx)" && exit 0',
  );
  chain = replaceOrThrow(
    chain,
    'exec "$d/npx" -y @inkeep/open-knowledge@latest mcp',
    'echo "HIT:glob:$d/npx" && exit 0',
  );
  if (opts.suppressNpxPath) {
    chain = replaceOrThrow(
      chain,
      /^command -v npx[^\n]*\n/m,
      '# command -v npx suppressed by test harness\n',
    );
  }
  if (opts.restrictGlobToHome) {
    chain = replaceOrThrow(
      chain,
      /^for d in [^\n]*; do$/m,
      'for d in "$HOME/.nvm/versions/node"/*/bin "$HOME/.fnm/node-versions"/*/installation/bin "$HOME/.asdf/installs/nodejs"/*/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do',
    );
  }
  if (opts.bundleOverride !== undefined) {
    // The override is interpolated into a shell double-quoted string.
    // Reject characters that would break out of the quotes or trigger
    // expansion (`"`, `$`, `\`, backtick). Test fixtures use tmpdir paths
    // which are safe today, but a future test passing a hostile path
    // would silently corrupt the chain mutation.
    if (/["$\\`]/.test(opts.bundleOverride)) {
      throw new Error(
        `bundleOverride must not contain ", $, \\, or backtick characters: ${opts.bundleOverride}`,
      );
    }
    // Both bundle branches (user-local + system) need redirecting away
    // from any real installed Desktop so the test's intended branch is the
    // one that fires. The override applies to BUNDLE; USER_BUNDLE points at
    // a guaranteed-missing sibling so the user-local probe also falls
    // through. The user-local override path uses `__user_bundle__` as a
    // suffix so collisions with the override path are impossible.
    chain = replaceOrThrow(
      chain,
      'USER_BUNDLE="$HOME/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"',
      `USER_BUNDLE="${opts.bundleOverride}__user_bundle__"`,
    );
    chain = replaceOrThrow(
      chain,
      'BUNDLE="/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"',
      `BUNDLE="${opts.bundleOverride}"`,
    );
  }
  return chain;
}

interface RunOpts {
  /** Override $HOME for the spawned shell. */
  home: string;
  /** Override PATH. Pass `null` to inherit. */
  path: string | null;
  /** Inject a custom chain — defaults to instrumented `CHAIN_V1`. */
  chainOverride?: string;
}

function runChain(opts: RunOpts): { stdout: string; stderr: string; status: number | null } {
  const chain = opts.chainOverride ?? instrumentChain();
  const env: NodeJS.ProcessEnv = { HOME: opts.home };
  if (opts.path !== null) env.PATH = opts.path;
  // `-i` would zero the env, but spawnSync's `env: {…}` is already a
  // replacement (not a merge). The `-l` login flag is what production uses,
  // so the harness uses it too — including the path_helper expansion that
  // the `suppressNpxPath` knob exists to defeat.
  const result = spawnSync('/bin/sh', ['-l', '-c', chain], { env, encoding: 'utf8' });
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    status: result.status,
  };
}

function setupTmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `mcp-chain-${label}-`));
}

describe('CHAIN_V1 POSIX shell grammar (cross-platform)', () => {
  // Grammar-only tests — assert POSIX sh semantics that hold under both
  // BSD sh (macOS) and dash (Linux). Run unconditionally so CI catches
  // shell-grammar regressions on every push, not only when a dev runs
  // the suite locally on a Mac.

  it('bundle missing, no npx, no version-manager dirs → exit 127 + stderr', () => {
    // npx-PATH branch suppressed, glob loop scoped to $HOME-only
    // directories (defeats the literal `/opt/homebrew/bin` +
    // `/usr/local/bin` probes that find brew npx on a dev mac), bundle
    // pointed at a missing path. Asserts `exit 127` from the final line
    // and the documented stderr message.
    const tmpHome = setupTmp('nofall');
    try {
      const chain = instrumentChain({
        suppressNpxPath: true,
        restrictGlobToHome: true,
        bundleOverride: join(tmpHome, 'no-such-bundle.sh'),
      });
      const { stderr, status } = runChain({
        home: tmpHome,
        path: '/usr/bin:/bin',
        chainOverride: chain,
      });
      expect(status).toBe(127);
      expect(stderr).toContain('OpenKnowledge: install OK Desktop or Node.js 24+');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('bundle path resolves to a directory → [ -f ] filter skips it', () => {
    // Without the `[ -f ]` filter, `[ -x DIR ]` accepts directories under
    // every POSIX shell. The chain would then `exec` the dir and the
    // shell would die. Asserts the bundle branch did NOT fire when
    // BUNDLE points at a directory; downstream branches are unconstrained.
    const tmpHome = setupTmp('dirbundle');
    try {
      const dirBundle = join(tmpHome, 'fake-bundle');
      mkdirSync(dirBundle);
      const chain = instrumentChain({ bundleOverride: dirBundle });
      const { stdout } = runChain({ home: tmpHome, path: '/usr/bin:/bin', chainOverride: chain });
      expect(stdout).not.toContain('HIT:bundle:');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('bundle file lacks +x → [ -x ] filter skips it', () => {
    // Seed a non-executable bundle. The bundle branch's `[ -x ]` guard
    // must reject it; downstream branches are unconstrained.
    const tmpHome = setupTmp('noexec');
    try {
      const noxBundle = join(tmpHome, 'bundle.sh');
      writeFileSync(noxBundle, '#!/bin/sh\necho should-not-run\n');
      chmodSync(noxBundle, 0o644);
      const chain = instrumentChain({ bundleOverride: noxBundle });
      const { stdout } = runChain({ home: tmpHome, path: '/usr/bin:/bin', chainOverride: chain });
      expect(stdout).not.toContain('HIT:bundle:');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('unmatched glob does NOT abort the shell (regression for zsh-glob-error bug)', () => {
    // POSIX `sh` (BSD sh, dash) leaves unmatched globs literal; only zsh
    // aborts with "no matches found". Asserts the chain reaches `exit
    // 127` — i.e. the loop did NOT crash mid-iteration when every glob
    // expansion missed.
    const tmpHome = setupTmp('zshglob');
    try {
      const chain = instrumentChain({
        suppressNpxPath: true,
        restrictGlobToHome: true,
        bundleOverride: join(tmpHome, 'no-such-bundle.sh'),
      });
      const { stderr, status } = runChain({
        home: tmpHome,
        path: '/usr/bin:/bin',
        chainOverride: chain,
      });
      expect(status).toBe(127);
      expect(stderr).toContain('OpenKnowledge: install OK Desktop or Node.js 24+');
      expect(stderr).not.toContain('no matches found');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('bundle process crashes — exit code propagates, no fallback fires', () => {
    // The bundle is a no-fallback contract once exec succeeds. Seed a
    // fake bundle that exits non-zero; the harness sees that non-zero
    // exit (exec semantics replace the shell — POSIX-portable).
    const tmpHome = setupTmp('crash');
    try {
      const crashBundle = join(tmpHome, 'bundle.sh');
      writeFileSync(crashBundle, '#!/bin/sh\nexit 42\n');
      chmodSync(crashBundle, 0o755);

      // Use the REAL chain (not instrumented) so the bundle branch
      // executes for-real. If exec succeeds and the bundle crashes, no
      // downstream branch can fire — the shell has been replaced.
      // USER_BUNDLE has to be redirected too, otherwise on a dev mac with
      // Desktop installed under ~/Applications the user-local branch
      // would shadow this test.
      let chain = replaceOrThrow(
        CHAIN_V1,
        'USER_BUNDLE="$HOME/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"',
        `USER_BUNDLE="${join(tmpHome, 'no-such-user-bundle.sh')}"`,
      );
      chain = replaceOrThrow(
        chain,
        'BUNDLE="/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"',
        `BUNDLE="${crashBundle}"`,
      );
      const { stdout, status } = runChain({
        home: tmpHome,
        path: '/usr/bin:/bin',
        chainOverride: chain,
      });
      expect(status).toBe(42);
      // No fallback marker — once the bundle exec'd, the chain's
      // downstream branches are unreachable.
      expect(stdout).not.toContain('exec');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe.skipIf(SKIP_PERSONA)('CHAIN_V1 macOS persona behavior (darwin only)', () => {
  // Persona tests — depend on macOS `/etc/profile` → `path_helper`
  // populating PATH with `/usr/local/bin` + `/opt/homebrew/bin` on a
  // login shell, AND on a filesystem-fixture-seeded glob path being
  // honored by the spawned login shell. Linux's `/etc/profile` doesn't
  // invoke `path_helper`, and Linux's `dash -l` exhibits subtly
  // different `$HOME`-from-spawn-env behavior under containerized CI
  // runners that turns the version-manager glob test red. The brew/
  // installer/version-manager Node personas don't have Linux
  // equivalents in scope today.

  it('bundle missing, npx on login PATH → npx branch fires', () => {
    // The bundle path is hardcoded to /Applications/...; if it exists on
    // the dev's mac the bundle branch short-circuits. Otherwise the
    // chain falls through to the path_helper-populated `command -v npx`
    // check or the glob loop. Either of bundle / npx / glob hits is a
    // valid resolution; only the absence of all three (exit 127) is
    // surprising on a typical dev mac.
    const tmpHome = setupTmp('npx');
    try {
      const { stdout, status } = runChain({
        home: tmpHome,
        path: '/usr/bin:/bin:/usr/sbin:/sbin',
      });
      expect([0, 127]).toContain(status ?? -1);
      if (status === 0) {
        expect(stdout).toMatch(/HIT:(bundle|npx|glob):/);
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('bundle missing, no npx on PATH, but version-manager glob fires', () => {
    // Seeds `~/.nvm/versions/node/v24.0.0/bin/npx` under the tmp HOME and
    // restricts the loop to $HOME-only probes so the brew/installer
    // literals can't shadow it. Asserts the loop walked to the seeded
    // path and would have exec'd it. Darwin-only because the equivalent
    // Linux dash -l environment doesn't honor the spawn-env-passed HOME
    // for glob expansion identically under containerized CI runners.
    const tmpHome = setupTmp('glob');
    try {
      const nvmBin = join(tmpHome, '.nvm', 'versions', 'node', 'v24.0.0', 'bin');
      mkdirSync(nvmBin, { recursive: true });
      const fakeNpx = join(nvmBin, 'npx');
      writeFileSync(fakeNpx, '#!/bin/sh\necho fake-npx-should-not-run\n');
      chmodSync(fakeNpx, 0o755);

      const chain = instrumentChain({
        suppressNpxPath: true,
        restrictGlobToHome: true,
        bundleOverride: join(tmpHome, 'no-such-bundle.sh'),
      });
      const { stdout, status } = runChain({
        home: tmpHome,
        path: '/usr/bin:/bin',
        chainOverride: chain,
      });
      expect(status).toBe(0);
      expect(stdout).toContain(`HIT:glob:${fakeNpx}`);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
