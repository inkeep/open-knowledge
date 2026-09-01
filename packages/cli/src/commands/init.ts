import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspect } from 'node:util';
import {
  type McpLauncherDeclineReason,
  OPENKNOWLEDGE_SKILLS_REPO,
} from '@inkeep/open-knowledge-core';
import { atomicWriteFileSync, withFileLockSync } from '@inkeep/open-knowledge-core/server';
import type {
  BundleId,
  InstallUserSkillOptions,
  InstallUserSkillResult,
} from '@inkeep/open-knowledge-server';
import {
  BUNDLE_SKILL_NAME,
  detectUserSkillHosts,
  ensureProjectGit,
  ensureProjectSkillGitignore,
  GitNotAvailableError,
  GitTooOldError,
  HomeProjectRootError,
  initContent,
  installUserSkill,
  MCP_SERVER_NAME,
  ONBOARDING_BUNDLE_IDS,
  ProjectGitInitError,
  reportSkillInstall,
  resolveSkillInstallReportSettings,
  USER_GLOBAL_BUNDLE_IDS,
  untrackTrackedProjectSkillProjection,
  writeBundleDecision,
  writeRootGitignoreForNewRepo,
} from '@inkeep/open-knowledge-server';
import checkbox from '@inquirer/checkbox';
import select from '@inquirer/select';
import { Command, Option } from 'commander';
import {
  applyEdits as applyJsoncEdits,
  getNodeValue,
  type Node as JsoncNode,
  type ParseError as JsoncParseError,
  modify as modifyJsonc,
  parseTree as parseJsoncTree,
} from 'jsonc-parser';
import { stringify as stringifyToml } from 'smol-toml';
import { isCollection, parseDocument, stringify as stringifyYaml } from 'yaml';
import { CONFIG_FILENAME, OK_DIR } from '../constants.ts';
import { formatPreviewBlock, type PreviewResult } from '../content/preview.ts';
import { buildPiExtensionSource, makePiManagedFileEntry } from '../integrations/pi-extension.ts';
import { isHomeDir, resolveProjectRoot } from '../integrations/resolve-project-root.ts';
import {
  assertProjectPathSafe,
  type ProjectSkillResult,
  writeProjectSkill,
} from '../integrations/write-project-skill.ts';
import { debugNativeLoadFailure } from '../native/load-native-config.ts';
import { resolveHarnessWritePaths } from '../native/symlink-resolve.ts';
import {
  getTomlConfigEngine,
  type TomlConfigEngine,
  type TomlUpsertResult,
} from '../native/toml-config-engine.ts';
import {
  addOkPathsToGitExclude,
  type ExcludeWriteResult,
  getOkArtifactPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
  type SharingMode,
  type TrackedRefusal,
} from '../sharing/git-exclude.ts';
import { accent, dim, error, info, success, warning } from '../ui/colors.ts';
import { isObject } from '../utils/is-object.ts';
import {
  ALL_EDITOR_IDS,
  EDITOR_LABELS,
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  type McpInstallOptions,
  resolveEditorTargets,
} from './editors.ts';
import { existingFileMode, isCrlfDominant } from './jsonc-surgical.ts';

const JSONC_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

const JSONC_INVALID_SYMBOL_CODE: number = 1;

function isBenignBomError(error: JsoncParseError, raw: string): boolean {
  return (
    error.error === JSONC_INVALID_SYMBOL_CODE && error.offset === 0 && raw.charCodeAt(0) === 0xfeff
  );
}

function parseJsoncObjectTree(raw: string): JsoncNode | null {
  const errors: JsoncParseError[] = [];
  const tree = parseJsoncTree(raw, errors, JSONC_PARSE_OPTIONS);
  if (errors.some((error) => !isBenignBomError(error, raw))) return null;
  if (!tree || tree.type !== 'object') return null;
  return tree;
}

function countTopLevelKey(objectNode: JsoncNode, key: string): number {
  let count = 0;
  for (const property of objectNode.children ?? []) {
    const keyNode = property.children?.[0];
    if (keyNode !== undefined && getNodeValue(keyNode) === key) count += 1;
  }
  return count;
}

function writeJsonConfig(path: string, config: Record<string, unknown>): void {
  atomicWriteFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function writeTomlConfig(path: string, config: Record<string, unknown>): void {
  const serialized = stringifyToml(config);
  atomicWriteFileSync(path, serialized.endsWith('\n') ? serialized : `${serialized}\n`);
}

function writeYamlConfig(path: string, config: Record<string, unknown>): void {
  const serialized = stringifyYaml(config);
  atomicWriteFileSync(path, serialized.endsWith('\n') ? serialized : `${serialized}\n`);
}

const JSON_CONFIG_MAX_BYTES = 10 * 1024 * 1024;

function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonValueEqual(value, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonValueEqual(a[key], b[key]));
  }
  return false;
}

const STANDARD_MANAGED_ENTRY_KEYS = ['command', 'args'] as const;
const OPENCODE_MANAGED_ENTRY_KEYS = ['type', 'command'] as const;

