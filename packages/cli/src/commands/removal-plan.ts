import { lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { PROJECT_SKILL_PROJECTION_PATHS } from '@inkeep/open-knowledge-core';
import { atomicWriteFileSync } from '@inkeep/open-knowledge-core/server';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { resolveLockDir } from '@inkeep/open-knowledge-server';
import { clearAllEmbeddingsKeys } from '../auth/embeddings-key-store.ts';
import { clearTokenFromAllBackends } from '../auth/token-store.ts';
import {
  DESKTOP_LEGACY_PRODUCT_NAME,
  desktopUpdaterCacheDir,
  desktopUserDataDir,
  stateDirIsOurs,
} from '../integrations/desktop-state.ts';
import {
  extraSymlinkStillOurs,
  type PathInstallMarker,
  stripManagedPathBlock,
} from '../integrations/path-shim.ts';
import { userGlobalSkillBundleTargets } from '../integrations/skill-teardown.ts';
import { assertProjectRemovalSafe } from '../integrations/write-project-skill.ts';
import {
  getInstalledSkillProjectionPaths,
  getOkArtifactPaths,
  removeOkPathsFromGitExclude,
} from '../sharing/git-exclude.ts';
import { configFileDeclineDetail, configFileDeclineReason } from '../utils/config-file-error.ts';
import { ALL_EDITOR_IDS, EDITOR_TARGETS, type EditorId } from './editors.ts';
import type { McpConfigDeclineReason } from './init.ts';
import { existingFileMode } from './jsonc-surgical.ts';
import { removeOwnLaunchEntry } from './launch-json-removal.ts';
import { removeOwnMcpEntry } from './mcp-config-removal.ts';
import { resolveRemovalFilePath } from './removal-file-path.ts';
import { probeCollabClients } from './stop.ts';
import { stopServerForRemoval } from './stop-for-removal.ts';

export type RemovalGroup = string;

export type RemovalOp = (
  | { kind: 'stop-server'; group: RemovalGroup; label: string; lockDir: string }
  | { kind: 'keychain-token'; group: RemovalGroup; label: string; host: string }
  | { kind: 'embeddings-key'; group: RemovalGroup; label: string }
  | { kind: 'shell-block'; group: RemovalGroup; label: string; rcFile: string }
  | { kind: 'extra-symlink'; group: RemovalGroup; label: string; path: string; target: string }
  | {
      kind: 'mcp-entry';
      group: RemovalGroup;
      label: string;
      editorId: EditorId;
      scope: 'user' | 'project';
      cwd: string;
      home: string;
      configPath: string;
    }
  | { kind: 'launch-entry'; group: RemovalGroup; label: string; projectRoot: string }
  | { kind: 'git-exclude'; group: RemovalGroup; label: string; projectRoot: string }
  | {
      kind: 'remove-path';
      group: RemovalGroup;
      label: string;
      path: string;
      preserve?: string[];
      requireOurState?: boolean;
      containWithin?: string;
      requiresSuccessfulCleanup?: boolean;
    }
) & { requiresStoppedServers?: readonly string[] };

export interface RemovalPlan {
  scope: 'uninstall' | 'deinit';
  ops: RemovalOp[];
}

type RemovalStatus = 'removed' | 'not-present' | 'skipped' | 'failed';

interface RemovalOpResult {
  op: RemovalOp;
  status: RemovalStatus;
  detail?: string;
}

export interface RemovalOutcome {
  results: RemovalOpResult[];
  removed: RemovalOpResult[];
  failed: RemovalOpResult[];
}

function tildify(p: string, home: string): string {
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

export function deinitOps(
  projectRoot: string,
  home: string,
  group: RemovalGroup = 'This project',
): RemovalOp[] {
  const ops: RemovalOp[] = [];

  ops.push({
    kind: 'stop-server',
    group,
    label: 'Stop the project server (if running)',
    lockDir: resolveLockDir(projectRoot),
  });

  const mcpRelPaths = new Set<string>();
  for (const id of ALL_EDITOR_IDS) {
    const target = EDITOR_TARGETS[id];
    if (!target.projectConfigPath) continue;
    const configPath = target.projectConfigPath(projectRoot);
    mcpRelPaths.add(toPosix(relative(projectRoot, configPath)));
    ops.push({
      kind: 'mcp-entry',
      group,
      label: `Remove OK's MCP entry from ${target.label} (${toPosix(relative(projectRoot, configPath))})`,
      editorId: id,
      scope: 'project',
      cwd: projectRoot,
      home,
      configPath,
    });
  }

  ops.push({
    kind: 'launch-entry',
    group,
    label: "Remove OK's entry from .claude/launch.json",
    projectRoot,
  });

  ops.push({
    kind: 'git-exclude',
    group,
    label: 'Remove OK paths from .git/info/exclude',
    projectRoot,
  });

  const removeRelPaths = new Set<string>([
    ...getOkArtifactPaths(projectRoot),
    ...getInstalledSkillProjectionPaths(projectRoot),
    ...PROJECT_SKILL_PROJECTION_PATHS,
  ]);
  for (const rel of removeRelPaths) {
    const bare = rel.replace(/\/$/, '');
    if (mcpRelPaths.has(bare)) continue;
    if (bare === '.claude/launch.json') continue;
    ops.push({
      kind: 'remove-path',
      group,
      label: `Remove ${rel}`,
      path: join(projectRoot, bare),
      containWithin: projectRoot,
    });
  }

  try {
    ops.push({
      kind: 'remove-path',
      group,
      label: 'Remove the OK shadow repo (.git/ok/)',
      path: resolveShadowDir(projectRoot),
    });
  } catch {}

  const projectStatePath = join(projectRoot, '.ok');
  ops.sort(
    (left, right) =>
      Number(left.kind === 'remove-path' && left.path === projectStatePath) -
      Number(right.kind === 'remove-path' && right.path === projectStatePath),
  );
  return ops.map((op) =>
    op.kind === 'stop-server'
      ? op
      : {
          ...op,
          requiresStoppedServers: [resolveLockDir(projectRoot)],
          ...(op.kind === 'remove-path' ? { requiresSuccessfulCleanup: true } : {}),
        },
  );
}

export function buildDeinitPlan(projectRoot: string, home: string): RemovalPlan {
  return { scope: 'deinit', ops: deinitOps(projectRoot, home) };
}

export interface UninstallPlanInput {
  home: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  host: string;
  lockDirs: string[];
  marker: PathInstallMarker | null;
  recentDeinitProjectRoots: string[];
  purgeContent: boolean;
}

export function buildUninstallPlan(input: UninstallPlanInput): RemovalPlan {
  const { home, platform, host, lockDirs, marker, recentDeinitProjectRoots, purgeContent } = input;
  const ops: RemovalOp[] = [];

  for (const lockDir of lockDirs) {
    ops.push({
      kind: 'stop-server',
      group: 'Running servers',
      label: `Stop server at ${tildify(join(lockDir, '..', '..'), home)}`,
      lockDir,
    });
  }

  ops.push({
    kind: 'keychain-token',
    group: 'Credentials',
    label: `Remove the GitHub credential (${host}) from the OS keychain + auth.yml`,
    host,
  });
  ops.push({
    kind: 'embeddings-key',
    group: 'Credentials',
    label: 'Remove all embeddings API keys (secrets.yml)',
  });

  ops.push(...pathRevertOps(marker, home));

  for (const id of ALL_EDITOR_IDS) {
    const target = EDITOR_TARGETS[id];
    let configPath: string;
    try {
      configPath = target.configPath('', home);
    } catch {
      continue;
    }
    ops.push({
      kind: 'mcp-entry',
      group: 'Editor MCP configs',
      label: `Remove OK's MCP entry from ${target.label} (${tildify(configPath, home)})`,
      editorId: id,
      scope: 'user',
      cwd: home,
      home,
      configPath,
    });
  }

  for (const target of userGlobalSkillBundleTargets(home)) {
    ops.push({
      kind: 'remove-path',
      group: 'Skill bundles',
      label: `Remove ${tildify(target.path, home)}`,
      path: target.path,
    });
  }

  for (const projectRoot of recentDeinitProjectRoots) {
    ops.push(...deinitOps(projectRoot, home, `Project: ${basename(projectRoot)}`));
  }

  ops.push(
    ...applicationDataOps(home, platform, input.env).map((op) =>
      op.kind === 'remove-path' ? { ...op, requiresSuccessfulCleanup: true } : op,
    ),
  );

  ops.push({
    kind: 'remove-path',
    group: 'Global directory',
    requiresSuccessfulCleanup: true,
    label: purgeContent
      ? 'Remove ~/.ok (including user-authored skills)'
      : 'Remove ~/.ok (keeping ~/.ok/skills)',
    path: join(home, '.ok'),
    preserve: purgeContent ? undefined : ['skills'],
  });

  return { scope: 'uninstall', ops };
}

function standardRcFiles(home: string): string[] {
  return [
    join(home, '.zshrc'),
    join(home, '.bash_profile'),
    join(home, '.config', 'fish', 'conf.d', 'open-knowledge.fish'),
  ];
}

function pathRevertOps(marker: PathInstallMarker | null, home: string): RemovalOp[] {
  const ops: RemovalOp[] = [];
  const rcCandidates = new Set([...standardRcFiles(home), ...(marker?.rcFiles ?? [])]);
  for (const rcFile of rcCandidates) {
    if (resolveRemovalFilePath(rcFile).kind === 'not-present') continue;
    ops.push({
      kind: 'shell-block',
      group: 'Shell PATH',
      label: `Strip the OK block from ${tildify(rcFile, home)}`,
      rcFile,
    });
  }
  for (const extra of marker?.extraSymlinks ?? []) {
    ops.push({
      kind: 'extra-symlink',
      group: 'Shell PATH',
      label: `Remove the ok symlink at ${tildify(extra.path, home)}`,
      path: extra.path,
      target: extra.target,
    });
  }
  return ops;
}

export function applicationDataOps(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv | undefined,
): RemovalOp[] {
  const options = { home, platformName: platform, env };

  const current = desktopUserDataDir(options);
  const updaterCache = desktopUpdaterCacheDir(options);
  const ops: RemovalOp[] = [
    {
      kind: 'remove-path',
      group: 'Application data',
      label: `Remove ${tildify(current, home)}`,
      path: current,
    },
  ];

  if (platform === 'darwin') {
    const legacy = desktopUserDataDir({ ...options, productName: DESKTOP_LEGACY_PRODUCT_NAME });
    ops.push({
      kind: 'remove-path',
      group: 'Application data',
      label: `Remove ${tildify(legacy, home)} (only if it is OpenKnowledge's)`,
      path: legacy,
      requireOurState: true,
    });
  }

  ops.push({
    kind: 'remove-path',
    group: 'Application data',
    label: `Remove ${tildify(updaterCache, home)}`,
    path: updaterCache,
  });

  return ops;
}

export interface RunRemovalDeps {
  env?: NodeJS.ProcessEnv;
  clearToken?: (
    host: string,
  ) => Promise<{ touched: Array<'keychain' | 'file'>; keychainError?: string }>;
  clearEmbeddingsKey?: () => Promise<{ touched: Array<'file'> }>;
  stopServer?: (lockDir: string) => Promise<{
    stopped: number;
    failed: Array<{ pid: number; error: string }>;
  }>;
}

export async function runRemoval(
  plan: RemovalPlan,
  deps: RunRemovalDeps = {},
): Promise<RemovalOutcome> {
  const clearToken = deps.clearToken ?? clearTokenFromAllBackends;
  const clearEmbeddingsKey = deps.clearEmbeddingsKey ?? clearAllEmbeddingsKeys;
  const stopServer = deps.stopServer ?? stopServerForRemoval;

  const resolvedDeps = { clearToken, clearEmbeddingsKey, stopServer, env: deps.env ?? {} };
  const execute = async (op: RemovalOp): Promise<RemovalOpResult> => {
    try {
      return await executeOp(op, resolvedDeps);
    } catch (err) {
      return { op, status: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
  };
  const stops = new Map<string, RemovalOpResult>();
  for (const op of plan.ops) {
    if (op.kind !== 'stop-server') continue;
    const key = resolve(op.lockDir);
    if (!stops.has(key)) stops.set(key, await execute(op));
  }

  const results: RemovalOpResult[] = [];
  for (const op of plan.ops) {
    if (op.kind === 'stop-server') {
      const result = stops.get(resolve(op.lockDir));
      if (result) results.push({ ...result, op });
      continue;
    }
    const required = op.requiresStoppedServers ?? [...stops.keys()];
    const blocked = required.filter((lockDir) => {
      const stop = stops.get(resolve(lockDir));
      return !stop || stop.status === 'failed';
    });
    if (blocked.length > 0) {
      results.push({
        op,
        status: 'failed',
        detail: `left untouched because server shutdown was not verified: ${blocked.join(', ')}. Stop the server and retry cleanup.`,
      });
      continue;
    }
    if (op.kind === 'remove-path' && op.requiresSuccessfulCleanup) {
      const previousFailure = results.some((result) => {
        if (result.status !== 'failed') return false;
        if (!op.requiresStoppedServers) return true;
        return result.op.requiresStoppedServers?.some((lockDir) => required.includes(lockDir));
      });
      if (previousFailure) {
        results.push({
          op,
          status: 'failed',
          detail:
            'left untouched so cleanup can be retried after the earlier failures are resolved',
        });
        continue;
      }
    }
    results.push(await execute(op));
  }

  return {
    results,
    removed: results.filter((r) => r.status === 'removed'),
    failed: results.filter((r) => r.status === 'failed'),
  };
}

export async function describeAttachedClients(
  plan: RemovalPlan,
  probe: (lockDir: string) => Promise<number | null> = probeCollabClients,
): Promise<string[]> {
  const lines: string[] = [];
  for (const op of plan.ops) {
    if (op.kind !== 'stop-server') continue;
    const clients = await probe(op.lockDir);
    if (clients === null || clients === 0) continue;
    lines.push(
      `${clients} collaboration client${clients === 1 ? '' : 's'} ` +
        `(editor window${clients === 1 ? '' : 's'} or agents) ${clients === 1 ? 'is' : 'are'} ` +
        `connected to the server at ${op.lockDir}. Those windows will stop working, and ` +
        'restarting will NOT recover them — this removes the project state they depend on.',
    );
  }
  return lines;
}

type ResolvedDeps = Required<RunRemovalDeps>;

async function executeOp(op: RemovalOp, deps: ResolvedDeps): Promise<RemovalOpResult> {
  switch (op.kind) {
    case 'stop-server': {
      const { stopped, failed } = await deps.stopServer(op.lockDir);
      if (failed.length > 0) {
        const detail = failed.map((f) => `pid ${f.pid}: ${f.error}`).join('; ');
        return {
          op,
          status: 'failed',
          detail: `could not stop the server (${detail}); dependent files were left untouched; stop the server and retry cleanup`,
        };
      }
      return { op, status: stopped > 0 ? 'removed' : 'not-present' };
    }
    case 'keychain-token': {
      const { touched, keychainError } = await deps.clearToken(op.host);
      if (keychainError) {
        return {
          op,
          status: 'failed',
          detail: `keychain unreachable (${keychainError}); remove manually: Keychain Access → service "open-knowledge"`,
        };
      }
      return { op, status: touched.length > 0 ? 'removed' : 'not-present' };
    }
    case 'embeddings-key': {
      const { touched } = await deps.clearEmbeddingsKey();
      return { op, status: touched.length > 0 ? 'removed' : 'not-present' };
    }
    case 'shell-block': {
      const resolved = resolveRemovalFilePath(op.rcFile);
      if (resolved.kind === 'not-present') return { op, status: 'not-present' };
      if (resolved.kind === 'declined' && resolved.reason === 'missing-symlink-target') {
        return {
          op,
          status: 'skipped',
          detail: `left the dangling shell symlink untouched; no target file contains a PATH block to remove: ${op.rcFile}`,
        };
      }
      if (resolved.kind === 'declined')
        return {
          op,
          status: 'failed',
          detail: `${configurationDeclineDetail(resolved.reason)}: ${op.rcFile}`,
        };
      let before: string;
      try {
        before = readFileSync(resolved.path, 'utf-8');
      } catch (error) {
        return {
          op,
          status: 'failed',
          detail: `${configurationDeclineDetail(configFileDeclineReason(error))}: ${op.rcFile}`,
        };
      }
      const { text, changed, emptyAfter } = stripManagedPathBlock(before);
      if (!changed) return { op, status: 'not-present' };
      if (emptyAfter && !resolved.symlink) {
        rmSync(op.rcFile, { force: true });
        return { op, status: 'removed', detail: 'file removed (was OK-owned)' };
      }
      atomicWriteFileSync(resolved.path, text, { mode: existingFileMode(resolved.path) });
      return { op, status: 'removed' };
    }
    case 'extra-symlink': {
      if (!extraSymlinkStillOurs(op.path, op.target)) return { op, status: 'not-present' };
      unlinkSync(op.path);
      return { op, status: 'removed' };
    }
    case 'mcp-entry': {
      const outcome = removeOwnMcpEntry(
        EDITOR_TARGETS[op.editorId],
        op.cwd,
        op.home,
        op.configPath,
        deps.env,
      );
      switch (outcome.kind) {
        case 'removed':
          if (outcome.trustDetail) {
            return {
              op,
              status: 'removed',
              detail: outcome.trustDetail,
            };
          }
          return { op, status: 'removed' };
        case 'not-present':
          return { op, status: 'not-present' };
        case 'left-foreign':
          return { op, status: 'skipped', detail: 'left a non-OK server in place' };
        case 'declined':
          if (outcome.reason === 'missing-symlink-target') {
            const configPath = op.configPath;
            if (op.editorId === 'pi') {
              return {
                op,
                status: 'failed',
                detail: `Pi bridge configuration left untouched (missing symlink target); Pi's separate folder trust grant has not been checked or removed. Restore the missing target of the OpenKnowledge bridge symlink at ${configPath}, or repoint that symlink to the intended bridge file, then retry cleanup`,
              };
            }
            return {
              op,
              status: 'skipped',
              detail: `left the dangling configuration symlink untouched; no target file contains an OpenKnowledge entry to remove: ${configPath}`,
            };
          }
          return {
            op,
            status: 'failed',
            detail: configurationDeclineDetail(outcome.reason),
          };
        default: {
          const _exhaustive: never = outcome;
          throw new Error(
            `unhandled mcp-remove outcome: ${(_exhaustive as { kind: string }).kind}`,
          );
        }
      }
    }
    case 'launch-entry': {
      const outcome = removeOwnLaunchEntry(op.projectRoot);
      switch (outcome.kind) {
        case 'removed':
          return { op, status: 'removed' };
        case 'not-present':
          return { op, status: 'not-present' };
        case 'declined':
          if (outcome.reason === 'missing-symlink-target') {
            return {
              op,
              status: 'skipped',
              detail: `left the dangling configuration symlink untouched; no target file contains an OpenKnowledge entry to remove: ${join(op.projectRoot, '.claude', 'launch.json')}`,
            };
          }
          return {
            op,
            status: 'failed',
            detail: configurationDeclineDetail(outcome.reason),
          };
        default: {
          const _exhaustive: never = outcome;
          throw new Error(
            `unhandled launch-remove outcome: ${(_exhaustive as { kind: string }).kind}`,
          );
        }
      }
    }
    case 'git-exclude': {
      const result = removeOkPathsFromGitExclude(
        op.projectRoot,
        removableGitExcludePaths(op.projectRoot),
      );
      if (result.kind === 'no-exclude') {
        switch (result.reason) {
          case 'inaccessible':
            return {
              op,
              status: 'failed',
              detail: 'could not write .git/info/exclude (inaccessible)',
            };
          case 'malformed-pointer':
            return {
              op,
              status: 'failed',
              detail: `could not locate .git/info/exclude; repair the .git pointer at ${join(op.projectRoot, '.git')} by restoring permissions or access to its repository, including any mounted volume. If its contents are malformed, restore a valid gitdir: <path> line pointing to the existing Git directory. For a linked worktree, run git worktree repair from the main repository with this worktree's path. If the repository is permanently gone, back up and remove only the stale .git pointer file, then retry cleanup`,
            };
          case 'no-git':
          case 'no-info-dir':
            return { op, status: 'not-present' };
        }
      }
      return { op, status: result.removed.length > 0 ? 'removed' : 'not-present' };
    }
    case 'remove-path':
      return executeRemovePath(op);
  }
}

function configurationDeclineDetail(reason: McpConfigDeclineReason): string {
  switch (reason) {
    case 'permission-denied':
    case 'missing-symlink-target':
    case 'unresolved-symlink':
    case 'not-a-file':
    case 'unreadable':
    case 'disappeared':
      return `configuration left untouched: ${configFileDeclineDetail(reason)}`;
    case 'oversize':
      return 'configuration left untouched (file is too large to edit safely); back up the file and reduce its size to 10 MiB or less while preserving needed settings, then retry cleanup';
    case 'duplicate-container':
      return 'configuration left untouched (duplicate server configuration blocks); combine the duplicate blocks while preserving their settings, then retry cleanup';
    case 'no-native-writer':
      return 'configuration left untouched (this install has no format-preserving TOML writer); remove the OpenKnowledge entry manually or reinstall OpenKnowledge, then retry cleanup';
    case 'unparseable':
      return 'configuration left untouched (unparseable); repair it and retry cleanup';
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled configuration decline reason: ${exhaustive}`);
    }
  }
}

function executeRemovePath(op: Extract<RemovalOp, { kind: 'remove-path' }>): RemovalOpResult {
  if (op.requireOurState && !stateDirIsOurs(op.path)) {
    return { op, status: 'skipped', detail: 'not verified as OpenKnowledge — left untouched' };
  }
  if (op.containWithin) {
    assertProjectRemovalSafe(op.path, op.containWithin);
  }
  let leafStat: ReturnType<typeof lstatSync> | undefined;
  try {
    leafStat = lstatSync(op.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!leafStat) return { op, status: 'not-present' };

  if (leafStat.isSymbolicLink()) {
    unlinkSync(op.path);
    return { op, status: 'removed' };
  }

  if (op.preserve && op.preserve.length > 0) {
    const keep = new Set(op.preserve);
    let removedAny = false;
    for (const entry of readdirSync(op.path)) {
      if (keep.has(entry)) continue;
      rmSync(join(op.path, entry), { recursive: true, force: true });
      removedAny = true;
    }
    return { op, status: removedAny ? 'removed' : 'not-present' };
  }

  rmSync(op.path, { recursive: true, force: true });
  return { op, status: 'removed' };
}

function removableGitExcludePaths(projectRoot: string): readonly string[] {
  const sharedPaths = new Set<string>([join(projectRoot, '.claude', 'launch.json')]);
  for (const id of ALL_EDITOR_IDS) {
    const path = EDITOR_TARGETS[id].projectConfigPath?.(projectRoot);
    if (path) sharedPaths.add(path);
  }
  return getOkArtifactPaths(projectRoot).filter((path) => {
    const absolute = join(projectRoot, path);
    if (!sharedPaths.has(absolute)) return true;
    try {
      lstatSync(absolute);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw err;
    }
  });
}
