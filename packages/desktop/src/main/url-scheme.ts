
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
  readonly doc: string;
}

const SHARE_UNIVERSAL_LINK_HOSTS = new Set(['openknowledge.ai', 'www.openknowledge.ai']);

const SHARE_UNIVERSAL_LINK_PATH_PREFIX = '/d/';

function readWebpageURL(source: unknown): string | null {
  if (source === null || typeof source !== 'object') return null;
  const candidate = (source as { webpageURL?: unknown }).webpageURL;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/** Successful share-URL parse — the routing payload the receive dialog renders
 *  against. Aliases the canonical kind-aware `OkSharePayloadFields` (carries
 *  `target: ShareTarget` + `sharedUrl`) so the parse output and the IPC payload
 *  can't drift, matching the `ShareDeepLinkFields` alias. */
export type ShareUrlPayload = OkSharePayloadFields;

export type ShareUrlSource = 'universal-link' | 'custom-scheme';

export type ShareParseResult =
  | { readonly kind: 'ok'; readonly source: ShareUrlSource; readonly payload: ShareUrlPayload }
  | {
      readonly kind: 'unsupported-version';
      readonly source: ShareUrlSource;
      readonly version: number;
    }
  | { readonly kind: 'invalid'; readonly source: ShareUrlSource };

export type ShareDeepLinkFields = OkSharePayloadFields;

export interface ShareDeepLinkBranchSwitchPayload {
  readonly share: ShareDeepLinkFields;
  readonly projectPath: string;
  readonly currentBranch: string | null;
}

export type ShareDeepLinkPayload = OkShareReceivedPayload;

/** Launcher-scoped subset of `ShareDeepLinkPayload` — the two kinds the
 *  Navigator hosts. Derived (not hand-copied) from `ShareDeepLinkPayload` so it
 *  stays in lockstep with the source variants; passed to `routeShareToNavigator`
 *  so the routing decision stays exhaustive at compile time. */
export type ShareNavigatorPayload = Extract<
  ShareDeepLinkPayload,
  { readonly kind: 'launcher-consent' } | { readonly kind: 'launcher-miss' }
>;

export function parseShareUrl(input: string): ShareParseResult | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.includes('\x00') || /%00/i.test(input)) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol === 'openknowledge:' && url.hostname === 'share') {
    return parseShareCustomScheme(url);
  }
  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    SHARE_UNIVERSAL_LINK_HOSTS.has(url.hostname) &&
    url.pathname.startsWith(SHARE_UNIVERSAL_LINK_PATH_PREFIX)
  ) {
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
  let decoded: { sharedUrl: string };
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
  return finalizeShareResult(decoded.sharedUrl, 'universal-link');
}

function parseShareCustomScheme(url: URL): ShareParseResult {
  const rawSharedUrl = url.searchParams.get('url');
  if (!rawSharedUrl) {
    return { kind: 'invalid', source: 'custom-scheme' };
  }
  return finalizeShareResult(rawSharedUrl, 'custom-scheme');
}

const MAX_SHARED_URL_LENGTH = 4096;

