import { spawn } from 'node:child_process';
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DESKTOP_PRODUCTS,
  OK_MACHINE_LOCAL_ROOT_DIRS,
  OK_MACHINE_LOCAL_ROOT_FILES,
  OK_USER_HOME_CREDENTIAL_FILES,
  REFUSED_SYMLINK_PATHS_CAP,
} from '@inkeep/open-knowledge-core';
import type { SimpleGit } from 'simple-git';
import { isSecretBearingFile, pathHasSecretBearingDirSegment } from './content-filter.ts';
import { createGitInstance } from './git-handle.ts';
import { compareSemver, parseGitVersion } from './git-preflight.ts';
import { errnoCode } from './http/handler-utils.ts';

export const SYMLINK_MERGE_MIN_GIT_VERSION = '2.38.0';
export const SYMLINK_MERGE_MIN_GIT_LABEL = '2.38';

const GIT_SYMLINK_MODE = '120000';
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';
const REPORTED_PATH_LIMIT = 5;
const MAX_SYMLINK_TARGET_BYTES = 4096;
const MAX_WALK_STEPS = 256;
const MAX_SYMLINK_HOPS = 40;
const MAX_INSPECTION_STEPS = 20_000;
const BLOB_READ_TIMEOUT_MS = 60_000;
const HFS_IGNORABLE_CHARACTERS = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/gu;
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const REPOSITORY_SCOPED_GIT_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
];

function foldOnce(name: string): string {
  return name
    .replace(HFS_IGNORABLE_CHARACTERS, '')
    .normalize('NFC')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFC');
}

function foldName(name: string): string {
  let folded = foldOnce(name);
  for (let round = 0; round < 4; round++) {
    const next = foldOnce(folded);
    if (next === folded) break;
    folded = next;
  }
  return folded.replace(/[. ]+$/u, (trailing, offset: number) => (offset === 0 ? trailing : ''));
}

function foldPath(path: string): string {
  return path.split('/').map(foldName).join('/');
}

const CONFIG_DIR_NAMES: ReadonlySet<string> = new Set(
  [
    '.ok',
    '.open-knowledge',
    '.openknowledge',
    ...Object.values(DESKTOP_PRODUCTS).map(({ userHomeDirName }) => userHomeDirName),
  ].map(foldName),
);
const MACHINE_LOCAL_NAMES: ReadonlySet<string> = new Set(
  [
    ...OK_MACHINE_LOCAL_ROOT_DIRS,
    ...OK_MACHINE_LOCAL_ROOT_FILES,
    ...OK_USER_HOME_CREDENTIAL_FILES,
  ].map(foldName),
);

function shortNamePattern(longNames: Iterable<string>): RegExp {
  const alternatives = new Set<string>();
  for (const name of longNames) {
    const basis = name.replace(/^\.+/u, '');
    if (!/^[a-z0-9-]+$/u.test(basis)) {
      throw new Error(`cannot derive 8.3 short names for config dir "${name}"`);
    }
    if (basis.length <= 2) {
      alternatives.add(`${basis}[0-9a-f]{4}`);
    } else {
      alternatives.add(basis.slice(0, 6));
      alternatives.add(`${basis.slice(0, 2)}[0-9a-f]{4}`);
    }
  }
  return new RegExp(`^(?:${[...alternatives].join('|')})~\\d+$`, 'u');
}

const CONFIG_DIR_SHORT_NAME = shortNamePattern(CONFIG_DIR_NAMES);

function isShortNameAlias(folded: string): boolean {
  return /^[^.~]{1,7}~\d{1,7}(?:\.[^.]{1,3})?$/u.test(folded);
}

function isGitDirName(folded: string): boolean {
  return folded === '.git' || /^git~\d+$/u.test(folded);
}

function isConfigDirName(folded: string): boolean {
  return CONFIG_DIR_NAMES.has(folded) || CONFIG_DIR_SHORT_NAME.test(folded);
}

export type UnsafeSymlinkReason =
  | 'outside-repository'
  | 'repository-root'
  | 'private-state'
  | 'secret-file'
  | 'inside-private-state'
  | 'requires-newer-git'
  | 'unverifiable-target';

export interface UnsafeIncomingSymlink {
  path: string;
  reason: UnsafeSymlinkReason;
}

interface TreeSymlink {
  path: string;
  folded: string;
  blob: string;
  size: number;
}

interface TreeListing {
  links: TreeSymlink[];
  spellings: Map<string, Set<string>>;
}

