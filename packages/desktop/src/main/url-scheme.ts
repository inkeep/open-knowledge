/**
 * `openknowledge://` deep-link URL scheme — parser + runtime handler.
 *
 * Public surfaces in this module:
 *   - Pure parsers — `parseOpenKnowledgeUrl` (`open` host, document deep
 *     links), `parseShareUrl` (`share` host + `openknowledge.ai` universal
 *     links), `parseScreenUrl` (`screen` host, named-screen deep links). No
 *     Electron import at module top, so unit tests exercise them without a real
 *     Electron runtime (precedent #4 — shared computation, per-surface render).
 *   - `registerProtocolHandler(deps)` — wires `app.on('open-url', ...)` +
 *     `app.on('second-instance', ...)`, scans `process.argv` for cold-start
 *     CLI-launch delivery, and implements the VS Code queue-then-flush
 *     pattern so macOS cold-start Apple Events that fire before `whenReady`
 *     are never lost.
 *
 * **Caller contract:** `app.requestSingleInstanceLock()` MUST be acquired by
 * the caller BEFORE `registerProtocolHandler` runs. Without the lock, the
 * `second-instance` event cannot fire (Electron only dispatches it on the
 * primary when a secondary invocation relinquishes the lock), so the
 * documented "CLI launch with argv delivery" path is silently dead. The
 * current call site is `packages/desktop/src/main/index.ts`, gated on
 * `GOT_SINGLE_INSTANCE_LOCK`.
 *
 * Validation layers (URL shape: `openknowledge://open?project=<abs>&doc=<name>`):
 *   1. Reject null bytes anywhere in the raw input (`\x00`, `%00`).
 *   2. Protocol must be `openknowledge:`; host must be `open`.
 *   3. `project` + `doc` required; each URL-decoded before path checks.
 *   4. `project` must be absolute AND must not contain `..` segments after
 *      `path.normalize()` — `path.resolve` would silently flatten `../../etc/x`
 *      to `/etc/x`, so we reject ANY `..` segment in the decoded path.
 *   5. `doc` must be a relative in-project name — reject any `..` segment (so
 *      `a/../b`, `../a`, and `..` all fail) and reject Windows `\` separators.
 *      `/` IS allowed as a segment separator — nested docNames like
 *      `notes/meeting-2026` are the common MCP producer shape (see
 *      `packages/cli/src/mcp/tools/write-document.ts:31` + `preview-url.ts:183`),
 *      and the renderer round-trips them cleanly via `encodeURIComponent(doc)`
 *      + `docNameFromHash` (`packages/app/src/lib/doc-hash.ts:14`).
 *
 * URL shape is fixed by an upstream contract; this module is downstream of it —
 * changes must be made there, not here.
 */

import { isAbsolute, resolve } from 'node:path';
import { parseGitHubShareUrl } from '@inkeep/open-knowledge';
import {
  type CandidateSelection,
  decodeShareUrl,
  InvalidShareUrlError,
  UnsupportedShareVersionError,
} from '@inkeep/open-knowledge-core';
import type {
  OkSharePayloadFields,
  OkShareReceivedPayload,
  ShareTarget,
} from '../shared/bridge-contract.ts';
import type { CheckTargetExistsResult } from './check-target-exists.ts';

function shareTargetPath(target: ShareTarget): string {
  return target.kind === 'doc' ? target.docPath : target.folderPath;
}

interface ParsedOpenKnowledgeUrl {
  readonly host: 'open';
  readonly project: string;
  readonly kind: 'doc' | 'folder';
  readonly doc: string;
}

const SHARE_UNIVERSAL_LINK_HOSTS = new Set(['openknowledge.ai', 'www.openknowledge.ai']);

const SHARE_UNIVERSAL_LINK_PATH_PREFIX = '/d/';

