import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  isValidAttachmentFolderPath,
  LEGACY_SKILL_STORE_ROOT,
  LINKABLE_ASSET_EXTENSIONS,
  normalizeAttachmentFolderPath,
  OK_DIR,
} from '@inkeep/open-knowledge-core';
import ignore, { type Ignore } from 'ignore';
import { isReservedForUserTree } from './cc1-broadcast.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { isProjectRoot } from './fs/find-project-root.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';
import { withSpan } from './telemetry.ts';

const log = getLogger('content-filter');

const execFileAsync = promisify(execFileCb);

const EDITOR_HOST_DIRS = ['.claude', '.cursor', '.codex', '.agents', '.opencode', '.pi'] as const;

const BUILTIN_SKIP_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'vendor',
  'dist',
  'build',
  'out',
  'output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.git',
  '.ok',
  '.open-knowledge',
  '.openknowledge',
  ...EDITOR_HOST_DIRS,
  'Library',
  'Applications',
  '.Trash',
]);

const ALWAYS_SKIP_DIRS = new Set<string>([
  '.git',
  'node_modules',
  '.ok',
  '.open-knowledge',
  '.openknowledge',
  ...EDITOR_HOST_DIRS,
]);

const OK_ALWAYS_SKIP_CHILDREN = new Set(['worktrees', 'local']);

type AttachmentFolderShape =
  | { kind: 'sibling' }
  | { kind: 'content-root' }
  | { kind: 'fixed'; path: string }
  | { kind: 'doc-relative'; path: string };

function attachmentFolderShape(value: string): AttachmentFolderShape {
  const normalized = normalizeAttachmentFolderPath(value);
  if (!isValidAttachmentFolderPath(normalized)) {
    throw new Error('Invalid attachment folder path');
  }
  if (normalized === './') return { kind: 'sibling' };
  if (normalized === '/' || normalized === '.') return { kind: 'content-root' };

  const docRelative = normalized.startsWith('./');
  const path = (docRelative ? normalized.slice(2) : normalized)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (path === '') return docRelative ? { kind: 'sibling' } : { kind: 'content-root' };
  return { kind: docRelative ? 'doc-relative' : 'fixed', path };
}

function assertNeverAttachmentShape(shape: never): never {
  throw new Error(`[AttachmentFolderShape] unhandled variant: ${JSON.stringify(shape)}`);
}

function isConfiguredAttachmentAsset(
  relativePath: string,
  shape: AttachmentFolderShape,
  hasDocumentInDir: (dir: string) => boolean,
): boolean {
  const ext = extname(relativePath).slice(1).toLowerCase();
  if (!LINKABLE_ASSET_EXTENSIONS.has(ext) || shape.kind === 'sibling') return false;

  const lastSlash = relativePath.lastIndexOf('/');
  const fileDir = lastSlash === -1 ? '' : relativePath.slice(0, lastSlash);
  if (shape.kind === 'content-root') return fileDir === '';
  if (shape.kind === 'fixed') {
    return fileDir === shape.path || fileDir.startsWith(`${shape.path}/`);
  }
  if (shape.kind === 'doc-relative') {
    const dirSegments = fileDir === '' ? [] : fileDir.split('/');
    const shapeSegments = shape.path.split('/');
    for (let start = 0; start <= dirSegments.length - shapeSegments.length; start++) {
      if (!shapeSegments.every((segment, offset) => dirSegments[start + offset] === segment)) {
        continue;
      }
      const parentDir = dirSegments.slice(0, start).join('/');
      if (hasDocumentInDir(parentDir)) return true;
    }
    return false;
  }
  return assertNeverAttachmentShape(shape);
}

function pathHasAlwaysSkipSegment(relativePath: string, showOk?: boolean): boolean {
  const segments = relativePath.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const canonicalSegment = segment.toLowerCase() === OK_DIR ? OK_DIR : segment;
    if (!ALWAYS_SKIP_DIRS.has(canonicalSegment)) continue;
    if (
      showOk &&
      canonicalSegment === OK_DIR &&
      !OK_ALWAYS_SKIP_CHILDREN.has((segments[i + 1] ?? '').toLowerCase())
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function isSkillContentFile(relativePath: string): boolean {
  return relativePath.startsWith(`${LEGACY_SKILL_STORE_ROOT}/`);
}

function isSkillContentAncestorDir(relativePath: string): boolean {
  return (
    relativePath === '.ok' ||
    relativePath === LEGACY_SKILL_STORE_ROOT ||
    relativePath.startsWith(`${LEGACY_SKILL_STORE_ROOT}/`)
  );
}

const WATCHER_CARVE_OUT_CAPABLE_DIRS = new Set<string>([OK_DIR, ...EDITOR_HOST_DIRS]);
const WATCHER_SAFE_BUILTIN_SKIP_DIRS = new Set(
  [...BUILTIN_SKIP_DIRS].filter((dir) => !WATCHER_CARVE_OUT_CAPABLE_DIRS.has(dir)),
);

export const WATCHER_STRUCTURAL_IGNORE_DIRS = [
  '.git',
  'node_modules',
  '.ok/local',
  '.ok/worktrees',
] as const;

const WATCHER_STRUCTURAL_IGNORE_GLOBS = WATCHER_STRUCTURAL_IGNORE_DIRS.flatMap((dir) => [
  dir,
  `${dir}/**`,
  `**/${dir}`,
  `**/${dir}/**`,
]);

function watcherPatternIsConfinedToAlwaysSkippedTree(pattern: string): boolean {
  const segments = pattern.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.includes('..')) return false;

  if (segments.some((segment) => WATCHER_SAFE_BUILTIN_SKIP_DIRS.has(segment))) {
    return true;
  }

  return segments.some(
    (segment, index) =>
      segment.toLowerCase() === OK_DIR &&
      OK_ALWAYS_SKIP_CHILDREN.has((segments[index + 1] ?? '').toLowerCase()),
  );
}

const WATCHER_MANAGED_CONTENT_PROBES = [
  '.gitignore',
  '.ok',
  '.ok/config.yml',
  '.ok/.gitignore',
  '.ok/schemas/frontmatter.json',
  '.ok/templates/example.md',
  '.ok/skills/example/SKILL.md',
  'docs/.ok',
  'docs/.ok/frontmatter.yml',
  'docs/.ok/templates/example.md',
  ...EDITOR_HOST_DIRS.flatMap((dir) => [dir, `${dir}/skills/example/SKILL.md`]),
] as const;

function patternIsUnsafeForWatcherIgnore(pattern: string): boolean {
  const candidate = pattern.trim();
  if (!candidate || candidate.startsWith('!') || candidate.startsWith('#')) return false;
  const segments = candidate.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.includes('..')) return true;
  if (watcherPatternIsConfinedToAlwaysSkippedTree(candidate)) return false;
  if (segments.some((segment) => WATCHER_CARVE_OUT_CAPABLE_DIRS.has(segment))) return true;

  try {
    const matcher = ignore().add(candidate);
    return WATCHER_MANAGED_CONTENT_PROBES.some((path) => matcher.ignores(path));
  } catch {
    return true;
  }
}

