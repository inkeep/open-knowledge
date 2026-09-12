import { MAX_BUG_REPORT_ATTACHMENTS_TOTAL_BYTES } from '@inkeep/open-knowledge-core';
import type { OkAssetUploadResult } from '@inkeep/open-knowledge-core/desktop-bridge';
import { logIpcError } from '../ipc-log.ts';
import {
  isValidAttachmentContentType,
  type OkAssetUploadRequestMessage,
  parseTransportSafeUrl,
  uploadFeedbackImageAsset,
} from './bug-report.ts';

export interface AssetUploadDeps {
  intakeBaseUrl: string | undefined;
  timeouts?: { mintMs?: number; putMs?: number };
}

const MAX_FILENAME_LENGTH = 255;

function isUploadImageRequest(request: unknown): request is OkAssetUploadRequestMessage {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  if (r.kind !== 'upload-image') return false;
  if (!isValidAttachmentContentType(r.contentType)) return false;
  if (typeof r.filename !== 'string' || r.filename === '') return false;
  if (r.filename.length > MAX_FILENAME_LENGTH || /[/\\]/.test(r.filename)) return false;
  if (!(r.bytes instanceof Uint8Array)) return false;
  return r.bytes.byteLength > 0 && r.bytes.byteLength <= MAX_BUG_REPORT_ATTACHMENTS_TOTAL_BYTES;
}

export async function handleAssetUpload(
  deps: AssetUploadDeps,
  request: unknown,
): Promise<OkAssetUploadResult> {
  if (!isUploadImageRequest(request)) {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'invalid-request',
      handler: 'handleAssetUpload',
    });
    return { error: 'invalid-request' };
  }
  const base = deps.intakeBaseUrl === undefined ? null : parseTransportSafeUrl(deps.intakeBaseUrl);
  if (base === null) {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'intake-unconfigured',
      handler: 'handleAssetUpload',
    });
    return { error: 'unconfigured' };
  }
  const assetUrl = await uploadFeedbackImageAsset(
    base,
    { bytes: request.bytes, contentType: request.contentType, filename: request.filename },
    deps.timeouts,
  );
  if (assetUrl === null) return { error: 'upload' };
  return { assetUrl };
}