interface Inspection {
  links: TreeSymlink[];
  spellings: ReadonlyMap<string, ReadonlySet<string>>;
  changed: ReadonlySet<string>;
  changedPaths: readonly string[];
  candidates: ConflictCandidate[];
  conflicted: ConflictedPath[];
  refused: UnsafeIncomingSymlink[];
  targets: ReadonlyMap<string, string>;
}

type Resolution = { kind: 'plain' } | { kind: 'link'; target: string } | { kind: 'unverifiable' };

interface WalkOutcome {
  reason: UnsafeSymlinkReason | null;
  crossed: ReadonlySet<string>;
  complete: boolean;
}

function privateStateIndex(folded: readonly string[]): number {
  return folded.findIndex(
    (segment, index) =>
      isGitDirName(segment) ||
      (isConfigDirName(segment) &&
        (index === folded.length - 1 || MACHINE_LOCAL_NAMES.has(folded[index + 1] ?? ''))),
  );
}

function touchesPrivateState(folded: readonly string[]): boolean {
  return privateStateIndex(folded) >= 0;
}

export function symlinkReachesPrivateState(lexicalRel: string, canonicalRel: string): boolean {
  const lexical = foldPath(lexicalRel).split('/');
  const canonical = foldPath(canonicalRel).split('/');
  if (lexical.join('/') === canonical.join('/')) return false;
  const index = privateStateIndex(canonical);
  if (index < 0) return false;
  const last = canonical.length - 1;
  const spelledFolderConfigDir =
    index === last &&
    isConfigDirName(canonical[last] ?? '') &&
    lexical[lexical.length - 1] === canonical[last];
  return !spelledFolderConfigDir;
}

function isUnverifiableTarget(target: string): boolean {
  return (
    target === '' ||
    target.includes('\0') ||
    target.includes('\\') ||
    target.includes(':') ||
    Buffer.byteLength(target, 'utf-8') > MAX_SYMLINK_TARGET_BYTES
  );
}

async function walkLink(
  linkPath: string,
  target: string,
  resolve: (folded: string, raw: string) => Promise<Resolution>,
  budget: { steps: number },
): Promise<WalkOutcome> {
  const crossed = new Set<string>();
  const outcome = (reason: UnsafeSymlinkReason | null): WalkOutcome => ({
    reason,
    crossed,
    complete: true,
  });
  const cut = (): WalkOutcome => ({ reason: 'unverifiable-target', crossed, complete: false });
  if (isUnverifiableTarget(target)) return outcome('unverifiable-target');
  if (target.startsWith('/')) return outcome('outside-repository');
  const pending = [...linkPath.split('/').slice(0, -1), ...target.split('/')];
  const raw: string[] = [];
  const folded: string[] = [];
  let steps = 0;
  let hops = 0;
  while (pending.length > 0) {
    const step = pending.shift() ?? '';
    steps += 1;
    budget.steps -= 1;
    if (steps > MAX_WALK_STEPS || budget.steps < 0) return cut();
    if (step === '' || step === '.') continue;
    if (step === '..') {
      if (raw.length === 0) return outcome('outside-repository');
      raw.pop();
      folded.pop();
      continue;
    }
    raw.push(step);
    const segment = foldName(step);
    folded.push(segment);
    if (isShortNameAlias(segment)) {
      return touchesPrivateState(folded)
        ? { reason: 'private-state', crossed, complete: false }
        : cut();
    }
    const visited = folded.join('/');
    crossed.add(visited);
    const resolution = await resolve(visited, raw.join('/'));
    if (resolution.kind === 'unverifiable') return cut();
    if (resolution.kind === 'link') {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS || isUnverifiableTarget(resolution.target)) return cut();
      if (resolution.target.startsWith('/')) return outcome('outside-repository');
      raw.pop();
      folded.pop();
      pending.unshift(...resolution.target.split('/'));
    }
  }
  if (folded.length === 0) return outcome('repository-root');
  if (touchesPrivateState(folded)) return outcome('private-state');
  const resolved = folded.join('/');
  if (isSecretBearingFile(resolved) || pathHasSecretBearingDirSegment(resolved)) {
    return outcome('secret-file');
  }
  return outcome(null);
}

function addSpelling(spellings: Map<string, Set<string>>, path: string): void {
  const segments = path.split('/');
  for (let length = 1; length <= segments.length; length++) {
    const prefix = segments.slice(0, length).join('/');
    const key = foldPath(prefix);
    const known = spellings.get(key);
    if (known === undefined) spellings.set(key, new Set([prefix]));
    else known.add(prefix);
  }
}

