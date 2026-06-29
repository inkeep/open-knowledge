import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LINKABLE_ASSET_EXTENSIONS, SKILL_CONTENT_ROOT } from '@inkeep/open-knowledge-core';
import ignore, { type Ignore } from 'ignore';
import { isReservedForUserTree } from './cc1-broadcast.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';
import { withSpan } from './telemetry.ts';

const execFileAsync = promisify(execFileCb);

/**
 * Directories that are always skipped during traversal, independent of
 * `.gitignore` / `.okignore`.
 *
 * Criteria: never contains user-authored markdown AND either (a) uses symlinks
 * aggressively, (b) is a massive tree, or (c) is a framework/tool cache.
 *
 * Package managers / language runtimes:
 *   node_modules  — pnpm broken symlinks crash statSync; massive tree
 *   .venv / venv / env — Python virtualenvs
 *   __pycache__   — Python bytecode
 *   vendor        — Go / PHP / Ruby vendored deps
 *
 * Build output:
 *   dist / build / out / output — compiled assets
 *   .next / .nuxt / .svelte-kit / .astro — framework build caches
 *   .turbo / .cache / .parcel-cache     — build tool caches
 *   coverage                            — test coverage reports
 *
 * VCS / per-project state:
 *   .git — already in the ig instance; hardcoded here for the fast-path
 *   .ok  — per-project state dir; the committed `.ok/.gitignore` already
 *          self-ignores its contents for git, but adding it here lets the
 *          walker skip the descent entirely
 *   .open-knowledge / .openknowledge — legacy per-project state dirs from
 *          pre-rename OK versions (≤v0.3.0). Kept in the skip set so any
 *          residue left on disk in user content dirs stays out of the
 *          sidebar even though the codebase no longer writes to them.
 *
 * OS-managed directories (macOS):
 *   Library     — application data, caches, preferences; ~macOS only but safe
 *                 to skip on all platforms (no project ever authors markdown here)
 *   Applications — macOS app bundles; never user markdown
 *   .Trash      — OS recycle bin; symlink-heavy, contents irrelevant
 */
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
  '.claude',
  '.cursor',
  '.codex',
  '.agents',
  '.opencode',
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
  '.claude',
  '.cursor',
  '.codex',
  '.agents',
  '.opencode',
]);

function pathHasAlwaysSkipSegment(relativePath: string): boolean {
  for (const segment of relativePath.split('/')) {
    if (ALWAYS_SKIP_DIRS.has(segment)) return true;
  }
  return false;
}

function isSkillContentFile(relativePath: string): boolean {
  return relativePath.startsWith(`${SKILL_CONTENT_ROOT}/`);
}

function isSkillContentAncestorDir(relativePath: string): boolean {
  return (
    relativePath === '.ok' ||
    relativePath === SKILL_CONTENT_ROOT ||
    relativePath.startsWith(`${SKILL_CONTENT_ROOT}/`)
  );
}

function globBlocksSkillContent(pattern: string): boolean {
  const p = pattern.replace(/^\/+/, '').replace(/\/+$/, '').trim();
  return p === '.ok' || p === '.ok/**' || p === '**/.ok' || p === '**/.ok/**';
}

const BUILTIN_SKIP_FILES = new Set<string>(['.DS_Store', '.localized']);

function isAlwaysSkipFile(relativePath: string): boolean {
  return BUILTIN_SKIP_FILES.has(relativePath.slice(relativePath.lastIndexOf('/') + 1));
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

const IGNORE_FILE_NAMES = ['.gitignore', '.okignore'] as const;

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
  const probe = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  return resolve(projectDir, probe.stdout.trim());
}

async function readGitCommonDirAsync(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (!stdout) return null;
    return resolve(projectDir, stdout.trim());
  } catch {
    return null;
  }
}

