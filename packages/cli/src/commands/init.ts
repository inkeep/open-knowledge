/**
 * `open-knowledge init` — one-shot terminal setup command.
 *
 * Does two things:
 *   1. Scaffolds `.ok/` in the current directory via initContent()
 *      (same logic the MCP server's init flow used to call — now factored out).
 *   2. Writes OpenKnowledge MCP server entries into every detected editor's
 *      config file. The CLI owns the `open-knowledge` / `open-knowledge-ui`
 *      entries and rewrites them to the current defaults on every run.
 *
 * Supports Claude, Claude Desktop, Cursor, Codex, and OpenCode.
 * Missing editor config roots are skipped so init does not create new user-home
 * directories for tools that are not installed.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { inspect } from 'node:util';
import { atomicWriteFileSync, withFileLockSync } from '@inkeep/open-knowledge-core/server';
import type {
  BundleId,
  InstallUserSkillOptions,
  InstallUserSkillResult,
} from '@inkeep/open-knowledge-server';
import {
  BUNDLE_SKILL_NAME,
  ensureProjectGit,
  GitNotAvailableError,
  GitTooOldError,
  initContent,
  installUserSkill,
  MCP_SERVER_NAME,
  ProjectGitInitError,
  USER_GLOBAL_BUNDLE_IDS,
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
import { CONFIG_FILENAME, OK_DIR } from '../constants.ts';
import { formatPreviewBlock, type PreviewResult } from '../content/preview.ts';
import { resolveProjectRoot } from '../integrations/resolve-project-root.ts';
import { removeUserGlobalSkillBundle } from '../integrations/skill-teardown.ts';
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
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  type McpInstallOptions,
  resolveDevCliDistPath,
  resolveEditorTargets,
} from './editors.ts';
import { existingFileMode, isCrlfDominant } from './jsonc-surgical.ts';
import { LAUNCH_JSON_PORT } from './ui.ts';

// ---------------------------------------------------------------------------
// Config I/O — generic across all editors
// ---------------------------------------------------------------------------

// Harness JSON configs are routinely hand-edited JSONC — `//` and block
// comments, trailing commas — and `JSON.parse` rejecting them is what let a
// valid config be mis-flagged corrupt. Parse with a tolerant scanner so the
// real content, not the strictness gap, decides the outcome.
const JSONC_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

// jsonc-parser reports a leading UTF-8 BOM as a lone InvalidSymbol at offset 0
// while still parsing the rest of the document. The code is inlined from
// `ParseErrorCode.InvalidSymbol`, a `const enum` that verbatimModuleSyntax
// cannot import as a runtime value.
const JSONC_INVALID_SYMBOL_CODE: number = 1;

/**
 * True for the single spurious error a leading UTF-8 BOM produces, so a
 * BOM-prefixed but otherwise valid config is read by its content rather than
 * mistaken for malformed.
 */
function isBenignBomError(error: JsoncParseError, raw: string): boolean {
  return (
    error.error === JSONC_INVALID_SYMBOL_CODE && error.offset === 0 && raw.charCodeAt(0) === 0xfeff
  );
}

/**
 * Parse JSONC text into its node tree, returning it only when the document is a
 * usable object root with no real syntax error (a leading BOM aside). Returns
 * null otherwise so callers map an unreadable config to a non-destructive
 * decline rather than a fresh write. The node tree (not just the value) lets the
 * classifier see a duplicate container key that the value parse would collapse.
 */
function parseJsoncObjectTree(raw: string): JsoncNode | null {
  const errors: JsoncParseError[] = [];
  const tree = parseJsoncTree(raw, errors, JSONC_PARSE_OPTIONS);
  if (errors.some((error) => !isBenignBomError(error, raw))) return null;
  if (!tree || tree.type !== 'object') return null;
  return tree;
}

/**
 * Count how many top-level properties carry the given key. jsonc-parser's value
 * parse silently keeps only the last of a duplicated key, so the node tree is
 * the only place a duplicate container is observable.
 */
function countTopLevelKey(objectNode: JsoncNode, key: string): number {
  let count = 0;
  for (const property of objectNode.children ?? []) {
    const keyNode = property.children?.[0];
    if (keyNode !== undefined && getNodeValue(keyNode) === key) count += 1;
  }
  return count;
}

/**
 * Write the config to disk as pretty-printed JSON with a trailing newline.
 * Atomic from the POV of external readers (Claude Desktop, Cursor, Codex)
 * via the shared `atomicWriteFileSync` in `@inkeep/open-knowledge-core/
 * server` — `rename(2)` is atomic on the same filesystem. The
 * `withFileLockSync` in `writeEditorMcpConfig` serializes OK writers
 * across processes so only one rename lands per logical update. Parent
 * directory is the caller's responsibility (matching the async sibling's
 * contract); `writeEditorMcpConfig` mkdirs before acquiring the lock.
 */
function writeJsonConfig(path: string, config: Record<string, unknown>): void {
  atomicWriteFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Write the config to disk as TOML with a trailing newline. Same
 * atomic-write + caller-owns-mkdir contract as `writeJsonConfig`.
 */
function writeTomlConfig(path: string, config: Record<string, unknown>): void {
  const serialized = stringifyToml(config);
  atomicWriteFileSync(path, serialized.endsWith('\n') ? serialized : `${serialized}\n`);
}

// ---------------------------------------------------------------------------
// Surgical JSON/JSONC upsert — touch only OK's own entry
// ---------------------------------------------------------------------------

/**
 * Largest JSON config we will rewrite in place. `~/.claude.json` stores
 * conversation history and can reach tens of megabytes; parsing and re-emitting
 * a file that large on every launch is a real latency cost for no benefit, so
 * above this bound OK declines instead of rewriting. Normal harness configs —
 * even chunky ones — sit far below it; only history-bloated pathological files
 * cross it.
 */
const JSON_CONFIG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Order-insensitive structural equality for parsed-JSON values. Used to detect
 * that OK's entry already matches the target so an unchanged config is skipped
 * rather than rewritten (key order in the on-disk entry is irrelevant to that
 * decision; array order is significant and preserved).
 */
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

/**
 * Detect the indentation a JSON/JSONC file already uses so a surgically-inserted
 * entry matches its convention. jsonc-parser's `modify` formats only the
 * inserted region from the passed `formattingOptions` and does NOT auto-detect;
 * worse, a mismatched unit makes it reflow the neighbouring sibling it rewrites
 * (a tab-indented file edited with 2-space options has its adjacent server
 * retyped from tabs to spaces), so passing the file's own unit is what keeps the
 * write only-additive. Heuristic: the first indented content line is one level.
 */
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

/**
 * Add or update only OK's own `[topLevelKey][serverName]` entry in a JSON
 * config, preserving every other token — comments, formatting, key order, and a
 * leading BOM — by editing the source text via jsonc-parser rather than
 * re-serializing the whole document.
 *
 * Guest-ownership disposition for a present file OK cannot safely edit: a parse
 * failure, a duplicate container key (an ambiguous edit target), or a file past
 * the size bound all DECLINE — the file is left byte-unchanged. Absent or blank
 * files have nothing to preserve and are created fresh.
 */
/**
 * A server entry lives at `[topLevelKey, serverName]` for most editors, or one
 * level deeper at `[topLevelKey, subKey, serverName]` for editors that nest the
 * server map (OpenClaw: `mcp.servers.<name>`). These helpers centralize the
 * flat-vs-nested branch so the JSON upsert and classify paths stay in lock-step;
 * with `subKey === undefined` every result is identical to the flat form the
 * other editors have always used.
 */
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
    // An I/O failure here (EACCES on a root-owned config, EROFS) is a distinct
    // cause from a malformed file, but collapses to the same decline; trace it
    // under OK_DEBUG_NATIVE so the read failure isn't fully invisible.
    debugNativeLoadFailure('json config read failed', err);
    return { kind: 'declined', reason: 'unparseable' };
  }
  if (raw.trim() === '') {
    writeJsonConfig(configPath, freshServerMapObject(topLevelKey, subKey, serverName, entry));
    return { kind: 'written' };
  }
  // Gate on raw size before the parse + modify so a multi-megabyte file costs
  // only a read, not a full structural rewrite, on every launch.
  if (Buffer.byteLength(raw, 'utf-8') > JSON_CONFIG_MAX_BYTES) {
    return { kind: 'declined', reason: 'oversize' };
  }
  const tree = parseJsoncObjectTree(raw);
  if (!tree) return { kind: 'declined', reason: 'unparseable' };
  // A duplicate container key collapses to the last block on a value parse,
  // hiding which one holds our entry — refuse rather than edit one arbitrarily.
  if (countTopLevelKey(tree, topLevelKey) > 1) {
    return { kind: 'declined', reason: 'duplicate-container' };
  }

  const root = getNodeValue(tree) as Record<string, unknown>;
  const container = readServerContainer(root, topLevelKey, subKey);
  const existing = isObject(container) ? container[serverName] : undefined;
  const entryExists = existing !== undefined;
  if (entryExists && jsonValueEqual(existing, entry)) {
    // Already present and current: skip the write so the file never churns on an
    // idempotent re-run.
    return { kind: 'overwritten' };
  }

  // jsonc-parser surfaces a leading BOM as an offset-0 anomaly; strip it for the
  // edit so node offsets stay clean, then re-apply so the byte is preserved.
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const edits = modifyJsonc(body, serverMapPath(topLevelKey, subKey, serverName), entry, {
    formattingOptions: { ...detectJsonIndent(body), eol },
  });
  const newText = `${hasBom ? '\uFEFF' : ''}${applyJsoncEdits(body, edits)}`;
  if (newText !== raw) {
    atomicWriteFileSync(configPath, newText, { mode: existingFileMode(configPath) });
  }
  return { kind: entryExists ? 'overwritten' : 'written' };
}