function managedEntryKeys(entry: Record<string, unknown>): readonly string[] {
  return entry.type === 'local' && Array.isArray(entry.command)
    ? OPENCODE_MANAGED_ENTRY_KEYS
    : STANDARD_MANAGED_ENTRY_KEYS;
}

function managedEntryFieldsEqual(
  existing: unknown,
  desired: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return isObject(existing) && keys.every((key) => jsonValueEqual(existing[key], desired[key]));
}

function detectJsonIndent(body: string): { insertSpaces: boolean; tabSize: number } {
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed.length === line.length) continue;
    if (line.charCodeAt(0) === 0x09) return { insertSpaces: false, tabSize: 1 };
    return { insertSpaces: true, tabSize: line.length - trimmed.length };
  }
  return { insertSpaces: true, tabSize: 2 };
}

type JsonUpsertOutcome =
  | { kind: 'written' | 'overwritten' }
  | { kind: 'declined'; reason: McpDeclineReason };

export function serverMapPath(
  topLevelKey: string,
  subKey: string | undefined,
  serverName: string,
): string[] {
  return subKey === undefined ? [topLevelKey, serverName] : [topLevelKey, subKey, serverName];
}

function freshServerMapObject(
  topLevelKey: string,
  subKey: string | undefined,
  serverName: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const inner = { [serverName]: entry };
  return { [topLevelKey]: subKey === undefined ? inner : { [subKey]: inner } };
}

function readServerContainer(
  root: Record<string, unknown>,
  topLevelKey: string,
  subKey: string | undefined,
): unknown {
  const top = root[topLevelKey];
  if (subKey === undefined) return top;
  return isObject(top) ? top[subKey] : undefined;
}

function upsertJsonMcpConfig(
  configPath: string,
  topLevelKey: string,
  serverName: string,
  entry: Record<string, unknown>,
  subKey?: string,
): JsonUpsertOutcome {
  if (!existsSync(configPath)) {
    writeJsonConfig(configPath, freshServerMapObject(topLevelKey, subKey, serverName, entry));
    return { kind: 'written' };
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    debugNativeLoadFailure('json config read failed', err);
    return { kind: 'declined', reason: 'unparseable' };
  }
  if (raw.trim() === '') {
    writeJsonConfig(configPath, freshServerMapObject(topLevelKey, subKey, serverName, entry));
    return { kind: 'written' };
  }
  if (Buffer.byteLength(raw, 'utf-8') > JSON_CONFIG_MAX_BYTES) {
    return { kind: 'declined', reason: 'oversize' };
  }
  const tree = parseJsoncObjectTree(raw);
  if (!tree) return { kind: 'declined', reason: 'unparseable' };
  if (countTopLevelKey(tree, topLevelKey) > 1) {
    return { kind: 'declined', reason: 'duplicate-container' };
  }

  const root = getNodeValue(tree) as Record<string, unknown>;
  const container = readServerContainer(root, topLevelKey, subKey);
  const existing = isObject(container) ? container[serverName] : undefined;
  const entryExists = existing !== undefined;
  const managedKeys = managedEntryKeys(entry);
  if (entryExists && managedEntryFieldsEqual(existing, entry, managedKeys)) {
    return { kind: 'overwritten' };
  }

  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const formattingOptions = { ...detectJsonIndent(body), eol };
  const entryPath = serverMapPath(topLevelKey, subKey, serverName);
  let editedBody = body;
  if (entryExists && isObject(existing)) {
    for (const key of managedKeys) {
      const edits = modifyJsonc(editedBody, [...entryPath, key], entry[key], {
        formattingOptions,
      });
      editedBody = applyJsoncEdits(editedBody, edits);
    }
  } else {
    const edits = modifyJsonc(editedBody, entryPath, entry, { formattingOptions });
    editedBody = applyJsoncEdits(editedBody, edits);
  }
  const newText = `${hasBom ? '\uFEFF' : ''}${editedBody}`;
  if (newText !== raw) {
    atomicWriteFileSync(configPath, newText, { mode: existingFileMode(configPath) });
  }
  return { kind: entryExists ? 'overwritten' : 'written' };
}

type TomlUpsertOutcome =
  | { kind: 'written' | 'overwritten' }
  | { kind: 'declined'; reason: McpDeclineReason };

