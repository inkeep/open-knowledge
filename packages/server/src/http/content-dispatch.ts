import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HOST_NOT_ADMITTED_REMEDIATION,
  type IngressPolicy,
  isHostAdmitted,
  isPeerAdmitted,
} from '../ingress-policy.ts';
import type { PinoLogger } from '../logger.ts';
import { errorResponse } from './error-response.ts';
import { admitRequestSurface } from './http-app.ts';

type ServingMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export interface ContentDispatchOptions {
  contentAssetMiddleware?: ServingMiddleware;
  reactShellMiddleware?: ServingMiddleware;
  ephemeral?: boolean;
  ingressPolicy: IngressPolicy;
  log: PinoLogger;
}

export function createContentDispatch({
  contentAssetMiddleware,
  reactShellMiddleware,
  ephemeral,
  ingressPolicy,
  log,
}: ContentDispatchOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = req.url?.split('?')[0];
    if (!admitRequestSurface(req, res, ingressPolicy, 'mcp-mount', log)) return;
    const runMiddleware = (
      middleware:
        | ((req: IncomingMessage, res: ServerResponse, next: () => void) => void)
        | undefined,
      label: string,
      onMiss: () => void,
    ): void => {
      if (middleware === undefined) {
        onMiss();
        return;
      }
      try {
        middleware(req, res, () => {
          if (res.writableEnded || res.headersSent) return;
          onMiss();
        });
      } catch (err) {
        log.error({ err }, `Unhandled ${label} middleware error`);
        if (!res.writableEnded && !res.headersSent) {
          errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
            handler: 'mcp-mount',
            cause: err,
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    };
    const runContent = (onMiss: () => void): void => {
      if (ephemeral === true && contentAssetMiddleware !== undefined) {
        if (!isPeerAdmitted(req.socket.remoteAddress, ingressPolicy)) {
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
      }
      runMiddleware(contentAssetMiddleware, 'content-asset', onMiss);
    };
    const runShell = (onMiss: () => void): void =>
      runMiddleware(reactShellMiddleware, 'react-shell', onMiss);
    const notFound = (): void => {
      if (res.writableEnded || res.headersSent) return;
      const uiHint =
        reactShellMiddleware === undefined
          ? 'This server is running without the web UI. Restart it with plain `ok start` to serve the editor. '
          : '';
      errorResponse(res, 404, 'urn:ok:error:not-found', 'Not found.', {
        handler: 'mcp-mount',
        detail: `${uiHint}No handler for ${url ?? '/'}`,
      });
    };

    if (
      reactShellMiddleware !== undefined &&
      (url?.startsWith('/assets/') || url?.startsWith('/excalidraw-assets/'))
    ) {
      runShell(() => runContent(notFound));
      return;
    }
    if (contentAssetMiddleware !== undefined || reactShellMiddleware !== undefined) {
      runContent(() => runShell(notFound));
      return;
    }
    errorResponse(res, 404, 'urn:ok:error:not-found', 'Not found.', {
      handler: 'mcp-mount',
      detail: `This server is running without the web UI. Restart it with plain \`ok start\` to serve the editor. No handler for ${url ?? '/'}`,
    });
  };
}