// ---------------------------------------------------------------------------
// Format-preserving TOML upsert — touch only OK's own entry
// ---------------------------------------------------------------------------

type TomlUpsertOutcome =
  | { kind: 'written' | 'overwritten' }
  | { kind: 'declined'; reason: McpDeclineReason };

/**
 * Add or update only OK's own `[mcp_servers.<serverName>]` entry in a Codex TOML
 * config, preserving every other token — comments, formatting, value types — and
 * the file's byte-level encoding (a leading BOM, CRLF line endings, trailing-
 * newline state) that toml_edit normalizes away on serialize.
 *
 * Only the native engine has a format-preserving document model. On the JS
 * fallback a present, non-blank config could be rewritten only by the lossy
 * whole-file serializer, which strips comments and reflows formatting, so OK
 * declines rather than degrade a config it doesn't own — an absent/blank file
 * (nothing to preserve) is the one safe case the fallback creates into.
 */
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
      // Same read-failure-vs-malformed conflation as the JSON path; trace under
      // OK_DEBUG_NATIVE so an EACCES/EROFS on the Codex config isn't invisible.
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
  // Capture the file's DOMINANT EOL, not the mere presence of a CRLF: a
  // mostly-LF file with one stray CRLF stays LF. toml_edit normalizes structural
  // CRLF to LF on serialize but keeps the bytes inside multi-line string VALUES
  // verbatim, so a sibling `"""\u2026"""` can carry either EOL.
  const crlfDominant = isCrlfDominant(body);
  // A pre-existing non-blank file dictates the trailing-newline convention; a
  // fresh/blank file gets the conventional single trailing newline.
  const wantTrailingNewline = blank || body.endsWith('\n');

  let result: TomlUpsertResult;
  try {
    result = engine.upsertEntry(body, serverName, entry);
  } catch (err) {
    // The native toml_edit engine threw on a present file (a parse error, or a
    // binding that loaded but can't execute). Surface it under OK_DEBUG_NATIVE
    // before declining so the swallowed cause is recoverable.
    debugNativeLoadFailure('upsertEntry failed', err);
    return { kind: 'declined', reason: 'unparseable' };
  }

  // toml_edit strips a leading BOM, normalizes structural CRLF to LF, and always
  // emits a trailing newline; restore the source file's encoding so the only
  // byte-level change is OK's own entry.
  let text = result.text;
  if (wantTrailingNewline) {
    if (!text.endsWith('\n')) text = `${text}\n`;
  } else {
    text = text.replace(/\n+$/, '');
  }
  if (crlfDominant) {
    // Collapse any CRLF toml_edit kept verbatim inside a sibling multi-line
    // string back to LF first, so converting every newline to CRLF can never
    // double a CR that was already there (`\r\n` -> `\r\r\n`).
    text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  }
  const newText = `${hasBom ? '\uFEFF' : ''}${text}`;

  if (newText !== raw) {
    atomicWriteFileSync(configPath, newText, { mode: existingFileMode(configPath) });
  }
  return { kind: result.existed ? 'overwritten' : 'written' };
}

// ---------------------------------------------------------------------------
// Scope types + helpers
// ---------------------------------------------------------------------------

type McpScope = 'user' | 'project' | 'both';

const writesUser = (s: McpScope) => s !== 'project';
const writesProject = (s: McpScope) => s !== 'user';

/**
 * Prompt the user interactively to select MCP scope via a checkbox multi-select.
 * Both 'user' and 'project' are pre-selected (default answer: 'both').
 * Returns null when the user clears both checkboxes (equivalent to --no-mcp).
 */
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

/**
 * Prompt the user to pick between `shared` (commit OK config alongside
 * content) and `local-only` (kept out of git via .git/info/exclude). The
 * `defaultMode` argument seeds the pre-selected answer — fresh repos use
 * `shared`; previously-local-only repos preserve `local-only` so an
 * idempotent `ok init` re-run doesn't silently flip the user's prior
 * choice.
 */
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

/**
 * Resolve the effective sharing-mode posture.
 *
 * Order of precedence:
 *   1. explicit `sharing` flag — terminal answer; no prompt.
 *   2. TTY: prompt with `readSharingMode(projectRoot)` as the pre-selected
 *      default. The prompt's response overrides everything else.
 *   3. Non-TTY: use `readSharingMode(projectRoot)` silently. For a fresh
 *      repo this is `shared` (today's behavior preserved); for a previously
 *      local-only repo this is `local-only` (preserves prior posture).
 *
 * The function is exported so unit tests can exercise the precedence
 * without round-tripping through `runInit`.
 */
