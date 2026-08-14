import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { normalizeFsPath, tracedAtomicFs, tracedRm } from '../fs-traced.ts';
import { getLogger } from '../logger.ts';

const MANAGED_BLOCK_START = '# BEGIN OpenKnowledge generated indexes';
const MANAGED_BLOCK_END = '# END OpenKnowledge generated indexes';
const MANAGED_BLOCK_NOTE = '# Required while Open Knowledge maintains generated index.md files.';
const log = getLogger('generated-index-git-attributes');

export type GeneratedIndexGitAttributesStatus =
  | { state: 'not-applicable' }
  | { state: 'ready'; ownership: 'open-knowledge' | 'existing' }
  | { state: 'missing' }
  | { state: 'conflict' }
  | { state: 'unavailable' };

export type GeneratedIndexGitAttributesUpdate =
  | {
      ok: true;
      status: GeneratedIndexGitAttributesStatus;
      changed: boolean;
      rollback: () => Promise<void>;
    }
  | { ok: false; status: GeneratedIndexGitAttributesStatus };

interface GitContext {
  gitRoot: string;
  attributesPath: string;
  generatedPaths: string[];
  expectedBlock: string;
}

interface ManagedBlockMatch {
  start: number;
  end: number;
  text: string;
  recognizable: boolean;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function runGit(cwd: string, args: string[], input?: string): ReturnType<typeof spawnSync> {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    input,
    timeout: 10_000,
    windowsHide: true,
  });
}

function gitContext(
  projectDir: string,
  contentDir: string,
  generatedDocNames: Iterable<string>,
): GitContext | GeneratedIndexGitAttributesStatus {
  const rootResult = runGit(projectDir, ['rev-parse', '--show-toplevel']);
  if (rootResult.error) return { state: 'unavailable' };
  if (rootResult.status !== 0) {
    const diagnostic = `${rootResult.stderr ?? ''}${rootResult.stdout ?? ''}`;
    return /not a git repository/i.test(diagnostic)
      ? { state: 'not-applicable' }
      : { state: 'unavailable' };
  }

  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const gitRoot = canonical(String(rootResult.stdout).trim());
  const canonicalContentDir = canonical(contentDir);
  const contentRelative = relative(gitRoot, canonicalContentDir);
  if (contentRelative === '..' || contentRelative.startsWith(`..${sep}`)) {
    return { state: 'not-applicable' };
  }

  const generatedPaths = [...generatedDocNames]
    .map((docName) => `${docName}.md`)
    .map((path) => relative(gitRoot, resolve(canonicalContentDir, path)).split(sep).join('/'))
    .filter((path) => path !== '..' && !path.startsWith('../'));
  if (generatedPaths.length === 0) {
    generatedPaths.push(
      relative(gitRoot, resolve(canonicalContentDir, 'index.md')).split(sep).join('/'),
    );
  }

  const escapedContentPath = contentRelative
    .split(sep)
    .filter(Boolean)
    .map(escapeAttributePatternSegment)
    .join('/');
  const prefix = escapedContentPath.length > 0 ? `/${escapedContentPath}` : '';
  const patterns = [
    `${formatAttributePattern(`${prefix}/index.md`)} merge=union`,
    `${formatAttributePattern(`${prefix}/**/index.md`)} merge=union`,
  ];
  const expectedBlock = [
    MANAGED_BLOCK_START,
    MANAGED_BLOCK_NOTE,
    ...patterns,
    MANAGED_BLOCK_END,
    '',
  ].join('\n');

  return {
    gitRoot,
    attributesPath: resolve(gitRoot, '.gitattributes'),
    generatedPaths: [...new Set(generatedPaths)].sort(),
    expectedBlock,
  };
}

function escapeAttributePatternSegment(segment: string): string {
  return segment.replace(/[\\!?*[\]]/g, (character) => `\\${character}`);
}

