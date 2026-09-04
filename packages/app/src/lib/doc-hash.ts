import { MANAGED_ARTIFACT_SCOPES, type SkillScope } from '@inkeep/open-knowledge-core';

function isSkillScope(value: string): value is SkillScope {
  return (MANAGED_ARTIFACT_SCOPES as readonly string[]).includes(value);
}

export function docNameFromHash(hash: string): string | null {
  if (hash.startsWith(ASSET_HASH_PREFIX)) return null;
  if (hash.startsWith(SKILL_FILE_HASH_PREFIX)) return null;
  if (hash.startsWith(SKILLS_HASH_PREFIX)) return null;
  if (hash.startsWith(SKILL_PREVIEW_HASH_PREFIX)) return null;
  if (!hash.startsWith('#/')) return null;
  const rest = hash.slice(2);
  const delimiter = firstRouteDelimiterIndex(rest);
  const encoded = delimiter >= 0 ? rest.slice(0, delimiter) : rest;
  if (!encoded) return null;
  try {
    return encoded.split('/').map(decodeURIComponent).join('/');
  } catch {
    return encoded;
  }
}

export function anchorFromHash(hash: string): string | null {
  if (hash.startsWith(ASSET_HASH_PREFIX)) return null;
  if (!hash.startsWith('#/')) return null;

  const rest = hash.slice(2);
  const fragment = rest.indexOf('#');
  if (fragment < 0) return null;
  const encoded = rest.slice(fragment + 1);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function encodeSegment(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE, '\uFFFD'));
}

function encodeRoutePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/');
}

export function hashFromDocName(docName: string, anchor?: string | null): string {
  const base = `#/${encodeRoutePath(docName)}`;
  return anchor ? `${base}#${encodeSegment(anchor)}` : base;
}

export function isSameHash(a: string, b: string): boolean {
  return a === b || decodeHashForComparison(a) === decodeHashForComparison(b);
}

function decodeHashForComparison(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

const MANAGED_HASH_HISTORY_STATE_KEY = '__okHashHistoryEntry';

function managedHashHistoryState(state: unknown): Record<string, unknown> {
  const preservedState = typeof state === 'object' && state !== null ? state : {};
  return { ...preservedState, [MANAGED_HASH_HISTORY_STATE_KEY]: true };
}

export function isManagedHashHistoryState(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[MANAGED_HASH_HISTORY_STATE_KEY] === true
  );
}

export function markCurrentHashHistoryEntry(): void {
  if (isManagedHashHistoryState(window.history.state)) return;
  window.history.replaceState(managedHashHistoryState(window.history.state), '');
}

export function replaceHashWithoutNavigation(hash: string): void {
  const { pathname, search } = window.location;
  window.history.replaceState(
    managedHashHistoryState(window.history.state),
    '',
    `${pathname}${search}${hash}`,
  );
}

export function pushHashWithoutNavigation(hash: string): void {
  if (isSameHash(window.location.hash, hash)) return;
  const { pathname, search } = window.location;
  window.history.pushState(
    managedHashHistoryState(window.history.state),
    '',
    `${pathname}${search}${hash}`,
  );
}

export function filePathToDocName(filePath: string): string {
  if (filePath.endsWith('.mdx')) return filePath.slice(0, -4);
  if (filePath.endsWith('.md')) return filePath.slice(0, -3);
  return filePath;
}

export function hashFromFolderPath(folderPath: string, anchor?: string | null): string {
  const normalized = folderPath.replace(/^\/+|\/+$/g, '');
  const base = normalized ? `#/${encodeRoutePath(normalized)}/` : '#/';
  return anchor ? `${base}#${encodeSegment(anchor)}` : base;
}

export function encodeShareTargetForHash(
  kind: 'doc' | 'folder',
  path: string,
  branch?: string | null,
): string {
  if (kind === 'folder') return hashFromFolderPath(path);
  const base = `#/${encodeSegment(path)}`;
  if (branch === undefined || branch === null || branch === '') return base;
  return `${base}?branch=${encodeSegment(branch)}`;
}

export function isContentRootHash(hash: string): boolean {
  if (hash === '#/') return true;
  if (!hash.startsWith('#/')) return false;
  const rest = hash.slice(2);
  return rest.length > 0 && rest[0] === '?';
}

const ASSET_HASH_PREFIX = '#/__asset__/';

function firstRouteDelimiterIndex(rest: string): number {
  const qmark = rest.indexOf('?');
  const fragment = rest.indexOf('#');
  if (qmark < 0) return fragment;
  if (fragment < 0) return qmark;
  return Math.min(qmark, fragment);
}

