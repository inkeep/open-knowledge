import { classifyGitHubShareHost } from '../constants/github.ts';
import type { ShareTarget } from '../desktop-bridge.ts';
import { isValidBranchName } from '../schemas/api/share.ts';

const SHARE_URL_VERSION_V1 = 0x01;
const SHARE_URL_VERSION_V2 = 0x02;
const V2_HEADER_BYTES = 3;
const SHARE_OWNER_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;
const IPV4_AUTHORITY_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export const MAX_V2_SHARE_TOKEN_CHARS = 3984;
export const MAX_V2_SHARE_PAYLOAD_BYTES = 2988;
export const MAX_V2_SHARED_URL_UTF8_BYTES = 2985;

export interface DecodedShareV1 {
  readonly version: 1;
  readonly sharedUrl: string;
}

export interface CanonicalGitHubShareSource {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly kind: 'doc' | 'folder';
  readonly targetSegments: readonly string[];
}

export interface DecodedShareV2 {
  readonly version: 2;
  readonly sharedUrl: string;
  readonly contentRootDepth: number;
  readonly source: CanonicalGitHubShareSource;
  readonly target: ShareTarget;
}

export type DecodedShare = DecodedShareV1 | DecodedShareV2;

export class UnsupportedShareVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Unsupported share URL version: 0x${version.toString(16).padStart(2, '0')}`);
    this.name = 'UnsupportedShareVersionError';
    this.version = version;
  }
}

export class InvalidShareUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidShareUrlError';
  }
}

export function encodeShareUrl(sharedUrl: string, contentRootDepth = 0): string {
  assertContentRootDepth(contentRootDepth, true);
  if (contentRootDepth === 0) {
    return encodeV1ShareUrl(sharedUrl);
  }
  if (sharedUrl.length > MAX_V2_SHARED_URL_UTF8_BYTES) {
    throw new InvalidShareUrlError('Share URL exceeds the v2 URL size limit');
  }

  const source = parseCanonicalGitHubShareUrl(sharedUrl);
  projectCanonicalGitHubShareTarget(source, contentRootDepth);

  const sharedUrlBytes = new TextEncoder().encode(sharedUrl);
  if (sharedUrlBytes.length > MAX_V2_SHARED_URL_UTF8_BYTES) {
    throw new InvalidShareUrlError('Share URL exceeds the v2 URL size limit');
  }

  const bytes = new Uint8Array(V2_HEADER_BYTES + sharedUrlBytes.length);
  bytes[0] = SHARE_URL_VERSION_V2;
  bytes[1] = contentRootDepth >>> 8;
  bytes[2] = contentRootDepth & 0xff;
  bytes.set(sharedUrlBytes, V2_HEADER_BYTES);

  if (bytes.length > MAX_V2_SHARE_PAYLOAD_BYTES) {
    throw new InvalidShareUrlError('Share payload exceeds the v2 size limit');
  }

  const encoded = uint8ArrayToBase64Url(bytes);
  if (encoded.length > MAX_V2_SHARE_TOKEN_CHARS) {
    throw new InvalidShareUrlError('Share token exceeds the v2 size limit');
  }
  return encoded;
}

export function decodeShareUrl(encoded: string): DecodedShare {
  const peekedVersion = peekBase64UrlVersion(encoded);

  if (peekedVersion === SHARE_URL_VERSION_V2 && encoded.length > MAX_V2_SHARE_TOKEN_CHARS) {
    throw new InvalidShareUrlError('Share token exceeds the v2 size limit');
  }

  const suffixIndex = encoded.search(/[?#]/);
  if (peekedVersion === SHARE_URL_VERSION_V2) {
    if (suffixIndex !== -1) throw new InvalidShareUrlError('V2 share tokens cannot have a suffix');
    return decodeV2ShareUrl(encoded);
  }

  const cleaned = suffixIndex === -1 ? encoded : encoded.slice(0, suffixIndex);
  const bytes = decodeBase64Url(cleaned);
  if (bytes.length === 0) {
    throw new InvalidShareUrlError('Share payload is empty');
  }

  const version = bytes[0];
  if (version !== SHARE_URL_VERSION_V1) {
    throw new UnsupportedShareVersionError(version);
  }

  return {
    version: 1,
    sharedUrl: decodeUtf8(bytes.subarray(1)),
  };
}

export function parseCanonicalGitHubShareUrl(sharedUrl: string): CanonicalGitHubShareSource {
  if (!sharedUrl.startsWith('https://')) {
    throw new InvalidShareUrlError('Share URL must use canonical HTTPS spelling');
  }
  if (sharedUrl.includes('?') || sharedUrl.includes('#')) {
    throw new InvalidShareUrlError('Share URL cannot contain a query or fragment');
  }

  const authorityAndPath = sharedUrl.slice('https://'.length);
  const pathStart = authorityAndPath.indexOf('/');
  if (pathStart <= 0) {
    throw new InvalidShareUrlError('Share URL is missing its repository path');
  }

  const host = authorityAndPath.slice(0, pathStart);
  assertCanonicalGitHubHost(host);

  const rawPath = authorityAndPath.slice(pathStart + 1);
  const rawSegments = rawPath.split('/');
  if (rawSegments.length < 4 || rawSegments.some((segment) => segment.length === 0)) {
    throw new InvalidShareUrlError('Share URL has an invalid path shape');
  }

  const [rawOwner, rawRepo, rawKind, rawBranch, ...rawTargetSegments] = rawSegments;
  if (rawKind !== 'blob' && rawKind !== 'tree') {
    throw new InvalidShareUrlError('Share URL has an unsupported repository path shape');
  }

  const owner = decodeCanonicalRepositoryComponent(rawOwner, 'owner');
  const repo = decodeCanonicalRepositoryComponent(rawRepo, 'repository');
  const branch = decodeCanonicalBranch(rawBranch);
  const targetSegments = rawTargetSegments.map((segment) =>
    decodeCanonicalPathComponent(segment, 'target'),
  );
  const kind = rawKind === 'blob' ? 'doc' : 'folder';

  if (kind === 'doc' && targetSegments.length === 0) {
    throw new InvalidShareUrlError('Document share URL is missing its target path');
  }

  const source: CanonicalGitHubShareSource = {
    host,
    owner,
    repo,
    branch,
    kind,
    targetSegments,
  };
  if (serializeCanonicalGitHubShareUrl(source) !== sharedUrl) {
    throw new InvalidShareUrlError('Share URL is not canonically serialized');
  }
  return source;
}

export function serializeCanonicalGitHubShareUrl(source: CanonicalGitHubShareSource): string {
  assertCanonicalGitHubHost(source.host);
  assertDecodedRepositoryComponent(source.owner, 'owner');
  assertDecodedRepositoryComponent(source.repo, 'repository');
  if (!isValidBranchName(source.branch)) {
    throw new InvalidShareUrlError('Share URL branch is invalid');
  }
  if (source.kind !== 'doc' && source.kind !== 'folder') {
    throw new InvalidShareUrlError('Share URL target kind is invalid');
  }
  if (source.kind === 'doc' && source.targetSegments.length === 0) {
    throw new InvalidShareUrlError('Document share URL is missing its target path');
  }
  for (const segment of source.targetSegments) {
    assertDecodedPathComponent(segment, 'target');
  }

  const kind = source.kind === 'doc' ? 'blob' : 'tree';
  const structuralSegments = [
    encodeURIComponent(source.owner),
    encodeURIComponent(source.repo),
    kind,
    encodeURIComponent(source.branch),
    ...source.targetSegments.map((segment) => encodeURIComponent(segment)),
  ];
  return `https://${source.host}/${structuralSegments.join('/')}`;
}

