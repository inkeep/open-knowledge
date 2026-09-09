import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MCP_SERVER_NAME } from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import { DESKTOP_UPDATER_CACHE_DIR_NAME } from '../integrations/desktop-state.ts';
import { readPathInstallMarker } from '../integrations/path-shim.ts';
import {
  createTomlConfigEngine,
  setTomlConfigEngineForTesting,
} from '../native/toml-config-engine.ts';
import { buildManagedServerEntry } from './editors.ts';
import { ensurePiBridge, probePiBridgeState } from './pi-acp-bridge.ts';
import { listPiTrustGrants, preparePiTrustGrant } from './pi-trust-grants.ts';
import { withPiTrustLockSync } from './pi-trust-lock.ts';
import {
  applicationDataOps,
  buildUninstallPlan,
  deinitOps,
  describeAttachedClients,
  type RemovalOp,
  type RunRemovalDeps,
  runRemoval,
  type UninstallPlanInput,
} from './removal-plan.ts';
import {
  formatRemovalOutcome,
  formatRemovalPlan,
  removalOutcomeToJson,
  removalPlanToJson,
} from './removal-render.ts';

const OWN_ENTRY = buildManagedServerEntry({ mode: 'published' });

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function stubDeps(over: Partial<RunRemovalDeps> = {}): RunRemovalDeps {
  return {
    clearToken: async () => ({ touched: ['keychain', 'file'] }),
    clearEmbeddingsKey: async () => ({ touched: ['file'] }),
    stopServer: () => ({ stopped: 0, failed: [] }),
    ...over,
  };
}