async function listTree(git: SimpleGit, treeish: string): Promise<TreeListing> {
  const raw = await git.raw(['ls-tree', '-r', '-z', '-l', '--full-tree', treeish]);
  const links: TreeSymlink[] = [];
  const spellings = new Map<string, Set<string>>();
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, , blob, size] = record.slice(0, Math.max(tab, 0)).trim().split(/\s+/u);
    if (tab < 0 || mode === undefined || blob === undefined || size === undefined) {
      throw new Error('unparseable git ls-tree record while inspecting incoming symlinks');
    }
    const path = record.slice(tab + 1);
    addSpelling(spellings, path);
    if (mode === GIT_SYMLINK_MODE) {
      links.push({ path, folded: foldPath(path), blob, size: Number(size) });
    }
  }
  return { links, spellings };
}

async function changedLinkPaths(
  git: SimpleGit,
  from: string,
  to: string,
): Promise<Map<string, string>> {
  const raw = await git.raw([
    'diff-tree',
    '-r',
    '-z',
    '--raw',
    '--no-renames',
    '--no-abbrev',
    from,
    to,
  ]);
  const records = raw.split('\0');
  const changed = new Map<string, string>();
  for (let i = 0; i + 1 < records.length; i += 2) {
    const meta = records[i] ?? '';
    const path = records[i + 1] ?? '';
    const [srcMode, dstMode] = meta.replace(/^\n?:/u, '').split(' ');
    if (!meta.includes(':') || dstMode === undefined || path === '') {
      throw new Error('unparseable git diff-tree record while inspecting incoming symlinks');
    }
    if (srcMode === GIT_SYMLINK_MODE || dstMode === GIT_SYMLINK_MODE) {
      changed.set(foldPath(path), path);
    }
  }
  return changed;
}

function blobReadEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...(env ?? process.env) };
  for (const name of REPOSITORY_SCOPED_GIT_VARIABLES) delete next[name];
  next.GIT_TERMINAL_PROMPT = '0';
  next.GIT_NO_LAZY_FETCH = '1';
  return next;
}

class IncomingBlobReadError extends Error {
  readonly failure: string;
  readonly detail: unknown;
  readonly stderr: string;

  constructor(failure: string, detail: unknown, stderr: string) {
    super(`could not read incoming symlink targets from git (${failure})`);
    this.name = 'IncomingBlobReadError';
    this.failure = failure;
    this.detail = detail;
    this.stderr = stderr;
  }
}

function readBlobs(
  repoRoot: string,
  links: readonly Pick<TreeSymlink, 'blob' | 'size'>[],
  env: NodeJS.ProcessEnv | undefined,
): Promise<Map<string, string>> {
  const wanted = [
    ...new Set(
      links
        .filter((link) => Number.isFinite(link.size) && link.size <= MAX_SYMLINK_TARGET_BYTES)
        .map((link) => link.blob),
    ),
  ];
  if (wanted.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    let settled = false;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const settle = (result: Map<string, string> | { failure: string; detail?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Map) {
        resolve(result);
        return;
      }
      reject(
        new IncomingBlobReadError(
          result.failure,
          result.detail,
          Buffer.concat(stderr).toString('utf-8'),
        ),
      );
    };
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      env: blobReadEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ failure: 'timeout' });
    }, BLOB_READ_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 4096) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.stdin.on('error', (err) => settle({ failure: 'stdin', detail: errnoCode(err) }));
    child.on('error', (err) => settle({ failure: 'spawn', detail: errnoCode(err) }));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        settle({ failure: 'exit', detail: signal ?? code });
        return;
      }
      const out = Buffer.concat(chunks);
      const blobs = new Map<string, string>();
      let offset = 0;
      for (const blob of wanted) {
        const headerEnd = out.indexOf(0x0a, offset);
        const [sha, type, size] = out.subarray(offset, headerEnd).toString('utf-8').split(' ');
        const length = Number(size);
        if (headerEnd < 0 || sha !== blob || type !== 'blob' || !Number.isFinite(length)) {
          settle({ failure: 'output' });
          return;
        }
        blobs.set(blob, out.subarray(headerEnd + 1, headerEnd + 1 + length).toString('utf-8'));
        offset = headerEnd + 1 + length + 1;
      }
      settle(blobs);
    });
    child.stdin.end(`${wanted.join('\n')}\n`);
  });
}