export function projectCanonicalGitHubShareTarget(
  source: CanonicalGitHubShareSource,
  contentRootDepth: number,
): ShareTarget {
  assertContentRootDepth(contentRootDepth, false);
  if (contentRootDepth > source.targetSegments.length) {
    throw new InvalidShareUrlError('Content root depth exceeds the repository target path');
  }

  const contentPath = source.targetSegments.slice(contentRootDepth).join('/');
  if (source.kind === 'doc') {
    if (contentPath.length === 0) {
      throw new InvalidShareUrlError('Document share target cannot be the content root');
    }
    return { kind: 'doc', docPath: contentPath };
  }
  return { kind: 'folder', folderPath: contentPath };
}

function encodeV1ShareUrl(sharedUrl: string): string {
  const sharedUrlBytes = new TextEncoder().encode(sharedUrl);
  const bytes = new Uint8Array(1 + sharedUrlBytes.length);
  bytes[0] = SHARE_URL_VERSION_V1;
  bytes.set(sharedUrlBytes, 1);
  return uint8ArrayToBase64Url(bytes);
}

function decodeV2ShareUrl(encoded: string): DecodedShareV2 {
  const bytes = decodeBase64Url(encoded);
  if (bytes.length > MAX_V2_SHARE_PAYLOAD_BYTES) {
    throw new InvalidShareUrlError('Share payload exceeds the v2 size limit');
  }
  if (uint8ArrayToBase64Url(bytes) !== encoded) {
    throw new InvalidShareUrlError('V2 share token is not canonically encoded');
  }
  if (bytes.length <= V2_HEADER_BYTES) {
    throw new InvalidShareUrlError('V2 share payload is truncated');
  }

  const contentRootDepth = (bytes[1] << 8) | bytes[2];
  assertContentRootDepth(contentRootDepth, false);

  const sharedUrlBytes = bytes.subarray(V2_HEADER_BYTES);
  if (sharedUrlBytes.length > MAX_V2_SHARED_URL_UTF8_BYTES) {
    throw new InvalidShareUrlError('Share URL exceeds the v2 URL size limit');
  }
  const sharedUrl = decodeUtf8(sharedUrlBytes);
  const source = parseCanonicalGitHubShareUrl(sharedUrl);
  const target = projectCanonicalGitHubShareTarget(source, contentRootDepth);
  return {
    version: 2,
    sharedUrl,
    contentRootDepth,
    source,
    target,
  };
}

