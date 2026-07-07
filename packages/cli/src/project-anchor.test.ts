import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getInvocationCwd, recordInvocationCwd, resolveProjectAnchor } from './project-anchor.ts';

const CLI_PACKAGE_ROOT = import.meta.dir.replace(/\/src$/, '');

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-anchor-'));
  cleanups.push(dir);
  return dir;
}

function makeProjectRoot(dir: string, configYaml = ''): void {
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), configYaml);
}

describe('resolveProjectAnchor — command gating', () => {
  const stubHit = () => ({ rootPath: '/proj', distance: 2 });

  test.each([
    'start',
    'stop',
    'status',
    'clean',
    'ui',
    'mcp',
    'preview',
  ])('anchors lifecycle command %s', (name) => {
    expect(resolveProjectAnchor(name, '/proj/sub/dir', stubHit)).toBe('/proj');
  });

  test('anchors the bare-`ok` dispatch (undefined command name)', () => {
    expect(resolveProjectAnchor(undefined, '/proj/sub/dir', stubHit)).toBe('/proj');
  });

  test.each([
    'init',
    'seed',
    'clone',
    'open',
    'ps',
    'auth',
    'config',
    'diagnose',
  ])('keeps literal-cwd semantics for %s without probing the filesystem', (name) => {
    let called = false;
    const probe = () => {
      called = true;
      return stubHit();
    };
    expect(resolveProjectAnchor(name, '/proj/sub/dir', probe)).toBeNull();
    expect(called).toBe(false);
  });

  test('returns null when cwd is itself the project root (distance 0)', () => {
    expect(
      resolveProjectAnchor('start', '/proj', () => ({ rootPath: '/proj', distance: 0 })),
    ).toBeNull();
  });

  test('returns null when no enclosing project exists', () => {
    expect(resolveProjectAnchor('start', '/nowhere', () => null)).toBeNull();
  });
});

describe('invocation cwd', () => {
  // Module-level state: reset after each case so no other test in this
  // process inherits a recorded value.
  afterEach(() => recordInvocationCwd(null));

  test('defaults to process.cwd() before any anchoring', () => {
    expect(getInvocationCwd()).toBe(process.cwd());
  });

  test('returns the recorded pre-anchor directory after recordInvocationCwd', () => {
    recordInvocationCwd('/proj/sub');
    expect(getInvocationCwd()).toBe('/proj/sub');
  });
});

describe('resolveProjectAnchor — real filesystem walk', () => {
  test('resolves the nearest enclosing project root from a subdirectory', () => {
    const root = makeFixture();
    makeProjectRoot(root);
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });

    expect(resolveProjectAnchor('start', sub)).toBe(root);
  });

  test('closest-ancestor-wins: a nested project stops the walk', () => {
    const outer = makeFixture();
    makeProjectRoot(outer);
    const inner = join(outer, 'a');
    makeProjectRoot(inner);
    const sub = join(inner, 'b');
    mkdirSync(sub, { recursive: true });

    expect(resolveProjectAnchor('start', sub)).toBe(inner);
  });

  test('a bare .ok/ directory without config.yml is not a project root', () => {
    const root = makeFixture();
    makeProjectRoot(root);
    const sub = join(root, 'a');
    // Folder-rule sidecar shape: `.ok/` exists but holds no config.yml.
    mkdirSync(join(sub, '.ok'), { recursive: true });
    const deeper = join(sub, 'b');
    mkdirSync(deeper, { recursive: true });

    expect(resolveProjectAnchor('start', deeper)).toBe(root);
  });

  test('returns null when no ancestor is a project root', () => {
    const dir = makeFixture();
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });

    expect(resolveProjectAnchor('start', sub)).toBeNull();
  });
});

/**
 * Cold-spawn the real CLI entry point — exercises the preAction hook wiring
 * (anchor → chdir → disclosure line → loadConfig from the resolved root),
 * not just the pure helper. Spawn cwd stays at the package root for module
 * resolution; the fixture directory is injected via `--cwd`, which the
 * preAction hook applies before anchoring.
 */