async function emptyTree(git: SimpleGit): Promise<string> {
  const format = (await git.raw(['rev-parse', '--show-object-format'])).trim();
  return format === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
}

async function isAncestor(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
  const base = (await git.raw(['merge-base', ancestor, descendant])).trim();
  return base === ancestor;
}

interface ConflictCandidate {
  path: string;
  stage: string;
  blob: string;
  size: number;
}

interface ConflictedPath {
  path: string;
  folded: string;
}

interface MergeResult {
  tree: string;
  candidates: ConflictCandidate[];
  conflicted: ConflictedPath[];
}

async function supportsMergeTreeWriteTree(git: SimpleGit): Promise<boolean> {
  const version = parseGitVersion(await git.raw(['version']));
  return version === null || compareSemver(version, SYMLINK_MERGE_MIN_GIT_VERSION) >= 0;
}

async function mergeResultTree(
  git: SimpleGit,
  head: string,
  incoming: string,
): Promise<MergeResult> {
  const raw = await git.raw(['merge-tree', '--write-tree', '-z', '--no-messages', head, incoming]);
  const [tree = '', ...entries] = raw.split('\0');
  if (!/^[0-9a-f]{40,64}$/u.test(tree)) {
    throw new Error('unexpected git merge-tree output while inspecting incoming symlinks');
  }
  const candidates: ConflictCandidate[] = [];
  const stagesByPath = new Map<string, Map<string, { mode: string; blob: string }>>();
  for (const entry of entries) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    const [mode, blob, stage] = entry.slice(0, Math.max(tab, 0)).split(' ');
    const path = entry.slice(tab + 1);
    if (
      tab < 0 ||
      mode === undefined ||
      blob === undefined ||
      stage === undefined ||
      !/^[123]$/u.test(stage) ||
      path === ''
    ) {
      throw new Error('unparseable git merge-tree record while inspecting incoming symlinks');
    }
    const stages = stagesByPath.get(path) ?? new Map<string, { mode: string; blob: string }>();
    stages.set(stage, { mode, blob });
    stagesByPath.set(path, stages);
    if (mode !== GIT_SYMLINK_MODE || stage !== '3') continue;
    const size = Number((await git.raw(['cat-file', '-s', blob])).trim());
    candidates.push({ path, stage, blob, size });
  }
  const conflicted: ConflictedPath[] = [];
  for (const [path, stages] of stagesByPath) {
    if (![...stages.values()].some(({ mode }) => mode === GIT_SYMLINK_MODE)) continue;
    conflicted.push({ path, folded: foldPath(path) });
  }
  return { tree, candidates, conflicted };
}

let cachedInspection: { key: string; inspection: Inspection | null } | undefined;

async function inspect(
  git: SimpleGit,
  repoRoot: string,
  head: string | null,
  incoming: string,
  landing: IncomingLanding,
  env: NodeJS.ProcessEnv | undefined,
): Promise<Inspection | null> {
  const key = JSON.stringify([repoRoot, head, incoming, landing]);
  if (cachedInspection?.key === key) return cachedInspection.inspection;
  const from = head ?? (await emptyTree(git));
  let result = incoming;
  let candidates: ConflictCandidate[] = [];
  let conflicted: ConflictedPath[] = [];
  if (landing === 'merge' && head !== null && !(await isAncestor(git, head, incoming))) {
    if (!(await supportsMergeTreeWriteTree(git))) {
      const bases = (await git.raw(['merge-base', '--all', head, incoming]))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const changed = new Map<string, string>();
      for (const base of bases.length > 0 ? bases : [head]) {
        for (const [folded, path] of await changedLinkPaths(git, base, incoming)) {
          changed.set(folded, path);
        }
      }
      if (changed.size === 0) return null;
      return {
        links: [],
        spellings: new Map(),
        changed: new Set(changed.keys()),
        changedPaths: [...changed.values()],
        candidates: [],
        conflicted: [],
        refused: [...changed.values()].map((path) => ({
          path,
          reason: 'requires-newer-git' as const,
        })),
        targets: new Map(),
      };
    }
    const merge = await mergeResultTree(git, head, incoming);
    result = merge.tree;
    candidates = merge.candidates;
    conflicted = merge.conflicted;
  }
  const changed = await changedLinkPaths(git, from, result);
  for (const entry of conflicted) changed.set(entry.folded, entry.path);
  let inspection: Inspection | null = null;
  if (changed.size > 0 || candidates.length > 0) {
    const listing = await listTree(git, result);
    inspection = {
      links: listing.links,
      spellings: listing.spellings,
      changed: new Set(changed.keys()),
      changedPaths: [...changed.values()],
      candidates,
      conflicted,
      refused: [],
      targets: await readBlobs(repoRoot, [...listing.links, ...candidates], env),
    };
  }
  cachedInspection = { key, inspection };
  return inspection;
}