export async function resolveSharingMode(opts: {
  sharing?: 'shared' | 'local-only';
  projectRoot: string;
  isTTY?: boolean;
  promptFn?: (defaultMode: 'shared' | 'local-only') => Promise<'shared' | 'local-only'>;
}): Promise<'shared' | 'local-only'> {
  if (opts.sharing !== undefined) return opts.sharing;
  const current = readSharingMode(opts.projectRoot);
  // `no-git` collapses to `shared` for the default — there's nothing to
  // toggle yet, and the default presented to a TTY user is the safer
  // share-with-team option.
  const seed: 'shared' | 'local-only' = current === 'local-only' ? 'local-only' : 'shared';
  const tty = opts.isTTY ?? process.stdout.isTTY;
  if (!tty) return seed;
  const prompt = opts.promptFn ?? promptSharingMode;
  return prompt(seed);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorMcpResult {
  editorId: EditorId;
  label: string;
  action: 'written' | 'overwritten' | 'skipped-missing' | 'skipped-flag' | 'failed' | 'declined';
  configPath: string;
  serverName: string;
  error?: string;
  /**
   * Set on a 'declined' action: the bounded reason OK left a present config
   * byte-unchanged rather than register into it (unparseable, oversized, or a
   * duplicate container key). Engineer-facing; no config contents.
   */
  declineReason?: McpDeclineReason;
  /** Set to 'project' when the result came from a project-scope write. */
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
  /** Register a local dev MCP entry using `node` + this repo's built dist CLI. */
  devMcp?: boolean;
  editors?: EditorId[];
  /** Override home directory (test-only, for global editor config paths). */
  home?: string;
  /**
   * Inject a pre-fabricated `installUserSkill` implementation (test hook).
   * Production callers omit this and hit the real `installUserSkill` from
   * `@inkeep/open-knowledge-server`.
   */
  installUserSkill?: (opts?: InstallUserSkillOptions) => Promise<InstallUserSkillResult>;
  /**
   * User-global skill opt-in. `undefined` (default) enables every bundle;
   * `false` (`--no-skills`) declines all; a comma list (`--skills discovery`)
   * enables only the named bundles. The decision is recorded so the desktop /
   * CLI reclaim gates never re-install a declined bundle.
   */
  skills?: string | boolean;
  /** MCP scope: user-level only, project-level only, or both. */
  scope?: McpScope;
  /** Test hook: override isTTY detection for the interactive scope prompt. */
  isTTY?: boolean;
  /** Test hook: inject a custom promptFn for the interactive scope prompt. */
  promptFn?: () => Promise<McpScope | null>;
  /**
   * Sharing-mode posture. Undefined means
   * "no explicit flag" — the prompt fires when stdin is a TTY; otherwise
   * the effective default is `readSharingMode(projectRoot)` (preserves
   * a prior `local-only` choice on an idempotent re-run; fresh repos
   * collapse to `shared`).
   */
  sharing?: 'shared' | 'local-only';
  /** Test hook: inject a custom prompt for the sharing-mode TTY prompt. */
  sharingPromptFn?: (defaultMode: 'shared' | 'local-only') => Promise<'shared' | 'local-only'>;
  /**
   * Explicit content scope, `cwd`-relative (like any path argument). Resolved
   * to a git-root-relative value written to `.ok/config.yml`'s `content.dir`,
   * so `--content-dir .` from a sub-folder scopes the project to that folder
   * instead of the whole promoted git repo. Must resolve to the project root
   * or a descendant — anything outside throws `ContentDirError`. When omitted,
   * scope defaults to the resolved project root (`.`). Only applied when the
   * config is scaffolded fresh; on re-init `writeIfMissing` leaves an existing
   * `config.yml` untouched (surfaced as an ignored-flag warning).
   */
  contentDir?: string;
}

/**
 * Thrown when `--content-dir` resolves outside the project root or names a
 * non-directory / missing path. The CLI action renders `.message` cleanly and
 * exits with a usage code rather than dumping a stack.
 */
export class ContentDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentDirError';
  }
}

/**
 * Resolve which user-global bundles `ok init` should enable from the `--skills`
 * / `--no-skills` flag: `undefined`/`true` → every bundle; `false`
 * (`--no-skills`) → none; a comma list (`--skills discovery`) → only the named
 * bundle ids (unknown tokens ignored — the known-id set wins).
 */
export function resolveInitSkillEnablement(skills: string | boolean | undefined): Set<BundleId> {
  if (skills === undefined || skills === true) return new Set(USER_GLOBAL_BUNDLE_IDS);
  if (skills === false) return new Set();
  const requested = skills
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(USER_GLOBAL_BUNDLE_IDS.filter((id) => requested.includes(id)));
}

/**
 * Resolve a user-supplied `--content-dir` (cwd-relative) into the git-root
 * relative value stored in `config.yml`. Rejects paths that escape the project
 * root or don't point at an existing directory. Returns `'.'` when the request
 * resolves to the project root itself (explicit whole-repo scope).
 */
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
    // Distinguish "not there" from "there but unreadable" — a bare catch
    // reporting ENOENT for an EACCES/ELOOP/ENOTDIR path sends the user
    // hunting for a missing folder that actually exists.
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
  // Canonicalize BOTH operands before the containment check. `projectRoot` may
  // be realpath-canonical (git-root promotion returns `git rev-parse
  // --show-toplevel`) while `abs` is built from the caller's un-canonicalized
  // `cwd` — under a symlinked working tree (macOS `/var` → `/private/var`) the
  // two prefixes disagree and even `--content-dir .` computes a `..`-prefixed
  // `rel` and wrongly throws. realpath both so the comparison is symlink-safe;
  // fall back to the input shape if realpath fails (never worse than before).
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

/** realpath, falling back to the input path when it can't be resolved. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

interface InitCommandResult {
  /**
   * Resolved project root after ancestor / git-root promotion. Differs from
   * the caller's `cwd` when the user runs `ok init` from a sub-folder of a
   * git repo or below an existing managed project. Post-init formatting and
   * preview must read from this directory, not `cwd`.
   */
  projectRoot: string;
  contentCreated: string[];
  contentUpdated: string[];
  contentSkipped: string[];
  /** Per-editor MCP config results. Empty when `--no-mcp`. */
  editors: EditorMcpResult[];
  /** Project-local MCP configs detected (excluding ones we just wrote). */
  legacyProjectConfigs: ProjectConfigResult[];
  /** Project-local Agent Skill files written beside project-scope MCP configs. */
  projectSkills: ProjectSkillResult[];
  /**
   * Result of the user-global Agent Skill install step.
   * `undefined` only when `content` scaffolding failed before the install
   * step could run.
   */
  skillInstall?: InstallUserSkillResult | 'declined';
  /** Content preview result (undefined if preview failed or was not run). */
  preview?: PreviewResult;
  /** Claude launch.json result (undefined when Claude is not a selected editor). */
  launchJson?: LaunchJsonResult;
  /** `true` if `ensureProjectGit` ran `git init` during this invocation. */
  didGitInit: boolean;
  /** `true` if a project-root `.gitignore` was seeded during this invocation.
   * Only set when `didGitInit` is also `true` AND no `.gitignore` was already
   * present at `projectRoot` — pre-existing files are never touched. */
  rootGitignoreCreated: boolean;
  /**
   * `true` when `ok init` ran from a sub-folder of a git repo and promoted the
   * project root up to the git working-tree root — making the whole repo the
   * default content scope (`content.dir='.'`). A one-way default with a large
   * blast radius, so `formatInitResult` renders a prominent warning next to the
   * file-count preview (the disclosure previously printed only as an
   * easy-to-miss stdout line that `| tail`/`| head` silently drops). See
   * `resolveProjectRoot`'s git-root-promotion branch.
   */
  gitRootPromoted: boolean;
  /**
   * When `gitRootPromoted`, the original `cwd` (the sub-folder the user ran
   * `ok init` in) relative to `projectRoot`. Names the folder to narrow
   * `content.dir` back to. `undefined` when no promotion happened.
   */
  promotedFromDir?: string;
  /**
   * Effective content scope (git-root-relative) that `config.yml` now holds,
   * set only when this run scaffolded a fresh `config.yml`. `undefined` when an
   * existing `config.yml` was left untouched (its scope is whatever the file
   * already declared — this run didn't set it).
   */
  contentDir?: string;
  /**
   * The raw `--content-dir` value the caller requested (cwd-relative), if any.
   * Retained so the summary can warn when the flag was ignored because
   * `config.yml` already existed.
   */
  contentDirRequested?: string;
  /**
   * True when `initContent` threw and the run bailed via the early-return path.
   * Disambiguates the two `contentDir === undefined` cases: a pre-existing
   * config (flag genuinely ignored) vs. scaffolding that never ran (the summary
   * must not claim `config.yml` already exists — it doesn't). See the
   * content-scope disclosure branches in `formatInitResult`.
   */
  contentScaffoldFailed: boolean;
  // Backward-compat fields (derived from the Claude entry or first editor):
  mcpAction: 'written' | 'overwritten' | 'skipped-missing' | 'skipped-flag' | 'failed' | 'declined';
  mcpPath: string;
  mcpError?: string;
  previewWarning?: string;
  /**
   * Labels of editors that were skipped during a project-scope write because
   * they have no standardized project-local config format (e.g. Windsurf,
   * Claude Desktop). Only populated when scope=project|both and at least one
   * editor was skipped for this reason.
   */
  projectScopeUnsupportedLabels?: string[];
  /**
   * Sharing-mode posture after init, with the transition record. `mode`
   * reflects what `readSharingMode` returns after the post-init exclude
   * write/remove (or no-op). `refusal` is set when a `shared → local-only`
   * transition was requested but refused by the tracked-files probe;
   * it carries the formatted diagnostic for `formatInitResult` to render.
   */
  sharing: SharingOutcome;
}