function upsertTomlMcpConfig(
  engine: TomlConfigEngine,
  configPath: string,
  topLevelKey: string,
  serverName: string,
  entry: Record<string, unknown>,
): TomlUpsertOutcome {
  let raw = '';
  if (existsSync(configPath)) {
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
      debugNativeLoadFailure('toml config read failed', err);
      return { kind: 'declined', reason: 'unparseable' };
    }
  }
  const blank = raw.trim() === '';

  if (engine.backend === 'fallback') {
    if (!blank) return { kind: 'declined', reason: 'no-native-writer' };
    writeTomlConfig(configPath, { [topLevelKey]: { [serverName]: entry } });
    return { kind: 'written' };
  }

  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  const crlfDominant = isCrlfDominant(body);
  const wantTrailingNewline = blank || body.endsWith('\n');

  let result: TomlUpsertResult;
  try {
    result = engine.upsertEntry(body, serverName, entry);
  } catch (err) {
    debugNativeLoadFailure('upsertEntry failed', err);
    return { kind: 'declined', reason: 'unparseable' };
  }

  let text = result.text;
  if (wantTrailingNewline) {
    if (!text.endsWith('\n')) text = `${text}\n`;
  } else {
    text = text.replace(/\n+$/, '');
  }
  if (crlfDominant) {
    text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  }
  const newText = `${hasBom ? '\uFEFF' : ''}${text}`;

  if (newText !== raw) {
    atomicWriteFileSync(configPath, newText, { mode: existingFileMode(configPath) });
  }
  return { kind: result.existed ? 'overwritten' : 'written' };
}

type YamlUpsertOutcome =
  | { kind: 'written' | 'overwritten' }
  | { kind: 'declined'; reason: McpDeclineReason };

function upsertYamlMcpConfig(
  configPath: string,
  topLevelKey: string,
  serverName: string,
  entry: Record<string, unknown>,
): YamlUpsertOutcome {
  let raw = '';
  if (existsSync(configPath)) {
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
      debugNativeLoadFailure('yaml config read failed', err);
      return { kind: 'declined', reason: 'unparseable' };
    }
  }
  if (raw.trim() === '') {
    writeYamlConfig(configPath, { [topLevelKey]: { [serverName]: entry } });
    return { kind: 'written' };
  }
  if (Buffer.byteLength(raw, 'utf-8') > JSON_CONFIG_MAX_BYTES) {
    return { kind: 'declined', reason: 'oversize' };
  }

  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  const doc = parseDocument(body);
  if (doc.errors.length > 0) return { kind: 'declined', reason: 'unparseable' };

  const path = [topLevelKey, serverName];
  const entryExists = doc.hasIn(path);
  if (doc.hasIn([topLevelKey]) && !isCollection(doc.getIn([topLevelKey], true))) {
    doc.deleteIn([topLevelKey]);
  }
  const existingEntryNode = doc.getIn(path, true);
  if (entryExists && isCollection(existingEntryNode)) {
    for (const key of managedEntryKeys(entry)) {
      doc.setIn([...path, key], doc.createNode(entry[key]));
    }
  } else {
    doc.setIn(path, doc.createNode(entry));
  }

  let text = doc.toString();
  const crlfDominant = isCrlfDominant(body);
  const wantTrailingNewline = body.endsWith('\n');
  if (wantTrailingNewline) {
    if (!text.endsWith('\n')) text = `${text}\n`;
  } else {
    text = text.replace(/\n+$/, '');
  }
  if (crlfDominant) {
    text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  }
  const newText = `${hasBom ? '\uFEFF' : ''}${text}`;

  if (newText !== raw) {
    atomicWriteFileSync(configPath, newText, { mode: existingFileMode(configPath) });
  }
  return { kind: entryExists ? 'overwritten' : 'written' };
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
  return null;
}

export async function resolveMcpScope(opts: {
  scope?: McpScope;
  mcp?: boolean;
  isTTY?: boolean;
  promptFn?: () => Promise<McpScope | null>;
}): Promise<McpScope | null> {
  if (opts.mcp === false) return null;
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
    message: 'How do you want to handle OpenKnowledge config files (.ok/, .mcp.json)?',
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
  freshProject?: boolean;
  promptFn?: (defaultMode: 'shared' | 'local-only') => Promise<'shared' | 'local-only'>;
}): Promise<'shared' | 'local-only'> {
  if (opts.sharing !== undefined) return opts.sharing;
  const current = readSharingMode(opts.projectRoot);
  const seed: 'shared' | 'local-only' =
    current === 'local-only' || opts.freshProject === true ? 'local-only' : 'shared';
  const tty = opts.isTTY ?? process.stdout.isTTY;
  if (!tty) return seed;
  const prompt = opts.promptFn ?? promptSharingMode;
  return prompt(seed);
}

export interface EditorMcpResult {
  editorId: EditorId;
  label: string;
  action: 'written' | 'overwritten' | 'skipped-missing' | 'skipped-flag' | 'failed' | 'declined';
  configPath: string;
  serverName: string;
  error?: string;
  declineReason?: McpDeclineReason;
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
  skills?: string | boolean;
  scope?: McpScope;
  isTTY?: boolean;
  promptFn?: () => Promise<McpScope | null>;
  sharing?: 'shared' | 'local-only';
  sharingPromptFn?: (defaultMode: 'shared' | 'local-only') => Promise<'shared' | 'local-only'>;
  contentDir?: string;
}

export class ContentDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentDirError';
  }
}

export { HomeProjectRootError };

export function resolveInitSkillEnablement(skills: string | boolean | undefined): Set<BundleId> {
  if (skills === undefined || skills === true) return new Set<BundleId>(ONBOARDING_BUNDLE_IDS);
  if (skills === false) return new Set();
  const requested = skills
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(USER_GLOBAL_BUNDLE_IDS.filter((id) => requested.includes(id)));
}

