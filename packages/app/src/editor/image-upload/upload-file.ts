/**
 * Generalized media-upload helper. POSTs a File to the unified `/api/upload`
 * endpoint and returns the resolved relative URL on success.
 *
 * The `accept` argument is a UX hint only — passed through to the picker's
 * `<input accept>` attribute and not re-validated here. The server is the
 * sole policy point: `/api/upload` is accept-all (extension-classified
 * admission via `ASSET_EXTENSIONS`), with magic-byte sniffing + path-escape
 * + symlink-realpath as the security boundary.
 */
import { ProblemDetailsSchema, UploadAssetSuccessSchema } from '@inkeep/open-knowledge-core';
import { HttpResponseParseError } from '../http-client.ts';
import { getCurrentDocName } from './current-doc-name.ts';

interface UploadFileResult {
  url: string;
}

const UPLOAD_ENDPOINT = '/api/upload';

/**
 * Optional dependency injection bag — production callers omit this and the
 * helper resolves both via the global / module-singleton (see defaults). Tests
 * pass mock implementations directly, sidestepping `globalThis.fetch =`
 * mutation patterns that have proven flaky on Linux Bun (the
 * bare-fetch / global-mutation interaction surfaces a
 * "string-rejection" before the first test runs).
 */
interface UploadFileDeps {
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Currently-open document name. Defaults to `getCurrentDocName()` from the
   *  module singleton (set by TiptapEditor on mount). */
  docName?: string | null;
}

export async function uploadFile(
  file: File,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: kept on the public signature so PropPanel + PropUploadButton compile unchanged after the per-MIME → unified endpoint flip; the picker's <input accept> already filters at the OS dialog
  accept: readonly string[],
  deps: UploadFileDeps = {},
): Promise<UploadFileResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  const docName = deps.docName !== undefined ? deps.docName : getCurrentDocName();
  if (!docName) {
    throw new Error('No document is open');
  }
  // Send the bare docName (extension-less per OK's server convention). The
  // server only uses `dirname(parentDocName)` to derive the upload directory,
  // so the extension is irrelevant — appending a hardcoded `.md` would send
  // the wrong literal for `.mdx` docs even though the dirname is the same.

  const formData = new FormData();
  formData.append('file', file);
  formData.append('parentDocName', docName);
  // Omit `placement` intentionally: editor uploads use the configured
  // attachment folder. Explicit folder drops send `placement=parent-dir`.

  let res: Response;
  try {
    res = await fetchImpl(UPLOAD_ENDPOINT, { method: 'POST', body: formData });
  } catch (networkError) {
    const message = networkError instanceof Error ? networkError.message : String(networkError);
    throw new Error(`Upload failed: ${message}`);
  }

  let rawBody: unknown;
  try {
    rawBody = await res.json();
  } catch (parseError) {
    throw new HttpResponseParseError('Upload response is not JSON.', {
      cause: parseError,
      status: res.status,
    });
  }

  // RFC 9457 two-step parse: status-discriminate, then per-handler schema.
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(rawBody);
    if (!problem.success) {
      throw new HttpResponseParseError('Upload error response did not match ProblemDetails.', {
        cause: problem.error,
        status: res.status,
      });
    }
    throw new Error(problem.data.title);
  }

  // Server success shape: `{ src, path, deduped }`. Prefer `path`
  // (contentDir-relative; honors a non-default `content.attachmentFolderPath`) over
  // `src` (bare basename — co-located-with-parent assumption that breaks
  // under Obsidian-style global attachment paths). Both POSIX-normalized,
  // no leading slash from the server side.
  //
  // Prefix `/` to root the URL at origin. The editor runs under hash routing
  // so `location.pathname === '/'` always; a relative `<img src="foo.png">`
  // resolves identically to a server-absolute one ONLY when the asset and
  // doc are co-located at content root. For any subdir doc referencing a
  // peer-dir asset (or any asset path that includes a directory segment
  // distinct from the doc's), the relative form 404s into Vite's SPA
  // fallback (`text/html` response → broken images + blank PDF tabs).
  // Mirrors the drop path's `resolvedSrc = `/${assetContentPath}`` in
  // `image-upload/index.ts`. Emitted MDX carries the same server-absolute
  // shape, so byte-identity round-trips through parser → render.
  const success = UploadAssetSuccessSchema.safeParse(rawBody);
  if (!success.success) {
    throw new HttpResponseParseError('Upload success response did not match UploadAssetSuccess.', {
      cause: success.error,
      status: res.status,
    });
  }
  const resolved = success.data.path ?? success.data.src;
  const url = resolved.startsWith('/') ? resolved : `/${resolved}`;
  return { url };
}