async function findUnsafeIncomingSymlinks(
  git: SimpleGit,
  incoming: string,
  landing: IncomingLanding,
  env: NodeJS.ProcessEnv | undefined,
  base: 'head' | 'empty-tree' = 'head',
): Promise<UnsafeIncomingSymlink[]> {
  const repoRoot = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
  if (repoRoot === '') throw new Error('could not resolve the repository root');
  const head =
    base === 'empty-tree'
      ? ''
      : (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
  const inspection = await inspect(
    git,
    repoRoot,
    head === '' ? null : head,
    incoming,
    landing,
    env,
  );
  if (inspection === null) return [];
  const { spellings, changed, candidates, targets } = inspection;
  if (inspection.refused.length > 0) return inspection.refused;

  const { links } = inspection;
  const conflictedFolds = new Set(inspection.conflicted.map(({ folded }) => folded));
  const relocatable = [
    ...[...conflictedFolds].map((folded) => folded.replace(/~[^/]*$/u, '')),
    ...changed,
  ];
  const crossesConflict = (folded: string): boolean =>
    conflictedFolds.has(folded) || relocatable.some((path) => folded.startsWith(`${path}~`));
  const linksByFold = new Map<string, TreeSymlink[]>();
  for (const link of links) {
    const known = linksByFold.get(link.folded);
    if (known === undefined) linksByFold.set(link.folded, [link]);
    else known.push(link);
  }
  const targetOfBlob = (blob: string): string => targets.get(blob) ?? '\0';

  const memo = new Map<string, Promise<Resolution>>();
  const resolveUncached = async (folded: string, rawPath: string): Promise<Resolution> => {
    if (crossesConflict(folded)) return { kind: 'unverifiable' };
    const known = spellings.get(folded);
    const foldedLinks = linksByFold.get(folded);
    if (foldedLinks !== undefined) {
      if (foldedLinks.length > 1 || (known !== undefined && known.size > 1)) {
        return { kind: 'unverifiable' };
      }
      const [link] = foldedLinks;
      return link === undefined
        ? { kind: 'unverifiable' }
        : { kind: 'link', target: targetOfBlob(link.blob) };
    }
    if (known !== undefined) return { kind: 'plain' };
    const onDisk = join(repoRoot, rawPath);
    try {
      if (!(await lstat(onDisk)).isSymbolicLink()) return { kind: 'plain' };
      return { kind: 'link', target: await readlink(onDisk) };
    } catch (err) {
      const code = errnoCode(err);
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'plain' } : { kind: 'unverifiable' };
    }
  };
  const resolve = (folded: string, rawPath: string): Promise<Resolution> => {
    const key = `${folded}\0${rawPath}`;
    let pending = memo.get(key);
    if (pending === undefined) {
      pending = resolveUncached(folded, rawPath);
      memo.set(key, pending);
    }
    return pending;
  };
  const budget = { steps: MAX_INSPECTION_STEPS };

  const unsafe: UnsafeIncomingSymlink[] = [];
  const refusedPaths = new Set<string>();
  const refuse = (path: string, reason: UnsafeSymlinkReason): void => {
    if (refusedPaths.has(path)) return;
    refusedPaths.add(path);
    unsafe.push({ path, reason });
  };
  for (const candidate of candidates) {
    const { reason } = await walkLink(
      candidate.path,
      targetOfBlob(candidate.blob),
      resolve,
      budget,
    );
    if (reason !== null) refuse(candidate.path, reason);
  }
  for (const link of links) {
    const isChanged = changed.has(link.folded);
    if (isChanged && touchesPrivateState(link.folded.split('/'))) {
      refuse(link.path, 'inside-private-state');
      continue;
    }
    const { reason, crossed, complete } = await walkLink(
      link.path,
      targetOfBlob(link.blob),
      resolve,
      budget,
    );
    if (reason === null) continue;
    if (isChanged || !complete || [...crossed].some((visited) => changed.has(visited))) {
      refuse(link.path, reason);
    }
  }
  if (budget.steps < 0) {
    for (const path of [...inspection.changedPaths, ...candidates.map(({ path }) => path)]) {
      refuse(path, 'unverifiable-target');
    }
  }
  return unsafe;
}