export function resolveRequestedContentDir(
  input: string,
  projectRoot: string,
  cwd: string,
): string {
  const abs = resolve(cwd, input);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ContentDirError(`--content-dir path does not exist: ${abs}`);
    }
    throw new ContentDirError(
      `--content-dir path is not accessible (${code ?? 'unknown error'}): ${abs}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new ContentDirError(`--content-dir must be a directory: ${abs}`);
  }
  const canonRoot = safeRealpath(projectRoot);
  const canonAbs = safeRealpath(abs);
  const rel = relative(canonRoot, canonAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ContentDirError(
      `--content-dir must be inside the project root (${projectRoot}); got ${abs}`,
    );
  }
  return rel === '' ? '.' : rel;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

interface InitCommandResult {
  projectRoot: string;
  contentCreated: string[];
  contentUpdated: string[];
  contentSkipped: string[];
  editors: EditorMcpResult[];
  legacyProjectConfigs: ProjectConfigResult[];
  projectSkills: ProjectSkillResult[];
  skillInstall?: InstallUserSkillResult | 'declined';
  skillHosts?: readonly string[];
  preview?: PreviewResult;
  didGitInit: boolean;
  rootGitignoreCreated: boolean;
  gitRootPromoted: boolean;
  promotedFromDir?: string;
  contentDir?: string;
  contentDirRequested?: string;
  contentScaffoldFailed: boolean;
  mcpAction: 'written' | 'overwritten' | 'skipped-missing' | 'skipped-flag' | 'failed' | 'declined';
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
      action: 'added' | 'removed' | 'cleaned' | 'noop';
      appended: string[];
      alreadyPresent: string[];
      removed: string[];
    }
  | { kind: 'refused-tracked'; tracked: string[]; remediation: string }
  | {
      kind: 'no-exclude';
      reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
      localOnlyRequested: boolean;
    };

export const LAUNCH_CONFIG_NAME = 'open-knowledge-ui';

function isEditorTargetAvailable(target: EditorMcpTarget, cwd: string, home?: string): boolean {
  try {
    const probePath = target.detectPath?.(cwd, home) ?? dirname(target.configPath(cwd, home));
    return existsSync(probePath);
  } catch {
    return false;
  }
}

function writeWouldFabricateDetection(
  target: EditorMcpTarget,
  cwd: string,
  home?: string,
): boolean {
  try {
    const configDir = resolve(dirname(target.configPath(cwd, home)));
    const probePath = resolve(target.detectPath?.(cwd, home) ?? configDir);
    return probePath === configDir || configDir.startsWith(probePath + sep);
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

  const enforceAvailability =
    !installOptions.skipAvailabilityCheck ||
    target.offerOnlyWhenDetected === true ||
    writeWouldFabricateDetection(target, cwd, home);
  if (!configPathOverride && enforceAvailability && !isEditorTargetAvailable(target, cwd, home)) {
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

  if (target.format === 'file') {
    return writeManagedEditorFile(target, configPath, serverName, installOptions, {
      isProjectScope: configPathOverride !== undefined,
    });
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

  const captured: {
    action: 'written' | 'overwritten' | 'declined';
    declineReason?: McpDeclineReason;
  } = { action: 'written' };
  let lockErr: Error | undefined;
  try {
    withFileLockSync(
      `${configPath}.lock`,
      () => {
        const writePath = resolveHarnessWritePaths(configPath).writePath;
        mkdirSync(dirname(writePath), { recursive: true });
        if (target.format === 'toml') {
          const tomlOutcome = upsertTomlMcpConfig(
            getTomlConfigEngine(),
            writePath,
            target.topLevelKey,
            serverName,
            targetEntry,
          );
          captured.action = tomlOutcome.kind;
          if (tomlOutcome.kind === 'declined') captured.declineReason = tomlOutcome.reason;
          return;
        }
        if (target.format === 'yaml') {
          const yamlOutcome = upsertYamlMcpConfig(
            writePath,
            target.topLevelKey,
            serverName,
            targetEntry,
          );
          captured.action = yamlOutcome.kind;
          if (yamlOutcome.kind === 'declined') captured.declineReason = yamlOutcome.reason;
          return;
        }
        const outcome = upsertJsonMcpConfig(
          writePath,
          target.topLevelKey,
          serverName,
          targetEntry,
          target.serverMapSubKey,
        );
        captured.action = outcome.kind;
        if (outcome.kind === 'declined') captured.declineReason = outcome.reason;
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

  if (captured.action === 'declined') {
    return {
      editorId: target.id,
      label: target.label,
      action: 'declined',
      configPath,
      serverName,
      declineReason: captured.declineReason,
      ...(configPathOverride !== undefined ? { configScope: 'project' as const } : {}),
    };
  }

  return {
    editorId: target.id,
    label: target.label,
    action: captured.action,
    configPath,
    serverName,
    ...(configPathOverride !== undefined ? { configScope: 'project' as const } : {}),
  };
}

export const MANAGED_FILE_BUILDERS: Partial<
  Record<EditorId, (options?: McpInstallOptions) => string>
> = {
  pi: buildPiExtensionSource,
};

function writeManagedEditorFile(
  target: EditorMcpTarget,
  configPath: string,
  serverName: string,
  installOptions: McpInstallOptions,
  opts: { isProjectScope: boolean },
): EditorMcpResult {
  const scopeField = opts.isProjectScope ? { configScope: 'project' as const } : {};
  const fail = (err: unknown): EditorMcpResult => ({
    editorId: target.id,
    label: target.label,
    action: 'failed',
    configPath,
    serverName,
    error: err instanceof Error ? err.message : String(err),
    ...scopeField,
  });

  const buildFileContent = MANAGED_FILE_BUILDERS[target.id];
  if (!buildFileContent) {
    return fail(
      new Error(
        `No managed-file builder registered for editor "${target.id}" (format: 'file' targets need a MANAGED_FILE_BUILDERS entry).`,
      ),
    );
  }
  let desired: string;
  try {
    desired = buildFileContent(installOptions);
  } catch (err) {
    return fail(err);
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });
  } catch (err) {
    return fail(err);
  }

  const captured: { action: 'written' | 'overwritten' } = { action: 'written' };
  try {
    withFileLockSync(
      `${configPath}.lock`,
      () => {
        let existing: string | null = null;
        try {
          existing = readFileSync(configPath, 'utf-8');
        } catch {
          existing = null;
        }
        if (existing === desired) {
          captured.action = 'overwritten';
          return;
        }
        atomicWriteFileSync(
          configPath,
          desired,
          existing !== null ? { mode: existingFileMode(configPath) } : undefined,
        );
        captured.action = existing === null ? 'written' : 'overwritten';
      },
      {
        onWarn: (message, context) =>
          process.stderr.write(`[ok] ${message} ${JSON.stringify(context)}\n`),
      },
    );
  } catch (err) {
    return fail(err);
  }

  return {
    editorId: target.id,
    label: target.label,
    action: captured.action,
    configPath,
    serverName,
    ...scopeField,
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
  const targets = resolveEditorTargets(opts.editors).filter((t) => t.scope === 'global');
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

export type McpDeclineReason =
  | 'unparseable'
  | 'duplicate-container'
  | 'oversize'
  | 'no-native-writer'
  | McpLauncherDeclineReason;

export type McpEntryClassification =
  | { kind: 'absent' }
  | { kind: 'no-entry' }
  | { kind: 'present'; entry: Record<string, unknown> }
  | { kind: 'decline'; reason: McpDeclineReason };

function classifyContainer(
  config: Record<string, unknown>,
  topLevelKey: string,
  serverName: string,
  subKey?: string,
): McpEntryClassification {
  const servers = readServerContainer(config, topLevelKey, subKey);
  if (!isObject(servers)) return { kind: 'no-entry' };
  const existing = servers[serverName];
  if (!isObject(existing)) return { kind: 'no-entry' };
  return { kind: 'present', entry: existing };
}

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

  try {
    if (statSync(configPath).size > JSON_CONFIG_MAX_BYTES) {
      return { kind: 'decline', reason: 'oversize' };
    }
  } catch {
    return { kind: 'decline', reason: 'unparseable' };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return { kind: 'decline', reason: 'unparseable' };
  }
  if (raw.trim() === '') {
    return { kind: 'absent' };
  }

  if (target.format === 'file') {
    return { kind: 'present', entry: makePiManagedFileEntry(raw) };
  }

  const serverName = target.serverName(cwd);

  if (target.format === 'toml') {
    let config: Record<string, unknown>;
    try {
      config = getTomlConfigEngine().parseToObject(raw);
    } catch {
      return { kind: 'decline', reason: 'unparseable' };
    }
    return classifyContainer(config, target.topLevelKey, serverName, target.serverMapSubKey);
  }

  if (target.format === 'yaml') {
    const doc = parseDocument(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (doc.errors.length > 0) return { kind: 'decline', reason: 'unparseable' };
    const config = (doc.toJS() ?? {}) as Record<string, unknown>;
    return classifyContainer(config, target.topLevelKey, serverName, target.serverMapSubKey);
  }

  const tree = parseJsoncObjectTree(raw);
  if (!tree) return { kind: 'decline', reason: 'unparseable' };
  if (countTopLevelKey(tree, target.topLevelKey) > 1) {
    return { kind: 'decline', reason: 'duplicate-container' };
  }
  return classifyContainer(
    getNodeValue(tree) as Record<string, unknown>,
    target.topLevelKey,
    serverName,
    target.serverMapSubKey,
  );
}

export async function runInit(options: InitCommandOptions = {}): Promise<InitCommandResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const resolution = resolveProjectRoot(cwd, { homeDir: options.home });
  const projectRoot = resolution.projectRoot;
  if (isHomeDir(projectRoot, options.home ?? homedir())) {
    throw new HomeProjectRootError(projectRoot);
  }
  const willScaffold = !existsSync(join(projectRoot, OK_DIR));
  const promotedFromDir = resolution.gitRootPromoted ? relative(projectRoot, cwd) : undefined;
  const contentDirScope =
    options.contentDir !== undefined
      ? resolveRequestedContentDir(options.contentDir, projectRoot, cwd)
      : resolution.defaultContentDir;
  if (resolution.ancestorPromoted) {
    console.log(`[ok] Opened existing project at ${projectRoot}`);
  } else if (resolution.gitRootPromoted && willScaffold && contentDirScope === '.') {
    process.stderr.write(
      `${warning(`[ok] Content scope promoted to the git repo root: ${projectRoot}`)}\n` +
        `      Ran in ${promotedFromDir}/, but .ok/ lives at the git root (one .ok/ per git repo),\n` +
        `      so the whole repo is now the content scope. To narrow it, re-run with\n` +
        `      \`ok init --content-dir .\`, or set content.dir: ${promotedFromDir} in ${OK_DIR}/config.yml.\n`,
    );
  }

  const installOptions: McpInstallOptions = {
    mode: options.devMcp ? 'dev' : 'published',
  };

  const gitResult = await ensureProjectGit(projectRoot);

  let contentResult: ReturnType<typeof initContent>;
  try {
    contentResult = initContent(projectRoot, { contentDir: contentDirScope });
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
      gitRootPromoted: resolution.gitRootPromoted,
      promotedFromDir,
      contentDirRequested: options.contentDir,
      contentScaffoldFailed: true,
      mcpAction: 'failed',
      mcpPath: fallbackPath,
      mcpError: `Content scaffolding failed: ${err instanceof Error ? err.message : String(err)}`,
      sharing: { kind: 'no-exclude', reason: 'no-git', localOnlyRequested: false },
    };
  }

  const configCreated = contentResult.created.includes(CONFIG_FILENAME);

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

  try {
    ensureProjectSkillGitignore(projectRoot);
  } catch (err) {
    console.warn(
      `[ok] Skipping project-skill .gitignore entry at ${projectRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const untrackResult = await untrackTrackedProjectSkillProjection(projectRoot);
  if (untrackResult.kind === 'untracked') {
    console.warn(
      `[ok] Untracked the OpenKnowledge project skill (${untrackResult.dirs.join(', ')}) — it is now local-only. Teammates will see this as a deletion on their next pull.`,
    );
  }

  const scope = await resolveMcpScope({
    scope: options.scope,
    mcp: options.mcp,
    isTTY: options.isTTY,
    promptFn: options.promptFn,
  });

  const userEditorIds = options.editors ?? detectInstalledEditors(projectRoot, options.home);
  const projectEditorIds = options.editors ?? userEditorIds;
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

    if (writesUser(scope) && userTargets.includes(target) && target.scope === 'global') {
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
    projectSkillResults.push(writeProjectSkill(target, projectRoot, { home: options.home }));
  }

  const installedForEditors = projectSkillResults
    .filter((r) => r.action === 'written' || r.action === 'overwritten')
    .map((r) => r.editorId);
  if (installedForEditors.length > 0) {
    const reportHome = options.home ?? homedir();
    void reportSkillInstall(
      {
        source: OPENKNOWLEDGE_SKILLS_REPO,
        skills: [BUNDLE_SKILL_NAME.project],
        agents: installedForEditors,
        scope: projectRoot,
      },
      { home: reportHome, enabled: resolveSkillInstallReportSettings(reportHome).enabled },
    );
  }

  const projectScopeUnsupportedLabels =
    !skipMcp && scope !== null && writesProject(scope)
      ? projectTargets
          .filter((t) => !t.projectConfigPath && !t.projectSkillPath)
          .map((t) => t.label)
      : undefined;

  const legacyProjectConfigs = skipMcp
    ? []
    : availableTargets
        .map((target) => collectProjectConfig(target, projectRoot))
        .filter((result): result is ProjectConfigResult => result !== undefined)
        .filter((result) => !writtenProjectPaths.has(result.path));

  const installSkill = options.installUserSkill ?? installUserSkill;
  const skillHome = options.home ?? homedir();
  const enabledBundles = resolveInitSkillEnablement(options.skills);
  let anyEnabled = false;
  let anyInstalled = false;
  let anyFailed = false;
  let anySkipped = false;
  let anyNoHosts = false;
  for (const id of USER_GLOBAL_BUNDLE_IDS) {
    if (!enabledBundles.has(id)) continue;
    await writeBundleDecision(skillHome, BUNDLE_SKILL_NAME[id], true).catch(() => {});
    anyEnabled = true;
    const result = await installSkill({ home: options.home, bundleId: id, force: true });
    if (result === 'installed') anyInstalled = true;
    else if (result === 'failed') anyFailed = true;
    else if (result === 'no-hosts') anyNoHosts = true;
    else anySkipped = true;
  }
  const skillInstall: InstallUserSkillResult | 'declined' = anyFailed
    ? 'failed'
    : anyInstalled
      ? 'installed'
      : anyEnabled && anySkipped
        ? 'skip-current'
        : anyEnabled && anyNoHosts
          ? 'no-hosts'
          : 'declined';
  const skillHosts = anyInstalled ? detectUserSkillHosts(skillHome).map((h) => h.editorId) : [];

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
    freshProject: willScaffold,
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
    skillInstall,
    skillHosts,
    didGitInit: gitResult.didInit,
    rootGitignoreCreated,
    gitRootPromoted: resolution.gitRootPromoted,
    promotedFromDir,
    contentDir: configCreated ? contentDirScope : undefined,
    contentDirRequested: options.contentDir,
    contentScaffoldFailed: false,
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
      action: result.appended.length > 0 ? 'added' : result.removed.length > 0 ? 'cleaned' : 'noop',
      appended: result.appended,
      alreadyPresent: result.alreadyPresent,
      removed: result.removed,
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

function declineReasonLabel(reason: McpDeclineReason | undefined): string {
  switch (reason) {
    case 'oversize':
      return 'config too large to edit safely';
    case 'duplicate-container':
      return 'duplicate server block';
    case 'no-native-writer':
      return 'no format-preserving writer available';
    default:
      return 'config not readable';
  }
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
        case 'declined':
          lines.push(
            `  ${labelWithScope}${pad}${displayPath}  left unchanged (${declineReasonLabel(editor.declineReason)})`,
          );
          break;
        case 'skipped-flag':
          break;
        default: {
          const _exhaustive: never = editor.action;
          void _exhaustive;
        }
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
        case 'skipped-prerequisite':
          lines.push(`  ${label}${pad}OpenKnowledge MCP is not configured; skipped`);
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
      case 'installed': {
        const hostLabels = (result.skillHosts ?? []).map(
          (id) => EDITOR_LABELS[id as EditorId] ?? id,
        );
        const target = hostLabels.length > 0 ? hostLabels.join(', ') : 'the shared ~/.agents store';
        lines.push(`  open-knowledge  ${success(`installed for ${target}`)}`);
        lines.push(
          `  ${dim('Counted on skills.sh (skill name + source repo, once per machine).')}`,
        );
        lines.push(`  ${dim('Opt out: DO_NOT_TRACK=1, or Settings → User → Preferences.')}`);
        break;
      }
      case 'skip-current':
        lines.push(`  open-knowledge  ${success('already installed at current version')}`);
        break;
      case 'declined':
        lines.push(`  open-knowledge  ${dim('skipped for this run (--no-skills)')}`);
        lines.push(
          `  ${dim('Nothing was installed or removed. Any built-in skills already on this')}`,
        );
        lines.push(`  ${dim('machine are untouched. Run init without the flag to install them:')}`);
        lines.push(`  ${dim('  ok init')}`);
        break;
      case 'no-hosts':
        lines.push(
          `  open-knowledge  ${dim('skipped — no supported agent host detected in your home directory')}`,
        );
        break;
      case 'failed':
        lines.push(
          `  ${warning('open-knowledge  install failed — MCP still configured; retry with:')}`,
        );
        lines.push(`  ${warning('  ok repair-skills')}`);
        break;
    }
  }

  if (
    result.contentDirRequested !== undefined &&
    result.contentDir === undefined &&
    !result.contentScaffoldFailed
  ) {
    lines.push('');
    lines.push(
      warning(
        `⚠ --content-dir ${result.contentDirRequested} ignored — ${OK_DIR}/config.yml already exists`,
      ),
    );
    lines.push(`  Edit ${OK_DIR}/config.yml → content.dir directly to change the content scope.`);
  } else if (result.contentDir !== undefined && result.contentDir !== '.') {
    lines.push('');
    lines.push(`Content scope set to ${result.contentDir}/ (content.dir in ${OK_DIR}/config.yml).`);
  } else if (
    result.gitRootPromoted &&
    result.contentDir === '.' &&
    result.contentDirRequested === undefined
  ) {
    lines.push('');
    lines.push(warning('⚠ Content scope promoted to the git repo root'));
    lines.push(
      `  .ok/ was initialized at ${cwd} because it contains a .git folder (one .ok/ per git repo),`,
    );
    lines.push(
      `  not the sub-folder you ran \`ok init\` in${result.promotedFromDir ? ` (${result.promotedFromDir})` : ''}. The whole repo is now the content scope.`,
    );
    if (result.promotedFromDir) {
      lines.push(
        `  To scope to just that sub-folder, re-run \`ok init --content-dir .\` from there, or set`,
      );
      lines.push(`  content.dir: ${result.promotedFromDir} in ${OK_DIR}/config.yml.`);
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
    lines.push(`     - ${info('ok seed --list-packs')}   — browse the starter packs`);
    lines.push(`     - ${info('ok seed')}                — scaffold an empty repo`);
    lines.push('  4. Ask your agent to capture a source, research a topic, or build a wiki —');
    lines.push('     the procedures ship as skills alongside the MCP tools.');
  }

  return lines.join('\n');
}