function assertContentRootDepth(contentRootDepth: number, allowZero: boolean): void {
  if (
    !Number.isInteger(contentRootDepth) ||
    contentRootDepth < (allowZero ? 0 : 1) ||
    contentRootDepth > 0xffff
  ) {
    throw new InvalidShareUrlError('Content root depth is invalid');
  }
}

function assertCanonicalGitHubHost(host: string): void {
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.endsWith('.') ||
    host !== host.toLowerCase() ||
    IPV4_AUTHORITY_PATTERN.test(host)
  ) {
    throw new InvalidShareUrlError('Share URL host is not canonical');
  }
  const labels = host.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new InvalidShareUrlError('Share URL host is not a DNS name');
  }
  if (classifyGitHubShareHost(host) !== host) {
    throw new InvalidShareUrlError('Share URL host is not a canonical GitHub host');
  }
}

function decodeCanonicalBranch(rawBranch: string): string {
  const branch = decodeCanonicalComponent(rawBranch, 'branch');
  if (!isValidBranchName(branch)) {
    throw new InvalidShareUrlError('Share URL branch is invalid');
  }
  return branch;
}

function decodeCanonicalPathComponent(
  rawComponent: string,
  role: 'owner' | 'repository' | 'target',
): string {
  const component = decodeCanonicalComponent(rawComponent, role);
  assertDecodedPathComponent(component, role);
  return component;
}

function decodeCanonicalRepositoryComponent(
  rawComponent: string,
  role: 'owner' | 'repository',
): string {
  const component = decodeCanonicalComponent(rawComponent, role);
  assertDecodedRepositoryComponent(component, role);
  return component;
}

function decodeCanonicalComponent(rawComponent: string, role: string): string {
  let component: string;
  try {
    component = decodeURIComponent(rawComponent);
  } catch {
    throw new InvalidShareUrlError(`Share URL ${role} has malformed percent encoding`);
  }
  if (encodeURIComponent(component) !== rawComponent) {
    throw new InvalidShareUrlError(`Share URL ${role} is not canonically encoded`);
  }
  return component;
}

function assertDecodedPathComponent(component: string, role: string): void {
  if (
    component.length === 0 ||
    component === '.' ||
    component === '..' ||
    component.toLowerCase() === '.git' ||
    component.includes('/') ||
    component.includes('\\') ||
    containsControlOrDel(component)
  ) {
    throw new InvalidShareUrlError(`Share URL ${role} component is invalid`);
  }
}

function assertDecodedRepositoryComponent(component: string, role: 'owner' | 'repository'): void {
  assertDecodedPathComponent(component, role);
  if (!SHARE_OWNER_REPO_PATTERN.test(component) || component.startsWith('-')) {
    throw new InvalidShareUrlError(`Share URL ${role} component is invalid`);
  }
}

function containsControlOrDel(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidShareUrlError('Share payload body is not valid UTF-8');
  }
}

function decodeBase64Url(input: string): Uint8Array {
  if (input.length === 0) {
    throw new InvalidShareUrlError('Share payload is empty');
  }
  try {
    return base64UrlToUint8Array(input);
  } catch {
    throw new InvalidShareUrlError('Share payload is not valid base64url');
  }
}

function peekBase64UrlVersion(input: string): number | null {
  if (input.length < 2) return null;
  const first = base64UrlAlphabetIndex(input.charCodeAt(0));
  const second = base64UrlAlphabetIndex(input.charCodeAt(1));
  if (first === -1 || second === -1) return null;
  return (first << 2) | (second >>> 4);
}

function base64UrlAlphabetIndex(codeUnit: number): number {
  if (codeUnit >= 65 && codeUnit <= 90) return codeUnit - 65;
  if (codeUnit >= 97 && codeUnit <= 122) return codeUnit - 97 + 26;
  if (codeUnit >= 48 && codeUnit <= 57) return codeUnit - 48 + 52;
  if (codeUnit === 45) return 62;
  if (codeUnit === 95) return 63;
  return -1;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binaryString = '';
  for (let index = 0; index < bytes.length; index++) {
    binaryString += String.fromCharCode(bytes[index]);
  }
  const base64 = btoa(binaryString);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUint8Array(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error('Input contains non-base64url characters');
  }
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index++) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return bytes;
}
