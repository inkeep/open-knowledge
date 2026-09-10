import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { EmptyRequestSchema } from '@inkeep/open-knowledge-core';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import type { PinoLogger } from '../logger.ts';
import type { AssetService } from '../services/assets.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { errnoCode } from './handler-utils.ts';
import { withValidation } from './request-validation.ts';

export interface AssetRouteDeps {
  assetService: AssetService;
  log: PinoLogger;
}

export function createAssetRoutes(deps: AssetRouteDeps): ApiRouteGroup {
  const { assetService, log } = deps;
  const ASSET_SERVE_ERRORS = {
    'missing-path': [400, 'urn:ok:error:invalid-request', 'Missing asset path.'],
    'unsupported-type': [415, 'urn:ok:error:unsupported-asset-type', 'Unsupported asset type.'],
    'not-found': [404, 'urn:ok:error:asset-not-found', 'Asset not found.'],
    'invalid-path': [400, 'urn:ok:error:invalid-request', 'Invalid asset path.'],
  } as const;

  const handleAsset = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const assetPath = url.searchParams.get('path');
        const resolution = assetService.resolveServableAsset(assetPath);
        if (!resolution.ok) {
          const [status, type, title] = ASSET_SERVE_ERRORS[resolution.reason];
          errorResponse(res, status, type, title, {
            handler: 'asset',
            ...(resolution.cause !== undefined ? { cause: resolution.cause } : {}),
          });
          return;
        }
        const { asset } = resolution;
        const headers: Record<string, string> = {
          'Content-Type': asset.contentType,
          'Content-Length': String(asset.size),
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': asset.disposition,
          'Cache-Control': 'no-store',
        };
        if (asset.csp !== null) {
          headers['Content-Security-Policy'] = asset.csp;
        }
        const canonicalPath = asset.canonicalPath;
        res.writeHead(200, headers);
        try {
          await pipeline(createReadStream(canonicalPath), res);
        } catch (streamError) {
          const span = trace.getActiveSpan();
          const code = errnoCode(streamError);
          const connectionClosed =
            code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'EPIPE';
          span?.setAttribute(
            ATTR_ERROR_TYPE,
            connectionClosed ? 'connection_closed' : 'stream_failure',
          );
          span?.recordException(streamError instanceof Error ? streamError : String(streamError));
          span?.setStatus({ code: SpanStatusCode.ERROR, message: 'Asset transfer incomplete' });
          log.error(
            {
              event: 'api.asset.pipeline-failed',
              handler: 'asset',
              assetPath,
              err: streamError,
            },
            '[asset] pipeline failed mid-stream',
          );
          if (!res.destroyed) {
            res.destroy(streamError instanceof Error ? streamError : undefined);
          }
        }
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'asset',
          cause: e,
        });
      }
    },
    { handler: 'asset', method: 'GET', skipBodyParse: true },
  );

  const TEXT_VIEW_MAX_BYTES = 1_048_576;
  const handleAssetText = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const assetPath = url.searchParams.get('path');
        const resolution = assetService.resolveTextAsset(assetPath);
        if (!resolution.ok) {
          const [status, type, title] = ASSET_SERVE_ERRORS[resolution.reason];
          errorResponse(res, status, type, title, {
            handler: 'asset-text',
            ...(resolution.cause !== undefined ? { cause: resolution.cause } : {}),
          });
          return;
        }
        if (resolution.size > TEXT_VIEW_MAX_BYTES) {
          errorResponse(
            res,
            413,
            'urn:ok:error:payload-too-large',
            `File exceeds the ${TEXT_VIEW_MAX_BYTES}-byte text-viewer cap.`,
            { handler: 'asset-text' },
          );
          return;
        }
        const bytes = await readFile(resolution.canonicalPath);
        const text = bytes.toString('utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline',
          'Cache-Control': 'no-store',
        });
        res.end(text);
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'asset-text',
          cause: e,
        });
      }
    },
    { handler: 'asset-text', method: 'GET', skipBodyParse: true },
  );

  return createApiRouteGroup({
    '/api/asset': handleAsset,
    '/api/asset-text': handleAssetText,
  });
}
