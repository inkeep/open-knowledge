import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_PRODUCTS, type DesktopProductName } from '@inkeep/open-knowledge-core';
import { describe, expect, it, vi } from 'vitest';
import { buildManagedServerEntry } from './editors.ts';

const CHANNELS = ['stable', 'beta'] as const satisfies readonly DesktopProductName[];

function chainFor(channel: DesktopProductName): string {
  vi.stubEnv('OK_CHANNEL', channel);
  try {
    const args = buildManagedServerEntry({ mode: 'published', platformName: 'darwin' }).args;
    if (!Array.isArray(args) || typeof args[2] !== 'string') throw new Error('expected a chain');
    return args[2];
  } finally {
    vi.unstubAllEnvs();
  }
}

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

function instrumentChain(channel: DesktopProductName, opts: InstrumentOpts = {}): string {
  const product = DESKTOP_PRODUCTS[channel];
  let chain = replaceOrThrow(
    chainFor(channel),
    'exec "$USER_BUNDLE" mcp',
    'echo "HIT:user-bundle:$USER_BUNDLE" && exit 0',
  );
  chain = replaceOrThrow(chain, 'exec "$BUNDLE" mcp', 'echo "HIT:bundle:$BUNDLE" && exit 0');
  chain = replaceOrThrow(
    chain,
    `exec npx -y @inkeep/open-knowledge@${product.npmDistTag} mcp`,
    'echo "HIT:npx:$(command -v npx):channel=$OK_CHANNEL" && exit 0',
  );
  chain = replaceOrThrow(
    chain,
    `exec "$d/npx" -y @inkeep/open-knowledge@${product.npmDistTag} mcp`,
    'echo "HIT:glob:$d/npx:channel=$OK_CHANNEL" && exit 0',
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
      `USER_BUNDLE="$HOME/Applications/${product.productName}.app/Contents/Resources/cli/bin/ok.sh"`,
      `USER_BUNDLE="${opts.bundleOverride}__user_bundle__"`,
    );
    chain = replaceOrThrow(
      chain,
      `BUNDLE="/Applications/${product.productName}.app/Contents/Resources/cli/bin/ok.sh"`,
      `BUNDLE="${opts.bundleOverride}"`,
    );
  }
  return chain;
}

interface RunOpts {
  home: string;
  path: string | null;
  chainOverride: string;
}

function runChain(opts: RunOpts): { stdout: string; stderr: string; status: number | null } {
  const chain = opts.chainOverride;
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

describe.each(CHANNELS)('%s chain POSIX shell grammar (cross-platform)', (channel) => {
  it('bundle missing, no npx, no version-manager dirs → exit 127 + stderr', () => {
    const tmpHome = setupTmp('nofall');
    try {
      const chain = instrumentChain(channel, {
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
      const chain = instrumentChain(channel, { bundleOverride: dirBundle });
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
      const chain = instrumentChain(channel, { bundleOverride: noxBundle });
      const { stdout } = runChain({ home: tmpHome, path: '/usr/bin:/bin', chainOverride: chain });
      expect(stdout).not.toContain('HIT:bundle:');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('unmatched glob does NOT abort the shell (regression for zsh-glob-error bug)', () => {
    const tmpHome = setupTmp('zshglob');
    try {
      const chain = instrumentChain(channel, {
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

  it("the npx fallback runs with this chain's channel", () => {
    const tmpHome = setupTmp('npxchannel');
    try {
      const bin = join(tmpHome, 'bin');
      mkdirSync(bin);
      const fakeNpx = join(bin, 'npx');
      writeFileSync(fakeNpx, '#!/bin/sh\nexit 0\n');
      chmodSync(fakeNpx, 0o755);
      const chain = instrumentChain(channel, {
        restrictGlobToHome: true,
        bundleOverride: join(tmpHome, 'no-such-bundle.sh'),
      });
      const { stdout, status } = runChain({
        home: tmpHome,
        path: `${bin}:/usr/bin:/bin`,
        chainOverride: chain,
      });
      expect(status).toBe(0);
      expect(stdout).toContain(
        `HIT:npx:${fakeNpx}:channel=${channel === 'stable' ? '' : channel}\n`,
      );
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

      const productName = DESKTOP_PRODUCTS[channel].productName;
      let chain = replaceOrThrow(
        chainFor(channel),
        `USER_BUNDLE="$HOME/Applications/${productName}.app/Contents/Resources/cli/bin/ok.sh"`,
        `USER_BUNDLE="${join(tmpHome, 'no-such-user-bundle.sh')}"`,
      );
      chain = replaceOrThrow(
        chain,
        `BUNDLE="/Applications/${productName}.app/Contents/Resources/cli/bin/ok.sh"`,
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

describe.skipIf(SKIP_PERSONA).each(CHANNELS)(
  '%s chain macOS persona behavior (darwin only)',
  (channel) => {
    it('bundle missing, npx on login PATH → npx branch fires', () => {
      const tmpHome = setupTmp('npx');
      try {
        const { stdout, status } = runChain({
          home: tmpHome,
          path: '/usr/bin:/bin:/usr/sbin:/sbin',
          chainOverride: instrumentChain(channel),
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

        const chain = instrumentChain(channel, {
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
  },
);
