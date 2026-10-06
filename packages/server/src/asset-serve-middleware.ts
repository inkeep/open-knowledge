import { realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { SANDBOXED_HTML_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { isWithinContentDir } from './content-path.ts';
import { resolvesIntoPrivateState } from './fs-safety.ts';
import { errorResponse } from './http/error-response.ts';
import {
  HOST_NOT_ADMITTED_REMEDIATION,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
} from './ingress-policy.ts';
import { isValidRelativeContentPath } from './relative-content-path.ts';
import { classifyAssetDisposition } from './services/asset-classification.ts';

export interface AssetServeFilter {
  isPathIgnored(relativePath: string): boolean;
}

export type SirvLikeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  fallback: () => void,
) => void;

interface AssetServeMiddlewareDeps {
  contentDir: string;
  contentFilter: AssetServeFilter;
  contentSirv: SirvLikeMiddleware;
  inlineExtensions: ReadonlySet<string>;
  assetExtensions: ReadonlySet<string>;
  blocklistExtensions: ReadonlySet<string>;
  ingressPolicy: IngressPolicy;
  resolveTrackedFile?: (relativePath: string) => string | undefined;
}

function sirvLookupPath(url: string): string {
  let pathname = url;
  if (pathname.length > 1) {
    const hash = pathname.indexOf('#', 1);
    if (hash !== -1) pathname = pathname.slice(0, hash);
    const query = pathname.indexOf('?', 1);
    if (query !== -1) pathname = pathname.slice(0, query);
  }
  if (!pathname.includes('%')) return pathname;
  try {
    return decodeURI(pathname);
  } catch {
    return pathname;
  }
}

function urlLookingUpExactly(relativePath: string, requestUrl: string): string | null {
  let encoded: string;
  try {
    encoded = encodeURI(relativePath);
  } catch {
    return null;
  }
  const query = requestUrl.indexOf('?');
  const url = `/${encoded}${query === -1 ? '' : requestUrl.slice(query)}`;
  return sirvLookupPath(url) === `/${relativePath}` ? url : null;
}

function isServableContentFile(contentDir: string, url: string): boolean {
  const root = resolve(contentDir);
  const requested = normalize(join(`${root}${sep}`, sirvLookupPath(url)));
  if (!requested.startsWith(`${root}${sep}`)) return false;
  try {
    const contentRoot = realpathSync(root);
    const canonical = realpathSync(requested);
    return (
      statSync(canonical).isFile() &&
      isWithinContentDir(canonical, contentRoot) &&
      !resolvesIntoPrivateState(
        join(contentRoot, relative(root, requested)),
        canonical,
        contentRoot,
      )
    );
  } catch {
    return false;
  }
}

export function createAssetServeMiddleware(
  deps: AssetServeMiddlewareDeps,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const {
    contentDir,
    contentFilter,
    contentSirv,
    inlineExtensions,
    assetExtensions,
    blocklistExtensions,
    ingressPolicy,
    resolveTrackedFile,
  } = deps;

  const extensionOf = (relativePath: string): string =>
    extname(relativePath).slice(1).toLowerCase();

  const servableTrackedFile = (
    requested: string,
    requestUrl: string,
  ): { url: string; ext: string } | null => {
    const tracked = resolveTrackedFile?.(requested);
    if (tracked === undefined || tracked === requested) return null;
    const ext = extensionOf(tracked);
    if (contentFilter.isPathIgnored(tracked) || !assetExtensions.has(ext)) return null;
    const url = urlLookingUpExactly(tracked, requestUrl);
    return url !== null && isServableContentFile(contentDir, url) ? { url, ext } : null;
  };

  return (req, res, next) => {
    const requestUrl = req.url ?? '';
    let rel: string;
    try {
      rel = decodeURIComponent(requestUrl.split('?')[0]?.replace(/^\//, '') ?? '');
    } catch {
      return next();
    }
    const sirvLooksUpRel =
      sirvLookupPath(requestUrl) === `/${rel}` && isValidRelativeContentPath(rel);
    const requestedExt = extensionOf(rel);
    const isDocExt = requestedExt === 'md' || requestedExt === 'mdx';
    if (
      !rel ||
      contentFilter.isPathIgnored(rel) ||
      (!isDocExt && !assetExtensions.has(requestedExt))
    )
      return next();
    const peerAddress = req.socket?.remoteAddress;
    if (peerAddress !== undefined && !isPeerAdmitted(peerAddress, ingressPolicy)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'content-asset-gate',
      });
      return;
    }
    if (!isHostAdmitted(req.headers.host, ingressPolicy)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'content-asset-gate',
        detail: HOST_NOT_ADMITTED_REMEDIATION,
      });
      return;
    }
    const exactServable = sirvLooksUpRel && isServableContentFile(contentDir, requestUrl);
    const tracked =
      !sirvLooksUpRel || exactServable || isDocExt ? null : servableTrackedFile(rel, requestUrl);
    const ext = tracked?.ext ?? requestedExt;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const classified = classifyAssetDisposition(ext, inlineExtensions);
    if (!isDocExt) {
      res.setHeader('Content-Disposition', classified.disposition);
    }
    if (classified.csp !== null) {
      res.setHeader('Content-Security-Policy', classified.csp);
    }
    if (classified.sandboxedHtml) {
      res.setHeader('Cache-Control', 'no-store');
    }
    const notServed = () => {
      if (res.headersSent) return;
      req.url = requestUrl;
      const isHtml = SANDBOXED_HTML_EXTENSIONS.has(ext);
      if (!isHtml && (assetExtensions.has(ext) || blocklistExtensions.has(ext))) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (isHtml) {
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('Content-Disposition');
        res.removeHeader('X-Content-Type-Options');
        res.removeHeader('Cache-Control');
      }
      next();
    };
    if (!exactServable && tracked === null) {
      notServed();
      return;
    }
    if (tracked !== null) req.url = tracked.url;
    contentSirv(req, res, notServed);
  };
}