function seedHome(home: string): void {
  write(join(home, '.ok', 'auth.yml'), 'github.com: {}\n');
  write(join(home, '.ok', 'secrets.yml'), 'key: x\n');
  write(join(home, '.ok', 'logs', 'server.jsonl'), '{}\n');
  write(join(home, '.ok', 'skills', 'my-note-skill', 'SKILL.md'), '# mine\n');
  write(
    join(home, 'Library', 'Application Support', 'OpenKnowledge', 'state.json'),
    JSON.stringify({ recentProjects: [] }),
  );
  write(join(home, 'Library', 'Application Support', 'OpenKnowledge', 'path-install.json'), '{}');
  write(
    join(home, 'Library', 'Application Support', 'Open Knowledge', 'state.json'),
    JSON.stringify({ theirData: true }),
  );
  write(join(home, 'Library', 'Caches', DESKTOP_UPDATER_CACHE_DIR_NAME, 'pending.zip'), 'x');
  write(join(home, '.agents', 'skills', 'open-knowledge-discovery', 'SKILL.md'), '# d\n');
  write(join(home, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md'), '# d\n');
  write(join(home, '.agents', 'skills', 'open-knowledge-write-skill', 'SKILL.md'), '# w\n');
  write(join(home, '.agents', 'skills', 'someone-elses-skill', 'SKILL.md'), '# theirs\n');
  write(
    join(home, '.claude.json'),
    `${JSON.stringify({ mcpServers: { other: { command: 'x' }, [MCP_SERVER_NAME]: OWN_ENTRY } }, null, 2)}\n`,
  );
  write(
    join(home, '.zshrc'),
    `export EDITOR=vim\n\n# >>> open-knowledge cli >>>\n[ -f "$HOME/.ok/env.sh" ] && . "$HOME/.ok/env.sh"\n# <<< open-knowledge cli <<<\n\nalias ll='ls -la'\n`,
  );
  write(
    join(home, '.config', 'fish', 'conf.d', 'open-knowledge.fish'),
    `# >>> open-knowledge cli >>>\nset -gx PATH "$HOME/.ok/bin" $PATH\n# <<< open-knowledge cli <<<\n`,
  );
}

function markerFor(home: string): UninstallPlanInput['marker'] {
  const extraTarget = join(home, '.ok', 'bin', 'ok');
  const extraLink = join(home, '.local', 'bin', 'ok');
  mkdirSync(dirname(extraTarget), { recursive: true });
  writeFileSync(extraTarget, 'wrapper');
  mkdirSync(dirname(extraLink), { recursive: true });
  rmSync(extraLink, { force: true });
  symlinkSync(extraTarget, extraLink);
  return {
    version: 1,
    installedAt: 'x',
    bundleVersion: '1.0.0',
    bundleWrapperPath: '/w',
    binDir: join(home, '.ok', 'bin'),
    envShimPath: join(home, '.ok', 'env.sh'),
    rcFiles: [join(home, '.zshrc'), join(home, '.config', 'fish', 'conf.d', 'open-knowledge.fish')],
    rcOptOuts: [],
    pathDiscovery: null,
    extraSymlinks: [{ path: extraLink, target: extraTarget, createdAt: 'x', kind: 'created' }],
  };
}

function baseInput(home: string, over: Partial<UninstallPlanInput> = {}): UninstallPlanInput {
  return {
    home,
    platform: 'darwin',
    host: 'github.com',
    lockDirs: [],
    marker: markerFor(home),
    recentDeinitProjectRoots: [],
    purgeContent: false,
    ...over,
  };
}

describe('buildUninstallPlan ordering', () => {
  test('stops servers first and removes ~/.ok last, with recent-project deinits before it', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-'));
    try {
      const plan = buildUninstallPlan(
        baseInput(home, {
          lockDirs: ['/some/project/.ok/local'],
          recentDeinitProjectRoots: ['/recent/proj'],
        }),
      );
      const kinds = plan.ops.map((o) => o.kind);
      expect(kinds[0]).toBe('stop-server');
      const last = plan.ops[plan.ops.length - 1];
      expect(last.kind).toBe('remove-path');
      expect((last as { path: string }).path).toBe(join(home, '.ok'));
      const recentIdx = plan.ops.findIndex((o) => o.group === 'Project: proj');
      expect(recentIdx).toBeGreaterThan(-1);
      expect(recentIdx).toBeLessThan(plan.ops.length - 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.each([
    {
      platform: 'darwin' as const,
      home: '/Users/x',
      env: {},
      expected: [
        '/Users/x/Library/Application Support/OpenKnowledge',
        '/Users/x/Library/Application Support/Open Knowledge',
        `/Users/x/Library/Caches/${DESKTOP_UPDATER_CACHE_DIR_NAME}`,
      ],
    },
    {
      platform: 'win32' as const,
      home: 'C:\\Users\\x',
      env: {
        APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      },
      expected: [
        'C:\\Users\\x\\AppData\\Roaming\\OpenKnowledge',
        `C:\\Users\\x\\AppData\\Local\\${DESKTOP_UPDATER_CACHE_DIR_NAME}`,
      ],
    },
    {
      platform: 'linux' as const,
      home: '/home/x',
      env: { XDG_CONFIG_HOME: '/xdg/config', XDG_CACHE_HOME: '/xdg/cache' },
      expected: ['/xdg/config/OpenKnowledge', `/xdg/cache/${DESKTOP_UPDATER_CACHE_DIR_NAME}`],
    },
  ])('plans only owned desktop data on $platform', ({ platform, home, env, expected }) => {
    const applicationData = applicationDataOps(home, platform, env);
    const paths = applicationData.map((op) => (op.kind === 'remove-path' ? op.path : null));

    expect(paths).toEqual(expected);
    expect(
      applicationData.filter((op) => op.kind === 'remove-path' && op.requireOurState),
    ).toHaveLength(platform === 'darwin' ? 1 : 0);
  });

  test('renders Linux desktop cleanup paths in human and JSON plans', () => {
    const plan = buildUninstallPlan({
      home: '/home/x',
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/home/x/.config', XDG_CACHE_HOME: '/home/x/.cache' },
      host: 'github.com',
      lockDirs: [],
      marker: null,
      recentDeinitProjectRoots: [],
      purgeContent: false,
    });

    const human = formatRemovalPlan(plan);
    expect(human).toContain('Application data:');
    expect(human).toContain('Remove ~/.config/OpenKnowledge');
    expect(human).toContain(`Remove ~/.cache/${DESKTOP_UPDATER_CACHE_DIR_NAME}`);

    const json = removalPlanToJson(plan);
    expect(json.mode).toBe('dry-run');
    expect(json.planned.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        'Remove ~/.config/OpenKnowledge',
        `Remove ~/.cache/${DESKTOP_UPDATER_CACHE_DIR_NAME}`,
      ]),
    );
  });

  test('keeps non-macOS PATH-shim behavior independent of desktop cleanup', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-'));
    try {
      const plan = buildUninstallPlan({
        home,
        platform: 'linux',
        env: { XDG_CONFIG_HOME: join(home, '.config') },
        host: 'github.com',
        lockDirs: [],
        marker: null,
        recentDeinitProjectRoots: [],
        purgeContent: false,
      });
      expect(plan.ops.some((o) => o.group === 'Application data')).toBe(true);
      expect(plan.ops.some((o) => o.kind === 'shell-block')).toBe(false);
      expect(plan.ops.some((o) => o.kind === 'keychain-token')).toBe(true);
      expect(plan.ops.some((o) => o.group === 'Editor MCP configs')).toBe(true);
      expect(plan.ops.some((o) => o.group === 'Skill bundles')).toBe(true);
      expect(plan.ops[plan.ops.length - 1].kind).toBe('remove-path');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('strips the ~/.zshrc block even when the path-install manifest is ABSENT', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-'));
    try {
      const zshrc = join(home, '.zshrc');
      writeFileSync(
        zshrc,
        `export EDITOR=vim\n\n# >>> open-knowledge cli >>>\n[ -f "$HOME/.ok/env.sh" ] && . "$HOME/.ok/env.sh"\n# <<< open-knowledge cli <<<\n\nalias ll='ls -la'\n`,
      );
      const plan = buildUninstallPlan(baseInput(home, { marker: null }));
      const shellOps = plan.ops.filter((o) => o.kind === 'shell-block');
      expect(shellOps.map((o) => (o as { rcFile: string }).rcFile)).toContain(zshrc);

      await runRemoval(plan, stubDeps());
      const after = readFileSync(zshrc, 'utf-8');
      expect(after).not.toContain('open-knowledge cli');
      expect(after).toContain('export EDITOR=vim');
      expect(after).toContain("alias ll='ls -la'");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('runRemoval — git-exclude write failure', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  test.skipIf(asRoot)('a read-only .git/info/exclude surfaces as a failed op', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ok-gitx-'));
    try {
      const excludePath = join(projectRoot, '.git', 'info', 'exclude');
      mkdirSync(dirname(excludePath), { recursive: true });
      writeFileSync(excludePath, '.ok/\n');
      chmodSync(excludePath, 0o444);

      const op = {
        kind: 'git-exclude' as const,
        group: 'test',
        label: 'Remove OK paths from .git/info/exclude',
        projectRoot,
      };
      const outcome = await runRemoval({ scope: 'deinit', ops: [op] }, stubDeps());
      expect(outcome.failed).toHaveLength(1);
      expect(outcome.failed[0].detail).toContain('inaccessible');
    } finally {
      try {
        chmodSync(join(projectRoot, '.git', 'info', 'exclude'), 0o644);
      } catch {}
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('runRemoval — project path containment guard', () => {
  test('refuses to remove a project artifact that escapes via a symlink', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-contain-'));
    try {
      const projectRoot = join(home, 'proj');
      const outside = join(home, 'outside-secret');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'keep.txt'), 'do not delete');
      mkdirSync(projectRoot, { recursive: true });
      symlinkSync(outside, join(projectRoot, '.claude'));

      const escaping = {
        kind: 'remove-path' as const,
        group: 'test',
        label: 'Remove .claude/skills/open-knowledge/',
        path: join(projectRoot, '.claude', 'skills', 'open-knowledge'),
        containWithin: projectRoot,
      };
      const outcome = await runRemoval({ scope: 'deinit', ops: [escaping] }, stubDeps());
      expect(outcome.failed).toHaveLength(1);
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('removes an OK skill-projection symlink, leaving the link target intact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-projlink-'));
    try {
      const projectRoot = join(home, 'proj');
      write(join(projectRoot, '.ok', 'skills', 'pack-kb', 'SKILL.md'), '# pack\n');
      mkdirSync(join(projectRoot, '.claude', 'skills'), { recursive: true });
      symlinkSync(
        join('..', '..', '.ok', 'skills', 'pack-kb'),
        join(projectRoot, '.claude', 'skills', 'pack-kb'),
      );

      const op = {
        kind: 'remove-path' as const,
        group: 'test',
        label: 'Remove .claude/skills/pack-kb/',
        path: join(projectRoot, '.claude', 'skills', 'pack-kb'),
        containWithin: projectRoot,
      };
      const outcome = await runRemoval({ scope: 'deinit', ops: [op] }, stubDeps());
      expect(outcome.failed).toHaveLength(0);
      expect(outcome.removed).toHaveLength(1);
      expect(
        lstatSync(join(projectRoot, '.claude', 'skills', 'pack-kb'), { throwIfNoEntry: false }),
      ).toBeUndefined();
      expect(existsSync(join(projectRoot, '.ok', 'skills', 'pack-kb', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('removes a DANGLING projection symlink instead of reporting not-present', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-danglink-'));
    try {
      const projectRoot = join(home, 'proj');
      mkdirSync(join(projectRoot, '.claude', 'skills'), { recursive: true });
      symlinkSync(
        join('..', '..', '.ok', 'skills', 'already-swept'),
        join(projectRoot, '.claude', 'skills', 'already-swept'),
      );

      const op = {
        kind: 'remove-path' as const,
        group: 'test',
        label: 'Remove .claude/skills/already-swept/',
        path: join(projectRoot, '.claude', 'skills', 'already-swept'),
        containWithin: projectRoot,
      };
      const outcome = await runRemoval({ scope: 'deinit', ops: [op] }, stubDeps());
      expect(outcome.removed).toHaveLength(1);
      expect(
        lstatSync(join(projectRoot, '.claude', 'skills', 'already-swept'), {
          throwIfNoEntry: false,
        }),
      ).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a leaf symlink pointing outside the project is unlinked; its target survives', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-leafout-'));
    try {
      const projectRoot = join(home, 'proj');
      const outside = join(home, 'outside-secret');
      write(join(outside, 'keep.txt'), 'do not delete');
      mkdirSync(join(projectRoot, '.claude', 'skills'), { recursive: true });
      symlinkSync(outside, join(projectRoot, '.claude', 'skills', 'planted'));

      const op = {
        kind: 'remove-path' as const,
        group: 'test',
        label: 'Remove .claude/skills/planted/',
        path: join(projectRoot, '.claude', 'skills', 'planted'),
        containWithin: projectRoot,
      };
      const outcome = await runRemoval({ scope: 'deinit', ops: [op] }, stubDeps());
      expect(outcome.removed).toHaveLength(1);
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('runRemoval — uninstall end to end', () => {
  test('reverses the whole footprint, preserving user content + foreign files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-'));
    try {
      seedHome(home);
      const plan = buildUninstallPlan(baseInput(home));
      const outcome = await runRemoval(plan, stubDeps());
      expect(outcome.failed).toHaveLength(0);

      expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(false);
      expect(existsSync(join(home, '.ok', 'logs'))).toBe(false);
      expect(existsSync(join(home, '.ok', 'skills', 'my-note-skill', 'SKILL.md'))).toBe(true);

      expect(existsSync(join(home, 'Library', 'Application Support', 'OpenKnowledge'))).toBe(false);
      expect(existsSync(join(home, 'Library', 'Application Support', 'Open Knowledge'))).toBe(true);
      expect(existsSync(join(home, 'Library', 'Caches', DESKTOP_UPDATER_CACHE_DIR_NAME))).toBe(
        false,
      );

      expect(existsSync(join(home, '.agents', 'skills', 'open-knowledge-discovery'))).toBe(false);
      expect(existsSync(join(home, '.claude', 'skills', 'open-knowledge-discovery'))).toBe(false);
      expect(existsSync(join(home, '.agents', 'skills', 'open-knowledge-write-skill'))).toBe(false);
      expect(existsSync(join(home, '.agents', 'skills', 'someone-elses-skill'))).toBe(true);

      const claudeCfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'));
      expect(claudeCfg.mcpServers[MCP_SERVER_NAME]).toBeUndefined();
      expect(claudeCfg.mcpServers.other).toEqual({ command: 'x' });

      const zshrc = readFileSync(join(home, '.zshrc'), 'utf-8');
      expect(zshrc).toContain('export EDITOR=vim');
      expect(zshrc).toContain("alias ll='ls -la'");
      expect(zshrc).not.toContain('open-knowledge cli');
      expect(existsSync(join(home, '.config', 'fish', 'conf.d', 'open-knowledge.fish'))).toBe(
        false,
      );

      expect(existsSync(join(home, '.local', 'bin', 'ok'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--purge-content also removes user-authored ~/.ok/skills', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-'));
    try {
      seedHome(home);
      const plan = buildUninstallPlan(baseInput(home, { purgeContent: true }));
      await runRemoval(plan, stubDeps());
      expect(existsSync(join(home, '.ok'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a locked keychain reports failure and retains state for retry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-'));
    try {
      seedHome(home);
      const plan = buildUninstallPlan(baseInput(home));
      const outcome = await runRemoval(
        plan,
        stubDeps({
          clearToken: async () => ({ touched: [], keychainError: 'SecKeychainError' }),
        }),
      );
      const keychain = outcome.results.find((r) => r.op.kind === 'keychain-token');
      expect(keychain?.status).toBe('failed');
      expect(keychain?.detail).toContain('Keychain Access');
      expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a stop-server failure preserves files still needed by the live process', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-'));
    try {
      seedHome(home);
      const plan = buildUninstallPlan(baseInput(home, { lockDirs: ['/proj/.ok/local'] }));
      const outcome = await runRemoval(
        plan,
        stubDeps({
          stopServer: () => ({ stopped: 0, failed: [{ pid: 4242, error: 'EPERM' }] }),
        }),
      );
      const stop = outcome.results.find((r) => r.op.kind === 'stop-server');
      expect(stop?.status).toBe('failed');
      expect(stop?.detail).toContain('4242');
      expect(outcome.failed.some((r) => r.op.kind === 'stop-server')).toBe(true);
      expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('idempotent — a second run is a clean no-op (nothing removed, nothing failed)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-'));
    try {
      seedHome(home);
      const input = baseInput(home);
      await runRemoval(buildUninstallPlan(input), stubDeps());
      const secondInput: UninstallPlanInput = { ...input, marker: readPathInstallMarker(home) };
      const second = await runRemoval(
        buildUninstallPlan(secondInput),
        stubDeps({
          clearToken: async () => ({ touched: [] }),
          clearEmbeddingsKey: async () => ({ touched: [] }),
        }),
      );
      expect(second.failed).toHaveLength(0);
      expect(second.removed).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('deinitOps', () => {
  test('emits stop + surgical MCP + launch + git-exclude + whole-remove + shadow ops', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ok-deinit-'));
    try {
      const ops = deinitOps(projectRoot, '/home/x');
      const kinds = ops.map((o) => o.kind);
      expect(kinds[0]).toBe('stop-server');
      expect(kinds).toContain('mcp-entry');
      expect(kinds).toContain('launch-entry');
      expect(kinds).toContain('git-exclude');
      const okRemoval = ops.find(
        (o) =>
          o.kind === 'remove-path' && (o as { path: string }).path === join(projectRoot, '.ok'),
      );
      expect(okRemoval).toBeDefined();
      const mcpWholeRemove = ops.find(
        (o) =>
          o.kind === 'remove-path' &&
          (o as { path: string }).path === join(projectRoot, '.mcp.json'),
      );
      expect(mcpWholeRemove).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('pi trust revocation surfaces through the removal plan', () => {
  function piOp(cwd: string, home: string) {
    return {
      kind: 'mcp-entry' as const,
      group: 'Editor integrations',
      label: "Remove OK's Pi bridge",
      editorId: 'pi' as const,
      scope: 'project' as const,
      cwd,
      home,
      configPath: join(cwd, '.pi', 'extensions', 'open-knowledge.ts'),
    };
  }

  test('a revoked trust entry reports plain removal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-pi-removal-'));
    const home = mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-'));
    try {
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      const { results } = await runRemoval({ ops: [piOp(cwd, home)] }, stubDeps());
      expect(results[0]).toMatchObject({ status: 'removed' });
      expect(results[0]?.detail).toBeUndefined();
      expect(probePiBridgeState(cwd, home).trust).toBe('untrusted');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a trust entry kept for another extension says so instead of claiming a clean sweep', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-pi-removal-'));
    const home = mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-'));
    try {
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      write(join(cwd, '.pi', 'extensions', 'theirs.ts'), '// someone else\n');
      const outcome = await runRemoval({ ops: [piOp(cwd, home)] }, stubDeps());
      expect(outcome.results[0]?.status).toBe('removed');
      expect(outcome.results[0]?.detail).toContain('folder trust');
      expect(outcome.results[0]?.detail).toContain(join(cwd, '.pi', 'extensions', 'theirs.ts'));
      expect(outcome.results[0]?.detail).toContain('will not revoke it on later cleanup runs');
      expect(probePiBridgeState(cwd, home).trust).toBe('trusted');
      expect(formatRemovalOutcome(outcome)).toContain('folder trust');
      const json = removalOutcomeToJson('deinit', outcome);
      expect(json.mode === 'applied' && json.removed[0]?.detail).toContain('folder trust');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reports every failed store alongside a completed trust handoff', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-')));
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-')));
    try {
      const stores = ['first', 'second', 'shared'].map((name) => join(home, name));
      for (const store of stores) {
        expect(
          await ensurePiBridge(cwd, { mode: 'published' }, home, { PI_CODING_AGENT_DIR: store }),
        ).toMatchObject({ ok: true });
      }
      const sharedTrust = join(home, 'shared', 'trust.json');
      const before = readFileSync(sharedTrust, 'utf8');
      const prompts = join(cwd, '.pi', 'prompts');
      mkdirSync(prompts);
      for (const name of ['first', 'second']) write(join(home, name, 'trust.json'), '{broken');

      const outcome = await runRemoval({ ops: [piOp(cwd, home)] }, stubDeps());
      expect(outcome.failed).toHaveLength(1);
      const detail = outcome.failed[0]?.detail;
      expect(detail).toContain(join(home, 'first', 'trust.json'));
      expect(detail).toContain(join(home, 'second', 'trust.json'));
      expect(detail).toContain(sharedTrust);
      expect(detail).toContain(prompts);
      expect(detail).toContain(JSON.stringify(cwd));
      expect(detail).toContain('has relinquished this grant');
      expect(detail).toContain('will not revoke it on later cleanup runs');
      expect(formatRemovalOutcome(outcome)).toContain(detail?.replaceAll('\n', '\n      '));
      const json = removalOutcomeToJson('deinit', outcome);
      expect(json.mode === 'applied' && json.failed[0]?.detail).toBe(detail);
      expect(readFileSync(sharedTrust, 'utf8')).toBe(before);
      expect(existsSync(piOp(cwd, home).configPath)).toBe(true);
      expect(
        listPiTrustGrants(home, cwd)
          .map((receipt) => receipt.record.configuredTrustPath)
          .sort(),
      ).toEqual(['first', 'second'].map((name) => join(home, name, 'trust.json')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([true, false])(
    'reports bridge deletion failure after trust cleanup with shared resources: %s',
    async (shared) => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-')));
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-')));
      const extensions = join(cwd, '.pi', 'extensions');
      try {
        await ensurePiBridge(cwd, { mode: 'published' }, home);
        const trustPath = join(home, '.pi', 'agent', 'trust.json');
        const before = readFileSync(trustPath, 'utf8');
        if (shared) mkdirSync(join(cwd, '.pi', 'prompts'));
        chmodSync(extensions, 0o555);
        const outcome = await runRemoval({ ops: [piOp(cwd, home)] }, stubDeps());
        expect(outcome.failed).toHaveLength(1);
        expect(outcome.results[0]?.status).toBe('failed');
        const detail = outcome.failed[0]?.detail;
        expect(detail).toMatch(/EACCES|EPERM/);
        if (shared) {
          expect(detail).toContain('has relinquished this grant');
          expect(detail).toContain('will not revoke it on later cleanup runs');
          expect(detail).toContain(trustPath);
          expect(readFileSync(trustPath, 'utf8')).toBe(before);
        } else {
          expect(detail).not.toContain('has relinquished this grant');
          expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({});
        }
        expect(formatRemovalOutcome(outcome)).toContain(detail?.replaceAll('\n', '\n      '));
        const json = removalOutcomeToJson('deinit', outcome);
        expect(json.mode === 'applied' && json.failed[0]?.detail).toBe(detail);
        expect(listPiTrustGrants(home, cwd)).toHaveLength(0);
        expect(existsSync(piOp(cwd, home).configPath)).toBe(true);
      } finally {
        chmodSync(extensions, 0o755);
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test('explains shared trust without claiming ownership of a pre-existing grant', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-')));
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-')));
    try {
      const trustPath = join(home, '.pi', 'agent', 'trust.json');
      const before = JSON.stringify({ [cwd]: true, other: false });
      write(trustPath, before);
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      mkdirSync(join(cwd, '.pi', 'prompts'));
      const outcome = await runRemoval({ ops: [piOp(cwd, home)] }, stubDeps());
      expect(outcome.results[0]?.status).toBe('removed');
      const detail = outcome.results[0]?.detail;
      expect(detail).toContain('has no ownership record for this grant');
      expect(detail).not.toContain('has relinquished');
      expect(detail).toContain('Removing this grant may stop Pi from loading');
      expect(detail).toContain('parent-folder and global trust settings still apply');
      expect(readFileSync(trustPath, 'utf8')).toBe(before);
      expect(listPiTrustGrants(home, cwd)).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'quotes resource names, escapes terminal controls, and bounds the retained-resource list',
    async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-')));
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-')));
      try {
        await ensurePiBridge(cwd, { mode: 'published' }, home);
        const name = '\u001b[2K\rforged\nnotice\u0085\u2028\u2029\u202e.ts';
        const commaName = 'a.ts, tailwind.ts';
        const adviceName = 'b.ts. This "grant" is safe to remove.ts';
        const names = [name, commaName, adviceName, 'c.ts', 'd.ts'];
        const trustPath = join(home, '.pi', 'agent', 'trust.json');
        const trustBefore = readFileSync(trustPath, 'utf8');
        for (const filename of names) {
          write(join(cwd, '.pi', 'extensions', filename), '');
        }
        const outcome = await runRemoval({ ops: [piOp(cwd, home)] }, stubDeps());
        const detail = outcome.results[0]?.detail;
        expect(outcome.results[0]?.status).toBe('removed');
        expect(detail).toContain('\\u001b[2K\\rforged\\nnotice\\u0085\\u2028\\u2029\\u202e.ts');
        expect(detail).toContain(JSON.stringify(join(cwd, '.pi', 'extensions', commaName)));
        expect(detail).toContain(JSON.stringify(join(cwd, '.pi', 'extensions', adviceName)));
        expect(detail).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
        expect(detail).not.toContain('\u202e');
        expect(detail).toContain('(+2 more)');
        expect(detail).not.toContain(join(cwd, '.pi', 'extensions', 'c.ts'));
        const rendered = formatRemovalOutcome(outcome);
        expect(rendered).toContain(detail);
        expect(rendered).not.toContain('\u001b[2K');
        expect(rendered).not.toContain(name);
        expect(readFileSync(trustPath, 'utf8')).toBe(trustBefore);
        for (const filename of names)
          expect(readFileSync(join(cwd, '.pi', 'extensions', filename), 'utf8')).toBe('');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.each(['unrecorded', 'pending'] as const)(
    'explains %s trust retention in human and JSON output without changing the grant',
    async (ownership) => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-')));
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-')));
      try {
        const trustPath = join(home, '.pi', 'agent', 'trust.json');
        const before = `${JSON.stringify({ [cwd]: true, other: false })}\n`;
        write(trustPath, before);
        await ensurePiBridge(cwd, { mode: 'published' }, home);
        if (ownership === 'pending') {
          withPiTrustLockSync(trustPath, trustPath, () => {
            preparePiTrustGrant(home, cwd, trustPath, trustPath, { present: false });
          });
        }
        const outcome = await runRemoval({ ops: [piOp(cwd, home)] }, stubDeps());
        const detail = outcome.results[0]?.detail;
        expect(outcome.results[0]?.status).toBe('removed');
        expect(detail).toContain(
          ownership === 'pending' ? 'record is pending' : 'no OpenKnowledge ownership record',
        );
        if (ownership === 'pending') expect(detail).toContain('does not reconcile this record');
        expect(detail).toContain(trustPath);
        expect(detail).toContain(JSON.stringify(cwd));
        expect(detail).toContain('remove only');
        expect(formatRemovalOutcome(outcome)).toContain(detail);
        const json = removalOutcomeToJson('deinit', outcome);
        expect(json.mode === 'applied' && json.removed[0]?.detail).toBe(detail);
        expect(readFileSync(trustPath, 'utf8')).toBe(before);
        expect(existsSync(piOp(cwd, home).configPath)).toBe(false);
        expect(listPiTrustGrants(home, cwd)).toHaveLength(ownership === 'pending' ? 1 : 0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test('a trust store OK cannot parse fails the op rather than reporting success', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-pi-removal-'));
    const home = mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-'));
    try {
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      write(join(home, '.pi', 'agent', 'trust.json'), 'not json at all');
      const { results, failed } = await runRemoval({ ops: [piOp(cwd, home)] }, stubDeps());
      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.detail).toContain('refused-unreadable');
      expect(failed).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'retains Pi trust and project state when the bridge symlink has no target',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'ok-pi-missing-'));
      const cwd = join(home, 'project');
      try {
        write(join(cwd, '.ok', 'config.yml'), '{}');
        await ensurePiBridge(cwd, { mode: 'published' }, home);
        const op = piOp(cwd, home);
        const bridge = readFileSync(op.configPath, 'utf8');
        const trustPath = join(home, '.pi', 'agent', 'trust.json');
        const trust = readFileSync(trustPath, 'utf8');
        rmSync(op.configPath);
        symlinkSync(join(home, 'missing-bridge.ts'), op.configPath);
        const outcome = await runRemoval({ ops: deinitOps(cwd, home) }, stubDeps());
        expect(outcome.failed[0]?.op).toMatchObject({ kind: 'mcp-entry', editorId: 'pi' });
        expect(outcome.failed[0]?.detail).toContain('missing symlink target');
        expect(outcome.failed[0]?.detail).toContain(
          "Pi's separate folder trust grant has not been checked or removed",
        );
        expect(outcome.failed[0]?.detail).toContain(
          `Restore the missing target of the OpenKnowledge bridge symlink at ${op.configPath}`,
        );
        expect(lstatSync(op.configPath).isSymbolicLink()).toBe(true);
        expect(readFileSync(trustPath, 'utf8')).toBe(trust);
        expect(readFileSync(join(cwd, '.ok', 'config.yml'), 'utf8')).toBe('{}');
        writeFileSync(join(home, 'missing-bridge.ts'), bridge);
        const retry = await runRemoval({ ops: deinitOps(cwd, home) }, stubDeps());
        expect(retry.failed).toHaveLength(0);
        expect(probePiBridgeState(cwd, home).trust).toBe('untrusted');
        expect(existsSync(op.configPath)).toBe(false);
        expect(existsSync(join(cwd, '.ok'))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retains the bridge and reports why trust cannot be checked until permissions are repaired',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'ok-pi-removal-'));
      const home = mkdtempSync(join(tmpdir(), 'ok-pi-removal-home-'));
      const extensions = join(cwd, '.pi', 'extensions');
      try {
        await ensurePiBridge(cwd, { mode: 'published' }, home);
        const op = piOp(cwd, home);
        const bridge = readFileSync(op.configPath, 'utf8');
        const trustPath = join(home, '.pi', 'agent', 'trust.json');
        const trust = readFileSync(trustPath, 'utf8');
        chmodSync(extensions, 0o111);
        const outcome = await runRemoval({ ops: [op] }, stubDeps());
        expect(outcome.failed).toHaveLength(1);
        expect(outcome.failed[0]?.detail).toContain('kept-unverified');
        expect(outcome.failed[0]?.detail).toContain('Could not inspect Pi project resources');
        expect(outcome.failed[0]?.detail).toContain('check file and parent-directory permissions');
        expect(outcome.failed[0]?.detail).toContain('bridge file was left untouched');
        expect(readFileSync(op.configPath, 'utf8')).toBe(bridge);
        expect(readFileSync(trustPath, 'utf8')).toBe(trust);
        chmodSync(extensions, 0o755);
        const retry = await runRemoval({ ops: [op] }, stubDeps());
        expect(retry.failed).toHaveLength(0);
        expect(existsSync(op.configPath)).toBe(false);
        expect(probePiBridgeState(cwd, home).trust).toBe('untrusted');
      } finally {
        chmodSync(extensions, 0o755);
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe.each(['mcp', 'launch', 'shell'] as const)(
  '%s configuration failure details',
  (surface) => {
    function configOp(dir: string): { op: RemovalOp; path: string } {
      const path = join(dir, '.claude', 'launch.json');
      mkdirSync(dirname(path), { recursive: true });
      const base = { group: 'config', label: path };
      const op: RemovalOp =
        surface === 'launch'
          ? { ...base, kind: 'launch-entry', projectRoot: dir }
          : surface === 'shell'
            ? { ...base, kind: 'shell-block', rcFile: path }
            : {
                ...base,
                kind: 'mcp-entry',
                editorId: 'claude',
                scope: 'project',
                cwd: dir,
                home: dir,
                configPath: path,
              };
      return { op, path };
    }

    test('names a non-file path without claiming its contents are malformed', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ok-config-decline-'));
      try {
        const { op, path } = configOp(dir);
        mkdirSync(path);
        writeFileSync(join(path, 'keep'), 'user data');
        const outcome = await runRemoval({ scope: 'deinit', ops: [op] }, stubDeps());
        expect(outcome.failed[0]?.detail).toContain('not a regular file');
        expect(outcome.failed[0]?.detail).toContain('restore the intended configuration file');
        expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('user data');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'names read permission failures and leaves the existing configuration intact',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ok-config-decline-'));
        const { op, path } = configOp(dir);
        const raw = '{"user":"settings"}';
        writeFileSync(path, raw);
        chmodSync(path, 0o000);
        try {
          const outcome = await runRemoval({ scope: 'deinit', ops: [op] }, stubDeps());
          expect(outcome.failed[0]?.detail).toContain('permission denied');
          expect(outcome.failed[0]?.detail).toContain(
            'check file and parent-directory permissions',
          );
          expect(outcome.failed[0]?.detail).toContain('then retry');
        } finally {
          chmodSync(path, 0o600);
          expect(readFileSync(path, 'utf8')).toBe(raw);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test.skipIf(process.platform === 'win32').each(['dangling', 'cycle'])(
      'reports a %s symlink while preserving it',
      async (kind) => {
        const dir = mkdtempSync(join(tmpdir(), 'ok-config-decline-'));
        try {
          const { op, path } = configOp(dir);
          symlinkSync(kind === 'cycle' ? path : join(dir, 'missing'), path);
          const outcome = await runRemoval({ scope: 'deinit', ops: [op] }, stubDeps());
          if (kind === 'dangling') {
            expect(outcome.failed).toHaveLength(0);
            expect(outcome.results[0]?.status).toBe('skipped');
            expect(formatRemovalOutcome(outcome)).toContain('left the dangling');
            const json = removalOutcomeToJson('deinit', outcome);
            expect(json.mode === 'applied' && json.skipped[0]?.detail).toContain('no target file');
          } else {
            expect(outcome.failed[0]?.detail).toContain('symlink cycle');
            expect(outcome.failed[0]?.detail).toContain('then retry');
          }
          expect(lstatSync(path).isSymbolicLink()).toBe(true);
          expect(existsSync(join(dir, 'missing'))).toBe(false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);

describe('configuration repair guidance', () => {
  function mcpOp(dir: string, editorId: 'claude' | 'codex', configPath: string): RemovalOp {
    return {
      kind: 'mcp-entry',
      group: 'config',
      label: configPath,
      editorId,
      scope: 'project',
      cwd: dir,
      home: dir,
      configPath,
    };
  }

  test.each(['oversize', 'duplicate-container'] as const)(
    'explains how to repair %s without changing the existing file',
    async (reason) => {
      const dir = mkdtempSync(join(tmpdir(), 'ok-config-remedy-'));
      try {
        const configPath = join(dir, 'config.json');
        const raw =
          reason === 'oversize'
            ? `{"mcpServers":{},"history":"${'x'.repeat(11 * 1024 * 1024)}"}`
            : '{"mcpServers":{"one":{"command":"one"}},"mcpServers":{"two":{"command":"two"}}}';
        writeFileSync(configPath, raw);
        const outcome = await runRemoval(
          { scope: 'deinit', ops: [mcpOp(dir, 'claude', configPath)] },
          stubDeps(),
        );
        const remedy =
          reason === 'oversize'
            ? 'back up the file and reduce its size to 10 MiB or less while preserving needed settings'
            : 'combine the duplicate blocks';
        expect(formatRemovalOutcome(outcome)).toContain(remedy);
        const json = removalOutcomeToJson('deinit', outcome);
        expect(json.mode === 'applied' && json.failed[0]?.detail).toContain(remedy);
        expect(readFileSync(configPath, 'utf8')).toBe(raw);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test('explains the missing TOML writer and accepts manual entry removal on retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-remedy-'));
    try {
      const configPath = join(dir, 'config.toml');
      const raw = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/bin/sh"\nargs = ${JSON.stringify(OWN_ENTRY.args)}\n`;
      writeFileSync(configPath, raw);
      setTomlConfigEngineForTesting(createTomlConfigEngine(() => null));
      const plan = { scope: 'deinit' as const, ops: [mcpOp(dir, 'codex', configPath)] };
      const outcome = await runRemoval(plan, stubDeps());
      expect(outcome.failed[0]?.detail).toContain('no format-preserving TOML writer');
      expect(outcome.failed[0]?.detail).toContain(
        'remove the OpenKnowledge entry manually or reinstall',
      );
      expect(readFileSync(configPath, 'utf8')).toBe(raw);
      const repaired = '# keep my other server\n[mcp_servers.other]\ncommand = "node"\n';
      writeFileSync(configPath, repaired);
      const retry = await runRemoval(plan, stubDeps());
      expect(retry.failed).toHaveLength(0);
      expect(retry.results[0]?.status).toBe('not-present');
      expect(readFileSync(configPath, 'utf8')).toBe(repaired);
    } finally {
      setTomlConfigEngineForTesting(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports a file that disappears after classification and succeeds on a subsequent retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-config-remedy-'));
    try {
      const configPath = join(dir, 'config.toml');
      writeFileSync(
        configPath,
        `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "/bin/sh"\nargs = ${JSON.stringify(OWN_ENTRY.args)}\n`,
      );
      const parser = createTomlConfigEngine(() => null);
      setTomlConfigEngineForTesting({
        backend: 'native',
        parseToObject(raw) {
          const parsed = parser.parseToObject(raw);
          rmSync(configPath);
          return parsed;
        },
        upsertEntry: (text) => ({ text, existed: false }),
        removeEntry: (text) => ({ text, existed: false }),
        removeEntryKey: (text) => ({ text, existed: false }),
      });
      const plan = { scope: 'deinit' as const, ops: [mcpOp(dir, 'codex', configPath)] };
      const outcome = await runRemoval(plan, stubDeps());
      expect(outcome.failed[0]?.detail).toContain('file disappeared');
      expect(outcome.failed[0]?.detail).toContain('retry to check its current state');
      expect(existsSync(configPath)).toBe(false);
      const retry = await runRemoval(plan, stubDeps());
      expect(retry.failed).toHaveLength(0);
      expect(retry.results[0]?.status).toBe('not-present');
      expect(existsSync(configPath)).toBe(false);
    } finally {
      setTomlConfigEngineForTesting(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('describeAttachedClients', () => {
  const plan = { scope: 'deinit' as const, ops: deinitOps('/proj', '/home/u') };

  test('names the attached clients and that restart will not recover them', async () => {
    const lines = await describeAttachedClients(plan, async () => 3);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('3 collaboration clients');
    expect(lines[0]).toContain('restarting will NOT recover them');
  });

  test('says nothing when no clients are attached', async () => {
    expect(await describeAttachedClients(plan, async () => 0)).toEqual([]);
  });

  test('says nothing when the server cannot be reached', async () => {
    expect(await describeAttachedClients(plan, async () => null)).toEqual([]);
  });

  test('disclosure does not gate: the stop op stays in the plan', async () => {
    await describeAttachedClients(plan, async () => 2);
    expect(plan.ops.filter((op) => op.kind === 'stop-server')).toHaveLength(1);
  });
});

describe('safe uninstall cleanup', () => {
  test.skipIf(process.platform === 'win32')(
    'identifies each dangling config when two projects have matching relative paths',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'ok-dangling-projects-'));
      try {
        const projects = [join(home, 'one'), join(home, 'two')];
        const paths: string[] = [];
        for (const project of projects) {
          for (const relativePath of ['.mcp.json', '.claude/launch.json']) {
            const path = join(project, relativePath);
            mkdirSync(dirname(path), { recursive: true });
            symlinkSync(join(home, 'missing-config.json'), path);
            paths.push(path);
          }
        }
        const outcome = await runRemoval(
          { ops: projects.flatMap((project) => deinitOps(project, home)) },
          stubDeps(),
        );
        expect(outcome.failed).toHaveLength(0);
        const text = formatRemovalOutcome(outcome);
        const json = removalOutcomeToJson('uninstall', outcome);
        for (const path of paths) {
          expect(text).toContain(path);
          expect(
            json.mode === 'applied' && json.skipped.some((item) => item.detail?.includes(path)),
          ).toBe(true);
          expect(lstatSync(path).isSymbolicLink()).toBe(true);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'preserves dangling editor and launch links without retaining unrelated project state',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'ok-dangling-configs-'));
      const project = join(home, 'project');
      try {
        write(join(project, '.ok', 'config.yml'), '{}');
        write(join(project, 'notes.md'), '# My notes\n');
        const paths = [join(project, '.mcp.json'), join(project, '.claude', 'launch.json')];
        for (const path of paths) {
          mkdirSync(dirname(path), { recursive: true });
          symlinkSync(join(home, 'missing-config.json'), path);
        }
        const outcome = await runRemoval({ ops: deinitOps(project, home) }, stubDeps());
        expect(outcome.failed).toHaveLength(0);
        expect(existsSync(join(project, '.ok'))).toBe(false);
        expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# My notes\n');
        for (const path of paths) expect(lstatSync(path).isSymbolicLink()).toBe(true);
        expect(formatRemovalOutcome(outcome)).toContain('no target file');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test('explains recovery for a permanently missing Git directory and permits cleanup after manual repair', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-orphaned-worktree-'));
    const project = join(home, 'project');
    const pointer = join(project, '.git');
    const rawPointer = 'gitdir: ../missing-main/.git/worktrees/project\n';
    try {
      write(join(project, '.ok', 'config.yml'), '{}');
      write(join(project, 'notes.md'), '# My notes\n');
      write(pointer, rawPointer);
      const outcome = await runRemoval({ ops: deinitOps(project, home) }, stubDeps());
      expect(outcome.failed[0]?.op.kind).toBe('git-exclude');
      expect(formatRemovalOutcome(outcome)).toContain('restoring permissions or access');
      expect(formatRemovalOutcome(outcome)).toContain('including any mounted volume');
      expect(formatRemovalOutcome(outcome)).toContain('git worktree repair');
      const json = removalOutcomeToJson('deinit', outcome);
      expect(json.mode === 'applied' && json.failed[0]?.detail).toContain(
        'If the repository is permanently gone, back up and remove only the stale .git pointer file',
      );
      expect(readFileSync(pointer, 'utf8')).toBe(rawPointer);
      expect(existsSync(join(project, '.ok'))).toBe(true);
      const backup = join(home, 'git-pointer.backup');
      writeFileSync(backup, readFileSync(pointer));
      rmSync(pointer);
      const retry = await runRemoval({ ops: deinitOps(project, home) }, stubDeps());
      expect(retry.failed).toHaveLength(0);
      expect(existsSync(join(project, '.ok'))).toBe(false);
      expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# My notes\n');
      expect(readFileSync(backup, 'utf8')).toBe(rawPointer);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps remaining shared editor exclude rules while removing OK-only and absent artifact rules', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-removal-excludes-'));
    const project = join(home, 'project');
    try {
      write(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      mkdirSync(join(project, '.git', 'objects'), { recursive: true });
      mkdirSync(join(project, '.git', 'refs'), { recursive: true });
      write(join(project, '.ok', 'config.yml'), '{}');
      write(
        join(project, '.mcp.json'),
        JSON.stringify({
          mcpServers: { [MCP_SERVER_NAME]: OWN_ENTRY, other: { command: 'keep' } },
        }),
      );
      write(join(project, '.cursor', 'mcp.json'), '{invalid json');
      write(join(project, '.claude', 'launch.json'), '{"configurations":[]}');
      const exclude = join(project, '.git', 'info', 'exclude');
      write(
        exclude,
        '# personal rules\r\n/.mcp.json\r\n.cursor/mcp.json\r\n.claude/launch.json\r\n.codex/config.toml\r\n.ok/\r\n.okignore\r\nprivate.env\r\n',
      );
      await runRemoval({ scope: 'deinit', ops: deinitOps(project, home) }, stubDeps());
      expect(readFileSync(exclude, 'utf-8')).toBe(
        '# personal rules\r\n/.mcp.json\r\n.cursor/mcp.json\r\n.claude/launch.json\r\nprivate.env\r\n',
      );
      expect(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf-8')).mcpServers).toEqual({
        other: { command: 'keep' },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.each(['reported', 'thrown'] as const)(
    'preserves blocked project and global state after a %s stop failure, but cleans an independent project',
    async (failure) => {
      const home = mkdtempSync(join(tmpdir(), 'ok-removal-stop-'));
      const blocked = join(home, 'one', 'project');
      const independent = join(home, 'two', 'project');
      try {
        seedHome(home);
        for (const project of [blocked, independent]) {
          write(join(project, '.ok', 'config.yml'), '{}');
          write(
            join(project, '.mcp.json'),
            JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: OWN_ENTRY } }),
          );
        }
        const blockedLock = join(blocked, '.ok', 'local');
        const calls: string[] = [];
        const outcome = await runRemoval(
          buildUninstallPlan(
            baseInput(home, {
              lockDirs: [blockedLock],
              recentDeinitProjectRoots: [blocked, independent],
            }),
          ),
          stubDeps({
            stopServer: async (lockDir) => {
              calls.push(lockDir);
              expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(true);
              if (lockDir !== blockedLock) return { stopped: 1, failed: [] };
              if (failure === 'thrown') throw new Error('stop unavailable');
              return { stopped: 0, failed: [{ pid: 4242, error: 'EPERM' }] };
            },
          }),
        );
        expect(calls.filter((dir) => dir === blockedLock)).toHaveLength(1);
        expect(existsSync(join(blocked, '.ok', 'config.yml'))).toBe(true);
        expect(readFileSync(join(blocked, '.mcp.json'), 'utf-8')).toContain(MCP_SERVER_NAME);
        expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(true);
        expect(
          existsSync(join(home, 'Library', 'Application Support', 'OpenKnowledge', 'state.json')),
        ).toBe(true);
        expect(existsSync(join(independent, '.ok'))).toBe(false);
        expect(outcome.failed.length).toBeGreaterThan(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe('shell configuration symlinks', () => {
  test.skipIf(process.platform === 'win32')(
    'preserves a dangling shell symlink without retaining unrelated uninstall state',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'ok-shell-missing-'));
      try {
        seedHome(home);
        const rcFile = join(home, '.zshrc');
        rmSync(rcFile);
        symlinkSync(join(home, 'missing-dotfiles', 'zshrc'), rcFile);
        const outcome = await runRemoval(buildUninstallPlan(baseInput(home)), stubDeps());
        expect(outcome.failed).toHaveLength(0);
        expect(lstatSync(rcFile).isSymbolicLink()).toBe(true);
        expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(false);
        expect(formatRemovalOutcome(outcome)).toContain(
          'left the dangling shell symlink untouched',
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.each(['alias ll="ls -la"\n', ''])(
    'keeps the symlink and destination after stripping the managed block with remaining content %j',
    async (before) => {
      const home = mkdtempSync(join(tmpdir(), 'ok-shell-remove-'));
      try {
        const target = join(home, 'dotfiles', 'zshrc');
        const rcFile = join(home, '.zshrc');
        write(
          target,
          `${before}# >>> open-knowledge cli >>>\nmanaged\n# <<< open-knowledge cli <<<\n`,
        );
        chmodSync(target, 0o600);
        symlinkSync(target, rcFile);
        const outcome = await runRemoval(
          {
            scope: 'uninstall',
            ops: [{ kind: 'shell-block', group: 'Shell PATH', label: 'Remove PATH block', rcFile }],
          },
          stubDeps(),
        );
        expect(outcome.failed).toHaveLength(0);
        expect(lstatSync(rcFile).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, 'utf-8')).toBe(before);
        expect(lstatSync(target).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
