import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { atomicWriteFileSync, withFileLockSync } from '@inkeep/open-knowledge-core/server';
import type {
  InstallUserSkillOptions,
  InstallUserSkillResult,
} from '@inkeep/open-knowledge-server';
import {
  ensureProjectGit,
  GitNotAvailableError,
  GitTooOldError,
  initContent,
  installUserSkill,
  MCP_SERVER_NAME,
  ProjectGitInitError,
  writeRootGitignoreForNewRepo,
} from '@inkeep/open-knowledge-server';
import checkbox from '@inquirer/checkbox';
import select from '@inquirer/select';
import { Command, Option } from 'commander';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { OK_DIR } from '../constants.ts';
import { formatPreviewBlock, type PreviewResult } from '../content/preview.ts';
import { resolveProjectRoot } from '../integrations/resolve-project-root.ts';
import {
  assertProjectPathSafe,
  type ProjectSkillResult,
  writeProjectSkill,
} from '../integrations/write-project-skill.ts';
import {
  addOkPathsToGitExclude,
  type ExcludeWriteResult,
  getOkArtifactPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
  type SharingMode,
  type TrackedRefusal,
} from '../sharing/git-exclude.ts';
import { accent, error, info, success, warning } from '../ui/colors.ts';
import { isObject } from '../utils/is-object.ts';
import {
  ALL_EDITOR_IDS,
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  type McpInstallOptions,
  resolveDevCliDistPath,
  resolveEditorTargets,
} from './editors.ts';
import { LAUNCH_JSON_PORT } from './ui.ts';

function readJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (isObject(parsed)) {
      return parsed;
    }
    throw new Error(`${path} root must be a JSON object`);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${path} contains invalid JSON: ${err.message}`);
    }
    throw err;
  }
}

function readTomlConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    const parsed = parseToml(trimmed);
    if (isObject(parsed)) {
      return parsed;
    }
    throw new Error(`${path} root must be a TOML table`);
  } catch (err) {
    throw new Error(
      `${path} contains invalid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function writeJsonConfig(path: string, config: Record<string, unknown>): void {
  atomicWriteFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function writeTomlConfig(path: string, config: Record<string, unknown>): void {
  const serialized = stringifyToml(config);
  atomicWriteFileSync(path, serialized.endsWith('\n') ? serialized : `${serialized}\n`);
}

type McpScope = 'user' | 'project' | 'both';

const writesUser = (s: McpScope) => s !== 'project';
const writesProject = (s: McpScope) => s !== 'user';

async function promptMcpScope(): Promise<McpScope | null> {
  const choices = await checkbox({
    message: 'Where should the MCP server be configured?\n',
    required: false,
    theme: {
      icon: {
        checked: '[x]',
        unchecked: '[ ]',
      },
    },
    choices: [
      {
        name: 'User-level  (~/.claude.json, ~/.cursor/mcp.json, …)',
        value: 'user' as const,
        checked: true,
      },
      {
        name: 'Project-level  (.mcp.json, .cursor/mcp.json, …)',
        value: 'project' as const,
        checked: true,
      },
    ],
  });

  if (choices.includes('user') && choices.includes('project')) return 'both';
  if (choices.includes('user')) return 'user';
  if (choices.includes('project')) return 'project';
  return null; // neither selected → skip MCP (equivalent to --no-mcp)
}

export async function resolveMcpScope(opts: {
  scope?: McpScope;
  mcp?: boolean;
  isTTY?: boolean;
  promptFn?: () => Promise<McpScope | null>;
}): Promise<McpScope | null> {
  if (opts.mcp === false) return null; // sentinel — --no-mcp short-circuits before this scope is read
  if (opts.scope) return opts.scope;
  const tty = opts.isTTY ?? process.stdout.isTTY;
  if (!tty) return 'both';
  const prompt = opts.promptFn ?? promptMcpScope;
  return prompt();
}

async function promptSharingMode(
  defaultMode: 'shared' | 'local-only',
): Promise<'shared' | 'local-only'> {
  return select<'shared' | 'local-only'>({
    message:
      'How do you want to handle OpenKnowledge config files (.ok/, .mcp.json, project skills, launch.json)?',
    default: defaultMode,
    choices: [
      {
        name: 'Share with my team (commit alongside content)',
        value: 'shared',
        description: 'OK config gets committed alongside your project content.',
      },
      {
        name: 'Local only (keep out of git via .git/info/exclude)',
        value: 'local-only',
        description:
          'OK config stays on this machine only; teammates do not see it. Safe escape hatch via `ok config-sharing share`.',
      },
    ],
  });
}

export async function resolveSharingMode(opts: {
  sharing?: 'shared' | 'local-only';
  projectRoot: string;
  isTTY?: boolean;
  promptFn?: (defaultMode: 'shared' | 'local-only') => Promise<'shared' | 'local-only'>;
}): Promise<'shared' | 'local-only'> {
  if (opts.sharing !== undefined) return opts.sharing;
  const current = readSharingMode(opts.projectRoot);
  const seed: 'shared' | 'local-only' = current === 'local-only' ? 'local-only' : 'shared';
  const tty = opts.isTTY ?? process.stdout.isTTY;
  if (!tty) return seed;
  const prompt = opts.promptFn ?? promptSharingMode;
  return prompt(seed);
}

export interface EditorMcpResult {
  editorId: EditorId;
  label: string;
  action: 'written' | 'overwritten' | 'skipped-missing' | 'skipped-flag' | 'failed';
  configPath: string;
  serverName: string;
  error?: string;
  configScope?: 'project';
}

interface ProjectConfigResult {
  editorId: EditorId;
  label: string;
  path: string;
}

interface InitCommandOptions {
  cwd?: string;
  mcp?: boolean;
  devMcp?: boolean;
  editors?: EditorId[];
  home?: string;
  installUserSkill?: (opts?: InstallUserSkillOptions) => Promise<InstallUserSkillResult>;
  scope?: McpScope;
  isTTY?: boolean;
  promptFn?: () => Promise<McpScope | null>;
  sharing?: 'shared' | 'local-only';
  sharingPromptFn?: (defaultMode: 'shared' | 'local-only') => Promise<'shared' | 'local-only'>;
}

interface InitCommandResult {
  projectRoot: string;
  contentCreated: string[];
  contentUpdated: string[];
  contentSkipped: string[];
  editors: EditorMcpResult[];
  legacyProjectConfigs: ProjectConfigResult[];
  projectSkills: ProjectSkillResult[];
  skillInstall?: InstallUserSkillResult;
  preview?: PreviewResult;
  launchJson?: LaunchJsonResult;
  didGitInit: boolean;
  /** `true` if a project-root `.gitignore` was seeded during this invocation.
   * Only set when `didGitInit` is also `true` AND no `.gitignore` was already
   * present at `projectRoot` — pre-existing files are never touched. */
  rootGitignoreCreated: boolean;
  mcpAction: 'written' | 'overwritten' | 'skipped-missing' | 'skipped-flag' | 'failed';
  mcpPath: string;
  mcpError?: string;
  previewWarning?: string;
  projectScopeUnsupportedLabels?: string[];
  sharing: SharingOutcome;
}

export type SharingOutcome =
  | {
      kind: 'applied';
      mode: SharingMode;
      action: 'added' | 'removed' | 'noop';
      appended: string[];
      alreadyPresent: string[];
      removed: string[];
    }
  | { kind: 'refused-tracked'; tracked: string[]; remediation: string }
  | {
      kind: 'no-exclude';
      reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
      /** True when --local-only was explicitly requested but no git repo
       *  existed; formatInitResult surfaces a clear warning. */
      localOnlyRequested: boolean;
    };

const LAUNCH_JSON_VERSION = '0.0.1';
export const LAUNCH_CONFIG_NAME = 'open-knowledge-ui';

export const LAUNCH_JSON_CANONICAL_ARGS: readonly string[] = [
  '-y',
  '@inkeep/open-knowledge@latest',
  'ui',
];

export const LAUNCH_UI_CHAIN_SENTINEL = '# ok-ui-v1';

export const LAUNCH_UI_CHAIN_V1 = `${LAUNCH_UI_CHAIN_SENTINEL}
UIPORT="\${PORT:-${LAUNCH_JSON_PORT}}"
unset PORT
USER_BUNDLE="$HOME/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"
[ -f "$USER_BUNDLE" ] && [ -x "$USER_BUNDLE" ] && exec "$USER_BUNDLE" start --ui-port "$UIPORT"
BUNDLE="/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh"
[ -f "$BUNDLE" ] && [ -x "$BUNDLE" ] && exec "$BUNDLE" start --ui-port "$UIPORT"
command -v npx >/dev/null 2>&1 && exec npx -y @inkeep/open-knowledge@latest start --ui-port "$UIPORT"
for d in "$HOME/.nvm/versions/node"/*/bin "$HOME/.fnm/node-versions"/*/installation/bin "$HOME/.asdf/installs/nodejs"/*/bin /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
  [ -f "$d/npx" ] && [ -x "$d/npx" ] && exec "$d/npx" -y @inkeep/open-knowledge@latest start --ui-port "$UIPORT"
done
echo "OpenKnowledge: install OK Desktop or Node.js 24+, then restart your editor" >&2
exit 127`;

type LaunchJsonAction = 'created' | 'merged' | 'failed';

export interface LaunchJsonResult {
  action: LaunchJsonAction;
  configPath: string;
  error?: string;
}

export function scaffoldLaunchJson(
  cwd: string,
  installOptions: McpInstallOptions = {},
): LaunchJsonResult {
  const configPath = join(cwd, '.claude', 'launch.json');
  const buildDevChain = () => `${LAUNCH_UI_CHAIN_SENTINEL}
UIPORT="\${PORT:-${LAUNCH_JSON_PORT}}"
unset PORT
exec node "${resolveDevCliDistPath()}" start --ui-port "$UIPORT"`;
  const entry: {
    name: string;
    runtimeExecutable: string;
    runtimeArgs: string[];
    port: number;
    autoPort: true;
  } =
    installOptions.mode === 'dev'
      ? {
          name: LAUNCH_CONFIG_NAME,
          runtimeExecutable: '/bin/sh',
          runtimeArgs: ['-l', '-c', buildDevChain()],
          port: LAUNCH_JSON_PORT,
          autoPort: true,
        }
      : {
          name: LAUNCH_CONFIG_NAME,
          runtimeExecutable: '/bin/sh',
          runtimeArgs: ['-l', '-c', LAUNCH_UI_CHAIN_V1],
          port: LAUNCH_JSON_PORT,
          autoPort: true,
        };

  try {
    assertProjectPathSafe(configPath, cwd);
    if (!existsSync(configPath)) {
      mkdirSync(dirname(configPath), { recursive: true });
      const content = { version: LAUNCH_JSON_VERSION, configurations: [entry] };
      writeFileSync(configPath, `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
      return { action: 'created', configPath };
    }

    const raw = readFileSync(configPath, 'utf-8').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    if (!isObject(parsed)) {
      return { action: 'failed', configPath, error: 'launch.json root is not an object' };
    }

    const configs: unknown[] = Array.isArray(parsed.configurations) ? parsed.configurations : [];
    const existingIdx = configs.findIndex(
      (c) => isObject(c) && (c as Record<string, unknown>).name === LAUNCH_CONFIG_NAME,
    );

    if (existingIdx >= 0) {
      configs[existingIdx] = entry;
    } else {
      configs.push(entry);
    }

    const updated = {
      ...parsed,
      version: parsed.version ?? LAUNCH_JSON_VERSION,
      configurations: configs,
    };
    writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8');
    return { action: existingIdx >= 0 ? 'merged' : 'created', configPath };
  } catch (err) {
    return {
      action: 'failed',
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isEditorTargetAvailable(target: EditorMcpTarget, cwd: string, home?: string): boolean {
  try {
    const probePath = target.detectPath?.(cwd, home) ?? dirname(target.configPath(cwd, home));
    return existsSync(probePath);
  } catch {
    return false;
  }
}

export function writeEditorMcpConfig(
  target: EditorMcpTarget,
  cwd: string,
  installOptions: McpInstallOptions,
  home?: string,
  configPathOverride?: string,
): EditorMcpResult {
  const serverName = target.serverName(cwd);
  let configPath: string;
  try {
    configPath = configPathOverride ?? target.configPath(cwd, home);
  } catch (err) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'failed',
      configPath: '',
      serverName,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (
    !configPathOverride &&
    !installOptions.skipAvailabilityCheck &&
    !isEditorTargetAvailable(target, cwd, home)
  ) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'skipped-missing',
      configPath,
      serverName,
    };
  }

  if (configPathOverride !== undefined) {
    try {
      assertProjectPathSafe(configPath, cwd);
    } catch (err) {
      return {
        editorId: target.id,
        label: target.label,
        action: 'failed',
        configPath,
        serverName,
        error: err instanceof Error ? err.message : String(err),
        configScope: 'project' as const,
      };
    }
  }

  let targetEntry: Record<string, unknown>;
  try {
    targetEntry = target.buildEntry(cwd, installOptions);
  } catch (err) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'failed',
      configPath,
      serverName,
      error: err instanceof Error ? err.message : String(err),
      ...(configPathOverride !== undefined ? { configScope: 'project' as const } : {}),
    };
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });
  } catch (err) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'failed',
      configPath,
      serverName,
      error: err instanceof Error ? err.message : String(err),
      ...(configPathOverride !== undefined ? { configScope: 'project' as const } : {}),
    };
  }

  let existing: unknown;
  let lockErr: Error | undefined;
  try {
    withFileLockSync(
      `${configPath}.lock`,
      () => {
        const config: Record<string, unknown> =
          target.format === 'toml' ? readTomlConfig(configPath) : readJsonConfig(configPath);
        const servers = (config[target.topLevelKey] as Record<string, unknown> | undefined) ?? {};
        existing = servers[serverName];
        const nextConfig: Record<string, unknown> = {
          ...config,
          [target.topLevelKey]: {
            ...servers,
            [serverName]: targetEntry,
          },
        };
        if (target.format === 'toml') {
          writeTomlConfig(configPath, nextConfig);
        } else {
          writeJsonConfig(configPath, nextConfig);
        }
      },
      {
        onWarn: (message, context) =>
          process.stderr.write(`[ok] ${message} ${JSON.stringify(context)}\n`),
      },
    );
  } catch (err) {
    lockErr = err instanceof Error ? err : new Error(String(err));
  }
  if (lockErr) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'failed',
      configPath,
      serverName,
      error: lockErr.message,
      ...(configPathOverride !== undefined ? { configScope: 'project' as const } : {}),
    };
  }

  return {
    editorId: target.id,
    label: target.label,
    action: existing !== undefined ? 'overwritten' : 'written',
    configPath,
    serverName,
    ...(configPathOverride !== undefined ? { configScope: 'project' as const } : {}),
  };
}

function collectProjectConfig(
  target: EditorMcpTarget,
  cwd: string,
): ProjectConfigResult | undefined {
  const projectPath = target.projectConfigPath?.(cwd);
  if (!projectPath || !existsSync(projectPath)) return undefined;
  return {
    editorId: target.id,
    label: target.label,
    path: projectPath,
  };
}

export interface UserMcpConfigsOptions {
  editors: EditorId[];
  home?: string;
}

export async function writeUserMcpConfigs(opts: UserMcpConfigsOptions): Promise<EditorMcpResult[]> {
  const targets = resolveEditorTargets(opts.editors);
  const installOptions: McpInstallOptions = {
    mode: 'published',
    skipAvailabilityCheck: true,
  };
  return targets.map((target) => writeEditorMcpConfig(target, '', installOptions, opts.home));
}

export function readExistingMcpEntry(
  target: EditorMcpTarget,
  cwd: string,
  home?: string,
  configPathOverride?: string,
): Record<string, unknown> | null {
  const classified = classifyExistingMcpEntry(target, cwd, home, configPathOverride);
  return classified.kind === 'present' ? classified.entry : null;
}

export type McpEntryClassification =
  | { kind: 'absent' }
  | { kind: 'no-entry' }
  | { kind: 'present'; entry: Record<string, unknown> }
  | { kind: 'corrupt'; error: string };

export function classifyExistingMcpEntry(
  target: EditorMcpTarget,
  cwd: string,
  home?: string,
  configPathOverride?: string,
): McpEntryClassification {
  let configPath: string;
  try {
    configPath = configPathOverride ?? target.configPath(cwd, home);
  } catch {
    return { kind: 'absent' };
  }
  if (!existsSync(configPath)) return { kind: 'absent' };

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    return { kind: 'corrupt', error: err instanceof Error ? err.message : String(err) };
  }
  if (raw.trim() === '') {
    return { kind: 'corrupt', error: 'file is empty' };
  }

  let config: Record<string, unknown>;
  try {
    config = target.format === 'toml' ? readTomlConfig(configPath) : readJsonConfig(configPath);
  } catch (err) {
    return { kind: 'corrupt', error: err instanceof Error ? err.message : String(err) };
  }
  const servers = config[target.topLevelKey];
  if (!isObject(servers)) return { kind: 'no-entry' };
  const existing = servers[target.serverName(cwd)];
  if (!isObject(existing)) return { kind: 'no-entry' };
  return { kind: 'present', entry: existing };
}

export async function runInit(options: InitCommandOptions = {}): Promise<InitCommandResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const resolution = resolveProjectRoot(cwd, { homeDir: options.home });
  const projectRoot = resolution.projectRoot;
  const willScaffold = !existsSync(join(projectRoot, OK_DIR));
  if (resolution.ancestorPromoted) {
    console.log(`[ok] Opened existing project at ${projectRoot}`);
  } else if (resolution.gitRootPromoted && willScaffold) {
    console.log(
      `[ok] Initialized OK at ${projectRoot} — opened parent of ${relative(projectRoot, cwd)} because it contains a .git folder`,
    );
  }

  const installOptions: McpInstallOptions = {
    mode: options.devMcp ? 'dev' : 'published',
  };

  const gitResult = await ensureProjectGit(projectRoot);

  let contentResult: ReturnType<typeof initContent>;
  try {
    contentResult = initContent(projectRoot, { contentDir: resolution.defaultContentDir });
  } catch (err) {
    const fallbackPath = EDITOR_TARGETS.claude.configPath(projectRoot, options.home);
    return {
      projectRoot,
      contentCreated: [],
      contentUpdated: [],
      contentSkipped: [],
      editors: [],
      projectSkills: [],
      legacyProjectConfigs: [],
      didGitInit: gitResult.didInit,
      rootGitignoreCreated: false,
      mcpAction: 'failed',
      mcpPath: fallbackPath,
      mcpError: `Content scaffolding failed: ${err instanceof Error ? err.message : String(err)}`,
      sharing: { kind: 'no-exclude', reason: 'no-git', localOnlyRequested: false },
    };
  }

  let rootGitignoreCreated = false;
  if (gitResult.didInit) {
    try {
      rootGitignoreCreated = writeRootGitignoreForNewRepo(projectRoot) === 'created';
    } catch (err) {
      console.warn(
        `[ok] Skipping .gitignore seed at ${projectRoot}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const scope = await resolveMcpScope({
    scope: options.scope,
    mcp: options.mcp,
    isTTY: options.isTTY,
    promptFn: options.promptFn,
  });

  const userEditorIds = options.editors ?? detectInstalledEditors(projectRoot, options.home);
  const projectEditorIds =
    options.editors ??
    ALL_EDITOR_IDS.filter((id) => EDITOR_TARGETS[id].projectConfigPath !== undefined);
  const userTargets = resolveEditorTargets(userEditorIds as EditorId[]);
  const projectTargets = resolveEditorTargets(projectEditorIds as EditorId[]);
  const skipMcp = options.mcp === false || scope === null;
  const selectedTargets = Array.from(
    new Map(
      [...userTargets, ...(skipMcp ? [] : projectTargets)].map((target) => [target.id, target]),
    ).values(),
  );
  const availableTargets = userTargets.filter((target) =>
    isEditorTargetAvailable(target, projectRoot, options.home),
  );

  const editorResults: EditorMcpResult[] = [];
  const projectSkillResults: ProjectSkillResult[] = [];
  const writtenProjectPaths = new Set<string>();

  for (const target of selectedTargets) {
    if (skipMcp) {
      let configPath = '';
      try {
        configPath = target.configPath(projectRoot, options.home);
      } catch {}
      editorResults.push({
        editorId: target.id,
        label: target.label,
        action: 'skipped-flag',
        configPath,
        serverName: target.serverName(projectRoot),
      });
      continue;
    }

    if (writesUser(scope) && userTargets.includes(target)) {
      editorResults.push(writeEditorMcpConfig(target, projectRoot, installOptions, options.home));
    }
    if (writesProject(scope) && projectTargets.includes(target) && target.projectConfigPath) {
      const projPath = target.projectConfigPath(projectRoot);
      const projResult = writeEditorMcpConfig(
        target,
        projectRoot,
        installOptions,
        options.home,
        projPath,
      );
      editorResults.push(projResult);
      if (projResult.action === 'written' || projResult.action === 'overwritten') {
        writtenProjectPaths.add(projPath);
      }
    }
  }

  const writtenSkillPaths = new Set<string>();
  for (const target of projectTargets) {
    const skillPath = target.projectSkillPath?.(projectRoot);
    if (!skillPath || writtenSkillPaths.has(skillPath)) continue;
    writtenSkillPaths.add(skillPath);
    projectSkillResults.push(writeProjectSkill(target, projectRoot));
  }

  const projectScopeUnsupportedLabels =
    !skipMcp && scope !== null && writesProject(scope)
      ? projectTargets.filter((t) => !t.projectConfigPath).map((t) => t.label)
      : undefined;

  const legacyProjectConfigs = skipMcp
    ? []
    : availableTargets
        .map((target) => collectProjectConfig(target, projectRoot))
        .filter((result): result is ProjectConfigResult => result !== undefined)
        .filter((result) => !writtenProjectPaths.has(result.path));

  const hasClaude = availableTargets.some((target) => target.id === 'claude');
  const launchJson =
    hasClaude && !skipMcp ? scaffoldLaunchJson(projectRoot, installOptions) : undefined;

  const installSkill = options.installUserSkill ?? installUserSkill;
  const skillInstall = await installSkill({ home: options.home });

  const defaultAction: EditorMcpResult['action'] = skipMcp ? 'skipped-flag' : 'skipped-missing';
  const primary = editorResults.find((r) => r.editorId === 'claude') ??
    editorResults[0] ?? {
      action: defaultAction,
      configPath: EDITOR_TARGETS.claude.configPath(projectRoot, options.home),
    };

  const desiredMode = await resolveSharingMode({
    sharing: options.sharing,
    projectRoot,
    isTTY: options.isTTY,
    promptFn: options.sharingPromptFn,
  });
  const sharing = await applySharingMode({
    projectRoot,
    desiredMode,
    explicitFlag: options.sharing,
  });

  return {
    projectRoot,
    contentCreated: contentResult.created,
    contentUpdated: contentResult.updated,
    contentSkipped: contentResult.skipped,
    editors: editorResults,
    projectSkills: projectSkillResults,
    legacyProjectConfigs,
    launchJson,
    skillInstall,
    didGitInit: gitResult.didInit,
    rootGitignoreCreated,
    mcpAction: primary.action,
    mcpPath: primary.configPath,
    mcpError: 'error' in primary ? (primary as EditorMcpResult).error : undefined,
    projectScopeUnsupportedLabels,
    sharing,
  };
}

export async function applySharingMode(opts: {
  projectRoot: string;
  desiredMode: 'shared' | 'local-only';
  explicitFlag: 'shared' | 'local-only' | undefined;
}): Promise<SharingOutcome> {
  const { projectRoot, desiredMode, explicitFlag } = opts;
  const current = readSharingMode(projectRoot);

  if (current === 'no-git') {
    return {
      kind: 'no-exclude',
      reason: 'no-git',
      localOnlyRequested: explicitFlag === 'local-only',
    };
  }

  const paths = getOkArtifactPaths(projectRoot);
  if (desiredMode === 'local-only') {
    const result = addOkPathsToGitExclude(projectRoot, paths);
    if (result.kind === 'refused-tracked') {
      const refusal: TrackedRefusal = result;
      return {
        kind: 'refused-tracked',
        tracked: refusal.tracked,
        remediation: refusal.remediation,
      };
    }
    if (result.kind === 'no-exclude') {
      return {
        kind: 'no-exclude',
        reason: result.reason,
        localOnlyRequested: explicitFlag === 'local-only',
      };
    }
    return summarizeApplied(projectRoot, result, 'add');
  }

  if (current === 'shared') {
    return {
      kind: 'applied',
      mode: 'shared',
      action: 'noop',
      appended: [],
      alreadyPresent: [],
      removed: [],
    };
  }
  const result = removeOkPathsFromGitExclude(projectRoot, paths);
  if (result.kind === 'no-exclude') {
    return {
      kind: 'no-exclude',
      reason: result.reason,
      localOnlyRequested: false,
    };
  }
  return summarizeApplied(projectRoot, result, 'remove');
}

function summarizeApplied(
  projectRoot: string,
  result: Extract<ExcludeWriteResult, { kind: 'updated' }>,
  direction: 'add' | 'remove',
): Extract<SharingOutcome, { kind: 'applied' }> {
  const mode = readSharingMode(projectRoot);
  if (direction === 'add') {
    return {
      kind: 'applied',
      mode,
      action: result.appended.length > 0 ? 'added' : 'noop',
      appended: result.appended,
      alreadyPresent: result.alreadyPresent,
      removed: [],
    };
  }
  return {
    kind: 'applied',
    mode,
    action: 'removed',
    appended: [],
    alreadyPresent: [],
    removed: result.removed,
  };
}

export function formatInitResult(result: InitCommandResult, cwd: string): string {
  const lines: string[] = [];
  const anyWritten = result.editors.some(
    (e) => e.action === 'written' || e.action === 'overwritten',
  );
  const anyFailed =
    result.editors.some((e) => e.action === 'failed') ||
    result.projectSkills.some((skill) => skill.action === 'failed');
  const allSkippedFlag =
    result.editors.length > 0 && result.editors.every((e) => e.action === 'skipped-flag');
  const allSkippedMissing =
    result.editors.length > 0 && result.editors.every((e) => e.action === 'skipped-missing');
  const formatLaunchJsonSummary = (launchJson: LaunchJsonResult): string => {
    const displayPath = launchJson.configPath.startsWith(cwd)
      ? relative(cwd, launchJson.configPath)
      : launchJson.configPath;
    switch (launchJson.action) {
      case 'created':
        return `    app preview server   ${displayPath}  configured for Claude Code Desktop embedded browser`;
      case 'merged':
        return `    app preview server   ${displayPath}  updated for Claude Code Desktop embedded browser`;
      case 'failed':
        return `    app preview server   ${displayPath}  FAILED: ${launchJson.error}`;
    }
  };

  if (result.didGitInit) {
    lines.push(`Initialized git repo at ${cwd}/.git/ (default branch: main)`);
  }
  if (result.rootGitignoreCreated) {
    lines.push(`Seeded .gitignore at ${cwd}/.gitignore (.DS_Store)`);
  }

  const okDir = join(cwd, OK_DIR);
  if (result.contentCreated.length > 0 || result.contentUpdated.length > 0) {
    lines.push(accent(`Content scaffolded at ${okDir}/`));
    if (result.contentCreated.length > 0) {
      lines.push(`  Created: ${result.contentCreated.join(', ')}`);
    }
    if (result.contentUpdated.length > 0) {
      lines.push(`  Updated: ${result.contentUpdated.join(', ')}`);
    }
  } else {
    lines.push(accent(`Content already present at ${okDir}/`));
  }
  if (result.contentSkipped.length > 0) {
    lines.push(`  Skipped (already exist): ${result.contentSkipped.join(', ')}`);
  }

  lines.push('');

  if (result.mcpError && result.editors.length === 0) {
    lines.push(`Warning: ${result.mcpError}`);
  } else if (result.editors.length === 0) {
    lines.push(accent('MCP server configuration:'));
    if (result.mcpAction === 'skipped-flag') {
      lines.push('  MCP config not written — use without --no-mcp to configure editors');
    } else if (
      result.projectScopeUnsupportedLabels &&
      result.projectScopeUnsupportedLabels.length > 0
    ) {
      const names = result.projectScopeUnsupportedLabels.join(', ');
      const verb = result.projectScopeUnsupportedLabels.length === 1 ? 'does' : 'do';
      lines.push(`  ${names} ${verb} not support project-level config; skipped`);
    } else {
      lines.push('  No supported editor config directories detected; skipped MCP registration');
    }
  } else if (allSkippedFlag) {
    lines.push('MCP config not written — use without --no-mcp to configure editors');
  } else if (allSkippedMissing) {
    lines.push(accent('MCP server configuration:'));
    lines.push('  No supported editor config directories detected; skipped MCP registration');
  } else {
    lines.push(accent('MCP server configuration:'));
    for (const editor of result.editors) {
      const displayPath = editor.configPath.startsWith(cwd)
        ? relative(cwd, editor.configPath)
        : editor.configPath.replace(/^\/Users\/[^/]+/, '~');
      const serverNameNote = editor.serverName === MCP_SERVER_NAME ? '' : ` (${editor.serverName})`;
      const scopeTag = editor.configScope === 'project' ? ' (project)' : '';
      const labelWithScope = `${editor.label}${scopeTag}`;
      const pad = ' '.repeat(Math.max(1, 20 - labelWithScope.length));
      const restartHint =
        editor.editorId === 'claude-desktop' &&
        (editor.action === 'written' || editor.action === 'overwritten')
          ? ' — quit and relaunch Claude Desktop to activate'
          : '';
      switch (editor.action) {
        case 'written':
          lines.push(
            `  ${labelWithScope}${pad}${displayPath}  ${success('registered')}${serverNameNote}${restartHint}`,
          );
          break;
        case 'overwritten':
          lines.push(
            `  ${labelWithScope}${pad}${displayPath}  ${success('updated')}${serverNameNote}${restartHint}`,
          );
          break;
        case 'skipped-missing':
          lines.push(`  ${labelWithScope}${pad}${displayPath}  config root missing; skipped`);
          break;
        case 'failed':
          lines.push(
            `  ${labelWithScope}${pad}${displayPath}  ${error('FAILED')}: ${editor.error}`,
          );
          break;
        case 'skipped-flag':
          break;
      }
      if (editor.editorId === 'claude' && result.launchJson) {
        lines.push(formatLaunchJsonSummary(result.launchJson));
      }
    }
    if (result.projectScopeUnsupportedLabels && result.projectScopeUnsupportedLabels.length > 0) {
      const names = result.projectScopeUnsupportedLabels.join(', ');
      const verb = result.projectScopeUnsupportedLabels.length === 1 ? 'does' : 'do';
      lines.push(`  ${names} ${verb} not support project-level config; skipped`);
    }
  }

  if (result.projectSkills.length > 0) {
    lines.push('');
    lines.push(accent('Project-local skills:'));
    for (const skill of result.projectSkills) {
      const label = `${skill.label} (project)`;
      const pad = ' '.repeat(Math.max(1, 20 - label.length));
      const displayPath = skill.path ? relative(cwd, skill.path) : '';
      switch (skill.action) {
        case 'written':
          lines.push(`  ${label}${pad}${displayPath}  ${success('installed')}`);
          break;
        case 'overwritten':
          lines.push(`  ${label}${pad}${displayPath}  ${success('updated')}`);
          break;
        case 'skipped-unsupported':
          lines.push(`  ${label}${pad}no known project skill surface; skipped`);
          break;
        case 'failed':
          lines.push(`  ${label}${pad}${displayPath}  ${error('FAILED')}: ${skill.error}`);
          break;
      }
    }
  }

  if (anyFailed) {
    lines.push('');
    lines.push('For failed editors, add the MCP server entry or project skill manually. See:');
    lines.push('  https://github.com/inkeep/open-knowledge#mcp-setup');
  }

  if (result.legacyProjectConfigs.length > 0) {
    lines.push('');
    lines.push('Project MCP configs found:');
    for (const proj of result.legacyProjectConfigs) {
      lines.push(`  ${proj.label}  ${relative(cwd, proj.path)}`);
    }
    lines.push(
      '  These project-local files may override the global config. Remove them if you want fully user-scoped MCP setup in this project.',
    );
  }

  if (result.skillInstall) {
    lines.push('');
    lines.push(accent('User-global skill:'));
    switch (result.skillInstall) {
      case 'installed':
        lines.push(
          `  open-knowledge  ${success('installed to detected agent hosts')} via \`npx skills\``,
        );
        break;
      case 'skip-current':
        lines.push(`  open-knowledge  ${success('already installed at current version')}`);
        break;
      case 'failed':
        lines.push(
          `  ${warning('open-knowledge  install failed — MCP still configured; run manually:')}`,
        );
        lines.push(
          `  ${warning("  npx skills@~1.5.0 add <bundled-path> --agent '*' -g -y --copy")}`,
        );
        break;
    }
  }

  if (result.preview) {
    lines.push('');
    lines.push(formatPreviewBlock(result.preview, cwd));
  } else if (result.previewWarning) {
    lines.push('');
    lines.push(`Content preview unavailable: ${result.previewWarning}`);
  }

  lines.push('');
  lines.push(...formatSharingOutcome(result.sharing, cwd));

  if (anyWritten) {
    const seen = new Set<EditorId>();
    const configuredLabels = result.editors
      .filter((e) => e.action === 'written' || e.action === 'overwritten')
      .filter((e) => !seen.has(e.editorId) && seen.add(e.editorId))
      .map((e) => e.label);

    lines.push('');
    lines.push(`${success('✓')} ${accent('Next steps:')}`);
    lines.push(`  1. Open your editor (${info(configuredLabels.join(' / '))})`);
    lines.push('  2. Approve the MCP server when prompted');
    lines.push('  3. (Optional) scaffold the starter knowledge-base structure:');
    lines.push(
      `     - ${info('ok seed')}                              — empty repo, Karpathy 3-layer`,
    );
    lines.push(
      `     - ${info('mcp__open-knowledge__discover')}      — existing repo, extract conventions`,
    );
    lines.push('  4. Use the MCP workflow tools as you build the wiki:');
    lines.push(`     - ${info('mcp__open-knowledge__ingest')}        — capture an external source`);
    lines.push(
      `     - ${info('mcp__open-knowledge__research')}      — gather sources and write findings`,
    );
    lines.push(
      `     - ${info('mcp__open-knowledge__consolidate')}   — promote research to canonical articles`,
    );
  }

  return lines.join('\n');
}

export function detectInstalledEditors(cwd: string, home?: string): EditorId[] {
  const detected: EditorId[] = [];
  for (const id of ALL_EDITOR_IDS) {
    if (isEditorTargetAvailable(EDITOR_TARGETS[id], cwd, home)) {
      detected.push(id);
    }
  }
  return detected;
}

export function initCommand(): Command {
  return new Command('init')
    .description(
      `Scaffold ${OK_DIR}/ in the current directory and register the MCP server for your editor(s)`,
    )
    .option('--mcp', 'Register the MCP server for selected editors (default: true)', true)
    .option('--no-mcp', `Scaffold the ${OK_DIR}/ directory but do not touch MCP config`)
    .option(
      '--dev-mcp',
      'Register a local dev MCP entry using node + packages/cli/dist/cli.mjs with debug logging',
    )
    .addOption(
      new Option(
        '--scope <scope>',
        'Write MCP config at user level, project level, or both',
      ).choices(['user', 'project', 'both']),
    )
    .addOption(
      new Option(
        '--shared',
        'Commit OK config alongside content (the default for fresh repos)',
      ).conflicts('localOnly'),
    )
    .addOption(
      new Option(
        '--local-only',
        'Keep OK config out of git via .git/info/exclude (per-clone, not committed)',
      ).conflicts('shared'),
    )
    .action(
      async (opts: {
        mcp?: boolean;
        devMcp?: boolean;
        scope?: McpScope;
        shared?: boolean;
        localOnly?: boolean;
      }) => {
        const cwd = process.cwd();

        const sharing: 'shared' | 'local-only' | undefined = opts.shared
          ? 'shared'
          : opts.localOnly
            ? 'local-only'
            : undefined;
        let result: InitCommandResult;
        try {
          result = await runInit({
            cwd,
            mcp: opts.mcp,
            devMcp: opts.devMcp,
            scope: opts.scope,
            sharing,
          });
        } catch (err) {
          if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
            process.stderr.write(`${err.message}\n`);
            process.exitCode = 78;
            return;
          }
          if (err instanceof ProjectGitInitError) {
            process.stderr.write(
              "open-knowledge could not initialize a git repo for this project. Re-run, or run 'git init' yourself in the project folder.\n",
            );
            if (err.stderr) process.stderr.write(`${err.stderr.trim()}\n`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }

        try {
          const { previewContent } = await import('../content/preview.ts');
          const { loadConfig } = await import('../config/loader.ts');
          const { resolveContentDir } = await import('@inkeep/open-knowledge-server');
          const { config } = loadConfig(result.projectRoot);
          const contentDir = resolveContentDir(config, result.projectRoot);
          result.preview = previewContent({
            projectDir: result.projectRoot,
            contentDir,
          });
        } catch (e) {
          result.previewWarning = e instanceof Error ? e.message : String(e);
        }

        process.stdout.write(`${formatInitResult(result, result.projectRoot)}\n`);

        if (result.editors.some((e) => e.action === 'failed') || result.mcpAction === 'failed') {
          process.exitCode = 1;
        }
      },
    );
}

export function formatSharingOutcome(outcome: SharingOutcome, cwd: string): string[] {
  const lines: string[] = [];
  switch (outcome.kind) {
    case 'applied':
      lines.push(accent('Sharing mode:'));
      if (outcome.mode === 'local-only') {
        if (outcome.action === 'added') {
          lines.push(
            `  ${success('local-only')} — appended ${outcome.appended.length} path(s) to ${accent(`${cwd}/.git/info/exclude`)} (per-clone, not committed).`,
          );
        } else if (outcome.action === 'noop' && outcome.alreadyPresent.length > 0) {
          lines.push(`  ${success('local-only')} — already excluded; nothing to do.`);
        } else {
          lines.push(`  ${success('local-only')}`);
        }
      } else {
        if (outcome.action === 'removed') {
          lines.push(
            `  ${success('shared')} — removed OK paths from ${accent(`${cwd}/.git/info/exclude`)}; commit the files to share with teammates.`,
          );
        } else {
          lines.push(`  ${success('shared')} — OK config will be committed alongside content.`);
        }
      }
      return lines;
    case 'refused-tracked':
      lines.push(warning('Sharing mode: switch to local-only deferred'));
      for (const raw of outcome.remediation.split('\n')) {
        lines.push(raw.length > 0 ? `  ${raw}` : '');
      }
      lines.push(
        `  Re-run ${info('ok config-sharing unshare')} after resolving to complete the switch.`,
      );
      return lines;
    case 'no-exclude': {
      if (outcome.localOnlyRequested) {
        lines.push(
          warning('Sharing mode: --local-only requested but no git repo found — option ignored'),
        );
        lines.push(
          `  Run ${info('git init')} (or open this folder via OK Desktop, which can scaffold a repo) and then ${info('ok config-sharing unshare')}.`,
        );
      } else if (outcome.reason === 'no-git') {
        return [];
      } else {
        lines.push(warning(`Sharing mode unavailable: ${outcome.reason}.`));
      }
      return lines;
    }
  }
}