function resolveGlobalExcludesfileSync(projectDir: string): string | null {
  const configProbe = spawnSync('git', ['config', '--get', '--type=path', 'core.excludesfile'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
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
      { cwd: projectDir, encoding: 'utf-8', timeout: 5_000 },
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
    console.warn(`[content-filter] Failed to read ${label} at ${path}:`, err);
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
    console.warn(`[content-filter] Failed to read ${label} at ${path}:`, err);
  }
}

export interface ContentFilterOptions {
  projectDir: string;
  contentDir: string;
  singleDocRelPath?: string;
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

interface ContentFilterReadOpts {
  bypassFilters?: boolean;
}

export interface ContentFilter {
  isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean;
  isDirExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean;
  isPathIgnored(relativePath: string, opts?: ContentFilterReadOpts): boolean;
  getWatcherIgnoreGlobs(): string[];
  incrementMdDir(dir: string): void;
  decrementMdDir(dir: string): void;
  rebuildDirCount(): void;
  rebuildIgnorePatterns(): Promise<RebuildResult>;
}

export function createContentFilter(opts: ContentFilterOptions): ContentFilter {
  const { projectDir, contentDir, onAfterRebuild, singleDocRelPath } = opts;

  const contentRelPrefix = toPosix(relative(projectDir, contentDir));
  const contentOutsideProject = contentRelPrefix.startsWith('..');

  let ig: Ignore;
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
      } catch (err) {
        console.warn(`[content-filter] Failed to read ${name} at ${path}:`, err);
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
        } catch (err) {
          console.warn(`[content-filter] Failed to read ${name} at ${path}:`, err);
        }
      }
    }

    const bytesAcc = { value: bytes };
    nestedFileCount += loadNestedIgnoreFiles(contentDir, projectDir, newIg, bytesAcc);
    bytes = bytesAcc.value;

    const gitExcludePatterns = loadGitExcludeSources(projectDir, bytesAcc);
    bytes = bytesAcc.value;
    if (gitExcludePatterns.length > 0) {
      newRootPatterns.push(...gitExcludePatterns);
      newIg.add(gitExcludePatterns);
    }

    const newWatcherGlobs = newRootPatterns.filter(
      (p) => p.length > 0 && !p.startsWith('!') && !p.startsWith('#') && !globBlocksSkillContent(p),
    );

    ig = newIg;
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

  function isIgnored(relativePath: string): boolean {
    if (contentOutsideProject) return false;
    const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${relativePath}` : relativePath;
    return ig.ignores(projectRelPath);
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

  return {
    isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;

      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;

      if (!opts?.bypassFilters && isSkillContentFile(relativePath)) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        if (isSupportedDocFile(relativePath)) return false;
        const ext = extname(relativePath).slice(1).toLowerCase();
        return !LINKABLE_ASSET_EXTENSIONS.has(ext);
      }

      if (pathHasAlwaysSkipSegment(relativePath)) return true;

      if (isAlwaysSkipFile(relativePath)) return true;

      if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;

      if (opts?.bypassFilters) return false;

      if (isRejectedByConfigurableRules(relativePath)) return true;

      if (isSupportedDocFile(relativePath)) return false;

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
      if (!opts?.bypassFilters && isSkillContentAncestorDir(relativePath)) return false;
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      if (singleDocRelPath !== undefined) {
        return !isSingleDocAncestorDir(relativePath, singleDocRelPath);
      }
      if (opts?.bypassFilters) return false;
      for (const segment of relativePath.split('/')) {
        if (BUILTIN_SKIP_DIRS.has(segment)) return true;
      }
      if (contentOutsideProject) return false;
      const projectRelPath = contentRelPrefix
        ? `${contentRelPrefix}/${relativePath}`
        : relativePath;
      return ig.ignores(projectRelPath) || ig.ignores(`${projectRelPath}/`);
    },

    isPathIgnored(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      if (isSkillContentFile(relativePath)) return false;
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
        getLogger('content-filter').warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'content-filter rebuildDirCount walk failed — retaining previous counts',
        );
      }
    },

    async rebuildIgnorePatterns(): Promise<RebuildResult> {
      const log = getLogger('content-filter');

      const prevIg = ig;
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
          refreshDirCount();

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
    },
  };
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
    console.warn(`[content-filter] Failed to read directory for dir-count: ${dir}`, err);
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
  bytesAcc: { value: number },
): number {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[content-filter] Failed to read directory ${dir}:`, err);
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
        count++;
      } catch (err) {
        console.warn(`[content-filter] Failed to read nested ${name} at ${filePath}:`, err);
      }
    }

    count += loadNestedIgnoreFiles(dirPath, projectDir, ig, bytesAcc);
  }

  return count;
}