function readWebpageURL(source: unknown): string | null {
  if (source === null || typeof source !== 'object') return null;
  const candidate = (source as { webpageURL?: unknown }).webpageURL;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export type ShareUrlPayload = OkSharePayloadFields;

export type ShareUrlSource = 'universal-link' | 'custom-scheme';

export type ShareParseResult =
  | {
      readonly kind: 'ok';
      readonly source: ShareUrlSource;
      readonly payload: ShareUrlPayload;
      readonly dedupKey: string;
    }
  | {
      readonly kind: 'unsupported-version';
      readonly source: ShareUrlSource;
      readonly version: number;
    }
  | { readonly kind: 'invalid'; readonly source: ShareUrlSource };

function classifyShareUrlSource(url: URL): ShareUrlSource | null {
  if (url.protocol === 'openknowledge:' && url.hostname === 'share') return 'custom-scheme';
  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    SHARE_UNIVERSAL_LINK_HOSTS.has(url.hostname) &&
    url.pathname.startsWith(SHARE_UNIVERSAL_LINK_PATH_PREFIX)
  ) {
    return 'universal-link';
  }
  return null;
}

function classifyRawShareUrlSource(input: string): ShareUrlSource | null {
  if (/^openknowledge:\/\/share(?::[^/?#@]*)?(?:[/?#]|$)/i.test(input)) {
    return 'custom-scheme';
  }
  if (/^https?:\/\/(?:www\.)?openknowledge\.ai(?::[^/?#@]*)?\/d\//i.test(input)) {
    return 'universal-link';
  }
  return null;
}

export type ShareDeepLinkFields = OkSharePayloadFields;

export interface ShareDeepLinkBranchSwitchPayload {
  readonly share: ShareDeepLinkFields;
  readonly projectPath: string;
  readonly currentBranch: string | null;
}

export type ShareDeepLinkPayload = OkShareReceivedPayload;

export type ShareNavigatorPayload = Extract<
  ShareDeepLinkPayload,
  { readonly kind: 'launcher-consent' } | { readonly kind: 'launcher-miss' }
>;

export function parseShareUrl(input: string): ShareParseResult | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  const rawSource = classifyRawShareUrlSource(input);
  if (input.includes('\x00') || /%00/i.test(input)) {
    return rawSource === null ? null : { kind: 'invalid', source: rawSource };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return rawSource === null ? null : { kind: 'invalid', source: rawSource };
  }

  const source = classifyShareUrlSource(url);
  if (source === 'custom-scheme') {
    return parseShareCustomScheme(url);
  }
  if (source === 'universal-link') {
    return parseShareUniversalLink(url);
  }
  return null;
}

function parseShareUniversalLink(url: URL): ShareParseResult {
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length !== 2 || segments[0] !== 'd') {
    return { kind: 'invalid', source: 'universal-link' };
  }
  const encoded = segments[1];
  if (encoded === undefined || encoded.length === 0) {
    return { kind: 'invalid', source: 'universal-link' };
  }
  let decoded: ReturnType<typeof decodeShareUrl>;
  try {
    decoded = decodeShareUrl(encoded);
  } catch (err) {
    if (err instanceof UnsupportedShareVersionError) {
      return {
        kind: 'unsupported-version',
        source: 'universal-link',
        version: err.version,
      };
    }
    if (err instanceof InvalidShareUrlError) {
      return { kind: 'invalid', source: 'universal-link' };
    }
    return { kind: 'invalid', source: 'universal-link' };
  }
  return finalizeDecodedShare(decoded, 'universal-link');
}

function parseShareCustomScheme(url: URL): ShareParseResult {
  const tokens = url.searchParams.getAll('token');
  const legacyUrls = url.searchParams.getAll('url');

  if (tokens.length > 0) {
    if (tokens.length !== 1 || tokens[0] === '' || legacyUrls.length !== 0) {
      return { kind: 'invalid', source: 'custom-scheme' };
    }
    try {
      const decoded = decodeShareUrl(tokens[0]);
      if (decoded.version !== 2) return { kind: 'invalid', source: 'custom-scheme' };
      return finalizeDecodedShare(decoded, 'custom-scheme');
    } catch (err) {
      if (err instanceof UnsupportedShareVersionError) {
        return { kind: 'unsupported-version', source: 'custom-scheme', version: err.version };
      }
      return { kind: 'invalid', source: 'custom-scheme' };
    }
  }

  if (legacyUrls.length !== 1 || legacyUrls[0] === '') {
    return { kind: 'invalid', source: 'custom-scheme' };
  }
  return finalizeV1ShareResult(legacyUrls[0], 'custom-scheme');
}

const MAX_SHARED_URL_LENGTH = 4096;

function finalizeDecodedShare(
  decoded: ReturnType<typeof decodeShareUrl>,
  source: ShareUrlSource,
): ShareParseResult {
  if (decoded.version === 1) return finalizeV1ShareResult(decoded.sharedUrl, source);

  const repositoryPath = decoded.source.targetSegments.join('/');
  const repositoryTarget: ShareTarget =
    decoded.source.kind === 'doc'
      ? { kind: 'doc', docPath: repositoryPath }
      : { kind: 'folder', folderPath: repositoryPath };
  return {
    kind: 'ok',
    source,
    dedupKey: `2:${decoded.contentRootDepth}:${decoded.sharedUrl}`,
    payload: {
      contentRootDepth: decoded.contentRootDepth,
      host: decoded.source.host,
      owner: decoded.source.owner,
      repo: decoded.source.repo,
      branch: decoded.source.branch,
      repositoryTarget,
      sharedUrl: decoded.sharedUrl,
      target: decoded.target,
    },
  };
}

function finalizeV1ShareResult(sharedUrl: string, source: ShareUrlSource): ShareParseResult {
  if (typeof sharedUrl !== 'string' || sharedUrl.length === 0) {
    return { kind: 'invalid', source };
  }
  if (sharedUrl.length > MAX_SHARED_URL_LENGTH) {
    return { kind: 'invalid', source };
  }
  if (sharedUrl.includes('\x00')) {
    return { kind: 'invalid', source };
  }
  const parsed = parseGitHubShareUrl(sharedUrl);
  if (parsed === null) {
    return { kind: 'invalid', source };
  }
  const target: ShareTarget =
    parsed.kind === 'doc'
      ? { kind: 'doc', docPath: parsed.path }
      : { kind: 'folder', folderPath: parsed.path };
  return {
    kind: 'ok',
    source,
    dedupKey: `1:${sharedUrl}`,
    payload: {
      contentRootDepth: null,
      host: parsed.host,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch,
      repositoryTarget: target,
      sharedUrl,
      target,
    },
  };
}

export function parseOpenKnowledgeUrl(input: string): ParsedOpenKnowledgeUrl | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.includes('\x00') || /%00/i.test(input)) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'openknowledge:') return null;
  if (parsed.hostname !== 'open') return null;

  const rawProject = parsed.searchParams.get('project');
  const rawDoc = parsed.searchParams.get('doc');
  const rawFolder = parsed.searchParams.get('folder');
  if (!rawProject) return null;
  if ((rawDoc == null) === (rawFolder == null)) return null;
  const kind: 'doc' | 'folder' = rawDoc != null ? 'doc' : 'folder';
  const rawTarget = (rawDoc ?? rawFolder) as string;

  let project: string;
  let doc: string;
  try {
    project = decodeURIComponent(rawProject);
    doc = decodeURIComponent(rawTarget);
  } catch {
    return null;
  }

  if (project.includes('\x00') || doc.includes('\x00')) return null;

  if (project.length === 0 || doc.length === 0) return null;

  if (!isAbsolute(project)) return null;
  if (project.split(/[/\\]/).includes('..')) return null;

  if (doc.includes('\\')) return null;
  if (doc.startsWith('/')) return null;
  if (doc.split('/').includes('..')) return null;

  return {
    host: 'open',
    project: resolve(project),
    kind,
    doc,
  };
}