function formatAttributePattern(pattern: string): string {
  if (!/\s/.test(pattern)) return pattern;
  return `"${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function assertWritableAttributesPath(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error('refusing to follow a .gitattributes symlink');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function readAttributes(path: string): string | null {
  assertWritableAttributesPath(path);
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

function findManagedBlock(content: string): ManagedBlockMatch | null | 'malformed' {
  const starts = [...content.matchAll(new RegExp(`^${MANAGED_BLOCK_START}$`, 'gm'))];
  const ends = [...content.matchAll(new RegExp(`^${MANAGED_BLOCK_END}$`, 'gm'))];
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) return 'malformed';

  const start = starts[0]?.index;
  const endMarkerStart = ends[0]?.index;
  if (start === undefined || endMarkerStart === undefined || endMarkerStart < start) {
    return 'malformed';
  }
  const markerEnd = endMarkerStart + MANAGED_BLOCK_END.length;
  const newlineLength = content.startsWith('\r\n', markerEnd)
    ? 2
    : /[\r\n]/.test(content[markerEnd] ?? '')
      ? 1
      : 0;
  const end = markerEnd + newlineLength;
  const text = content.slice(start, end);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const body = lines.slice(1, -1);
  const recognizable =
    body[0] === MANAGED_BLOCK_NOTE &&
    body.slice(1).length > 0 &&
    body.slice(1).every((line) => line.endsWith(' merge=union'));
  return { start, end, text, recognizable };
}

function effectiveMergeValues(context: GitContext): string[] | null {
  const result = runGit(
    context.gitRoot,
    ['check-attr', '-z', '--stdin', 'merge'],
    `${context.generatedPaths.join('\0')}\0`,
  );
  if (result.error || result.status !== 0) return null;
  const fields = String(result.stdout).split('\0');
  const values: string[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    values.push(fields[index + 2] ?? 'unspecified');
  }
  return values.length === context.generatedPaths.length ? values : null;
}

function inspectWithContext(
  context: GitContext,
  content: string | null,
): GeneratedIndexGitAttributesStatus {
  const block = findManagedBlock(content ?? '');
  if (block === 'malformed') return { state: 'conflict' };
  if (block && !block.recognizable) return { state: 'conflict' };

  const values = effectiveMergeValues(context);
  if (values === null) return { state: 'unavailable' };
  const allUnion = values.every((value) => value === 'union');
  const hasConflict = values.some((value) => value !== 'union' && value !== 'unspecified');

  if (block) {
    if (
      normalizeLineEndings(block.text).trimEnd() !==
      normalizeLineEndings(context.expectedBlock).trimEnd()
    ) {
      return { state: 'missing' };
    }
    return allUnion ? { state: 'ready', ownership: 'open-knowledge' } : { state: 'conflict' };
  }
  if (hasConflict) return { state: 'conflict' };
  if (content === null) return { state: 'missing' };
  return allUnion ? { state: 'ready', ownership: 'existing' } : { state: 'missing' };
}

export function inspectGeneratedIndexGitAttributes(options: {
  projectDir: string;
  contentDir: string;
  generatedDocNames: Iterable<string>;
}): GeneratedIndexGitAttributesStatus {
  const context = gitContext(options.projectDir, options.contentDir, options.generatedDocNames);
  if (!('gitRoot' in context)) return context;
  try {
    return inspectWithContext(context, readAttributes(context.attributesPath));
  } catch (error) {
    log.warn(
      { err: error, path: normalizeFsPath(context.attributesPath) },
      'failed to inspect generated-index Git attributes',
    );
    return { state: 'unavailable' };
  }
}

function appendManagedBlock(content: string | null, block: string): string {
  if (content === null || content.length === 0) return block;
  const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}${block}`;
}

function replaceManagedBlock(content: string, match: ManagedBlockMatch, block: string): string {
  return `${content.slice(0, match.start)}${block}${content.slice(match.end)}`;
}

function removeManagedBlock(content: string, match: ManagedBlockMatch): string {
  const before = content
    .slice(0, match.start)
    .replace(/(?:\r?\n){2,}$/, (newlines) => (newlines.endsWith('\r\n') ? '\r\n' : '\n'));
  const after = content.slice(match.end).replace(/^(?:\r?\n)+/, '');
  return `${before}${after}`;
}