/** Post-init sharing-mode outcome — see InitCommandResult.sharing. */
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

// ---------------------------------------------------------------------------
// Claude launch.json scaffolding
// ---------------------------------------------------------------------------

const LAUNCH_JSON_VERSION = '0.0.1';
export const LAUNCH_CONFIG_NAME = 'open-knowledge-ui';

/**
 * Canonical published-mode `runtimeArgs` for the `open-knowledge-ui` launch
 * config. Pinned to `@latest` so Claude Code Desktop's preview-pane spawn
 * can't be silently downgraded by npm's engine-aware sort in
 * `npm-pick-manifest`; `-y` suppresses the install-confirm prompt under the
 * non-TTY preview spawn. Single source of truth — `scaffoldLaunchJson`
 * writes this shape and `repair-launch-json.ts` classifies against it.
 */
export const LAUNCH_JSON_CANONICAL_ARGS: readonly string[] = [
  '-y',
  '@inkeep/open-knowledge@latest',
  'ui',
];

/**
 * Version sentinel for the published-mode launch.json recipe. The first line
 * of the chain doubles as a shell comment and the stamp `classifyLaunchJsonEntry`
 * matches on. Bump the suffix (`v2`, …) on any structurally-different chain so
 * the repair sweep recognizes stale text and rewrites it forward.
 */
export const LAUNCH_UI_CHAIN_SENTINEL = '# ok-ui-v1';

/**
 * Published-mode `.claude/launch.json` recipe — the preview pane spawns this
 * to bring the worktree's editor up. Mirrors the proven `# ok-mcp-v1` chain
 * (editors.ts) — resolves the Desktop bundle first (user → system Applications),
 * then npx, then version-manager `npx` paths — but runs **`ok start`**, not
 * bare `ok ui`, so the folder gets its OWN collab server (the worktree fix).
 * `ok start` connects-instead-of-erroring on a live lock (`--ui-port` path), so
 * one committed recipe is safe on both the main checkout and a fresh worktree.
 *
 * Port handling: the pane passes its watched port via `PORT` env. We capture it
 * as `UIPORT`, defaulting to the launch.json `port` (`LAUNCH_JSON_PORT`) when
 * `PORT` is somehow absent — the pane probes that same port, so the default
 * matches what it watches. `unset PORT` so the collab server kernel-allocates
 * instead of fighting its UI sibling for the env port (`ok start` also drops
 * env-`PORT` for the collab when `--ui-port` is set, belt-and-braces). We ALWAYS
 * pass `--ui-port` — that is what arms `ok start`'s connect-instead-of-exit-1
 * fallback, so a missing `PORT` can never leave the main checkout running a bare
 * `ok start` that exits 1 and breaks the preview pane. Ports are numeric;
 * `"$UIPORT"` is quoted for safety.
 *
 * Portable + public-safe: no machine-specific absolute path is baked in; the
 * bundle is resolved at spawn time. Same chain ships in the git-committed
 * scaffold and the per-open desktop reclaim (which force-writes this shape).
 */
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

/**
 * Scaffold or merge a `.claude/launch.json` entry so that Claude's
 * built-in preview browser can start the OpenKnowledge dev server via
 * `preview_start("open-knowledge-ui")`.
 *
 * `runtimeArgs` launches `open-knowledge ui` (not `open-knowledge start`) —
 * the UI sibling-process is what the preview pane renders; collab runs in a
 * separate `open-knowledge start` process auto-spawned by `ok ui` via the
 * MCP stdio path.
 *
 * - File missing        → create with the OK entry
 * - File exists, no OK  → merge the entry into configurations
 * - File exists, has OK → replace with current defaults
 */