function buildWatcherIgnoreGlobs(patterns: readonly string[]): string[] {
  const retained = patterns.filter(
    (pattern) =>
      pattern.length > 0 &&
      !pattern.startsWith('!') &&
      !pattern.startsWith('#') &&
      !patternIsUnsafeForWatcherIgnore(pattern),
  );
  return [...new Set([...retained, ...WATCHER_STRUCTURAL_IGNORE_GLOBS])];
}

function templateFolderPrefixIsSkipped(segments: string[], okIndex: number): boolean {
  for (let i = 0; i < okIndex; i++) {
    if (BUILTIN_SKIP_DIRS.has(segments[i]) || segments[i].toLowerCase() === OK_DIR) return true;
  }
  return false;
}

function isTemplateContentFile(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const n = segments.length;
  if (n < 3) return false;
  if (
    segments[n - 3] !== OK_DIR ||
    segments[n - 2] !== 'templates' ||
    extname(segments[n - 1]) !== '.md'
  ) {
    return false;
  }
  return !templateFolderPrefixIsSkipped(segments, n - 3);
}

function isTemplateContentAncestorDir(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const n = segments.length;
  if (segments[n - 1] === OK_DIR) {
    return !templateFolderPrefixIsSkipped(segments, n - 1);
  }
  if (n >= 2 && segments[n - 1] === 'templates' && segments[n - 2] === OK_DIR) {
    return !templateFolderPrefixIsSkipped(segments, n - 2);
  }
  return false;
}

/**
 * True for a FILE on the shareable `.ok` artifact allow-list:
 *   - `.ok/config.yml` and `.ok/.gitignore`, project root only
 *   - `.ok/schemas/<name>.json`, project root only, flat — `.json` matched
 *     case-insensitively like the schema enumerator's filter
 *   - `<folder>/.ok/templates/<name>.md` at any depth, root included
 *   - `<folder>/.ok/frontmatter.yml` at any depth — root included, because
 *     the project root's own folder metadata lives at `.ok/frontmatter.yml`
 *
 * Exported because the symlink guard's `.ok` write exemption must consult
 * THIS predicate on the resolved path (precedent #55: one predicate for
 * "is this in sync scope", never a parallel copy that can drift).
 *
 * The folder-scoped shapes inherit the templates family's skip-dir bound:
 * these predicates are consulted on flat full paths (head listings, raw
 * watcher events), not only via the top-down walk that prunes skip-dir roots
 * first, so a `frontmatter.yml` vendored under `node_modules/` — or inside
 * `.ok/worktrees/<wt>/…`, whose prefix contains the skip-dir `.ok` — must
 * not leak in.
 */
export function isShareableOkArtifact(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const n = segments.length;
  if (segments[0] === OK_DIR) {
    if (n === 2 && (segments[1] === 'config.yml' || segments[1] === '.gitignore')) return true;
    if (n === 3 && segments[1] === 'schemas' && segments[2].toLowerCase().endsWith('.json')) {
      return true;
    }
  }
  if (isTemplateContentFile(relativePath)) return true;
  if (n >= 2 && segments[n - 1] === 'frontmatter.yml' && segments[n - 2] === OK_DIR) {
    return !templateFolderPrefixIsSkipped(segments, n - 2);
  }
  return false;
}

function isShareableOkArtifactAncestorDir(relativePath: string): boolean {
  if (relativePath === OK_DIR || relativePath === `${OK_DIR}/schemas`) return true;
  return isTemplateContentAncestorDir(relativePath);
}

function isUnderSkillRoot(relativePath: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (relativePath === root || relativePath.startsWith(`${root}/`)) return true;
  }
  return false;
}

function isInPlaceSkillFile(relativePath: string, dirs: ReadonlySet<string>): boolean {
  if (dirs.size === 0) return false;
  for (const d of dirs) {
    if (relativePath.startsWith(`${d}/`)) return true;
  }
  return false;
}

function isInPlaceSkillAncestorDir(relativePath: string, dirs: ReadonlySet<string>): boolean {
  if (dirs.size === 0) return false;
  for (const d of dirs) {
    if (
      d === relativePath ||
      d.startsWith(`${relativePath}/`) ||
      relativePath.startsWith(`${d}/`)
    ) {
      return true;
    }
  }
  return false;
}

const BUILTIN_SKIP_FILES = new Set<string>([
  '.ds_store',
  '.localized',
  'thumbs.db',
  'desktop.ini',
  '.directory',
]);

function isAlwaysSkipFile(relativePath: string): boolean {
  return BUILTIN_SKIP_FILES.has(
    relativePath.slice(relativePath.lastIndexOf('/') + 1).toLowerCase(),
  );
}

const SECRET_BEARING_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);

function pathHasSecretBearingDirSegment(relativePath: string): boolean {
  for (const segment of relativePath.split('/')) {
    if (SECRET_BEARING_DIRS.has(segment.toLowerCase())) return true;
  }
  return false;
}