export interface InitJsonSummary {
  projectRoot: string;
  gitRootPromoted: boolean;
  promotedFromDir: string | null;
  contentDir: string;
  contentDirRequested: string | null;
  contentDirApplied: boolean;
  contentFileCount: number | null;
  previewError: string | null;
  didGitInit: boolean;
  mcpAction: InitCommandResult['mcpAction'];
  editors: Array<{
    editorId: EditorId;
    label: string;
    action: EditorMcpResult['action'];
    configPath: string;
    scope: 'project' | 'user';
  }>;
}

export function buildInitJsonSummary(
  result: InitCommandResult,
  opts: { contentDir: string; contentFileCount: number | null },
): InitJsonSummary {
  return {
    projectRoot: result.projectRoot,
    gitRootPromoted: result.gitRootPromoted,
    promotedFromDir: result.promotedFromDir ?? null,
    contentDir: opts.contentDir,
    contentDirRequested: result.contentDirRequested ?? null,
    contentDirApplied: result.contentDir !== undefined,
    contentFileCount: opts.contentFileCount,
    previewError: result.previewWarning ?? null,
    didGitInit: result.didGitInit,
    mcpAction: result.mcpAction,
    editors: result.editors.map((e) => ({
      editorId: e.editorId,
      label: e.label,
      action: e.action,
      configPath: e.configPath,
      scope: e.configScope === 'project' ? 'project' : 'user',
    })),
  };
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

function redirectStdoutConsoleToStderr(): () => void {
  const orig = { log: console.log, info: console.info, debug: console.debug };
  const toErr = (...args: unknown[]): void => {
    process.stderr.write(
      `${args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ')}\n`,
    );
  };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  return () => {
    console.log = orig.log;
    console.info = orig.info;
    console.debug = orig.debug;
  };
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
    .option(
      '--content-dir <dir>',
      `Limit content to <dir> instead of the whole project. <dir> is interpreted relative to your current directory (e.g. "." = the folder you run the command in), then saved to ${OK_DIR}/config.yml as content.dir.`,
    )
    .option('--json', 'Emit a structured JSON summary to stdout (diagnostics stay on stderr)')
    .option(
      '--skills <ids>',
      'Install only the named user-global skill bundles (comma list: discovery,write-skill)',
    )
    .option('--no-skills', 'Do not install any user-global skill bundles')
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
        contentDir?: string;
        json?: boolean;
        skills?: string | boolean;
      }) => {
        const cwd = process.cwd();

        const sharing: 'shared' | 'local-only' | undefined = opts.shared
          ? 'shared'
          : opts.localOnly
            ? 'local-only'
            : undefined;
        const restoreConsole = opts.json ? redirectStdoutConsoleToStderr() : null;
        try {
          let result: InitCommandResult;
          try {
            result = await runInit({
              cwd,
              mcp: opts.mcp,
              devMcp: opts.devMcp,
              scope: opts.scope,
              sharing,
              contentDir: opts.contentDir,
              skills: opts.skills,
            });
          } catch (err) {
            if (err instanceof ContentDirError || err instanceof HomeProjectRootError) {
              process.stderr.write(`${err.message}\n`);
              process.exitCode = 64;
              return;
            }
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

          let effectiveContentDir = result.contentDir ?? '.';
          let contentFileCount: number | null = null;
          const { loadConfig } = await import('../config/loader.ts');
          const { resolveContentDir } = await import('@inkeep/open-knowledge-server');
          let config: Awaited<ReturnType<typeof loadConfig>>['config'] | undefined;
          try {
            config = loadConfig(result.projectRoot).config;
            effectiveContentDir = config.content.dir;
          } catch (e) {
            result.previewWarning = e instanceof Error ? e.message : String(e);
          }
          if (config) {
            try {
              const { previewContent } = await import('../content/preview.ts');
              const contentDir = resolveContentDir(config, result.projectRoot);
              result.preview = previewContent({
                projectDir: result.projectRoot,
                contentDir,
              });
              contentFileCount = result.preview.totalCount;
            } catch (e) {
              result.previewWarning = e instanceof Error ? e.message : String(e);
            }
          }

          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(
                buildInitJsonSummary(result, { contentDir: effectiveContentDir, contentFileCount }),
                null,
                2,
              )}\n`,
            );
          } else {
            process.stdout.write(`${formatInitResult(result, result.projectRoot)}\n`);
          }

          if (result.editors.some((e) => e.action === 'failed') || result.mcpAction === 'failed') {
            process.exitCode = 1;
          }
        } finally {
          restoreConsole?.();
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
          if (outcome.removed.length > 0) {
            lines.push(
              `    cleared ${outcome.removed.length} stale entry(s) left by an older version: ${outcome.removed.join(', ')}.`,
            );
          }
        } else if (outcome.action === 'cleaned') {
          lines.push(
            `  ${success('local-only')} — already excluded; cleared ${outcome.removed.length} stale entry(s) left by an older version: ${outcome.removed.join(', ')}.`,
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