async function initContentDirStateAsync(
  dir: string,
  relPath: string,
  projectDir: string,
  ig: Ignore,
  contentRelPrefix: string,
  contentOutsideProject: boolean,
  dirCount: Map<string, number>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[content-filter] Failed to read directory ${dir}:`, err);
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
            ig.add(patterns.map((p) => prefixPattern(p, relToProject)));
          } catch (err) {
            console.warn(`[content-filter] Failed to read nested ${name} at ${filePath}:`, err);
          }
        }
      }

      await initContentDirStateAsync(
        dirPath,
        childRel,
        projectDir,
        ig,
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

  const contentRelPrefix = toPosix(relative(projectDir, contentDir));
  const contentOutsideProject = contentRelPrefix.startsWith('..');

  let ig = ignore();
  let watcherIgnoreGlobs: string[] = [];

  const dirCount = new Map<string, number>();

  const refreshDirCount = (): void => {
    if (singleDocRelPath !== undefined) return;
    populateDirCount(contentDir, '', isIgnored, dirCount);
  };

  function isIgnored(relativePath: string): boolean {
    if (contentOutsideProject) return false;
    const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${relativePath}` : relativePath;
    return ig.ignores(projectRelPath);
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
    newIg.add('.git');
    const newRootPatterns: string[] = [];

    for (const name of IGNORE_FILE_NAMES) {
      const path = join(projectDir, name);
      if (!existsSync(path)) continue;
      try {
        const patterns = parseIgnorePatterns(await readFileAsync(path, 'utf-8'));
        newRootPatterns.push(...patterns);
        newIg.add(patterns);
      } catch (err) {
        console.warn(`[content-filter] Failed to read ${name} at ${path}:`, err);
      }
    }

    if (contentRelPrefix && !contentOutsideProject) {
      for (const name of IGNORE_FILE_NAMES) {
        const path = join(contentDir, name);
        if (!existsSync(path)) continue;
        try {
          const patterns = parseIgnorePatterns(await readFileAsync(path, 'utf-8'));
          newIg.add(patterns.map((p) => prefixPattern(p, contentRelPrefix)));
        } catch (err) {
          console.warn(`[content-filter] Failed to read ${name} at ${path}:`, err);
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
        contentRelPrefix,
        contentOutsideProject,
        newDirCount,
      );
    }

    ig = newIg;
    watcherIgnoreGlobs = newRootPatterns.filter(
      (p) => p.length > 0 && !p.startsWith('!') && !p.startsWith('#') && !globBlocksSkillContent(p),
    );
    dirCount.clear();
    for (const [k, v] of newDirCount) dirCount.set(k, v);
  }

  await buildAndSwapPatternState();

  return {
    isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      if (!opts?.bypassFilters && isSkillContentFile(relativePath)) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        if (isSupportedDocFile(relativePath)) return false;
        const skillExt = extname(relativePath).slice(1).toLowerCase();
        return !LINKABLE_ASSET_EXTENSIONS.has(skillExt);
      }
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      if (isAlwaysSkipFile(relativePath)) return true;
      if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
      if (opts?.bypassFilters) return false;
      if (isRejectedByConfigurableRules(relativePath)) return true;
      if (isSupportedDocFile(relativePath)) return false;
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
      if (!opts?.bypassFilters && isSkillContentAncestorDir(relativePath)) return false;
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      if (singleDocRelPath !== undefined) {
        return !isSingleDocAncestorDir(relativePath, singleDocRelPath);
      }
      if (opts?.bypassFilters) return false;
      for (const segment of relativePath.split('/')) {
        if (BUILTIN_SKIP_DIRS.has(segment)) return true;
      }
      if (contentOutsideProject) return false;
      const projectRelPath = contentRelPrefix
        ? `${contentRelPrefix}/${relativePath}`
        : relativePath;
      return ig.ignores(projectRelPath) || ig.ignores(`${projectRelPath}/`);
    },

    isPathIgnored(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      if (isSkillContentFile(relativePath)) return false;
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
        getLogger('content-filter').warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'content-filter rebuildDirCount walk failed — retaining previous counts',
        );
      }
    },

    async rebuildIgnorePatterns(): Promise<RebuildResult> {
      const log = getLogger('content-filter');
      const prevIg = ig;
      const prevWatcherGlobs = watcherIgnoreGlobs;
      const prevDirCount = new Map(dirCount);
      const startedAt = Date.now();

      return withSpan('config.ignore.rebuild', { attributes: {} }, async (span) => {
        try {
          await buildAndSwapPatternState();
          const durationMs = Date.now() - startedAt;
          span.setAttributes({
            'ok.ignore.pattern_count': watcherIgnoreGlobs.length,
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
            patternCount: watcherIgnoreGlobs.length,
            nestedFileCount: 0,
            bytes: 0,
            durationMs,
          };
        } catch (err) {
          ig = prevIg;
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
    },
  };
}