const SECRET_CREDENTIAL_BASENAMES = new Set([
  'credentials',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.git-credentials',
]);
const SECRET_KEY_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.ppk'] as const;
function isSecretBearingFile(relativePath: string): boolean {
  const lower = relativePath.slice(relativePath.lastIndexOf('/') + 1).toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (SECRET_CREDENTIAL_BASENAMES.has(lower)) return true;
  if (
    lower.startsWith('id_rsa') ||
    lower.startsWith('id_ed25519') ||
    lower.startsWith('id_ecdsa') ||
    lower.startsWith('id_dsa')
  ) {
    return true;
  }
  for (const suffix of SECRET_KEY_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

function isSingleDocAncestorDir(relativeDir: string, singleDocRelPath: string): boolean {
  return singleDocRelPath === relativeDir || singleDocRelPath.startsWith(`${relativeDir}/`);
}

/**
 * Gate that keeps a descendant project's content out of the enclosing
 * project's scope.
 *
 * A directory carrying `.ok/config.yml` is its own project root, so a server
 * anchored there owns those files. Indexing them from the enclosing project as
 * well gives one file on disk two owners that reconcile only through disk
 * writes. `isProjectRoot` is the marker check, and it is also what keeps a
 * nested `.ok/` holding folder rules (`frontmatter.yml`, `templates/`) but no
 * `config.yml` admitted — folder metadata is not a project.
 *
 * Consulted by both `isExcluded` and `isDirExcluded` so a walker pruning
 * directories and a caller classifying a single path agree (precedent #55).
 *
 * Inert in single-file scope: an ephemeral single-doc filter has no enclosing
 * project, and the one admitted doc must stay admitted wherever it lives.
 */
function createDescendantProjectGate(
  projectDir: string,
  contentDir: string,
  singleDocRelPath: string | undefined,
): {
  isInside: (relativePath: string, syncScope?: { pathBase: 'content' | 'project' }) => boolean;
  reset: () => void;
} {
  const enabled = singleDocRelPath === undefined;
  const cache = new Map<string, boolean>();

  function isRoot(absoluteDir: string): boolean {
    const cached = cache.get(absoluteDir);
    if (cached !== undefined) return cached;
    let hit: boolean;
    try {
      hit = isProjectRoot(absoluteDir);
    } catch {
      return false;
    }
    cache.set(absoluteDir, hit);
    return hit;
  }

  return {
    isInside(relativePath: string, syncScope?: { pathBase: 'content' | 'project' }): boolean {
      if (!enabled || relativePath === '') return false;
      const base = syncScope?.pathBase === 'project' ? projectDir : contentDir;
      let prefix = base;
      for (const segment of relativePath.split('/')) {
        prefix = join(prefix, segment);
        if (isRoot(prefix)) return true;
      }
      return false;
    },
    reset(): void {
      cache.clear();
    },
  };
}

const IGNORE_FILE_NAMES = ['.gitignore', '.okignore'] as const;

/**
 * Resolve the patterns `git add` would honor *beyond* the project's
 * `.gitignore` tree: the per-clone `<git-common-dir>/info/exclude` (where
 * `ensureOkExcludedFromGit` itself writes `.ok/`), and the user's
 * `core.excludesfile` — or, when that is unset, git's documented
 * `$XDG_CONFIG_HOME/git/ignore` fallback.
 *
 * Mirroring these into `ContentFilter` keeps the sync walker and `git add`
 * agreed on scope (precedent #55). Without it, the walker can gather a
 * file `.git/info/exclude` already disqualifies, and the next push-cycle
 * `git add -- <path>` errors with `addIgnoredFile`.
 *
 * Gated on the `git rev-parse --git-common-dir` probe succeeding: when
 * `projectDir` isn't a git repo, `git add` is never called and there's no
 * symmetry to maintain — both `.git/info/exclude` AND the global
 * excludesfile are skipped, so non-git OK vaults aren't silently filtered
 * by the user's host-wide git rules.
 *
 * Returns the combined pattern list, or [] when none are reachable
 * (non-git dirs, `git` missing from PATH, files unreadable). All failures
 * are silent — the rest of the filter pipeline (project `.gitignore` +
 * `.okignore`) continues to apply.
 */
function loadGitExcludeSources(projectDir: string, bytesAcc: { value: number }): string[] {
  const commonDir = readGitCommonDirSync(projectDir);
  if (commonDir === null) return [];

  const patterns: string[] = [];
  appendExcludeFileIfExists(join(commonDir, 'info', 'exclude'), bytesAcc, patterns, 'info/exclude');

  const globalExcludePath = resolveGlobalExcludesfileSync(projectDir);
  if (globalExcludePath) {
    appendExcludeFileIfExists(globalExcludePath, bytesAcc, patterns, 'global excludesfile');
  }

  return patterns;
}

async function loadGitExcludeSourcesAsync(
  projectDir: string,
  bytesAcc: { value: number },
): Promise<string[]> {
  const commonDir = await readGitCommonDirAsync(projectDir);
  if (commonDir === null) return [];

  const patterns: string[] = [];
  await appendExcludeFileIfExistsAsync(
    join(commonDir, 'info', 'exclude'),
    bytesAcc,
    patterns,
    'info/exclude',
  );

  const globalExcludePath = await resolveGlobalExcludesfileAsync(projectDir);
  if (globalExcludePath) {
    await appendExcludeFileIfExistsAsync(
      globalExcludePath,
      bytesAcc,
      patterns,
      'global excludesfile',
    );
  }

  return patterns;
}

function readGitCommonDirSync(projectDir: string): string | null {
  const probe = spawnSync(
    'git',
    ['rev-parse', '--git-common-dir'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  if (probe.status !== 0 || !probe.stdout) return null;
  return resolve(projectDir, probe.stdout.trim());
}

async function readGitCommonDirAsync(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--git-common-dir'],
      withHiddenWindowsConsole({
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 5_000,
      }),
    );
    if (!stdout) return null;
    return resolve(projectDir, stdout.trim());
  } catch {
    return null;
  }
}

function resolveGlobalExcludesfileSync(projectDir: string): string | null {
  const configProbe = spawnSync(
    'git',
    ['config', '--get', '--type=path', 'core.excludesfile'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  if (configProbe.status === 0 && configProbe.stdout) {
    const raw = configProbe.stdout.trim();
    if (raw) return raw;
  }
  return xdgGlobalIgnoreDefault();
}

async function resolveGlobalExcludesfileAsync(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', '--type=path', 'core.excludesfile'],
      withHiddenWindowsConsole({ cwd: projectDir, encoding: 'utf-8', timeout: 5_000 }),
    );
    const raw = stdout.trim();
    if (raw) return raw;
  } catch {}
  return xdgGlobalIgnoreDefault();
}

function xdgGlobalIgnoreDefault(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'git', 'ignore');
}

function appendExcludeFileIfExists(
  path: string,
  bytesAcc: { value: number },
  patterns: string[],
  label: string,
): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, 'utf-8');
    bytesAcc.value += content.length;
    patterns.push(...parseIgnorePatterns(content));
  } catch (err) {
    log.warn({ path, err }, `Failed to read ${label} at ${path}`);
  }
}

async function appendExcludeFileIfExistsAsync(
  path: string,
  bytesAcc: { value: number },
  patterns: string[],
  label: string,
): Promise<void> {
  if (!existsSync(path)) return;
  try {
    const content = await readFileAsync(path, 'utf-8');
    bytesAcc.value += content.length;
    patterns.push(...parseIgnorePatterns(content));
  } catch (err) {
    log.warn({ path, err }, `Failed to read ${label} at ${path}`);
  }
}

export interface ContentFilterOptions {
  projectDir: string;
  contentDir: string;
  singleDocRelPath?: string;
  attachmentFolderPath?: string;
  inPlaceSkillDirs?: ReadonlySet<string>;
  skillRootPaths?: ReadonlySet<string>;
  rescanInPlaceSkillDirs?: () => ReadonlySet<string>;
  onAfterRebuild?: () => void;
}

export type RebuildResult =
  | {
      ok: true;
      patternCount: number;
      nestedFileCount: number;
      bytes: number;
      durationMs: number;
    }
  | {
      ok: false;
      error: { message: string };
    };

interface ContentFilterCommonReadOpts {
  respectOkignore?: boolean;
  showOk?: boolean;
}

type ContentFilterOrdinaryReadOpts = ContentFilterCommonReadOpts & {
  bypassFilters?: boolean;
  syncScope?: never;
};

type ContentFilterSyncReadOpts = ContentFilterCommonReadOpts & {
  bypassFilters?: never;
  /**
   * Admit the shareable `.ok` artifact allow-list (`isShareableOkArtifact`)
   * so the sync engine can stage and deletion-track team-shareable OK state
   * — `isExcluded` / `isDirExcluded` only; `isPathIgnored` (the asset-serve
   * gate) keeps the absolute floor, so sync admission never makes these
   * paths HTTP-servable. Paths the unified ignore rules reject stay refused
   * even with the scope: the gather walk and `git add` must agree on every
   * path (precedent #55), and a local-only project's blanket `.ok/` exclude
   * covers exactly this set. Sync-engine staging + head-listing use only —
   * index, sidebar, watcher-event, and conflict-partition callers must not
   * pass it, so these artifacts never surface as documents and their merge
   * conflicts keep the non-content auto-resolve class. Independent of
   * `showOk`. The type contract prevents combining this capability with
   * `bypassFilters`.
   */
  syncScope: { pathBase: 'content' | 'project' };
};

