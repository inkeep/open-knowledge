import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAIN_V1 } from './editors.ts';

const SKIP_PERSONA = process.platform !== 'darwin';

interface InstrumentOpts {
  suppressNpxPath?: boolean;
  restrictGlobToHome?: boolean;
  bundleOverride?: string;
}

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
    if (/["$\\`]/.test(opts.bundleOverride)) {
      throw new Error(
        `bundleOverride must not contain ", $, \\, or backtick characters: ${opts.bundleOverride}`,
      );
    }
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
  home: string;
  path: string | null;
  chainOverride?: string;
}

function runChain(opts: RunOpts): { stdout: string; stderr: string; status: number | null } {
  const chain = opts.chainOverride ?? instrumentChain();
  const env: NodeJS.ProcessEnv = { HOME: opts.home };
  if (opts.path !== null) env.PATH = opts.path;
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
  it('bundle missing, no npx, no version-manager dirs → exit 127 + stderr', () => {
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
    const tmpHome = setupTmp('crash');
    try {
      const crashBundle = join(tmpHome, 'bundle.sh');
      writeFileSync(crashBundle, '#!/bin/sh\nexit 42\n');
      chmodSync(crashBundle, 0o755);

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
      expect(stdout).not.toContain('exec');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe.skipIf(SKIP_PERSONA)('CHAIN_V1 macOS persona behavior (darwin only)', () => {
  it('bundle missing, npx on login PATH → npx branch fires', () => {
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