function finalizeShareResult(sharedUrl: string, source: ShareUrlSource): ShareParseResult {
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
    payload: {
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch,
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
  if (!rawProject || !rawDoc) return null;

  let project: string;
  let doc: string;
  try {
    project = decodeURIComponent(rawProject);
    doc = decodeURIComponent(rawDoc);
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

interface ProtocolHandlerDeps {
  app: {
    on(event: 'open-url', cb: (event: { preventDefault: () => void }, url: string) => void): void;
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
      pendingDeepLinkTarget?: { kind: 'doc' | 'folder'; path: string };
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
    },
  ): void;
  sendShareDeepLink?(win: BrowserWindowHandle, payload: ShareDeepLinkPayload): void;
  resolveShareTarget?(share: ShareUrlPayload): Promise<CandidateSelection>;
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
  now?: () => number;
  log?: {
    warn(obj: object, msg: string): void;
    info?(obj: object, msg: string): void;
  };
}

// biome-ignore lint/suspicious/noEmptyInterface: intentional — opaque handle.
interface BrowserWindowHandle {}

interface ProtocolHandlerControl {
  singleFileLaunch(): boolean;
  urlLaunchOwnsWindow(): boolean;
  drainQueuedUrls(): void;
  routeUrl(url: string): void;
}

const SHARE_DEDUP_WINDOW_MS = 10_000;

const QUEUE_FLUSH_MAX_ATTEMPTS = 10;
const QUEUE_FLUSH_INTERVAL_MS = 500;

export function registerProtocolHandler(deps: ProtocolHandlerDeps): ProtocolHandlerControl {
  const schedule = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const urlQueue: string[] = [];
  const shareDedup = new Map<string, number>();
  let flushed = false;
  let singleFileLaunch = false;
  let urlLaunchOwnsWindow = false;

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
              { err: (err as Error).message },
              '[url-scheme] removeAsDefaultProtocolClient failed on before-quit',
            );
          }
        });
      }
    } catch (err) {
      deps.log?.warn(
        { err: (err as Error).message },
        '[url-scheme] setAsDefaultProtocolClient failed',
      );
    }
  }

  const broadcastShareToast = (
    url: string,
    payload: { readonly kind: 'unsupported-version' } | { readonly kind: 'invalid' },
  ): void => {
    const sendShare = deps.sendShareDeepLink;
    if (!sendShare) {
      deps.log?.warn({ url }, '[receive] sendShareDeepLink dep missing — share dropped');
      return;
    }
    const target = deps.getFocusedWindow?.() ?? deps.getAnyReadyWindow();
    if (!target) {
      deps.log?.warn({ url }, '[receive] no target window — share dropped');
      return;
    }
    sendShare(target, payload);
  };

  const dispatchResolvedShare = (
    url: string,
    share: ShareUrlPayload,
    selection: CandidateSelection,
  ): void => {
    deps.log?.info?.({ url, selection: selection.kind }, '[receive] action=routed');
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
        const isContentRoot = share.target.kind === 'folder' && targetPath === '';
        const targetMissing =
          !isContentRoot &&
          deps.checkShareTargetExists?.(selection.candidate.path, share.target.kind, targetPath) ===
            'missing';
        if (targetMissing) {
          deps.log?.warn(
            { url, project: selection.candidate.path },
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
            ...(targetMissing ? { targetMissing: true } : {}),
          });
          return;
        }
        void deps
          .openProject(selection.candidate.path, {
            pendingDeepLinkTarget: { kind: share.target.kind, path: targetPath },
            pendingBranch: share.branch,
            pendingMultiCandidate: selection.multiCandidate,
            ...(targetMissing ? { pendingTargetMissing: true } : {}),
          })
          .then((win) => {
            if (win === null) {
              degradeToLauncherMiss(
                { url, project: selection.candidate.path },
                '[receive] openProject(branch-match-ok) returned null — degrading to launcher-miss',
              );
            }
          })
          .catch((err) => {
            degradeToLauncherMiss(
              {
                url,
                err: err instanceof Error ? err.message : String(err),
                project: selection.candidate.path,
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
            { url, project: selection.anchor.path },
            '[receive] sendShareDeepLink dep missing — branch-switch payload not delivered to open window',
          );
        }
        void deps
          .openProject(selection.anchor.path, { pendingShareBranchSwitch: branchSwitch })
          .then((win) => {
            if (win === null) {
              degradeToLauncherMiss(
                { url, project: selection.anchor.path },
                '[receive] openProject(branch-switch) returned null — degrading to launcher-miss',
              );
            }
          })
          .catch((err) => {
            degradeToLauncherMiss(
              {
                url,
                err: err instanceof Error ? err.message : String(err),
                project: selection.anchor.path,
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
            { url },
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
          deps.log?.warn(
            { url },
            '[receive] routeShareToNavigator dep missing — launcher-miss dropped',
          );
          return;
        }
        routeToNav({ kind: 'launcher-miss', share });
        return;
      }
      default: {
        const _exhaustive: never = selection;
        deps.log?.warn(
          { url, selection: (_exhaustive as { kind: string }).kind },
          '[receive] unknown CandidateSelection kind — share dropped',
        );
      }
    }
  };

  const routeShare = (url: string, result: ShareParseResult): void => {
    if (result.kind === 'unsupported-version') {
      deps.log?.warn(
        { source: result.source, result: result.kind, version: result.version },
        '[receive] action=url-parse',
      );
    } else {
      deps.log?.warn({ source: result.source, result: result.kind }, '[receive] action=url-parse');
    }
    if (result.kind !== 'ok') {
      broadcastShareToast(url, { kind: result.kind });
      return;
    }
    const now = deps.now ? deps.now() : Date.now();
    const last = shareDedup.get(result.payload.sharedUrl);
    if (last !== undefined && now - last < SHARE_DEDUP_WINDOW_MS) {
      deps.log?.warn({ source: result.source, result: result.kind }, '[receive] action=deduped');
      return;
    }
    shareDedup.set(result.payload.sharedUrl, now);
    for (const [url, ts] of shareDedup) {
      if (now - ts >= SHARE_DEDUP_WINDOW_MS) shareDedup.delete(url);
    }
    const resolver = deps.resolveShareTarget;
    if (!resolver) {
      deps.log?.warn({ url }, '[receive] resolveShareTarget dep missing — share dropped');
      return;
    }
    void resolver(result.payload).then(
      (selection) => dispatchResolvedShare(url, result.payload, selection),
      (err) => {
        deps.log?.warn(
          { err: err instanceof Error ? err.message : String(err), url },
          '[receive] resolveShareTarget rejected — degrading to Navigator (miss)',
        );
        dispatchResolvedShare(url, result.payload, { kind: 'miss' });
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
      routeShare(url, share);
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
        deps.log?.warn(
          { err: (err as Error).message, file: fileOpen.file },
          '[url-scheme] openEphemeralFile failed',
        );
      });
      return;
    }
    const parsed = parseOpenKnowledgeUrl(url);
    if (!parsed) {
      deps.log?.warn({ url }, '[url-scheme] dropped malformed URL');
      return;
    }
    const existing = deps.focusWindowForProject(parsed.project);
    if (existing) {
      deps.sendDeepLink(existing, { doc: parsed.doc, kind: 'doc' });
      return;
    }
    void deps
      .openProject(parsed.project, { pendingDeepLinkTarget: { kind: 'doc', path: parsed.doc } })
      .catch((err) => {
        deps.log?.warn(
          { err: (err as Error).message, project: parsed.project },
          '[url-scheme] openProject failed',
        );
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
  };
}