type ContentFilterReadOpts = ContentFilterOrdinaryReadOpts | ContentFilterSyncReadOpts;

type ContentFilterPathReadOpts = Omit<ContentFilterOrdinaryReadOpts, 'syncScope'>;

export interface ContentFilter {
  isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean;
  isDirExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean;
  isPathIgnored(relativePath: string, opts?: ContentFilterPathReadOpts): boolean;
  getWatcherIgnoreGlobs(): string[];
  incrementMdDir(dir: string): void;
  decrementMdDir(dir: string): void;
  rebuildDirCount(): void;
  setAttachmentFolderPath(value: string): void;
  rebuildIgnorePatterns(): Promise<RebuildResult>;

  refreshInPlaceSkillDirs(): void;
  inPlaceSkillDirsFingerprint(): string;
  peekFreshInPlaceSkillDirsFingerprint(): string;
}

export function createContentFilter(opts: ContentFilterOptions): ContentFilter {
  const { projectDir, contentDir, onAfterRebuild, singleDocRelPath } = opts;
  let inPlaceSkillDirs: ReadonlySet<string> = opts.inPlaceSkillDirs ?? new Set();
  let configuredAttachmentFolder = attachmentFolderShape(
    opts.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH,
  );
  const skillRootPaths: ReadonlySet<string> = opts.skillRootPaths ?? new Set();
  const descendantProjects = createDescendantProjectGate(projectDir, contentDir, singleDocRelPath);

  const contentRelPrefix = toPosix(relative(projectDir, contentDir));
  const contentOutsideProject = contentRelPrefix.startsWith('..');

  let ig: Ignore;
  let okignoreIg: Ignore;
  let rootIgnorePatterns: string[];
  let watcherIgnoreGlobs: string[];
  let lastPatternCount = 0;
  let lastNestedFileCount = 0;
  let lastBytes = 0;

  function buildPatternState(): {
    patternCount: number;
    nestedFileCount: number;
    bytes: number;
  } {
    const newIg = ignore();
    const newOkignoreIg = ignore();

    newIg.add('.git');

    const newRootPatterns: string[] = [];
    let bytes = 0;
    let nestedFileCount = 0;

    for (const name of IGNORE_FILE_NAMES) {
      const path = join(projectDir, name);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, 'utf-8');
        bytes += content.length;
        const patterns = parseIgnorePatterns(content);
        newRootPatterns.push(...patterns);
        newIg.add(patterns);
        if (name === '.okignore') newOkignoreIg.add(patterns);
      } catch (err) {
        log.warn({ path, err }, `Failed to read ${name} at ${path}`);
      }
    }

    if (contentRelPrefix && !contentOutsideProject) {
      for (const name of IGNORE_FILE_NAMES) {
        const path = join(contentDir, name);
        if (!existsSync(path)) continue;
        try {
          const content = readFileSync(path, 'utf-8');
          bytes += content.length;
          nestedFileCount++;
          const patterns = parseIgnorePatterns(content);
          const prefixed = patterns.map((p) => prefixPattern(p, contentRelPrefix));
          newIg.add(prefixed);
          if (name === '.okignore') newOkignoreIg.add(prefixed);
        } catch (err) {
          log.warn({ path, err }, `Failed to read ${name} at ${path}`);
        }
      }
    }

    const bytesAcc = { value: bytes };
    nestedFileCount += loadNestedIgnoreFiles(
      contentDir,
      projectDir,
      newIg,
      newOkignoreIg,
      bytesAcc,
    );
    bytes = bytesAcc.value;

    const gitExcludePatterns = loadGitExcludeSources(projectDir, bytesAcc);
    bytes = bytesAcc.value;
    if (gitExcludePatterns.length > 0) {
      newRootPatterns.push(...gitExcludePatterns);
      newIg.add(gitExcludePatterns);
    }

    const newWatcherGlobs = buildWatcherIgnoreGlobs(newRootPatterns);

    ig = newIg;
    okignoreIg = newOkignoreIg;
    rootIgnorePatterns = newRootPatterns;
    watcherIgnoreGlobs = newWatcherGlobs;
    lastPatternCount = newRootPatterns.length;
    lastNestedFileCount = nestedFileCount;
    lastBytes = bytes;

    return {
      patternCount: lastPatternCount,
      nestedFileCount: lastNestedFileCount,
      bytes: lastBytes,
    };
  }

  buildPatternState();

  const dirCount = new Map<string, number>();

  function isIgnored(
    relativePath: string,
    syncScope?: ContentFilterReadOpts['syncScope'],
  ): boolean {
    if (contentOutsideProject && syncScope?.pathBase !== 'project') return false;
    const projectRelPath =
      syncScope?.pathBase === 'project' || !contentRelPrefix
        ? relativePath
        : `${contentRelPrefix}/${relativePath}`;
    if (projectRelPath.startsWith('..')) return false;
    return ig.ignores(projectRelPath);
  }

  function syncProjectRelPath(
    relativePath: string,
    syncScope: NonNullable<ContentFilterReadOpts['syncScope']>,
  ): string {
    return syncScope.pathBase === 'project' || !contentRelPrefix
      ? relativePath
      : `${contentRelPrefix}/${relativePath}`;
  }

  function isOkIgnored(relativePath: string): boolean {
    if (contentOutsideProject) return false;
    const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${relativePath}` : relativePath;
    return okignoreIg.ignores(projectRelPath);
  }

  const refreshDirCount = (): void => {
    if (singleDocRelPath !== undefined) return;
    populateDirCount(contentDir, '', isIgnored, dirCount);
  };

  refreshDirCount();

  function isReservedDocName(relativePath: string): boolean {
    const docName = stripDocExtension(relativePath);
    return isReservedForUserTree(docName);
  }

  function isRejectedByConfigurableRules(relativePath: string): boolean {
    for (const segment of relativePath.split('/')) {
      if (BUILTIN_SKIP_DIRS.has(segment)) return true;
    }

    if (contentOutsideProject) return false;
    return isIgnored(relativePath);
  }

  let rebuildInFlight: Promise<RebuildResult> | null = null;
  let rebuildTrailing: Promise<RebuildResult> | null = null;

  return {
    isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;

      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;

      if (descendantProjects.isInside(relativePath, opts?.syncScope)) return true;

      if (
        !opts?.bypassFilters &&
        isUnderSkillRoot(relativePath, skillRootPaths) &&
        !isInPlaceSkillFile(relativePath, inPlaceSkillDirs)
      ) {
        return true;
      }

      if (
        !opts?.bypassFilters &&
        (isSkillContentFile(relativePath) ||
          (isInPlaceSkillFile(relativePath, inPlaceSkillDirs) && !isIgnored(relativePath)))
      ) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        if (isSupportedDocFile(relativePath)) return false;
        const ext = extname(relativePath).slice(1).toLowerCase();
        return !LINKABLE_ASSET_EXTENSIONS.has(ext);
      }

      if (!opts?.bypassFilters && isTemplateContentFile(relativePath)) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        return false;
      }

      if (
        !opts?.bypassFilters &&
        opts?.syncScope !== undefined &&
        isShareableOkArtifact(syncProjectRelPath(relativePath, opts.syncScope)) &&
        !isIgnored(relativePath, opts.syncScope)
      ) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        return false;
      }

      if (pathHasAlwaysSkipSegment(relativePath, opts?.showOk)) return true;

      if (isAlwaysSkipFile(relativePath)) return true;

      if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;

      if (opts?.bypassFilters) {
        return opts.respectOkignore === true && isOkIgnored(relativePath);
      }

      if (isRejectedByConfigurableRules(relativePath)) return true;

      if (isSupportedDocFile(relativePath)) return false;

      if (
        isConfiguredAttachmentAsset(
          relativePath,
          configuredAttachmentFolder,
          (dir) => (dirCount.get(dir) ?? 0) > 0,
        )
      )
        return false;

      const ext = extname(relativePath).slice(1).toLowerCase();
      if (LINKABLE_ASSET_EXTENSIONS.has(ext)) {
        const dir = dirname(relativePath);
        const normalizedDir = dir === '.' ? '' : dir;
        if ((dirCount.get(normalizedDir) ?? 0) > 0) return false;
      }

      return true;
    },

    isDirExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      if (descendantProjects.isInside(relativePath, opts?.syncScope)) return true;
      if (
        !opts?.bypassFilters &&
        (isSkillContentAncestorDir(relativePath) ||
          isTemplateContentAncestorDir(relativePath) ||
          (opts?.syncScope !== undefined &&
            isShareableOkArtifactAncestorDir(syncProjectRelPath(relativePath, opts.syncScope))) ||
          isInPlaceSkillAncestorDir(relativePath, inPlaceSkillDirs))
      )
        return false;
      if (pathHasAlwaysSkipSegment(relativePath, opts?.showOk)) return true;
      if (singleDocRelPath !== undefined) {
        return !isSingleDocAncestorDir(relativePath, singleDocRelPath);
      }
      if (opts?.bypassFilters) {
        return (
          opts.respectOkignore === true &&
          (isOkIgnored(relativePath) || isOkIgnored(`${relativePath}/`))
        );
      }
      for (const segment of relativePath.split('/')) {
        if (BUILTIN_SKIP_DIRS.has(segment)) return true;
      }
      if (contentOutsideProject) return false;
      return (
        isIgnored(relativePath, opts?.syncScope) || isIgnored(`${relativePath}/`, opts?.syncScope)
      );
    },

    isPathIgnored(relativePath: string, opts?: ContentFilterPathReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      if (
        isSkillContentFile(relativePath) ||
        (isInPlaceSkillFile(relativePath, inPlaceSkillDirs) && !isIgnored(relativePath))
      )
        return false;
      if (isTemplateContentFile(relativePath)) return false;
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      if (isAlwaysSkipFile(relativePath)) return true;
      if (opts?.bypassFilters) return false;
      return isRejectedByConfigurableRules(relativePath);
    },

    getWatcherIgnoreGlobs(): string[] {
      return watcherIgnoreGlobs;
    },

    incrementMdDir(dir: string): void {
      const normalizedDir = dir === '.' ? '' : dir;
      dirCount.set(normalizedDir, (dirCount.get(normalizedDir) ?? 0) + 1);
    },

    decrementMdDir(dir: string): void {
      const normalizedDir = dir === '.' ? '' : dir;
      const current = dirCount.get(normalizedDir) ?? 0;
      if (current <= 1) {
        dirCount.delete(normalizedDir);
      } else {
        dirCount.set(normalizedDir, current - 1);
      }
    },

    rebuildDirCount(): void {
      const prev = new Map(dirCount);
      dirCount.clear();
      try {
        refreshDirCount();
      } catch (err) {
        for (const [k, v] of prev) dirCount.set(k, v);
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'content-filter rebuildDirCount walk failed — retaining previous counts',
        );
      }
    },

    setAttachmentFolderPath(value: string): void {
      configuredAttachmentFolder = attachmentFolderShape(value);
    },

    refreshInPlaceSkillDirs(): void {
      if (!opts.rescanInPlaceSkillDirs) return;
      try {
        inPlaceSkillDirs = opts.rescanInPlaceSkillDirs();
      } catch (err) {
        log.warn({ err }, 'in-place skill re-scan failed — keeping previous allow-list');
      }
    },

    inPlaceSkillDirsFingerprint(): string {
      return [...inPlaceSkillDirs].sort().join('\n');
    },

    peekFreshInPlaceSkillDirsFingerprint(): string {
      if (!opts.rescanInPlaceSkillDirs) return [...inPlaceSkillDirs].sort().join('\n');
      try {
        return [...opts.rescanInPlaceSkillDirs()].sort().join('\n');
      } catch {
        return [...inPlaceSkillDirs].sort().join('\n');
      }
    },

    async rebuildIgnorePatterns(): Promise<RebuildResult> {
      const startRun = (runOnce: () => Promise<RebuildResult>): Promise<RebuildResult> => {
        rebuildInFlight = runOnce().finally(() => {
          rebuildInFlight = null;
        });
        return rebuildInFlight;
      };
      const runRebuild = async (): Promise<RebuildResult> => {
        descendantProjects.reset();
        if (opts.rescanInPlaceSkillDirs) {
          try {
            inPlaceSkillDirs = opts.rescanInPlaceSkillDirs();
          } catch (err) {
            log.warn({ err }, 'in-place skill re-scan failed — keeping previous allow-list');
          }
        }

        const prevIg = ig;
        const prevOkignoreIg = okignoreIg;
        const prevRootPatterns = rootIgnorePatterns;
        const prevWatcherGlobs = watcherIgnoreGlobs;
        const prevPatternCount = lastPatternCount;
        const prevNestedFileCount = lastNestedFileCount;
        const prevBytes = lastBytes;

        const startedAt = Date.now();

        return withSpan('config.ignore.rebuild', { attributes: {} }, async (span) => {
          try {
            const counts = buildPatternState();
            dirCount.clear();
            if (singleDocRelPath === undefined) {
              await populateDirCountYielding(contentDir, isIgnored, dirCount);
            }

            const durationMs = Date.now() - startedAt;
            span.setAttributes({
              'ok.ignore.pattern_count': counts.patternCount,
              'ok.ignore.nested_file_count': counts.nestedFileCount,
              'ok.ignore.bytes': counts.bytes,
            });
            log.info(
              {
                patternCount: counts.patternCount,
                nestedFileCount: counts.nestedFileCount,
                bytes: counts.bytes,
                durationMs,
              },
              'content-filter rebuild succeeded',
            );

            if (onAfterRebuild) {
              try {
                onAfterRebuild();
              } catch (err) {
                log.warn(
                  { err: err instanceof Error ? err : new Error(String(err)) },
                  'content-filter onAfterRebuild callback threw — derived views may be stale',
                );
              }
            }

            return {
              ok: true as const,
              patternCount: counts.patternCount,
              nestedFileCount: counts.nestedFileCount,
              bytes: counts.bytes,
              durationMs,
            };
          } catch (err) {
            ig = prevIg;
            okignoreIg = prevOkignoreIg;
            rootIgnorePatterns = prevRootPatterns;
            watcherIgnoreGlobs = prevWatcherGlobs;
            lastPatternCount = prevPatternCount;
            lastNestedFileCount = prevNestedFileCount;
            lastBytes = prevBytes;
            dirCount.clear();
            try {
              refreshDirCount();
            } catch (rollbackErr) {
              log.warn(
                {
                  err: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)),
                },
                'content-filter rollback dirCount re-walk failed — sibling-asset counts may be stale until next rebuild',
              );
            }

            const message = err instanceof Error ? err.message : String(err);
            log.warn(
              { err: err instanceof Error ? err : new Error(message) },
              'content-filter rebuild failed — rolled back to previous state',
            );
            return { ok: false as const, error: { message } };
          }
        });
      };
      if (rebuildInFlight !== null) {
        if (rebuildTrailing === null) {
          rebuildTrailing = rebuildInFlight
            .catch(() => null)
            .then(() => {
              rebuildTrailing = null;
              return startRun(runRebuild);
            });
        }
        return rebuildTrailing;
      }
      return startRun(runRebuild);
    },
  };
}

const YIELD_EVERY_DIRS = 50;
async function populateDirCountYielding(
  dir: string,
  isIgnored: (path: string) => boolean,
  dirCount: Map<string, number>,
): Promise<void> {
  const stack: Array<{ dir: string; relPath: string }> = [{ dir, relPath: '' }];
  let sinceYield = 0;
  while (stack.length > 0) {
    const { dir: cur, relPath } = stack.pop() as { dir: string; relPath: string };
    sinceYield += 1;
    if (sinceYield >= YIELD_EVERY_DIRS) {
      sinceYield = 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      log.warn({ dir: cur, err }, `Failed to read directory for dir-count: ${cur}`);
      continue;
    }
    for (const entry of entries) {
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (BUILTIN_SKIP_DIRS.has(entry.name)) continue;
        if (isIgnored(childRel) || isIgnored(`${childRel}/`)) continue;
        stack.push({ dir: join(cur, entry.name), relPath: childRel });
      } else if (entry.isFile() && isSupportedDocFile(entry.name) && !isIgnored(childRel)) {
        dirCount.set(relPath, (dirCount.get(relPath) ?? 0) + 1);
      }
    }
  }
}

function populateDirCount(
  dir: string,
  relPath: string,
  isIgnored: (path: string) => boolean,
  dirCount: Map<string, number>,
): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log.warn({ dir, err }, `Failed to read directory for dir-count: ${dir}`);
    return;
  }
  for (const entry of entries) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (BUILTIN_SKIP_DIRS.has(entry.name)) continue;
      if (isIgnored(childRel) || isIgnored(`${childRel}/`)) continue;
      populateDirCount(join(dir, entry.name), childRel, isIgnored, dirCount);
    } else if (entry.isFile() && isSupportedDocFile(entry.name) && !isIgnored(childRel)) {
      dirCount.set(relPath, (dirCount.get(relPath) ?? 0) + 1);
    }
  }
}

function parseIgnorePatterns(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Re-anchor one nested ignore-file pattern into project-root-relative form for
 * the single flattened `ignore` matcher, preserving gitignore depth semantics.
 *
 * gitignore scoping: a bare basename (no leading or embedded slash; an optional
 * trailing `/` doesn't count) matches at ANY depth below the ignore file's
 * directory, while a pattern with a leading or embedded slash is anchored to
 * that directory. A naive `${relPrefix}/${pattern}` always injects an embedded
 * slash, which the `ignore` library reads as root-anchored — silently
 * collapsing an any-depth rule to "this exact level only." That made nested
 * `.blob-storage/` match `<dir>/.blob-storage` but miss `<dir>/agents-api/.blob-storage`,
 * so the sync walker handed `git add` a path git rejects with `addIgnoredFile`
 * (the predicate-symmetry break precedent #55 guards against). Non-anchored
 * patterns therefore get a globstar segment (`relPrefix` + slash + `**` + slash)
 * so they keep matching at any depth.
 */
function prefixPattern(pattern: string, relPrefix: string): string {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const core = body.startsWith('/') ? body.slice(1) : body;
  const withoutTrailingSlash = core.endsWith('/') ? core.slice(0, -1) : core;
  const anchored = body.startsWith('/') || withoutTrailingSlash.includes('/');
  const reanchored = anchored ? `${relPrefix}/${core}` : `${relPrefix}/**/${core}`;
  return negated ? `!${reanchored}` : reanchored;
}

function loadNestedIgnoreFiles(
  dir: string,
  projectDir: string,
  ig: Ignore,
  okignoreIg: Ignore,
  bytesAcc: { value: number },
): number {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log.warn({ dir, err }, `Failed to read directory ${dir}`);
    return 0;
  }

  let count = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (BUILTIN_SKIP_DIRS.has(entry.name)) continue;

    const dirPath = join(dir, entry.name);
    const relToProject = toPosix(relative(projectDir, dirPath));

    if (relToProject.startsWith('..')) continue;

    if (ig.ignores(relToProject) || ig.ignores(`${relToProject}/`)) continue;

    for (const name of IGNORE_FILE_NAMES) {
      const filePath = join(dirPath, name);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, 'utf-8');
        bytesAcc.value += content.length;
        const patterns = parseIgnorePatterns(content);
        const prefixed = patterns.map((p) => prefixPattern(p, relToProject));
        ig.add(prefixed);
        if (name === '.okignore') okignoreIg.add(prefixed);
        count++;
      } catch (err) {
        log.warn({ path: filePath, err }, `Failed to read nested ${name} at ${filePath}`);
      }
    }

    count += loadNestedIgnoreFiles(dirPath, projectDir, ig, okignoreIg, bytesAcc);
  }

  return count;
}

async function initContentDirStateAsync(
  dir: string,
  relPath: string,
  projectDir: string,
  ig: Ignore,
  okignoreIg: Ignore,
  contentRelPrefix: string,
  contentOutsideProject: boolean,
  dirCount: Map<string, number>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    log.warn({ dir, err }, `Failed to read directory ${dir}`);
    return;
  }

  for (const entry of entries) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (BUILTIN_SKIP_DIRS.has(entry.name)) continue;

      const dirPath = join(dir, entry.name);

      if (!contentOutsideProject) {
        const relToProject = toPosix(relative(projectDir, dirPath));
        if (relToProject.startsWith('..')) continue;
        if (ig.ignores(relToProject) || ig.ignores(`${relToProject}/`)) continue;

        for (const name of IGNORE_FILE_NAMES) {
          const filePath = join(dirPath, name);
          if (!existsSync(filePath)) continue;
          try {
            const patterns = parseIgnorePatterns(await readFileAsync(filePath, 'utf-8'));
            const prefixed = patterns.map((p) => prefixPattern(p, relToProject));
            ig.add(prefixed);
            if (name === '.okignore') okignoreIg.add(prefixed);
          } catch (err) {
            log.warn({ path: filePath, err }, `Failed to read nested ${name} at ${filePath}`);
          }
        }
      }

      await initContentDirStateAsync(
        dirPath,
        childRel,
        projectDir,
        ig,
        okignoreIg,
        contentRelPrefix,
        contentOutsideProject,
        dirCount,
      );
    } else if (entry.isFile() && isSupportedDocFile(entry.name)) {
      if (!contentOutsideProject) {
        const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${childRel}` : childRel;
        if (ig.ignores(projectRelPath)) continue;
      }
      dirCount.set(relPath, (dirCount.get(relPath) ?? 0) + 1);
    }
  }
}