export async function resolveIncomingCommit(git: SimpleGit, ref: string): Promise<string> {
  const commit = (await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error('cannot resolve the incoming commit');
  }
  return commit;
}

function describeSymlinkReason(reason: UnsafeSymlinkReason): string {
  switch (reason) {
    case 'outside-repository':
      return 'points outside the repository';
    case 'repository-root':
      return 'points at the repository root';
    case 'private-state':
      return 'points into private .git or OpenKnowledge state';
    case 'secret-file':
      return 'points at a file that may hold secrets, such as .env or a key';
    case 'inside-private-state':
      return 'is placed inside private .git or OpenKnowledge state';
    case 'requires-newer-git':
      return `needs Git ${SYMLINK_MERGE_MIN_GIT_LABEL} or newer to check during a merge`;
    case 'unverifiable-target':
      return 'has a target that cannot be checked';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function escapePathForDisplay(path: string): string {
  return JSON.stringify(path)
    .slice(1, -1)
    .replace(INVISIBLE_CHARACTERS, (character) =>
      Array.from(
        { length: character.length },
        (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`,
      ).join(''),
    );
}

export class UnsafeIncomingSymlinkError extends Error {
  readonly unsafe: readonly UnsafeIncomingSymlink[];

  constructor(unsafe: readonly UnsafeIncomingSymlink[]) {
    super('refusing to pull: incoming symlinks are unsafe to check out');
    this.name = 'UnsafeIncomingSymlinkError';
    this.unsafe = unsafe;
  }

  displayPaths(): string[] {
    return this.unsafe
      .slice(0, REFUSED_SYMLINK_PATHS_CAP)
      .map(({ path }) => escapePathForDisplay(path));
  }

  describeLinks(): string {
    const shown = this.unsafe
      .slice(0, REPORTED_PATH_LIMIT)
      .map(
        ({ path, reason }) => `"${escapePathForDisplay(path)}" (${describeSymlinkReason(reason)})`,
      );
    const more =
      this.unsafe.length > REPORTED_PATH_LIMIT
        ? `, and ${this.unsafe.length - REPORTED_PATH_LIMIT} more`
        : '';
    return `${shown.join(', ')}${more}`;
  }
}

export type IncomingLanding = 'merge' | 'checkout';

export async function assertIncomingSymlinksSafe(
  git: SimpleGit,
  incoming: string,
  landing: IncomingLanding,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const commit = await resolveIncomingCommit(git, incoming);
  const unsafe = await findUnsafeIncomingSymlinks(git, commit, landing, env);
  if (unsafe.length > 0) throw new UnsafeIncomingSymlinkError(unsafe);
}

export async function assertCheckoutSymlinksSafe(
  git: SimpleGit,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const commit = await resolveIncomingCommit(git, ref);
  const unsafe = await findUnsafeIncomingSymlinks(git, commit, 'checkout', env, 'empty-tree');
  if (unsafe.length > 0) throw new UnsafeIncomingSymlinkError(unsafe);
}

export async function assertRepoCheckoutSymlinksSafe(repoDir: string, ref: string): Promise<void> {
  const handle = createGitInstance(repoDir, { credentialConfig: [] });
  await assertCheckoutSymlinksSafe(handle.git, ref, handle.env);
}

export class IncomingRefMovedError extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super('the incoming branch moved after its incoming symlinks were inspected; pull again');
    this.name = 'IncomingRefMovedError';
    this.ref = ref;
  }
}

export class IncomingRefShadowedError extends Error {
  readonly shadowedName: string;

  constructor(shadowedName: string) {
    super(
      'another ref with the incoming branch name, such as a tag, shadows it, so sync will not merge it until that ref is deleted here and on the remote',
    );
    this.name = 'IncomingRefShadowedError';
    this.shadowedName = shadowedName;
  }
}

async function resolvedCommitOrEmpty(git: SimpleGit, name: string): Promise<string> {
  return (await git.raw(['rev-parse', '--verify', '--quiet', `${name}^{commit}`])).trim();
}

export async function assertMergeNameResolvesTo(
  git: SimpleGit,
  target: { name: string; trackingRef: string; commit: string },
): Promise<void> {
  if ((await resolvedCommitOrEmpty(git, target.trackingRef)) !== target.commit) {
    throw new IncomingRefMovedError(target.trackingRef);
  }
  if ((await resolvedCommitOrEmpty(git, target.name)) !== target.commit) {
    throw new IncomingRefShadowedError(target.name);
  }
}