export function assetPathFromHash(hash: string): string | null {
  if (!hash.startsWith(ASSET_HASH_PREFIX)) return null;
  const encoded = hash.slice(ASSET_HASH_PREFIX.length);
  if (!encoded) return null;
  try {
    return encoded.split('/').map(decodeURIComponent).join('/');
  } catch {
    return encoded;
  }
}

export function hashFromAssetPath(assetPath: string): string {
  return `${ASSET_HASH_PREFIX}${encodeRoutePath(assetPath)}`;
}

const SKILL_FILE_HASH_PREFIX = '#/__skill-file__/';

const SKILLS_HASH_PREFIX = '#/__skills__';
export function skillsFromHash(hash: string): boolean {
  return hash === SKILLS_HASH_PREFIX || hash.startsWith(`${SKILLS_HASH_PREFIX}/`);
}

const SKILL_PREVIEW_HASH_PREFIX = '#/__skill-preview__/';
const SKILL_PREVIEW_FLAVORS = ['explore', 'detected', 'builtin', 'foreign', 'linked'] as const;
export type SkillPreviewFlavor = (typeof SKILL_PREVIEW_FLAVORS)[number];
function isSkillPreviewFlavor(v: string | undefined): v is SkillPreviewFlavor {
  return v !== undefined && (SKILL_PREVIEW_FLAVORS as readonly string[]).includes(v);
}
export interface SkillPreviewHashTarget {
  flavor: SkillPreviewFlavor;
  source: string;
  name: string;
  subtitle: string;
  level?: SkillScope;
  path?: string;
}

const DEFAULT_PREVIEW_LEVEL: SkillScope = 'project';

export function encodeSkillPreviewSegments(target: SkillPreviewHashTarget): string {
  return [
    target.flavor,
    target.source,
    target.name,
    target.subtitle,
    target.level ?? DEFAULT_PREVIEW_LEVEL,
  ]
    .map(encodeSegment)
    .join('/');
}

export function decodeSkillPreviewSegments(body: string): SkillPreviewHashTarget | null {
  if (!body) return null;
  let segments: string[];
  try {
    segments = body.split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length < 4 || segments.length > 6) return null;
  const [flavor, source, name, subtitle, level, path] = segments;
  if (!isSkillPreviewFlavor(flavor)) return null;
  if (!source || !name) return null;
  return {
    flavor,
    source,
    name,
    subtitle: subtitle ?? '',
    ...(level && isSkillScope(level) ? { level } : {}),
    ...(path ? { path } : {}),
  };
}

export function hashFromSkillPreview(target: SkillPreviewHashTarget): string {
  let body = encodeSkillPreviewSegments(target);
  if (target.path) body += `/${encodeSegment(target.path)}`;
  return `${SKILL_PREVIEW_HASH_PREFIX}${body}`;
}

export function skillPreviewFromHash(hash: string): SkillPreviewHashTarget | null {
  if (!hash.startsWith(SKILL_PREVIEW_HASH_PREFIX)) return null;
  return decodeSkillPreviewSegments(hash.slice(SKILL_PREVIEW_HASH_PREFIX.length));
}

export function selectedPathForSkillPreview(
  hash: string,
  target: SkillPreviewHashTarget,
): string | undefined {
  const hashTarget = skillPreviewFromHash(hash);
  if (!hashTarget) return undefined;
  return encodeSkillPreviewSegments(hashTarget) === encodeSkillPreviewSegments(target)
    ? hashTarget.path
    : undefined;
}

export interface SkillFileHashTarget {
  scope: SkillScope;
  name: string;
  path: string;
  host?: string;
}

const SKILL_FILE_HOST_SEP = ':';

export function hashFromSkillFile(target: SkillFileHashTarget): string {
  const named =
    target.host === undefined ? target.name : `${target.name}${SKILL_FILE_HOST_SEP}${target.host}`;
  const head = [target.scope, named].map(encodeSegment).join('/');
  const tail = encodeRoutePath(target.path);
  return `${SKILL_FILE_HASH_PREFIX}${head}/${tail}`;
}

export function skillFileFromHash(hash: string): SkillFileHashTarget | null {
  if (!hash.startsWith(SKILL_FILE_HASH_PREFIX)) return null;
  const encoded = hash.slice(SKILL_FILE_HASH_PREFIX.length);
  if (!encoded) return null;
  let segments: string[];
  try {
    segments = encoded.split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length < 3) return null;
  const [scope, named, ...rest] = segments;
  const path = rest.join('/');
  if (!scope || !named || !path || !isSkillScope(scope)) return null;
  const sep = named.indexOf(SKILL_FILE_HOST_SEP);
  const name = sep === -1 ? named : named.slice(0, sep);
  const host = sep === -1 ? undefined : named.slice(sep + 1);
  if (!name) return null;
  return { scope, name, path, ...(host ? { host } : {}) };
}