export async function createContentFilterAsync(opts: ContentFilterOptions): Promise<ContentFilter> {
  const { projectDir, contentDir, onAfterRebuild, singleDocRelPath } = opts;
  let inPlaceSkillDirs: ReadonlySet<string> = opts.inPlaceSkillDirs ?? new Set();
  let configuredAttachmentFolder = attachmentFolderShape(
    opts.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH,
  );
  const skillRootPaths: ReadonlySet<string> = opts.skillRootPaths ?? new Set();
  const descendantProjects = createDescendantProjectGate(projectDir, contentDir, singleDocRelPath);

  const contentRelPrefix = toPosix(relative(projectDir, contentDir));
  const contentOutsideProject = contentRelPrefix.startsWith('..');

  let ig = ignore();
  let okignoreIg = ignore();
  let watcherIgnoreGlobs: string[] = [];
  let lastPatternCount = 0;

  const dirCount = new Map<string, number>();

  const refreshDirCount = (): void => {
    if (singleDocRelPath !== undefined) return;
    populateDirCount(contentDir, '', isIgnored, dirCount);
  };

  function isIgnored(
    relativePath: string,
    syncScope?: ContentFilterReadOpts['syncScope'],
  ): boolean {
    if (contentOutsideProject && syncScope?.pathBase !== 'project') return false;
    const projectRelPath =
      syncScope?.pathBase === 'project' || !contentRelPrefix
        ? relativePath
        : `${contentRelPrefix}/${relativePath}`;
    if (projectRelPath.startsWith('..')) return false;
    return ig.ignores(projectRelPath);
  }

  function syncProjectRelPath(
    relativePath: string,
    syncScope: NonNullable<ContentFilterReadOpts['syncScope']>,
  ): string {
    return syncScope.pathBase === 'project' || !contentRelPrefix
      ? relativePath
      : `${contentRelPrefix}/${relativePath}`;
  }

  function isOkIgnored(relativePath: string): boolean {
    if (contentOutsideProject) return false;
    const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${relativePath}` : relativePath;
    return okignoreIg.ignores(projectRelPath);
  }

  function isReservedDocName(relativePath: string): boolean {
    const docName = stripDocExtension(relativePath);
    return isReservedForUserTree(docName);
  }
  function isRejectedByConfigurableRules(relativePath: string): boolean {
    for (const segment of relativePath.split('/')) {
      if (BUILTIN_SKIP_DIRS.has(segment)) return true;
    }
    if (contentOutsideProject) return false;
    return isIgnored(relativePath);
  }

  async function buildAndSwapPatternState(): Promise<void> {
    const newIg = ignore();
    const newOkignoreIg = ignore();
    newIg.add('.git');
    const newRootPatterns: string[] = [];

    for (const name of IGNORE_FILE_NAMES) {
      const path = join(projectDir, name);
      if (!existsSync(path)) continue;
      try {
        const patterns = parseIgnorePatterns(await readFileAsync(path, 'utf-8'));
        newRootPatterns.push(...patterns);
        newIg.add(patterns);
        if (name === '.okignore') newOkignoreIg.add(patterns);
      } catch (err) {
        log.warn({ path, err }, `Failed to read ${name} at ${path}`);
      }
    }

    if (contentRelPrefix && !contentOutsideProject) {
      for (const name of IGNORE_FILE_NAMES) {
        const path = join(contentDir, name);
        if (!existsSync(path)) continue;
        try {
          const patterns = parseIgnorePatterns(await readFileAsync(path, 'utf-8'));
          const prefixed = patterns.map((p) => prefixPattern(p, contentRelPrefix));
          newIg.add(prefixed);
          if (name === '.okignore') newOkignoreIg.add(prefixed);
        } catch (err) {
          log.warn({ path, err }, `Failed to read ${name} at ${path}`);
        }
      }
    }

    const bytesAcc = { value: 0 };
    const gitExcludePatterns = await loadGitExcludeSourcesAsync(projectDir, bytesAcc);
    if (gitExcludePatterns.length > 0) {
      newRootPatterns.push(...gitExcludePatterns);
      newIg.add(gitExcludePatterns);
    }

    const newDirCount = new Map<string, number>();
    if (singleDocRelPath === undefined) {
      await initContentDirStateAsync(
        contentDir,
        '',
        projectDir,
        newIg,
        newOkignoreIg,
        contentRelPrefix,
        contentOutsideProject,
        newDirCount,
      );
    }

    ig = newIg;
    okignoreIg = newOkignoreIg;
    watcherIgnoreGlobs = buildWatcherIgnoreGlobs(newRootPatterns);
    lastPatternCount = newRootPatterns.length;
    dirCount.clear();
    for (const [k, v] of newDirCount) dirCount.set(k, v);
  }

  await buildAndSwapPatternState();

  let rebuildInFlight: Promise<RebuildResult> | null = null;
  let rebuildTrailing: Promise<RebuildResult> | null = null;

  return {
    isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      if (descendantProjects.isInside(relativePath, opts?.syncScope)) return true;

      if (
        !opts?.bypassFilters &&
        isUnderSkillRoot(relativePath, skillRootPaths) &&
        !isInPlaceSkillFile(relativePath, inPlaceSkillDirs)
      ) {
        return true;
      }

      if (
        !opts?.bypassFilters &&
        (isSkillContentFile(relativePath) ||
          (isInPlaceSkillFile(relativePath, inPlaceSkillDirs) && !isIgnored(relativePath)))
      ) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        if (isSupportedDocFile(relativePath)) return false;
        const skillExt = extname(relativePath).slice(1).toLowerCase();
        return !LINKABLE_ASSET_EXTENSIONS.has(skillExt);
      }
      if (!opts?.bypassFilters && isTemplateContentFile(relativePath)) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        return false;
      }
      if (
        !opts?.bypassFilters &&
        opts?.syncScope !== undefined &&
        isShareableOkArtifact(syncProjectRelPath(relativePath, opts.syncScope)) &&
        !isIgnored(relativePath, opts.syncScope)
      ) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        return false;
      }
      if (pathHasAlwaysSkipSegment(relativePath, opts?.showOk)) return true;
      if (isAlwaysSkipFile(relativePath)) return true;
      if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
      if (opts?.bypassFilters) {
        return opts.respectOkignore === true && isOkIgnored(relativePath);
      }
      if (isRejectedByConfigurableRules(relativePath)) return true;
      if (isSupportedDocFile(relativePath)) return false;
      if (
        isConfiguredAttachmentAsset(
          relativePath,
          configuredAttachmentFolder,
          (dir) => (dirCount.get(dir) ?? 0) > 0,
        )
      )
        return false;
      const ext = extname(relativePath).slice(1).toLowerCase();
      if (LINKABLE_ASSET_EXTENSIONS.has(ext)) {
        const dir = dirname(relativePath);
        const normalizedDir = dir === '.' ? '' : dir;
        if ((dirCount.get(normalizedDir) ?? 0) > 0) return false;
      }
      return true;
    },

    isDirExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      if (descendantProjects.isInside(relativePath, opts?.syncScope)) return true;
      if (
        !opts?.bypassFilters &&
        (isSkillContentAncestorDir(relativePath) ||
          isTemplateContentAncestorDir(relativePath) ||
          (opts?.syncScope !== undefined &&
            isShareableOkArtifactAncestorDir(syncProjectRelPath(relativePath, opts.syncScope))) ||
          isInPlaceSkillAncestorDir(relativePath, inPlaceSkillDirs))
      )
        return false;
      if (pathHasAlwaysSkipSegment(relativePath, opts?.showOk)) return true;
      if (singleDocRelPath !== undefined) {
        return !isSingleDocAncestorDir(relativePath, singleDocRelPath);
      }
      if (opts?.bypassFilters) {
        return (
          opts.respectOkignore === true &&
          (isOkIgnored(relativePath) || isOkIgnored(`${relativePath}/`))
        );
      }
      for (const segment of relativePath.split('/')) {
        if (BUILTIN_SKIP_DIRS.has(segment)) return true;
      }
      if (contentOutsideProject) return false;
      return (
        isIgnored(relativePath, opts?.syncScope) || isIgnored(`${relativePath}/`, opts?.syncScope)
      );
    },

    isPathIgnored(relativePath: string, opts?: ContentFilterPathReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      if (
        isSkillContentFile(relativePath) ||
        (isInPlaceSkillFile(relativePath, inPlaceSkillDirs) && !isIgnored(relativePath))
      )
        return false;
      if (isTemplateContentFile(relativePath)) return false;
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      if (isAlwaysSkipFile(relativePath)) return true;
      if (opts?.bypassFilters) return false;
      return isRejectedByConfigurableRules(relativePath);
    },

    getWatcherIgnoreGlobs(): string[] {
      return watcherIgnoreGlobs;
    },

    incrementMdDir(dir: string): void {
      const normalizedDir = dir === '.' ? '' : dir;
      dirCount.set(normalizedDir, (dirCount.get(normalizedDir) ?? 0) + 1);
    },

    decrementMdDir(dir: string): void {
      const normalizedDir = dir === '.' ? '' : dir;
      const current = dirCount.get(normalizedDir) ?? 0;
      if (current <= 1) {
        dirCount.delete(normalizedDir);
      } else {
        dirCount.set(normalizedDir, current - 1);
      }
    },

    rebuildDirCount(): void {
      const prev = new Map(dirCount);
      dirCount.clear();
      try {
        refreshDirCount();
      } catch (err) {
        for (const [k, v] of prev) dirCount.set(k, v);
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'content-filter rebuildDirCount walk failed — retaining previous counts',
        );
      }
    },

    setAttachmentFolderPath(value: string): void {
      configuredAttachmentFolder = attachmentFolderShape(value);
    },

    refreshInPlaceSkillDirs(): void {
      if (!opts.rescanInPlaceSkillDirs) return;
      try {
        inPlaceSkillDirs = opts.rescanInPlaceSkillDirs();
      } catch (err) {
        log.warn({ err }, 'in-place skill re-scan failed — keeping previous allow-list');
      }
    },

    inPlaceSkillDirsFingerprint(): string {
      return [...inPlaceSkillDirs].sort().join('\n');
    },

    peekFreshInPlaceSkillDirsFingerprint(): string {
      if (!opts.rescanInPlaceSkillDirs) return [...inPlaceSkillDirs].sort().join('\n');
      try {
        return [...opts.rescanInPlaceSkillDirs()].sort().join('\n');
      } catch {
        return [...inPlaceSkillDirs].sort().join('\n');
      }
    },

    async rebuildIgnorePatterns(): Promise<RebuildResult> {
      const startRun = (runOnce: () => Promise<RebuildResult>): Promise<RebuildResult> => {
        rebuildInFlight = runOnce().finally(() => {
          rebuildInFlight = null;
        });
        return rebuildInFlight;
      };
      const runRebuild = async (): Promise<RebuildResult> => {
        descendantProjects.reset();
        if (opts.rescanInPlaceSkillDirs) {
          try {
            inPlaceSkillDirs = opts.rescanInPlaceSkillDirs();
          } catch (err) {
            log.warn({ err }, 'in-place skill re-scan failed — keeping previous allow-list');
          }
        }
        const prevIg = ig;
        const prevOkignoreIg = okignoreIg;
        const prevWatcherGlobs = watcherIgnoreGlobs;
        const prevDirCount = new Map(dirCount);
        const startedAt = Date.now();

        return withSpan('config.ignore.rebuild', { attributes: {} }, async (span) => {
          try {
            await buildAndSwapPatternState();
            const durationMs = Date.now() - startedAt;
            span.setAttributes({
              'ok.ignore.pattern_count': lastPatternCount,
              'ok.ignore.nested_file_count': 0,
              'ok.ignore.bytes': 0,
            });
            log.info({ durationMs }, 'content-filter async rebuild succeeded');

            if (onAfterRebuild) {
              try {
                onAfterRebuild();
              } catch (err) {
                log.warn(
                  { err: err instanceof Error ? err : new Error(String(err)) },
                  'content-filter onAfterRebuild callback threw — derived views may be stale',
                );
              }
            }

            return {
              ok: true as const,
              patternCount: lastPatternCount,
              nestedFileCount: 0,
              bytes: 0,
              durationMs,
            };
          } catch (err) {
            ig = prevIg;
            okignoreIg = prevOkignoreIg;
            watcherIgnoreGlobs = prevWatcherGlobs;
            dirCount.clear();
            for (const [k, v] of prevDirCount) dirCount.set(k, v);
            const message = err instanceof Error ? err.message : String(err);
            log.warn(
              { err: err instanceof Error ? err : new Error(message) },
              'content-filter async rebuild failed — rolled back',
            );
            return { ok: false as const, error: { message } };
          }
        });
      };
      if (rebuildInFlight !== null) {
        if (rebuildTrailing === null) {
          rebuildTrailing = rebuildInFlight
            .catch(() => null)
            .then(() => {
              rebuildTrailing = null;
              return startRun(runRebuild);
            });
        }
        return rebuildTrailing;
      }
      return startRun(runRebuild);
    },
  };
}
