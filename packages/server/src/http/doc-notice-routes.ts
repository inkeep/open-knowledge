import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DismissDocNoticeRequestSchema,
  DismissDocNoticeSuccessSchema,
  DocNoticesSuccessSchema,
} from '@inkeep/open-knowledge-core';
import type { DocNoticeLedger } from '../doc-notices.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface DocNoticeRouteDeps {
  docNotices: Pick<DocNoticeLedger, 'list' | 'dismiss'> | null;
  getBranch: () => string;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
}

export function createDocNoticeRoutes(deps: DocNoticeRouteDeps): ApiRouteGroup {
  const { docNotices, getBranch, checkLocalOpSecurity } = deps;

  async function handleDocNotices(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'doc-notices' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'doc-notices',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const notices = docNotices === null ? [] : await docNotices.list(getBranch());
      successResponse(res, 200, DocNoticesSuccessSchema, { notices }, { handler: 'doc-notices' });
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'doc-notices',
        cause: e,
      });
    }
  }

  const handleDismissDocNotice = withValidation(
    DismissDocNoticeRequestSchema,
    async (_req, res, body) => {
      try {
        const dismissed = docNotices?.dismiss(body.docName, body.id) ?? false;
        successResponse(
          res,
          200,
          DismissDocNoticeSuccessSchema,
          { dismissed },
          { handler: 'doc-notice-dismiss' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'doc-notice-dismiss',
          cause: e,
        });
      }
    },
    {
      handler: 'doc-notice-dismiss',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'doc-notice-dismiss' }),
    },
  );

  const routes = {
    '/api/doc-notices': handleDocNotices,
    '/api/doc-notices/dismiss': handleDismissDocNotice,
  } satisfies ApiRouteRecord;

  return createApiRouteGroup(routes, { mutating: ['/api/doc-notices/dismiss'] });
}
