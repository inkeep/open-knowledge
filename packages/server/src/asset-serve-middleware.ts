import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { SANDBOXED_HTML_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { errorResponse } from './http/error-response.ts';
import {
  HOST_NOT_ADMITTED_REMEDIATION,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
} from './ingress-policy.ts';
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
  contentFilter: AssetServeFilter;
  contentSirv: SirvLikeMiddleware;
  inlineExtensions: ReadonlySet<string>;
  assetExtensions: ReadonlySet<string>;
  blocklistExtensions: ReadonlySet<string>;
  ingressPolicy: IngressPolicy;
}

export function createAssetServeMiddleware(
  deps: AssetServeMiddlewareDeps,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const {
    contentFilter,
    contentSirv,
    inlineExtensions,
    assetExtensions,
    blocklistExtensions,
    ingressPolicy,
  } = deps;

  return (req, res, next) => {
    let rel: string;
    try {
      rel = decodeURIComponent(req.url?.split('?')[0]?.replace(/^\//, '') ?? '');
    } catch {
      return next();
    }
    const ext = extname(rel).slice(1).toLowerCase();
    const isDocExt = ext === 'md' || ext === 'mdx';
    if (!rel || contentFilter.isPathIgnored(rel) || (!isDocExt && !assetExtensions.has(ext)))
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
    contentSirv(req, res, () => {
      if (res.headersSent) return;
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
    });
  };
}
