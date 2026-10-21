import {
  DocumentRefreshRequestSchema,
  DocumentRefreshSuccessSchema,
} from '@inkeep/open-knowledge-core';
import type { RefreshDocumentsFromDisk } from '../document-refresh.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface DocumentRefreshRouteDeps {
  refreshDocumentsFromDisk: RefreshDocumentsFromDisk;
}

export function createDocumentRefreshRoutes(deps: DocumentRefreshRouteDeps): ApiRouteGroup {
  const handleDocumentRefresh = withValidation(
    DocumentRefreshRequestSchema,
    async (_req, res, body) => {
      try {
        const result = await deps.refreshDocumentsFromDisk(body.docNames, 'focus');
        successResponse(res, 200, DocumentRefreshSuccessSchema, result, {
          handler: 'document-refresh',
        });
      } catch (err) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to re-read the documents from disk.',
          { handler: 'document-refresh', cause: err },
        );
      }
    },
    { handler: 'document-refresh', method: 'POST' },
  );

  return createApiRouteGroup(
    { '/api/documents/refresh': handleDocumentRefresh },
    { mutating: ['/api/documents/refresh'] },
  );
}
