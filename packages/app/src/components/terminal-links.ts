import type { PageListCacheSnapshot } from '../editor/page-list-cache';
import { filePathToDocName } from '../lib/doc-hash';

export interface PathCandidate {
  readonly path: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly trailingSlash: boolean;
}

export type TerminalLinkKind = 'doc' | 'folder' | 'asset';

export type TerminalLinkTarget =
  | {
      readonly kind: TerminalLinkKind;
      readonly relPath: string;
    }
  | {
      readonly kind: 'external';
      readonly absPath: string;
    };

export type ResolvedTerminalPath =
  | { readonly kind: 'in-project'; readonly relPath: string }
  | { readonly kind: 'external'; readonly absPath: string };

export function resolveTerminalPath(
  rawPath: string,
  projectPath: string,
): ResolvedTerminalPath | null {
  const rel = toProjectRelative(rawPath, projectPath);
  if (rel !== null) return { kind: 'in-project', relPath: rel };
  if (rawPath.startsWith('/')) {
    if (rawPath === normalizeRoot(projectPath)) return null;
    return { kind: 'external', absPath: rawPath };
  }
  return null;
}

function normalizeRoot(projectPath: string): string {
  return projectPath.replace(/\/+$/, '');
}

const MAX_LINE_LENGTH = 2000;

const RUN_RE = /[^\s<>"'`|(){}[\]\0]+/g;

const SUFFIX_RE = /:\d+(?::\d+)?$/;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const HAS_EXTENSION_RE = /\.[A-Za-z0-9]+$/;

export function hasPathExtension(token: string): boolean {
  return HAS_EXTENSION_RE.test(token);
}

export function detectPathCandidates(line: string, maxCandidates = 10): PathCandidate[] {
  if (line.length === 0 || line.length > MAX_LINE_LENGTH) return [];
  const out: PathCandidate[] = [];

  for (const match of line.matchAll(RUN_RE)) {
    if (out.length >= maxCandidates) break;
    const run = match[0];
    const runStart = match.index;

    if (SCHEME_RE.test(run)) continue;

    let path = run.replace(/[.,;:!?]+$/, '');

    const suffix = path.match(SUFFIX_RE);
    if (suffix) path = path.slice(0, suffix.index);

    const trailingSlash = path.endsWith('/');
    const core = trailingSlash ? path.slice(0, -1) : path;
    if (!isPathShaped(core)) continue;

    const endIndex = runStart + core.length;
    out.push({ path: core, startIndex: runStart, endIndex, trailingSlash });
  }

  return out;
}

export interface TerminalBufferRange {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export function terminalBufferRange(
  startIndex: number,
  endIndex: number,
  startLine: number,
  cols: number,
): TerminalBufferRange {
  const width = cols > 0 ? cols : Number.MAX_SAFE_INTEGER;
  const lastIndex = Math.max(startIndex, endIndex - 1);
  const cell = (i: number) => ({ x: (i % width) + 1, y: startLine + Math.floor(i / width) });
  return { start: cell(startIndex), end: cell(lastIndex) };
}

function isPathShaped(token: string): boolean {
  if (token.length < 2) return false;
  if (token.startsWith('~')) return false;
  if (token.includes('/')) return true;
  return HAS_EXTENSION_RE.test(token);
}

export function toProjectRelative(rawPath: string, projectPath: string): string | null {
  if (!rawPath || !projectPath) return null;
  const root = normalizeRoot(projectPath);

  let rel: string;
  if (rawPath.startsWith('/')) {
    if (rawPath === root) return null;
    const prefix = `${root}/`;
    if (!rawPath.startsWith(prefix)) return null;
    rel = rawPath.slice(prefix.length);
  } else {
    rel = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
  }

  const segments: string[] = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  return segments.join('/');
}

export function classifyTarget(
  relPath: string,
  trailingSlash: boolean,
  snapshot: PageListCacheSnapshot | null,
): TerminalLinkKind {
  if (trailingSlash) return 'folder';
  if (snapshot?.folderPaths.has(relPath)) return 'folder';
  if (relPath.endsWith('.md') || relPath.endsWith('.mdx')) return 'doc';
  if (snapshot?.pages.has(filePathToDocName(relPath))) return 'doc';
  return 'asset';
}

export function createRecentOpenGuard(windowMs = 300): (uri: string, now: number) => boolean {
  let last: { uri: string; at: number } | null = null;
  return (uri, now) => {
    if (last !== null && last.uri === uri && now - last.at < windowMs) return true;
    last = { uri, at: now };
    return false;
  };
}

export function isKnownInSnapshot(
  relPath: string,
  trailingSlash: boolean,
  snapshot: PageListCacheSnapshot | null,
): boolean {
  if (!snapshot) return false;
  if (trailingSlash) return snapshot.folderPaths.has(relPath);
  if (snapshot.pages.has(filePathToDocName(relPath))) return true;
  if (snapshot.assetPaths?.has(relPath)) return true;
  if (snapshot.filePaths?.has(relPath)) return true;
  return snapshot.folderPaths.has(relPath);
}