interface ParsedOpenKnowledgeFileUrl {
  readonly host: 'open';
  readonly file: string;
}

export function parseOpenKnowledgeFileUrl(input: string): ParsedOpenKnowledgeFileUrl | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.includes('\x00') || /%00/i.test(input)) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'openknowledge:') return null;
  if (parsed.hostname !== 'open') return null;

  const rawFile = parsed.searchParams.get('file');
  if (!rawFile) return null;

  let file: string;
  try {
    file = decodeURIComponent(rawFile);
  } catch {
    return null;
  }

  if (file.includes('\x00')) return null;
  if (file.length === 0) return null;

  if (!isAbsolute(file)) return null;
  if (file.split(/[/\\]/).includes('..')) return null;

  return { host: 'open', file: resolve(file) };
}

const SCREEN_TARGETS = ['settings', 'install-claude'] as const;
export type ScreenTarget = (typeof SCREEN_TARGETS)[number];

interface ParsedScreenUrl {
  readonly host: 'screen';
  readonly name: ScreenTarget;
}

function isScreenTarget(value: string): value is ScreenTarget {
  return (SCREEN_TARGETS as readonly string[]).includes(value);
}

export function parseScreenUrl(input: string): ParsedScreenUrl | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.includes('\x00') || /%00/i.test(input)) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'openknowledge:') return null;
  if (parsed.hostname !== 'screen') return null;

  const rawName = parsed.searchParams.get('name');
  if (!rawName) return null;

  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  if (!isScreenTarget(name)) return null;

  return { host: 'screen', name };
}