async function restoreAttributes(
  path: string,
  previous: string | null,
  expectedCurrent: string | null,
): Promise<void> {
  const current = readAttributes(path);
  if (current === previous) return;
  if (current !== expectedCurrent) {
    throw new Error('.gitattributes changed after Open Knowledge updated it');
  }
  if (previous === null) {
    await tracedRm(path);
    return;
  }
  await atomicWriteFile(path, previous, { fs: tracedAtomicFs });
}

export async function updateGeneratedIndexGitAttributes(options: {
  projectDir: string;
  contentDir: string;
  generatedDocNames: Iterable<string>;
  enabled: boolean;
}): Promise<GeneratedIndexGitAttributesUpdate> {
  const context = gitContext(options.projectDir, options.contentDir, options.generatedDocNames);
  if (!('gitRoot' in context)) {
    if (context.state === 'not-applicable') {
      return { ok: true, status: context, changed: false, rollback: async () => {} };
    }
    return { ok: false, status: context };
  }

  let previous: string | null;
  try {
    previous = readAttributes(context.attributesPath);
  } catch (error) {
    log.warn(
      { err: error, path: normalizeFsPath(context.attributesPath) },
      'failed to read generated-index Git attributes',
    );
    return { ok: false, status: { state: 'unavailable' } };
  }
  const beforeStatus = inspectWithContext(context, previous);

  if (!options.enabled) {
    const match = findManagedBlock(previous ?? '');
    if (match === null) {
      return { ok: true, status: beforeStatus, changed: false, rollback: async () => {} };
    }
    if (match === 'malformed' || !match.recognizable) {
      return { ok: false, status: { state: 'conflict' } };
    }
    const next = removeManagedBlock(previous ?? '', match);
    try {
      if (readAttributes(context.attributesPath) !== previous) {
        return { ok: false, status: { state: 'unavailable' } };
      }
      if (next.length === 0) {
        await tracedRm(context.attributesPath);
      } else {
        await atomicWriteFile(context.attributesPath, next, { fs: tracedAtomicFs });
      }
      return {
        ok: true,
        status: inspectWithContext(context, next.length === 0 ? null : next),
        changed: true,
        rollback: () =>
          restoreAttributes(context.attributesPath, previous, next.length === 0 ? null : next),
      };
    } catch (error) {
      log.warn(
        { err: error, path: normalizeFsPath(context.attributesPath) },
        'failed to remove generated-index Git attributes',
      );
      return { ok: false, status: { state: 'unavailable' } };
    }
  }

  if (beforeStatus.state === 'ready' && previous !== null) {
    return { ok: true, status: beforeStatus, changed: false, rollback: async () => {} };
  }
  if (beforeStatus.state === 'conflict' || beforeStatus.state === 'unavailable') {
    return { ok: false, status: beforeStatus };
  }

  const existingMatch = findManagedBlock(previous ?? '');
  if (existingMatch === 'malformed' || (existingMatch && !existingMatch.recognizable)) {
    return { ok: false, status: { state: 'conflict' } };
  }
  const next = existingMatch
    ? replaceManagedBlock(previous ?? '', existingMatch, context.expectedBlock)
    : appendManagedBlock(previous, context.expectedBlock);
  try {
    if (readAttributes(context.attributesPath) !== previous) {
      return { ok: false, status: { state: 'unavailable' } };
    }
    await atomicWriteFile(context.attributesPath, next, { fs: tracedAtomicFs });
    const afterStatus = inspectWithContext(context, next);
    if (afterStatus.state !== 'ready') {
      await restoreAttributes(context.attributesPath, previous, next);
      return { ok: false, status: afterStatus };
    }
    return {
      ok: true,
      status: afterStatus,
      changed: true,
      rollback: () => restoreAttributes(context.attributesPath, previous, next),
    };
  } catch (error) {
    try {
      await restoreAttributes(context.attributesPath, previous, next);
    } catch (rollbackError) {
      log.warn(
        { err: rollbackError, path: normalizeFsPath(context.attributesPath) },
        'failed to roll back generated-index Git attributes',
      );
      // The caller still receives unavailable; a second write cannot make the
      // original setup trustworthy enough to enable generation.
    }
    log.warn(
      { err: error, path: normalizeFsPath(context.attributesPath) },
      'failed to update generated-index Git attributes',
    );
    return { ok: false, status: { state: 'unavailable' } };
  }
}