export function scaffoldLaunchJson(
  cwd: string,
  installOptions: McpInstallOptions = {},
): LaunchJsonResult {
  const configPath = join(cwd, '.claude', 'launch.json');
  // `port` deliberately differs from `DEFAULT_UI_PORT` so Claude's spawn of the
  // UI sibling (with `PORT=LAUNCH_JSON_PORT` env) goes through the lock-collision
  // proxy branch rather than the same-port "already-running" exit-0 branch (which
  // empirically fails Claude's preview pane). `autoPort: true` is the additional
  // fallback when `LAUNCH_JSON_PORT` itself is occupied — Claude picks a free
  // port, passes via `PORT`, still routes through the proxy branch. Full pairing
  // rationale on `LAUNCH_JSON_PORT` in `ui.ts`.
  //
  // The recipe runs `ok start` (not bare `ok ui`) via a `/bin/sh` chain so the
  // opened folder — crucially, a worktree — gets its OWN collab server, not just
  // a UI. `ok start` connects-instead-of-erroring on a live lock (the `--ui-port`
  // path), so the same committed recipe is correct on both the main checkout and
  // a fresh worktree. Dev mode pins the chain's exec to the local CLI dist; both
  // modes carry the `# ok-ui-v1` sentinel so the repair sweep recognizes them.
  //
  // `resolveDevCliDistPath()` is resolved LAZILY (dev branch only) — it throws
  // when the repo root can't be inferred, which is the normal case for the
  // published recipe + the desktop reclaim, so it must never run in that path.
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

// ---------------------------------------------------------------------------
// Per-editor write logic
// ---------------------------------------------------------------------------

function isEditorTargetAvailable(target: EditorMcpTarget, cwd: string, home?: string): boolean {
  try {
    const probePath = target.detectPath?.(cwd, home) ?? dirname(target.configPath(cwd, home));
    return existsSync(probePath);
  } catch {
    return false;
  }
}

/**
 * Per-editor MCP config writer. Exported so `@inkeep/open-knowledge`
 * consumers — specifically Electron main's first-launch consent flow via
 * `writeUserMcpConfigs` — can invoke the same write logic that the
 * terminal-origin `ok init` command uses. The
 * `installOptions.skipAvailabilityCheck` flag distinguishes the two call
 * sites: `ok init` enforces `isEditorTargetAvailable` so users don't get
 * empty config dirs for editors they haven't installed; the consent flow
 * bypasses the check because the user explicitly toggled the editor
 * checkbox in the dialog.
 */
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

  // First-launch-consent bypass: the consent dialog showed the editor's
  // checkbox and the user explicitly toggled it. Skipping on
  // `isEditorTargetAvailable` would silently drop their choice — treat the
  // click as the consent. Also skip the check for project-scope writes
  // (configPathOverride set) — the project directory always exists by
  // definition.
  //
  // `offerOnlyWhenDetected` editors (OpenClaw) are the exception: their config
  // root must exist even under the consent bypass, so we never create a config
  // for a global tool that isn't installed. Project-scope writes stay exempt —
  // OpenClaw has no project config, so `configPathOverride` never applies to it.
  const enforceAvailability =
    !installOptions.skipAvailabilityCheck || target.offerOnlyWhenDetected === true;
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

  // Serialize the read-modify-write loop across processes via advisory
  // file lock. Without this, concurrent OK writers (CLI `ok init` + OK
  // Desktop's startup-repair sweep, two desktop instances, double-clicked
  // consent dialog) can each read state-N, each compute state-N + their
  // own entry, and the second write clobbers the first's addition. Worse:
  // a writeFileSync(O_TRUNC) interleave can leave the file with a valid
  // JSON prefix followed by trailing garbage, breaking Claude Desktop's
  // parse and silently dropping every MCP server (per anthropics/claude-
  // code#28966, which diagnoses the same bug class in .claude.json and
  // recommends this exact fix shape). The sync variant of `withFileLock`
  // is intentional — flipping `writeEditorMcpConfig` async cascades
  // through three orchestrators and one Desktop arrow function for a fix
  // that only needs to serialize a sub-10 ms critical section. The
  // busy-wait CPU cost is bounded by the 5 s acquire timeout and only
  // fires under contention.
  // Ensure the config's parent dir exists before acquiring the sibling
  // lock file there — first-init writes can land in a path whose dir
  // (`~/.cursor/`, `~/.codex/`, etc.) does not yet exist.
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

  // Captured inside the (synchronous) lock callback. Held on an object so the
  // post-lock reads see the declared union rather than the initializer literal.
  // The 'written' placeholder is never observed on the success path: a throw
  // before assignment sets `lockErr` and returns 'failed' before it is read.
  const captured: {
    action: 'written' | 'overwritten' | 'declined';
    declineReason?: McpDeclineReason;
  } = { action: 'written' };
  let lockErr: Error | undefined;
  try {
    withFileLockSync(
      `${configPath}.lock`,
      () => {
        // Write through a symlinked config to its real target so a dotfile-managed
        // (stow/chezmoi) config is not replaced by a regular file and orphaned. A
        // cyclic/unreadable chain resolves back to the original path, where a fresh
        // regular-file write intentionally breaks the link. Resolved inside the
        // lock so the resolve+read+write is atomic against other OK writers; the
        // target's directory may differ from the symlink's, so ensure it exists.
        const writePath = resolveHarnessWritePaths(configPath).writePath;
        mkdirSync(dirname(writePath), { recursive: true });
        // Both formats edit only OK's own entry: TOML through the native
        // format-preserving addon (declining on the JS fallback rather than a
        // lossy whole-file rewrite), JSON through the surgical jsonc editor.
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
        // Surface stale-lock recovery to stderr — the only signal that a
        // prior writer crashed mid-critical-section. Server-side callers
        // route this to a structured logger; the CLI has no logger
        // dependency so stderr is the lowest-overhead diagnostic surface.
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

// ---------------------------------------------------------------------------
// User-scoped MCP config writer (Electron main entry, NOT CLI `ok init`)
// ---------------------------------------------------------------------------

export interface UserMcpConfigsOptions {
  /**
   * Editors whose MCP config to write. Caller (mcp-wiring.ts confirmHandler)
   * owns user disclosure for any existing `open-knowledge` namespace entry
   * before calling this writer. This function unconditionally overwrites every
   * editor it receives (aligning with `writeEditorMcpConfig`'s always-rewrite
   * semantic — installs stay aligned with current defaults).
   */
  editors: EditorId[];
  /** Override `$HOME` for resolving user-scoped config paths (test hook). */
  home?: string;
}

/**
 * Write MCP config entries for a set of editors without any of `runInit`'s
 * project-scoped side effects.
 *
 * Specifically does NOT run:
 *   - `ensureProjectGit` — would `git init` wherever `cwd` is (packaged Electron
 *     apps have `process.cwd() === '/'` by default)
 *   - `initContent` — scaffolds `.ok/` in a project
 *   - `scaffoldLaunchJson` — writes `.claude/launch.json`
 *   - `upsertRootInstructions` — mutates `AGENTS.md` / `CLAUDE.md`
 *   - `collectLegacyProjectConfig` — scans for `.mcp.json` / `.cursor/mcp.json`
 *
 * This is the entry point Electron main's first-launch MCP consent flow
 * calls after the user clicks Add. The terminal-invoked `ok init`
 * path shares the same canonical npx shape.
 *
 * Bypasses `isEditorTargetAvailable` via `skipAvailabilityCheck: true` — the
 * user explicitly toggled the editor checkbox; their click IS the consent,
 * so skip-on-missing would silently drop their selection.
 */
export async function writeUserMcpConfigs(opts: UserMcpConfigsOptions): Promise<EditorMcpResult[]> {
  const targets = resolveEditorTargets(opts.editors);
  const installOptions: McpInstallOptions = {
    mode: 'published',
    skipAvailabilityCheck: true,
  };
  // `cwd` is empty — every user-scoped target ignores it (each editor's
  // `configPath` + `serverName` resolves from `home` or a constant).
  return targets.map((target) => writeEditorMcpConfig(target, '', installOptions, opts.home));
}

/**
 * Read a single editor's existing MCP server entry for use with the
 * desktop confirm-flow's canonical-shape classification. Reads the
 * user-scoped config (format-aware — JSON or TOML), looks up
 * `config[topLevelKey][serverName]`, and returns it as a plain object.
 * Returns `null` when the config file is absent, unreadable,
 * unparseable, or has no entry for this editor's server name.
 *
 * **Never-throws contract (load-bearing):** the first-launch consent flow
 * MUST be able to classify every selected editor without aborting on one
 * malformed config. A corrupt user config (e.g., stale
 * `~/.codex/config.toml` from a half-completed third-party edit) on ANY
 * selected editor would otherwise crash `confirmHandler`, leave the
 * marker absent, and create an infinite dialog re-fire loop on the user's
 * machine. Delegates to the never-throwing `classifyExistingMcpEntry`; every
 * non-`present` classification returns `null`:
 *   - configPath() throws → null (platform-mismatched target, e.g.
 *     Claude Desktop on Linux)
 *   - file absent or blank → null
 *   - parse fails / duplicate container → `decline` → null (unparseable config)
 *   - top-level key absent or not a plain object → `no-entry` → null
 *   - server entry value not a plain object → `no-entry` → null
 *
 * Note: `null` deliberately conflates "absent" with "no compatible entry to
 * merge into" from the desktop classifier's perspective. The downstream
 * `writeEditorMcpConfig` re-reads via the same capable parser and, on a present
 * config it can't safely edit, DECLINES (leaves it byte-unchanged) rather than
 * throwing — surfaced via the bounded `mcp-config-decline` event.
 */
export function readExistingMcpEntry(
  target: EditorMcpTarget,
  cwd: string,
  home?: string,
  configPathOverride?: string,
): Record<string, unknown> | null {
  const classified = classifyExistingMcpEntry(target, cwd, home, configPathOverride);
  return classified.kind === 'present' ? classified.entry : null;
}

/**
 * Bounded set of reasons OpenKnowledge declines to register into a present,
 * non-empty config. Kept to a closed enum (never raw parser text or a config
 * path) so a decline is observable in telemetry without logging the user's
 * config contents. `unparseable` covers a genuinely-malformed file, one OK's
 * parser can't read, or a half-written file caught mid-write by a concurrent
 * harness — none of which OK's parsers can reliably tell apart, so all collapse
 * here. `duplicate-container` is produced by the JSON/TOML write paths (an
 * ambiguous edit target); `oversize` is produced by both the write paths and
 * `classifyExistingMcpEntry` when a config exceeds the size bound;
 * `no-native-writer` is the TOML write path declining a present config because
 * the format-preserving native engine is unavailable and a JS-fallback rewrite
 * would be lossy — the file was never parsed, so it is not `unparseable`.
 */
export type McpDeclineReason =
  | 'unparseable'
  | 'duplicate-container'
  | 'oversize'
  | 'no-native-writer';

/**
 * Discriminated classification of an existing MCP host config file. Where
 * `readExistingMcpEntry` collapses every state into `Record | null`, this
 * surface distinguishes them so callers can act differently per state.
 *
 * OpenKnowledge is a guest in another tool's config — its write authority is
 * scoped to its own entry. A present, non-empty file it cannot parse is
 * therefore `'decline'`: left untouched, never renamed or overwritten, so a
 * config OK's parser merely can't read is never mistaken for one to reset.
 * A `'no-entry'` file (parses, but holds no entry under our server name) is
 * likewise left alone — it could be an unrelated tool's config.
 *
 * Blank / whitespace / 0-byte files classify as `'absent'`: there is nothing
 * to preserve, so they are safe to create into (the readers already coerce
 * blank input to `{}` for the merge path). A non-blank file whose parse throws
 * is `'decline'`, NOT `'absent'` — a half-written file caught mid-write by a
 * concurrent harness must be left alone, not treated as empty-and-creatable.
 *
 * **Never-throws contract:** every failure path returns a structured outcome.
 * Mirrors `readExistingMcpEntry`'s contract for the same load-bearing reason
 * (one unreadable user config must not pull the whole startup flow down).
 */
export type McpEntryClassification =
  | { kind: 'absent' }
  | { kind: 'no-entry' }
  | { kind: 'present'; entry: Record<string, unknown> }
  | { kind: 'decline'; reason: McpDeclineReason };

/**
 * Locate our entry within a parsed config object: `no-entry` when the container
 * or our slot is absent or not an object (an unrelated tool's config we leave
 * alone), `present` with the entry otherwise.
 */
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

  // Mirror `upsertJsonMcpConfig`'s oversize decline one step earlier: stat
  // rather than read, so a history-bloated host config (a `~/.claude.json`
  // can reach tens of MB) is left untouched without pulling megabytes into
  // memory and parsing them on every classify. A stat that throws on a
  // present file is the same can't-inspect-so-leave-untouched posture as an
  // unreadable read below, never `absent`.
  try {
    if (statSync(configPath).size > JSON_CONFIG_MAX_BYTES) {
      return { kind: 'decline', reason: 'oversize' };
    }
  } catch {
    return { kind: 'decline', reason: 'unparseable' };
  }

  // Read raw content first so a blank/whitespace file classifies as 'absent'
  // (creatable) instead of flowing into the parse path. A present file OK
  // can't even read is 'decline', not 'absent' — never overwrite bytes we
  // couldn't inspect.
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return { kind: 'decline', reason: 'unparseable' };
  }
  if (raw.trim() === '') {
    return { kind: 'absent' };
  }

  const serverName = target.serverName(cwd);

  // TOML reads through the capable engine (the native `toml_edit` addon when
  // present): it parses 64-bit integers and microsecond datetimes the JS
  // `smol-toml` parser throws on, so a valid config is classified by its
  // content instead of being mis-flagged. The JSON path parses the bytes we
  // already read with a JSONC-capable scanner so a comment-rich or BOM-prefixed
  // config is read by its content, and a duplicate container key — which the
  // value parse silently collapses to the last block, hiding which one holds
  // our entry — is surfaced as a decline rather than an arbitrary edit target.
  if (target.format === 'toml') {
    let config: Record<string, unknown>;
    try {
      config = getTomlConfigEngine().parseToObject(raw);
    } catch {
      return { kind: 'decline', reason: 'unparseable' };
    }
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

// ---------------------------------------------------------------------------
// Core init logic
// ---------------------------------------------------------------------------

export async function runInit(options: InitCommandOptions = {}): Promise<InitCommandResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  // Walk up for `.ok/` (ancestor-promote), else promote to git root when cwd
  // sits inside a git working tree below home. The CLI's first-and-only print
  // happens here — every other path stays silent.
  const resolution = resolveProjectRoot(cwd, { homeDir: options.home });
  const projectRoot = resolution.projectRoot;
  const willScaffold = !existsSync(join(projectRoot, OK_DIR));
  // `gitRootPromoted` guarantees cwd is a strict descendant of projectRoot, so
  // `relative` is non-empty. Captured for the result so `formatInitResult` can
  // repeat the warning next to the file-count preview the user actually reads.
  const promotedFromDir = resolution.gitRootPromoted ? relative(projectRoot, cwd) : undefined;
  // Resolve the requested scope (cwd-relative) to a git-root-relative value
  // before any side effect, so an out-of-project `--content-dir` fails fast.
  // When omitted, `--content-dir .` from the promoted sub-folder is the fix the
  // user reaches for; an explicit request also suppresses the whole-repo
  // surprise warning below (the choice was deliberate, not a silent default).
  const contentDirScope =
    options.contentDir !== undefined
      ? resolveRequestedContentDir(options.contentDir, projectRoot, cwd)
      : resolution.defaultContentDir;
  if (resolution.ancestorPromoted) {
    console.log(`[ok] Opened existing project at ${projectRoot}`);
  } else if (resolution.gitRootPromoted && willScaffold && contentDirScope === '.') {
    // Whole-repo content scope is a large, one-way default. Emit the disclosure
    // to stderr (it's a diagnostic, not data) and style it as a warning so it
    // survives `ok init 2>&1 | tail` / `| head` — the exact pipe that ate the
    // old stdout `console.log` and let a 1,387-file repo scope in unnoticed.
    // Skipped when `--content-dir` narrowed scope (no surprise to disclose).
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

  // 0. Ensure the project has a `.git/` — `ok init` is the explicit "set
  // this project up" verb, so it does the heavier side-effect too.
  // Propagates GitNotAvailableError / GitTooOldError (preflight) or ProjectGitInitError (genuine init failure); caller exits non-zero.
  const gitResult = await ensureProjectGit(projectRoot);

  // 1. Scaffold .ok/
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
      // Sharing-mode posture is computed AFTER content scaffolding; on the
      // content-failure early return we have no fresh signal yet, but
      // resolveGitDir + readSharingMode are pure reads of disk state so we
      // can still report what's currently true. Defensive default keeps
      // the return type sound without surfacing a misleading 'applied'.
      sharing: { kind: 'no-exclude', reason: 'no-git', localOnlyRequested: false },
    };
  }

  // `content.dir` is only written when a fresh `config.yml` is scaffolded
  // (`writeIfMissing` — an existing file wins). Distinguishing created vs
  // skipped lets the summary confirm an applied scope or warn that the
  // `--content-dir` flag was ignored on a re-init.
  const configCreated = contentResult.created.includes(CONFIG_FILENAME);

  // 1b. Seed a project-root `.gitignore` with `.DS_Store` IFF we just ran
  // `git init` in this invocation. Skipped when an enclosing repo already
  // exists — its `.gitignore` belongs to the user/org. `writeIfMissing`
  // semantics inside the helper guarantee hand-authored files stay
  // untouched on re-init. Symlink-detection errors are non-fatal — the
  // project is fully usable without the seed.
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

  // 2. Wire MCP config per editor (unless --no-mcp). Defaults are scope-aware:
  // user-level writes stay limited to editors detected on this machine, while
  // project-level writes create all standardized project config files so a repo
  // can be prepared for teammates who use different editors.
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
  // Track project-scope paths we wrote so we can suppress them from the notice.
  const writtenProjectPaths = new Set<string>();

  for (const target of selectedTargets) {
    if (skipMcp) {
      let configPath = '';
      try {
        configPath = target.configPath(projectRoot, options.home);
      } catch {
        // Unsupported-platform target (e.g. Claude Desktop on Linux) — --no-mcp
        // explicitly means "don't write", so the path is informational only.
      }
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

  // Project-local skill install. The rich `project` bundle rides with the
  // repo. Decoupled from the MCP-config scope flag AND from `--no-mcp` —
  // skills are independent of MCP wiring (the rich skill applies whenever an
  // MCP server IS registered, which a `--no-mcp` user may do via custom
  // wiring). Runs once per project-capable target; `projectTargets` is
  // computed regardless of `skipMcp` and is already de-duplicated by editor id.
  //
  // De-dupe by RESOLVED skill path too: most editors resolve to their own
  // per-editor dir (`.codex/skills`, `.opencode/skills`, …) so this is usually a
  // no-op, but should two targets ever share a `projectSkillPath` it is written
  // once — keeping the post-init notice clean — and the first target in
  // `projectTargets` order owns the write.
  const writtenSkillPaths = new Set<string>();
  for (const target of projectTargets) {
    const skillPath = target.projectSkillPath?.(projectRoot);
    if (!skillPath || writtenSkillPaths.has(skillPath)) continue;
    writtenSkillPaths.add(skillPath);
    projectSkillResults.push(writeProjectSkill(target, projectRoot));
  }

  // Editors skipped for project-scope because they have no project-local config format.
  const projectScopeUnsupportedLabels =
    !skipMcp && scope !== null && writesProject(scope)
      ? projectTargets.filter((t) => !t.projectConfigPath).map((t) => t.label)
      : undefined;

  const legacyProjectConfigs = skipMcp
    ? []
    : availableTargets
        .map((target) => collectProjectConfig(target, projectRoot))
        .filter((result): result is ProjectConfigResult => result !== undefined)
        // Suppress paths we just wrote during project-scope install.
        .filter((result) => !writtenProjectPaths.has(result.path));

  // 3. Scaffold .claude/launch.json when Claude is a selected editor.
  // hasClaude checks availableTargets (existence of ~/.claude/), not the full
  // targets list, so scope=project writes .mcp.json but skips launch.json when
  // ~/.claude/ is absent (e.g. CI). This is intentional: launch.json targets a
  // running editor instance, not a committed project artifact.
  const hasClaude = availableTargets.some((target) => target.id === 'claude');
  const launchJson =
    hasClaude && !skipMcp ? scaffoldLaunchJson(projectRoot, installOptions) : undefined;

  // `ok init` does not write to root AGENTS.md / CLAUDE.md. Behavioral
  // guidance ships via (1) per-tool MCP tool descriptions and (2) the
  // user-global Agent Skill installed via `installUserSkill` from
  // @inkeep/open-knowledge-server.

  // 4. Install the enabled user-global Agent Skills. Per-bundle opt-in
  // (`--skills` / `--no-skills`); the decision is recorded so the desktop /
  // CLI reclaim gates never re-install a declined bundle. Non-fatal — init
  // exits 0 even on install failure; users see a warning + manual-install hint.
  const installSkill = options.installUserSkill ?? installUserSkill;
  const skillHome = options.home ?? homedir();
  const enabledBundles = resolveInitSkillEnablement(options.skills);
  let anyEnabled = false;
  let anyInstalled = false;
  let anyFailed = false;
  let anySkipped = false;
  for (const id of USER_GLOBAL_BUNDLE_IDS) {
    const enabled = enabledBundles.has(id);
    await writeBundleDecision(skillHome, BUNDLE_SKILL_NAME[id], enabled).catch(() => {});
    if (enabled) {
      anyEnabled = true;
      // force: the loop shares the `cli-hosts` version key across bundles, so
      // one bundle's version write must not satisfy another's skip-current gate.
      const result = await installSkill({ home: options.home, bundleId: id, force: true });
      if (result === 'installed') anyInstalled = true;
      else if (result === 'failed') anyFailed = true;
      else anySkipped = true;
    } else {
      try {
        removeUserGlobalSkillBundle(skillHome, id);
      } catch {
        // Fail-soft — the decline is already recorded; teardown is best-effort.
      }
    }
  }
  // Honest summary: a failure (even partial) surfaces the manual-install hint;
  // declining every skill reports declined, not a false "already installed".
  // The `skip-current` arm can't be reached from a real `ok init` (force always
  // reinstalls) but is retained so an injected `installUserSkill` that returns
  // `skip-current` still renders honestly.
  const skillInstall: InstallUserSkillResult | 'declined' = anyFailed
    ? 'failed'
    : anyInstalled
      ? 'installed'
      : anyEnabled && anySkipped
        ? 'skip-current'
        : 'declined';

  // Derive backward-compat fields from the Claude entry (preferred) or first result
  const defaultAction: EditorMcpResult['action'] = skipMcp ? 'skipped-flag' : 'skipped-missing';
  const primary = editorResults.find((r) => r.editorId === 'claude') ??
    editorResults[0] ?? {
      action: defaultAction,
      configPath: EDITOR_TARGETS.claude.configPath(projectRoot, options.home),
    };

  // 6. Apply the resolved sharing mode. Runs AFTER every
  // artifact-writing step so the tracked-files probe inside
  // `addOkPathsToGitExclude` sees the latest on-disk shape. The single
  // `apply` site means the tracked-files refusal cannot drift between
  // CLI surfaces (init / unshare / desktop).
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

/**
 * Encapsulates the four post-init transitions for `runInit`:
 *
 *   1. desired `local-only` + currently `shared`/`no-git` → add OK paths
 *      via `addOkPathsToGitExclude`. On tracked-files refusal, return the
 *      refusal verbatim — `formatInitResult` renders the diagnostic.
 *   2. desired `shared` + currently `local-only` → remove OK paths via
 *      `removeOkPathsFromGitExclude`. Always succeeds.
 *   3. desired matches current → no-op write; report `kind: 'applied',
 *      action: 'noop'`.
 *   4. gitdir unresolvable → return `no-exclude` with the sub-reason. When
 *      `explicitFlag === 'local-only'` we set `localOnlyRequested: true`
 *      so the summary surfaces the warning.
 */
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

  // desiredMode === 'shared'
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
    // `removeOkPathsFromGitExclude` reports the artifact paths whose lines it
    // actually removed; surface that (not the full candidate set) so the
    // summary doesn't claim phantom removals for paths that were already absent.
    removed: result.removed,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Short, bounded human phrase for why OK declined to write a present config. */
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

/**
 * Format a user-facing summary of an init run.
 */
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

  // Auto-git-init disclosure — surfaced when ensureProjectGit ran
  // `git init` during this invocation. Silent when the project already had
  // `.git/`.
  if (result.didGitInit) {
    lines.push(`Initialized git repo at ${cwd}/.git/ (default branch: main)`);
  }
  // Seeded-`.gitignore` disclosure — surfaced when the fresh-`git init` path
  // also wrote a project-root `.gitignore`. Silent when an existing
  // `.gitignore` was already present at projectRoot.
  if (result.rootGitignoreCreated) {
    lines.push(`Seeded .gitignore at ${cwd}/.gitignore (.DS_Store)`);
  }

  // Content scaffolding summary
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

  // MCP config summary — per-editor
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
          // Exhaustiveness: a new EditorMcpResult action must get an explicit
          // render branch here rather than silently rendering nothing.
          const _exhaustive: never = editor.action;
          void _exhaustive;
        }
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

  // Show manual config hint for any failures
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

  // User-global skill install summary
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
      case 'declined':
        lines.push(`  open-knowledge  ${dim('skipped (opted out via --no-skills)')}`);
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

  // No Chat & Cowork hint here by design: the `ok cowork` bundle build is a
  // deliberately unadvertised power-user escape hatch (see cowork.ts). `ok init`
  // wires Claude directly; Chat/Cowork is niche and discovered pull-only via the
  // Open Knowledge skill, never pushed from the init summary.

  // Content-scope disclosures — rendered immediately before the Content
  // preview so scope info sits next to the file count the user reads (the
  // top-of-run stderr disclosure can scroll out of a piped tail; this repeat
  // can't). `cwd` here is `result.projectRoot` (the git root), per the call
  // site. The three branches are mutually exclusive by construction:
  //   - `--content-dir` requested but config already existed → flag ignored
  //     (excludes the scaffold-failure early return, where no config exists);
  //   - `--content-dir` applied to a fresh config → confirm the narrowed scope;
  //   - promoted to git root with whole-repo scope and no explicit request →
  //     the surprise-default warning.
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

  // Content preview block (between MCP and Next steps)
  if (result.preview) {
    lines.push('');
    lines.push(formatPreviewBlock(result.preview, cwd));
  } else if (result.previewWarning) {
    lines.push('');
    lines.push(`Content preview unavailable: ${result.previewWarning}`);
  }

  // Sharing-mode summary — concise lines summarizing the post-init
  // posture and the refusal diagnostic (when applicable).
  lines.push('');
  lines.push(...formatSharingOutcome(result.sharing, cwd));

  // Next steps (only if something was written)
  if (anyWritten) {
    // Deduplicate by editorId: scope=both produces two entries per editor
    // (user-scope + project-scope) with the same label.
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

/**
 * Machine-readable projection of an `InitCommandResult` for `--json`. A second
 * renderer of the same result object that `formatInitResult` renders as text —
 * the stable, scriptable surface. Unlike the text disclosure, the promotion +
 * scope signals are *fields* here, so `ok init --json | jq` can't scroll past
 * them the way `2>&1 | tail` dropped the old stdout log line.
 */
export interface InitJsonSummary {
  projectRoot: string;
  gitRootPromoted: boolean;
  /** Sub-folder init ran in, relative to `projectRoot`; `null` when no promotion. */
  promotedFromDir: string | null;
  /** Effective `content.dir` now in `config.yml` (git-root-relative). */
  contentDir: string;
  /** Raw `--content-dir` requested (cwd-relative); `null` when not supplied. */
  contentDirRequested: string | null;
  /** True when this run wrote `content.dir` (fresh `config.yml`); false when a
   * pre-existing config left the requested scope unapplied. */
  contentDirApplied: boolean;
  /** Files the watcher will index under the content scope; `null` if preview
   * failed — pair with `previewError` to distinguish a failure from 0 files. */
  contentFileCount: number | null;
  /** The preview/config-read failure message when `contentFileCount` is `null`
   * because scope resolution threw; `null` when the preview ran (so a `null`
   * `contentFileCount` alongside a `null` `previewError` genuinely means 0). */
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

/**
 * Build the `--json` projection. `contentDir` (the effective scope) and
 * `contentFileCount` are passed in because the CLI resolves them post-init from
 * the on-disk config + a content-scope preview — the same source the text
 * summary reads — so JSON and text never diverge.
 */
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

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

/**
 * Detect every editor whose global config surface already exists. Each target
 * can override the probe path when the config file itself is a poor signal
 * (for example Claude writes `~/.claude.json`, but installation is better
 * inferred from the presence of `~/.claude/`).
 *
 * Used by `runInit()` and the CLI to install to every editor that already has
 * a config root on disk without creating new user-home directories for tools
 * the user does not have.
 */
export function detectInstalledEditors(cwd: string, home?: string): EditorId[] {
  const detected: EditorId[] = [];
  for (const id of ALL_EDITOR_IDS) {
    if (isEditorTargetAvailable(EDITOR_TARGETS[id], cwd, home)) {
      detected.push(id);
    }
  }
  return detected;
}

/**
 * Route `console.log`/`info`/`debug` (which default to stdout) to stderr and
 * return a restore thunk. Used by `--json` so deep-in-the-stack diagnostics
 * (e.g. the skill-installer's `console.info`) can't corrupt the JSON document
 * on stdout. `process.stdout.write` — how the JSON itself is emitted — is left
 * untouched, and `console.warn`/`error` already target stderr.
 */
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
        // In `--json` mode, keep stdout pure: route stray stdout-bound console
        // diagnostics to stderr for the whole action, restored in `finally`.
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
            // Invalid `--content-dir` (outside the project, missing, or a file):
            // print the message cleanly and exit EX_USAGE (64) — a usage error,
            // distinct from the git-preflight EX_CONFIG (78) below.
            if (err instanceof ContentDirError) {
              process.stderr.write(`${err.message}\n`);
              process.exitCode = 64;
              return;
            }
            // The setup-boundary preflight now throws the recoverable typed error
            // when git is unusable (no longer re-wrapped as ProjectGitInitError).
            // Print its install-guidance message cleanly (no stack) and exit
            // EX_CONFIG (78) — the same stable scriptable signal `ok start` maps
            // the typed git-preflight errors to (start.ts), so the contract is
            // consistent across commands.
            if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
              process.stderr.write(`${err.message}\n`);
              process.exitCode = 78;
              return;
            }
            if (err instanceof ProjectGitInitError) {
              // git is present and validated by the preflight above — this is a
              // genuine `git init` failure (spawn error, or a partial init that
              // left `.git/HEAD` absent), not a missing-git case.
              process.stderr.write(
                "open-knowledge could not initialize a git repo for this project. Re-run, or run 'git init' yourself in the project folder.\n",
              );
              if (err.stderr) process.stderr.write(`${err.stderr.trim()}\n`);
              process.exitCode = 1;
              return;
            }
            throw err;
          }

          // Effective content scope + file count, read post-init from the on-disk
          // config + a preview walk — the single source both the text summary and
          // the `--json` projection render, so they can never diverge. Defaults
          // survive a preview failure (`--json` still emits, with a null count).
          let effectiveContentDir = result.contentDir ?? '.';
          let contentFileCount: number | null = null;
          const { loadConfig } = await import('../config/loader.ts');
          const { resolveContentDir } = await import('@inkeep/open-knowledge-server');
          // Read the on-disk scope in its OWN try, independent of the preview
          // walk. Otherwise a preview failure on a narrowed re-init would leave
          // `effectiveContentDir` at the `result.contentDir ?? '.'` seed and the
          // `--json` `contentDir` field would emit `.` while `config.yml` says
          // `notes` — silently misreporting the scriptable contract. Use the
          // resolved projectRoot (post-promotion), not cwd.
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
            // stdout carries only JSON (diagnostics went to stderr). Pretty-print
            // for human-inspectable `--json` output; `jq` and `JSON.parse` are
            // whitespace-insensitive so the indentation costs downstream nothing.
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

// ---------------------------------------------------------------------------
// Sharing-mode summary formatting
// ---------------------------------------------------------------------------

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
          // No appended, no alreadyPresent: artifact set was empty (rare).
          lines.push(`  ${success('local-only')}`);
        }
      } else {
        // shared
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
      // Indent the multi-line remediation for readability under the header.
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
        // Silent for fresh repos with no flag — the default is `shared`
        // and there's nothing to surface.
        return [];
      } else {
        lines.push(warning(`Sharing mode unavailable: ${outcome.reason}.`));
      }
      return lines;
    }
  }
}