function spawnCli(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [
      'bun',
      '--conditions=development',
      '-e',
      `
      process.argv = [process.execPath, process.cwd() + '/src/cli.ts', ...${JSON.stringify(args)}];
      await import('./src/cli.ts');
      `,
    ],
    cwd: CLI_PACKAGE_ROOT,
    // OK_BUNDLE_PROXY=0 keeps `ok mcp` in-process on machines with the
    // desktop app installed (it would otherwise exec the bundled CLI).
    env: { ...process.env, NO_COLOR: '1', OK_BUNDLE_PROXY: '0' },
    // Closed stdin: long-running stdio commands (`ok mcp`) see EOF and exit
    // instead of wedging the sync spawn. Timeout is the regression backstop.
    stdin: 'ignore',
    timeout: 25_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('CLI preAction project anchoring (cold spawn)', () => {
  test('`ok status` from a subdirectory anchors to the root and prints the disclosure line', () => {
    const root = makeFixture();
    makeProjectRoot(root);
    const sub = join(root, 'notes', 'daily');
    mkdirSync(sub, { recursive: true });

    const { exitCode, stdout, stderr } = spawnCli(['--cwd', sub, 'status', '--json']);

    expect(exitCode).toBe(0);
    // `--cwd` goes through process.chdir, which canonicalizes symlinks
    // (macOS `/var` → `/private/var`), so compare against the realpath.
    expect(stderr).toContain(`[ok] Using OpenKnowledge project at ${realpathSync(root)}`);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('server');
  }, 30_000);

  test('`ok preview` from a subdirectory loads the ROOT config, not defaults', () => {
    const root = makeFixture();
    makeProjectRoot(root, 'content:\n  dir: docs\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'hello.md'), '# hello\n');
    const sub = join(root, 'unrelated', 'deep');
    mkdirSync(sub, { recursive: true });

    const { exitCode, stdout, stderr } = spawnCli(['--cwd', sub, 'preview']);

    expect(exitCode).toBe(0);
    expect(stderr).toContain(`[ok] Using OpenKnowledge project at ${realpathSync(root)}`);
    // Scope resolved from the root's `content.dir: docs` — proves loadConfig
    // ran against the anchored root rather than the literal cwd's defaults.
    expect(stdout).toContain('hello.md');
  }, 30_000);

  test('no disclosure line when cwd is already the project root', () => {
    const root = makeFixture();
    makeProjectRoot(root);

    const { exitCode, stderr } = spawnCli(['--cwd', root, 'status', '--json']);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('Using OpenKnowledge project at');
  }, 30_000);

  test('`ok stop <relative-dir>` resolves the target against the invocation cwd, not the anchored root', () => {
    const root = makeFixture();
    makeProjectRoot(root);
    const sub = join(root, 'sub');
    // The live lock sits at <sub>/target — only reachable when the relative
    // target resolves against the invocation cwd. A regression that resolves
    // against the post-anchor root would look in <root>/target and report
    // "No running open-knowledge processes." instead of stopping the pid.
    const targetDir = join(sub, 'target');
    mkdirSync(join(targetDir, '.ok', 'local'), { recursive: true });

    const sleeper = Bun.spawn(['sleep', '60']);
    try {
      writeFileSync(
        join(targetDir, '.ok', 'local', 'server.lock'),
        JSON.stringify({ pid: sleeper.pid, port: 4242, hostname: hostname() }),
      );

      const { exitCode, stdout, stderr } = spawnCli(['--cwd', sub, 'stop', './target']);

      expect(exitCode).toBe(0);
      expect(stderr).toContain(`[ok] Using OpenKnowledge project at ${realpathSync(root)}`);
      expect(stdout).toContain(`Stopped: server (pid=${sleeper.pid}, port=4242)`);
    } finally {
      sleeper.kill();
    }
  }, 30_000);

  test('`ok mcp` from a subdirectory keeps stdout clean for JSON-RPC', () => {
    const root = makeFixture();
    makeProjectRoot(root);
    const sub = join(root, 'notes');
    mkdirSync(sub, { recursive: true });

    // Closed stdin = immediate EOF: the stdio MCP server boots, sees EOF,
    // and exits 0 without ever receiving a JSON-RPC request.
    const { exitCode, stdout, stderr } = spawnCli(['--cwd', sub, 'mcp']);

    expect(exitCode).toBe(0);
    expect(stderr).toContain(`[ok] Using OpenKnowledge project at ${realpathSync(root)}`);
    // Binary guarantee: stdout is the JSON-RPC channel — the disclosure line
    // (and any other diagnostics) must never land there.
    expect(stdout).toBe('');
  }, 30_000);

  test('non-anchored commands keep literal-cwd semantics from a subdirectory', () => {
    const root = makeFixture();
    makeProjectRoot(root);
    const sub = join(root, 'notes');
    mkdirSync(sub, { recursive: true });

    const { exitCode, stderr } = spawnCli(['--cwd', sub, 'ps', '--json']);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('Using OpenKnowledge project at');
  }, 30_000);
});