export type ForeignHostDecision = 'proceed' | 'open-browser' | 'connect' | 'cancel';

interface ProtocolHandlerDeps {
  app: {
    on(event: 'open-url', cb: (event: { preventDefault: () => void }, url: string) => void): void;
    on(event: 'open-file', cb: (event: { preventDefault: () => void }, path: string) => void): void;
    on(event: 'second-instance', cb: (event: unknown, argv: readonly string[]) => void): void;
    on(event: 'before-quit', cb: () => void): void;
    on(
      event: 'continue-activity',
      cb: (
        event: { preventDefault: () => void },
        type: string,
        userInfo: unknown,
        details?: { webpageURL?: string },
      ) => void,
    ): void;
    whenReady(): Promise<void>;
    isPackaged: boolean;
    setAsDefaultProtocolClient(scheme: string): boolean;
    removeAsDefaultProtocolClient(scheme: string): boolean;
  };
  focusWindowForProject(projectPath: string): BrowserWindowHandle | null;
  openProject(
    projectPath: string,
    opts?: {
      pendingDeepLinkTarget?: {
        kind: 'doc' | 'folder';
        path: string;
        repositoryPath?: string;
        contentRootDepth?: number;
      };
      pendingBranch?: string | null;
      pendingMultiCandidate?: boolean;
      pendingTargetMissing?: boolean;
      pendingShareBranchSwitch?: ShareDeepLinkBranchSwitchPayload;
    },
  ): Promise<BrowserWindowHandle | null>;
  openEphemeralFile?(filePath: string): Promise<void>;
  sendDeepLink(
    win: BrowserWindowHandle,
    payload: {
      doc: string;
      kind: 'doc' | 'folder';
      branch?: string | null;
      multiCandidate?: boolean;
      targetMissing?: boolean;
      repositoryPath?: string;
      contentRootDepth?: number;
    },
  ): void;
  sendShareDeepLink?(win: BrowserWindowHandle, payload: ShareDeepLinkPayload): void;
  resolveShareTarget?(share: ShareUrlPayload): Promise<CandidateSelection>;
  gateForeignShareHost?(host: string, sharedUrl: string): Promise<ForeignHostDecision>;
  checkShareTargetExists?(
    projectPath: string,
    kind: 'doc' | 'folder',
    path: string,
  ): CheckTargetExistsResult;
  routeShareToNavigator?(payload: ShareNavigatorPayload): void;
  openScreen?(win: BrowserWindowHandle, screen: ScreenTarget): void;
  getFocusedWindow?(): BrowserWindowHandle | null;
  getAnyReadyWindow(): BrowserWindowHandle | null;
  getInitialArgv?: () => readonly string[];
  setTimeout?: (cb: () => void, ms: number) => unknown;
  platform?: NodeJS.Platform;
  now?: () => number;
  log?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    info?(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

// biome-ignore lint/suspicious/noEmptyInterface: intentional — opaque handle.
interface BrowserWindowHandle {}

interface ProtocolHandlerControl {
  singleFileLaunch(): boolean;
  urlLaunchOwnsWindow(): boolean;
  drainQueuedUrls(): void;
  routeUrl(url: string): void;
  waitForUrlLaunchSettled(): Promise<void>;
}

const SHARE_DEDUP_WINDOW_MS = 10_000;

const QUEUE_FLUSH_MAX_ATTEMPTS = 10;
const QUEUE_FLUSH_INTERVAL_MS = 500;

const URL_LAUNCH_SETTLE_GRACE_MS = 250;

export function registerProtocolHandler(deps: ProtocolHandlerDeps): ProtocolHandlerControl {
  const schedule = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const platform = deps.platform ?? process.platform;
  const urlQueue: string[] = [];
  const shareDedup = new Map<string, number>();
  let flushed = false;
  let singleFileLaunch = false;
  let urlLaunchOwnsWindow = false;

  let settled = false;
  let settleResolve: (() => void) | null = null;
  const settlePromise = new Promise<void>((res) => {
    settleResolve = res;
  });
  const settleNow = (): void => {
    if (settled) return;
    settled = true;
    settleResolve?.();
    settleResolve = null;
  };

  if (!deps.app.isPackaged) {
    try {
      const ok = deps.app.setAsDefaultProtocolClient('openknowledge');
      if (!ok) {
        deps.log?.warn(
          {},
          '[url-scheme] setAsDefaultProtocolClient returned false — dev deep-links may not reach this instance',
        );
      } else {
        deps.app.on('before-quit', () => {
          try {
            deps.app.removeAsDefaultProtocolClient('openknowledge');
          } catch (err) {
            deps.log?.warn(
              { err },
              '[url-scheme] removeAsDefaultProtocolClient failed on before-quit',
            );
          }
        });
      }
    } catch (err) {
      deps.log?.warn({ err }, '[url-scheme] setAsDefaultProtocolClient failed');
    }
  } else {
    try {
      const ok = deps.app.setAsDefaultProtocolClient('openknowledge');
      if (!ok) {
        deps.log?.error(
          {},
          '[url-scheme] packaged setAsDefaultProtocolClient returned false — openknowledge:// links may not reach this install',
        );
      }
    } catch (err) {
      deps.log?.error({ err }, '[url-scheme] packaged setAsDefaultProtocolClient failed');
    }
  }

  const broadcastShareToast = (
    payload: { readonly kind: 'unsupported-version' } | { readonly kind: 'invalid' },
  ): void => {
    const sendShare = deps.sendShareDeepLink;
    if (!sendShare) {
      deps.log?.warn({}, '[receive] sendShareDeepLink dep missing — share dropped');
      return;
    }
    const target = deps.getFocusedWindow?.() ?? deps.getAnyReadyWindow();
    if (!target) {
      deps.log?.warn({}, '[receive] no target window — share dropped');
      return;
    }
    sendShare(target, payload);
  };

  const dispatchResolvedShare = (share: ShareUrlPayload, selection: CandidateSelection): void => {
    deps.log?.info?.({ selection: selection.kind }, '[receive] action=routed');
    const degradeToLauncherMiss = (logCtx: Record<string, unknown>, message: string): void => {
      deps.log?.warn(logCtx, message);
      if (!deps.routeShareToNavigator) {
        deps.log?.warn(
          logCtx,
          '[receive] routeShareToNavigator dep missing — launcher-miss degrade dropped',
        );
        return;
      }
      deps.routeShareToNavigator({ kind: 'launcher-miss', share });
    };
    switch (selection.kind) {
      case 'branch-match-ok': {
        const targetPath = shareTargetPath(share.target);
        const repositoryPath = shareTargetPath(share.repositoryTarget);
        const isContentRoot = share.target.kind === 'folder' && targetPath === '';
        const targetMissing =
          !isContentRoot &&
          deps.checkShareTargetExists?.(
            selection.candidate.path,
            share.repositoryTarget.kind,
            repositoryPath,
          ) === 'missing';
        if (targetMissing) {
          deps.log?.warn(
            { targetKind: share.repositoryTarget.kind },
            '[receive] target_check=missing — share target not on checked-out branch; dispatching with in-context toast',
          );
        }
        const existing = deps.focusWindowForProject(selection.candidate.path);
        if (existing) {
          deps.sendDeepLink(existing, {
            doc: targetPath,
            kind: share.target.kind,
            branch: share.branch,
            multiCandidate: selection.multiCandidate,
            repositoryPath,
            ...(share.contentRootDepth === null
              ? {}
              : { contentRootDepth: share.contentRootDepth }),
            ...(targetMissing ? { targetMissing: true } : {}),
          });
          return;
        }
        void deps
          .openProject(selection.candidate.path, {
            pendingDeepLinkTarget: {
              kind: share.target.kind,
              path: targetPath,
              repositoryPath,
              ...(share.contentRootDepth === null
                ? {}
                : { contentRootDepth: share.contentRootDepth }),
            },
            pendingBranch: share.branch,
            pendingMultiCandidate: selection.multiCandidate,
            ...(targetMissing ? { pendingTargetMissing: true } : {}),
          })
          .then((win) => {
            if (win === null) {
              degradeToLauncherMiss(
                {},
                '[receive] openProject(branch-match-ok) returned null — degrading to launcher-miss',
              );
            }
          })
          .catch((err) => {
            degradeToLauncherMiss(
              {
                errorKind: err instanceof Error ? err.name : typeof err,
                errorCode: err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined,
              },
              '[receive] openProject(branch-match-ok) failed — degrading to launcher-miss',
            );
          });
        return;
      }
      case 'fallback': {
        const branchSwitch: ShareDeepLinkBranchSwitchPayload = {
          share,
          projectPath: selection.anchor.path,
          currentBranch: selection.anchor.head.currentBranch,
        };
        const existing = deps.focusWindowForProject(selection.anchor.path);
        if (existing) {
          if (deps.sendShareDeepLink) {
            deps.sendShareDeepLink(existing, { kind: 'project-branch-switch', ...branchSwitch });
            return;
          }
          deps.log?.warn(
            {},
            '[receive] sendShareDeepLink dep missing — branch-switch payload not delivered to open window',
          );
        }
        void deps
          .openProject(selection.anchor.path, { pendingShareBranchSwitch: branchSwitch })
          .then((win) => {
            if (win === null) {
              degradeToLauncherMiss(
                {},
                '[receive] openProject(branch-switch) returned null — degrading to launcher-miss',
              );
            }
          })
          .catch((err) => {
            degradeToLauncherMiss(
              {
                errorKind: err instanceof Error ? err.name : typeof err,
                errorCode: err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined,
              },
              '[receive] openProject(branch-switch) failed — degrading to launcher-miss',
            );
          });
        return;
      }
      case 'branch-match-non-ok': {
        const routeToNav = deps.routeShareToNavigator;
        if (!routeToNav) {
          deps.log?.warn(
            {},
            '[receive] routeShareToNavigator dep missing — launcher-consent dropped',
          );
          return;
        }
        routeToNav({
          kind: 'launcher-consent',
          share,
          candidatePath: selection.candidate.path,
          parentProjectName: selection.anchorRecent?.name ?? null,
        });
        return;
      }
      case 'miss': {
        const routeToNav = deps.routeShareToNavigator;
        if (!routeToNav) {
          deps.log?.warn({}, '[receive] routeShareToNavigator dep missing — launcher-miss dropped');
          return;
        }
        routeToNav({ kind: 'launcher-miss', share });
        return;
      }
      default: {
        const _exhaustive: never = selection;
        deps.log?.warn(
          { selection: (_exhaustive as { kind: string }).kind },
          '[receive] unknown CandidateSelection kind — share dropped',
        );
      }
    }
  };

  const routeShare = (result: ShareParseResult): void => {
    const diagnostic =
      result.kind === 'ok'
        ? {
            source: result.source,
            result: result.kind,
            codecVersion:
              result.payload.contentRootDepth !== null ? ('v2' as const) : ('v1' as const),
            targetKind: result.payload.target.kind,
            rootScope:
              result.payload.contentRootDepth !== null ? ('nested' as const) : ('unknown' as const),
          }
        : {
            source: result.source,
            result: result.kind,
            codecVersion:
              result.kind === 'unsupported-version'
                ? ('unsupported' as const)
                : ('unknown' as const),
            targetKind: 'unknown' as const,
            rootScope: 'unknown' as const,
          };
    if (result.kind === 'ok') {
      deps.log?.info?.(diagnostic, '[receive] action=url-parse');
    } else if (result.kind === 'unsupported-version') {
      deps.log?.warn({ ...diagnostic, version: result.version }, '[receive] action=url-parse');
    } else {
      deps.log?.warn(diagnostic, '[receive] action=url-parse');
    }
    if (result.kind !== 'ok') {
      broadcastShareToast({ kind: result.kind });
      return;
    }
    const now = deps.now ? deps.now() : Date.now();
    const last = shareDedup.get(result.dedupKey);
    if (last !== undefined && now - last < SHARE_DEDUP_WINDOW_MS) {
      deps.log?.warn({ source: result.source, result: result.kind }, '[receive] action=deduped');
      return;
    }
    shareDedup.set(result.dedupKey, now);
    for (const [key, ts] of shareDedup) {
      if (now - ts >= SHARE_DEDUP_WINDOW_MS) shareDedup.delete(key);
    }
    const resolver = deps.resolveShareTarget;
    if (!resolver) {
      deps.log?.warn({}, '[receive] resolveShareTarget dep missing — share dropped');
      return;
    }
    if (result.payload.host !== 'github.com') {
      const gate = deps.gateForeignShareHost;
      if (!gate) {
        deps.log?.warn(
          { host: result.payload.host },
          '[receive] foreign-host share with no gate — dropped',
        );
        return;
      }
      void gate(result.payload.host, result.payload.sharedUrl).then(
        (decision) => {
          if (decision === 'proceed') {
            void resolver(result.payload).then(
              (selection) => dispatchResolvedShare(result.payload, selection),
              () => dispatchResolvedShare(result.payload, { kind: 'miss' }),
            );
          } else {
            deps.log?.info?.(
              { host: result.payload.host, decision },
              '[receive] foreign-host share not proceeded',
            );
          }
        },
        (err) => {
          deps.log?.warn(
            { errorKind: err instanceof Error ? err.name : typeof err },
            '[receive] foreign-host gate rejected — share dropped',
          );
        },
      );
      return;
    }
    void resolver(result.payload).then(
      (selection) => dispatchResolvedShare(result.payload, selection),
      (err) => {
        deps.log?.warn(
          { errorKind: err instanceof Error ? err.name : typeof err },
          '[receive] resolveShareTarget rejected — degrading to Navigator (miss)',
        );
        dispatchResolvedShare(result.payload, { kind: 'miss' });
      },
    );
  };

  const routeScreen = (url: string, screen: ScreenTarget): void => {
    deps.log?.info?.({ url, screen }, '[url-scheme] routing screen deep link');
    const openScreen = deps.openScreen;
    if (!openScreen) {
      deps.log?.warn({ url }, '[url-scheme] openScreen dep missing — screen deep link dropped');
      return;
    }
    const target = deps.getFocusedWindow?.() ?? deps.getAnyReadyWindow();
    if (!target) {
      deps.log?.warn({ url, screen }, '[url-scheme] no target window — screen deep link dropped');
      return;
    }
    openScreen(target, screen);
  };

  const routeUrl = (url: string): void => {
    const share = parseShareUrl(url);
    if (share !== null) {
      routeShare(share);
      return;
    }
    const screen = parseScreenUrl(url);
    if (screen !== null) {
      routeScreen(url, screen.name);
      return;
    }
    const fileOpen = parseOpenKnowledgeFileUrl(url);
    if (fileOpen !== null) {
      const open = deps.openEphemeralFile;
      if (!open) {
        deps.log?.warn(
          { url },
          '[url-scheme] openEphemeralFile dep missing — single-file open dropped',
        );
        return;
      }
      void open(fileOpen.file).catch((err) => {
        deps.log?.warn({ err, file: fileOpen.file }, '[url-scheme] openEphemeralFile failed');
      });
      return;
    }
    const parsed = parseOpenKnowledgeUrl(url);
    if (!parsed) {
      deps.log?.warn({}, '[url-scheme] dropped malformed URL');
      return;
    }
    const existing = deps.focusWindowForProject(parsed.project);
    if (existing) {
      deps.sendDeepLink(existing, { doc: parsed.doc, kind: parsed.kind });
      return;
    }
    void deps
      .openProject(parsed.project, {
        pendingDeepLinkTarget: { kind: parsed.kind, path: parsed.doc },
      })
      .catch((err) => {
        deps.log?.warn({ err, project: parsed.project }, '[url-scheme] openProject failed');
      });
  };

  const drainAll = (): void => {
    flushed = true;
    while (urlQueue.length > 0) {
      const next = urlQueue.shift();
      if (next) routeUrl(next);
    }
  };

  const enqueueOrRoute = (url: string): void => {
    const isSingleFile = parseOpenKnowledgeFileUrl(url) !== null;
    if (isSingleFile) {
      singleFileLaunch = true;
    }
    if (isSingleFile || parseShareUrl(url)?.kind === 'ok') {
      urlLaunchOwnsWindow = true;
      settleNow();
    }
    if (flushed) {
      routeUrl(url);
    } else {
      urlQueue.push(url);
    }
  };

  deps.app.on('open-url', (event, url) => {
    event.preventDefault();
    enqueueOrRoute(url);
  });

  deps.app.on('open-file', (event, filePath) => {
    event.preventDefault();
    enqueueOrRoute(`openknowledge://open?file=${encodeURIComponent(filePath)}`);
  });

  deps.app.on('continue-activity', (event, type, userInfo, details) => {
    if (type !== 'NSUserActivityTypeBrowsingWeb') return;
    const webpageURL =
      readWebpageURL(details) ?? readWebpageURL(userInfo as { webpageURL?: unknown } | undefined);
    if (!webpageURL) return;
    let host: string;
    try {
      host = new URL(webpageURL).hostname.toLowerCase();
    } catch {
      return;
    }
    if (!SHARE_UNIVERSAL_LINK_HOSTS.has(host)) return;
    event.preventDefault();
    deps.log?.warn({ type, urlHost: host }, '[receive] action=continue-activity-received');
    enqueueOrRoute(webpageURL);
  });

  deps.app.on('second-instance', (_event, argv) => {
    for (const arg of argv) {
      if (typeof arg === 'string' && arg.startsWith('openknowledge://')) {
        enqueueOrRoute(arg);
      }
    }
  });

  const initialArgv = deps.getInitialArgv ? deps.getInitialArgv() : [];
  for (const arg of initialArgv) {
    if (typeof arg === 'string' && arg.startsWith('openknowledge://')) {
      enqueueOrRoute(arg);
    }
  }

  void deps.app.whenReady().then(() => {
    if (platform === 'darwin') {
      schedule(() => settleNow(), URL_LAUNCH_SETTLE_GRACE_MS);
    }
    const tryFlush = (attempt: number): void => {
      if (urlQueue.length === 0 || deps.getAnyReadyWindow()) {
        drainAll();
        return;
      }
      if (attempt >= QUEUE_FLUSH_MAX_ATTEMPTS) {
        drainAll();
        return;
      }
      schedule(() => tryFlush(attempt + 1), QUEUE_FLUSH_INTERVAL_MS);
    };
    tryFlush(0);
  });

  return {
    singleFileLaunch: () => singleFileLaunch,
    urlLaunchOwnsWindow: () => urlLaunchOwnsWindow,
    drainQueuedUrls: () => drainAll(),
    routeUrl: (url) => enqueueOrRoute(url),
    waitForUrlLaunchSettled: () => {
      if (platform !== 'darwin') return Promise.resolve();
      if (urlLaunchOwnsWindow) return Promise.resolve();
      return settlePromise;
    },
  };
}
