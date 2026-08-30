/**
 * The file-ops family — `create-page`, `create-folder`, `duplicate-path`,
 * `rename-path`, `delete-path`, `trash/cleanup`, and multipart `upload` —
 * natively routed as one group. What the handlers share with the rest of the
 * extension (the FileOpsService/AssetService instances, the managed-rename
 * spine, attribution + telemetry helpers) arrives as
 * {@link FileOpsRouteDeps}.
 *
 * Every path in the family mutates, so the whole group rides the
 * loopback/workspace-Host mutating gate.
 *
 * `/api/upload` is multipart: its body never touches the shared JSON body
 * reader — busboy streams it to a tempfile via `readUploadBody`, and the
 * metadata fields validate post-assembly through `validateBody`.
 *
 * `rename-path` here is only the ROUTE + handler shell: the managed-rename
 * spine (`_performManagedRenameForDocs` and its two asset siblings) stays in
 * `api-extension.ts` because of its CRDT/sessionManager paired-write
 * coupling — routing is orthogonal to those internals, so the shell lives
 * here and the spine is injected.
 */

import {
  createWriteStream,
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  CreateFolderRequestSchema,
  CreateFolderSuccessSchema,
  CreatePageRequestSchema,
  CreatePageSuccessSchema,
  DeletePathRequestSchema,
  DeletePathSuccessSchema,
  DuplicatePathRequestSchema,
  DuplicatePathSuccessSchema,
  instantiateDoc,
  isManagedArtifactDocName,
  LINKABLE_ASSET_EXTENSIONS,
  type Principal,
  type ProblemType,
  RenamePathRequestSchema,
  RenamePathSuccessSchema,
  TrashCleanupRequestSchema,
  TrashCleanupSuccessSchema,
  UploadAssetSuccessSchema,
  UploadRequestSchema,
} from '@inkeep/open-knowledge-core';
import { formatRenameSubject } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { SummaryResponse } from '../agent-write-summary.ts';
import { ManagedRenameCollisionError } from '../apply-managed-rename.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import { DocInConflictError, isDocInConflict, respondDocInConflict } from '../conflict-errors.ts';
import { isReservedProjectStatePath } from '../content/managed-doc-enum.ts';
import { applySubstitution, todayIsoUtc } from '../content/substitution.ts';
import { resolveTemplatesAvailable } from '../content/templates-resolver.ts';
import type { ContentFilter } from '../content-filter.ts';
import { recordContributor } from '../contributor-tracker.ts';
import {
  docNameToRelativePath,
  getDocExtension,
  isSupportedAssetFile,
  isSupportedDocFile,
  registerDocExtension,
  SUPPORTED_DOC_EXTENSIONS,
  stripDocExtension,
} from '../doc-extensions.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import { canonicalRelPathForNewTarget, isContainmentRejection } from '../fs-safety.ts';
import { classifyFsPath, normalizeFsPath } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';
import { createMultipartParser, type MultipartParser } from '../multipart.ts';
import type { AssetService } from '../services/assets.ts';
import { DuplicateNameExhaustedError, type FileOpsService } from '../services/file-ops.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { type getMeter, withSpan } from '../telemetry.ts';
import {
  classifyUploadErrno,
  UploadWriteError,
  type UploadWriteReason,
  uploadStatusFor,
  uploadTitleFor,
} from '../upload-errors.ts';
import { HashingPassThrough, mintTempUploadPath } from '../upload-streaming.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse, type HttpErrorStatus } from './error-response.ts';
import { errnoCode } from './handler-utils.ts';
import { getRequestId } from './request-id.ts';
import { validateBody, withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

/** Result-shape of the managed-rename spine, shared with `api-extension.ts`. */
export interface RenamedDocMapping {
  fromDocName: string;
  toDocName: string;
}

export interface RenamedAssetMapping {
  fromPath: string;
  toPath: string;
}

export interface ManagedRenameRewrittenDoc {
  docName: string;
  rewrites: number;
}

/**
 * True when `path` is one of the synthetic top-level folders (`__system__`,
 * `__config__`, `__user__`, `__local__`) or lives under one — the reserved
 * folder-name set that create/rename must refuse. Distinct from
 * `isReservedProjectStatePath`, which gates the `.ok`/`.git` state dirs.
 */
function isReservedSyntheticFolderPath(path: string): boolean {
  return (
    path === '__system__' ||
    path === '__config__' ||
    path === '__user__' ||
    path === '__local__' ||
    path.startsWith('__system__/') ||
    path.startsWith('__config__/') ||
    path.startsWith('__user__/') ||
    path.startsWith('__local__/')
  );
}

type DuplicatePathFilesystemProblem = {
  status: 500 | 507;
  type: Extract<ProblemType, 'urn:ok:error:storage-full' | 'urn:ok:error:storage-readonly'>;
  title: string;
};

function classifyDuplicatePathFilesystemProblem(
  err: unknown,
): DuplicatePathFilesystemProblem | null {
  const code = errnoCode(err);
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return {
      status: 507,
      type: 'urn:ok:error:storage-full',
      title: 'Could not duplicate path because storage is full.',
    };
  }
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
    return {
      status: 500,
      type: 'urn:ok:error:storage-readonly',
      title: 'Could not duplicate path because storage is not writable.',
    };
  }
  return null;
}

type RenameAttributionActor = Exclude<
  ReturnType<typeof extractActorIdentity>,
  { kind: 'invalid-summary' }
>;

interface UploadResult {
  filename: string;
  mimeType: string;
  parentDocName: string;
  placement: string;
  tempPath: string;
  sha: string;
  byteLength: number;
}

/**
 * Stream multipart upload body to a tempfile while hashing on-the-fly.
 *
 * Replaces the buffer-to-memory pattern (chunks.push(chunk) +
 * Buffer.concat) with busboy's streaming 'file' event piped through a
 * HashingPassThrough Transform into createWriteStream(tempPath). Memory
 * becomes O(1); disk is the only bound.
 *
 * Error contract (typed via UploadWriteError.reason — URN-form ProblemType):
 *   - urn:ok:error:malformed-upload: busboy 'error' (unparseable multipart, etc.)
 *   - urn:ok:error:storage-full: ENOSPC / EDQUOT during the write stream
 *   - urn:ok:error:storage-readonly: EROFS / EACCES / EPERM during the write stream
 *   - urn:ok:error:storage-error: any other write-stream error
 *
 * On any error, the tempfile is best-effort unlinked before propagating.
 */
function readUploadBody(req: IncomingMessage, projectDir: string): Promise<UploadResult> {
  return new Promise((resolveP, reject) => {
    let bb: MultipartParser;
    try {
      // `files: 1` caps the file part; `fields` + `fieldSize` cap non-file
      // surface so a flooded multipart can't buffer thousands of fields or a
      // multi-MB string field in memory before the upload body resolves. The
      // legitimate schema (agentId / docName / position / summary) is bounded
      // — short identifiers, never approaching 2 KB or 10 entries. The
      // ENAMETOOLONG-via-crafted-filename DoS path is closed by the 255-byte
      // ceiling in `sanitizeFilename` (the filesystem-portability layer);
      // busboy does not expose a header-section-size limit (only headerPairs
      // count), so the parsed-value cap is the right place.
      bb = createMultipartParser(req, { files: 1, fields: 10, fieldSize: 2 * 1024 });
    } catch (err) {
      reject(new UploadWriteError('urn:ok:error:malformed-upload', err));
      return;
    }

    let settled = false;
    let filename = 'upload';
    let mimeType = '';
    let parentDocName = '';
    let placement = '';
    let tempPath: string | undefined;
    let writeStream: ReturnType<typeof createWriteStream> | undefined;
    let pipelineError: unknown;
    // Track whether the 'file' event ever fired. busboy emits 'close' as
    // soon as it finishes parsing the request body — but the file
    // pipeline (createWriteStream + HashingPassThrough) is async and may
    // still be running when 'close' fires. We must NOT resolve to an
    // empty UploadResult on 'close' when a file IS being processed; the
    // pipeline `.then()` is the legitimate resolver in that case. Only
    // the no-file path needs the 'close' fallback.
    let fileEventFired = false;

    // Mint the tempfile path lazily on the first 'file' event — busboy
    // can fire 'error' before any file arrives (e.g. missing boundary)
    // and we'd otherwise create a zero-byte tempfile for no reason.

    const fail = (reason: UploadWriteReason, cause: unknown) => {
      if (settled) return;
      settled = true;
      // Destroy the write stream BEFORE the unlink: `unlink()` only removes
      // the directory entry, so an fd left open by a mid-stream disconnect
      // would pin the inode's disk blocks (and leak the fd) for the rest of
      // the process's uptime — the boot-time orphan sweep readdirs the
      // staging dir and cannot see an already-unlinked file. Destroying also
      // settles the `pipeline()` promise; its `.catch` re-enters `fail()` as
      // a no-op via the `settled` guard.
      //
      // `destroy()` schedules the fd close on a later tick, so the synchronous
      // unlink below still runs against an open handle. On POSIX that is fine —
      // the entry goes away and the inode is reclaimed when the deferred close
      // lands. On platforms with mandatory locking (Windows) that unlink fails
      // with the handle open, so also retry once the stream has actually
      // closed; there, the close-ordered retry (not the sync call) is what
      // drains the staging dir.
      if (writeStream && tempPath) {
        const staged = tempPath;
        writeStream.once('close', () => {
          try {
            unlinkSync(staged);
          } catch {
            // already gone — the synchronous unlink won (the POSIX path)
          }
        });
      }
      writeStream?.destroy();
      if (tempPath) {
        try {
          unlinkSync(tempPath);
        } catch {
          // best-effort; the close-ordered retry above covers open-handle
          // platforms, and the orphan sweep catches any remaining stragglers
        }
      }
      reject(cause instanceof UploadWriteError ? cause : new UploadWriteError(reason, cause));
    };

    const classifyWriteError = classifyUploadErrno;

    bb.on('field', (name, val) => {
      if (name === 'parentDocName') parentDocName = val;
      if (name === 'placement') placement = val;
    });

    bb.on('file', (_fieldname, file, info) => {
      fileEventFired = true;
      filename = info.filename || 'upload';
      mimeType = info.mimeType || '';

      // `mintTempUploadPath` does `tracedMkdirSync(.., { recursive: true })`
      // which can throw ENOSPC / EDQUOT / EROFS / EACCES / EPERM / EIO. An
      // uncaught throw here bubbles back through busboy's `_write` and
      // re-emits as `'error'`, which the listener below classifies as
      // `'urn:ok:error:malformed-upload'` (HTTP 400). That misleads operators triaging
      // a full disk into chasing a phantom client bug. Catch the sync
      // throw, classify via the same table the pipeline rejection uses,
      // and drain the file part so busboy can finish parsing the rest.
      let path: string;
      try {
        path = mintTempUploadPath(projectDir);
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        fail(classifyWriteError(nodeErr), err as Error);
        file.resume();
        return;
      }
      tempPath = path;
      const hasher = new HashingPassThrough();
      writeStream = createWriteStream(path);

      pipeline(file, hasher, writeStream)
        .then(() => {
          if (settled) return;
          settled = true;
          resolveP({
            filename,
            mimeType,
            parentDocName,
            placement,
            tempPath: path,
            sha: hasher.digest(),
            byteLength: hasher.byteLength(),
          });
        })
        .catch((err) => {
          pipelineError = err;
          // Classify from the deepest write error if available; otherwise
          // treat as a generic storage-error. The unlink happens inside fail().
          const nodeErr = err as NodeJS.ErrnoException;
          fail(classifyWriteError(nodeErr), err);
        });
    });

    bb.on('error', (err) => {
      fail('urn:ok:error:malformed-upload', err);
    });

    // busboy's `close` (Writable, emitClose:true via @types/busboy@1.6.0)
    // fires once busboy finishes parsing the request body. If by then
    // no `file` event ever fired, the request was a well-formed
    // multipart with fields-only (no file part) — resolve with a
    // synthetic empty UploadResult so the route handler's
    // `byteLength === 0` guard returns the standard 400 "No file
    // received." Without this hook the Promise never settles on fields-
    // only uploads and the connection hangs until Node's request
    // timeout fires (DoS).
    //
    // CRUCIAL: gate on `!fileEventFired`. If a file part IS present,
    // busboy emits 'close' as soon as it finishes parsing — but the
    // async write/hash pipeline below may still be running. Resolving
    // here would race the pipeline's legitimate resolveP and produce a
    // spurious empty result. Pipeline resolves win in that case.
    bb.on('close', () => {
      if (settled || pipelineError) return;
      if (fileEventFired) return;
      settled = true;
      resolveP({
        filename: '',
        mimeType: '',
        parentDocName,
        placement,
        tempPath: '',
        sha: '',
        byteLength: 0,
      });
    });

    // Guard the "client disconnected mid-stream" path. busboy never
    // reaches `_final` if the request aborts before the closing boundary,
    // so its `close` would not fire and the Promise would otherwise hang.
    req.on('close', () => {
      if (settled || pipelineError) return;
      if (!req.complete) {
        fail('urn:ok:error:malformed-upload', new Error('client disconnected'));
      }
    });

    req.pipe(bb);
  });
}

/**
 * Everything the seven handlers used to reach through the extension closure.
 * Function-shaped deps keep their extension-side names so the handler bodies
 * read unchanged.
 */
export interface FileOpsRouteDeps {
  contentDir: string;
  projectDir: string | undefined;
  log: PinoLogger;
  getPrincipal: (() => Principal | null) | undefined;
  contentFilter: ContentFilter | undefined;
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  hocuspocus: Hocuspocus;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  flushContributors: (() => Promise<void>) | undefined;
  fileOpsService: FileOpsService;
  assetService: AssetService;
  extractAgentIdentity: (body: Record<string, unknown>) => {
    rawAgentId: string | undefined;
    agentId: string;
    agentName: string;
    colorSeed: string;
    clientName: string | undefined;
    clientVersion: string | undefined;
    label: string | undefined;
  };
  recordDerivedDocumentBestEffort: (
    documentName: string,
    markdown: string,
    reason: string,
  ) => Promise<void>;
  invalidateReferencedAssetsCache: () => void;
  listManagedDocNamesUnderFolderFromDisk: (sourcePathRoot: string) => string[];
  resolveContentEntryPath: (contentDir: string, kind: 'file' | 'folder', path: string) => string;
  docNameForFileOperationPath: (contentDir: string, relPath: string) => string;
  withPeriod: (s: string) => string;
  toManagedRenamePublicError: (error: unknown) => {
    status: HttpErrorStatus;
    type: ProblemType;
    error: string;
  };
  attributeRenameWriteToActor: (
    actor: RenameAttributionActor,
    defaultSummarySubject: string,
    entries: readonly { docName: string; subject: string }[],
    options: { context: string; onAnonymous?: () => void },
  ) => SummaryResponse | undefined;
  renameAttributionCounter: () => ReturnType<ReturnType<typeof getMeter>['createCounter']>;
  _performAssetRename: (
    fromPath: string,
    toPath: string,
  ) => Promise<{
    renamedAssets: RenamedAssetMapping[];
    rewrittenDocs: ManagedRenameRewrittenDoc[];
  }>;
  _performDocumentToFileRename: (
    fromPath: string,
    toPath: string,
  ) => Promise<{
    renamedAssets: RenamedAssetMapping[];
    rewrittenDocs: ManagedRenameRewrittenDoc[];
  }>;
  _performManagedRenameForDocs: (
    fromPath: string,
    toPath: string,
    kind: 'file' | 'folder',
    options?: {
      actor?: {
        writerId: string;
        displayName: string;
        colorSeed?: string;
        actorMetadata?: {
          principalId?: string;
          agentType?: string;
          clientName?: string;
          clientVersion?: string;
          label?: string;
        };
      };
    },
  ) => Promise<{
    renamed: RenamedDocMapping[];
    renamedAssets: RenamedAssetMapping[];
    rewrittenDocs: ManagedRenameRewrittenDoc[];
  }>;
  isValidRelativeContentPath: (path: string) => boolean;
}

export function createFileOpsRoutes(deps: FileOpsRouteDeps): ApiRouteGroup {
  const {
    contentDir,
    projectDir,
    log,
    getPrincipal,
    contentFilter,
    signalChannel,
    hocuspocus,
    getSyncEngine,
    flushContributors,
    fileOpsService,
    assetService,
    extractAgentIdentity,
    recordDerivedDocumentBestEffort,
    invalidateReferencedAssetsCache,
    listManagedDocNamesUnderFolderFromDisk,
    resolveContentEntryPath,
    docNameForFileOperationPath,
    withPeriod,
    toManagedRenamePublicError,
    attributeRenameWriteToActor,
    renameAttributionCounter,
    _performAssetRename,
    _performDocumentToFileRename,
    _performManagedRenameForDocs,
    isValidRelativeContentPath,
  } = deps;

  /**
   * True when a request path — clean of `.ok`/`.git` segments lexically —
   * CANONICALLY resolves into a reserved subtree, i.e. a symlinked directory
   * routes it into `.ok`/`.git` without an escape (the realpath stays inside the
   * content root, so `assertNoSymlinkEscape` admits it). Consumers: create-folder,
   * duplicate-path, rename-path (source and destination), delete-path, and
   * upload; create-page runs the same check through its own inline
   * `canonicalRelPathForNewTarget` call, since it already holds a resolved
   * `fullPath`. The guard is judged by where the operation ACTUALLY lands, not
   * the lexical request string. Resolves the path verbatim (`kind: 'folder'`, no
   * extension munging) purely to obtain the on-disk location. When resolution
   * itself throws the canonical location is unknowable, so this returns `false`.
   * That swallow is safe ONLY because every consumer runs
   * `isValidRelativeContentPath` (and 400s) BEFORE this gate — upload validates
   * and passes the parent directory component, since its basename is a raw
   * filename it never resolves — so the paths that reach it cannot fail the
   * lexical half of resolution; a
   * genuinely non-lexical fault then re-raises in the route's own downstream
   * resolution, where a containment rejection maps to 400 path-escape via each
   * route's `isContainmentRejection` arm and a raw errno to the typed 500.
   * Upload's downstream check is destination-side instead: `storeUpload`'s
   * `reserved-destination` outcome on the resolved dest dir.
   */
  const canonicalTargetIsReserved = (lexicalRelPath: string): boolean => {
    let fullPath: string;
    try {
      fullPath = resolveContentEntryPath(contentDir, 'folder', lexicalRelPath);
    } catch {
      return false;
    }
    return isReservedProjectStatePath(
      canonicalRelPathForNewTarget(fullPath, resolve(contentDir), log),
    );
  };

  /**
   * Probe disk for the actual on-disk extension of a file's docName, registering
   * it in the doc-extensions map if found. Closes a boot/watcher race where the
   * rename handler runs before the file watcher has observed the source — without
   * this, `getDocExtension()` returns the `.md` default, which silently defeats
   * `.mdx`-specific exclusion patterns and routes existence checks to the wrong
   * path. Iterating in `SUPPORTED_DOC_EXTENSIONS` precedence order ensures the
   * `.mdx` precedence rule is preserved when both files exist on disk.
   * Idempotent — `registerDocExtension` is a no-op when the higher-precedence
   * extension is already registered.
   */
  function probeAndRegisterSourceFileExtension(probeContentDir: string, fromPath: string): void {
    if (!isValidRelativeContentPath(fromPath)) return;
    const resolvedContentDir = resolve(probeContentDir);
    if (isSupportedDocFile(fromPath)) {
      const extensionless = stripDocExtension(fromPath);
      for (const ext of SUPPORTED_DOC_EXTENSIONS) {
        const candidate = resolve(resolvedContentDir, `${extensionless}${ext}`);
        if (
          candidate !== resolvedContentDir &&
          !candidate.startsWith(`${resolvedContentDir}${sep}`)
        ) {
          continue;
        }
        if (existsSync(candidate)) {
          registerDocExtension(extensionless, ext);
        }
      }
      const explicitCandidate = resolve(resolvedContentDir, fromPath);
      if (
        explicitCandidate !== resolvedContentDir &&
        explicitCandidate.startsWith(`${resolvedContentDir}${sep}`) &&
        existsSync(explicitCandidate)
      ) {
        registerDocExtension(extensionless, extname(fromPath));
      }
      return;
    }
    for (const ext of SUPPORTED_DOC_EXTENSIONS) {
      const candidate = resolve(resolvedContentDir, `${fromPath}${ext}`);
      if (
        candidate !== resolvedContentDir &&
        !candidate.startsWith(`${resolvedContentDir}${sep}`)
      ) {
        continue;
      }
      if (existsSync(candidate)) {
        registerDocExtension(fromPath, ext);
        return;
      }
    }
  }

  function resolveExtensionlessAssetPath(assetPath: string): {
    path: string;
    ambiguous: boolean;
  } {
    // Filesystem-backed authority for extensionless asset targets; the client
    // canonicalizer is only a UX aid for dialogs and shell-trash paths.
    if (extname(assetPath)) return { path: assetPath, ambiguous: false };

    const slash = assetPath.lastIndexOf('/');
    const parent = slash === -1 ? '' : assetPath.slice(0, slash);
    const stem = slash === -1 ? assetPath : assetPath.slice(slash + 1);
    const parentPath = parent ? resolveContentEntryPath(contentDir, 'folder', parent) : contentDir;

    let entries: Dirent[];
    try {
      entries = readdirSync(parentPath, { withFileTypes: true });
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { path: assetPath, ambiguous: false };
      }
      throw err;
    }

    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${stem}.`))
      .map((entry) => (parent ? `${parent}/${entry.name}` : entry.name))
      .filter((candidate) => isSupportedAssetFile(candidate, LINKABLE_ASSET_EXTENSIONS));

    if (candidates.length === 1) return { path: candidates[0], ambiguous: false };
    return { path: assetPath, ambiguous: candidates.length > 1 };
  }

  const handleCreatePage = withValidation(
    CreatePageRequestSchema,
    async (_req, res, body) => {
      try {
        const bodyObj = body as unknown as Record<string, unknown>;
        // Identity boundary: only attribute when the caller explicitly supplies
        // agentId. UI-driven creates fall through to the loaded principal (if
        // any) or anonymous — never to a synthetic 'Claude' default. Mirrors
        // handleRollback / handleRenamePath.
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'create-page',
          });
          return;
        }

        const filePath = body.path;
        if (!isSupportedDocFile(filePath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path must end with .md or .mdx.',
            { handler: 'create-page' },
          );
          return;
        }
        if (
          filePath.includes('..') ||
          filePath.startsWith('/') ||
          filePath.includes('\x00') ||
          filePath.includes('\\')
        ) {
          errorResponse(res, 400, 'urn:ok:error:path-escape', 'Invalid path.', {
            handler: 'create-page',
            detail: 'path must not contain .. or start with /',
          });
          return;
        }
        // Same containment core as the five sibling routes: lexical prefix
        // check PLUS the realpath symlink-escape refusal. A hand-rolled
        // resolve + prefix pair here would admit a write through a symlinked
        // directory pointing outside the content root.
        const resolvedContentDir = resolve(contentDir);
        let fullPath: string;
        try {
          fullPath = resolveContentEntryPath(contentDir, 'file', filePath);
        } catch (err) {
          // `resolveContentEntryPath` throws a WIDER set than the old lexical
          // check it replaced. `isContainmentRejection` is exactly the
          // caller-fault set — the lexical `PathContainmentError` plus the
          // realpath `SymlinkEscapeError` — which maps to a 400 path-escape.
          // Everything else (notably the raw realpath errnos
          // `assertNoSymlinkEscape` rethrows by contract — EPERM/EACCES/EIO/
          // ESTALE) is an infrastructure fault and must reach the handler's
          // outer catch as a typed 500, not a misleading client 400.
          if (isContainmentRejection(err)) {
            errorResponse(
              res,
              400,
              'urn:ok:error:path-escape',
              'path must not escape content directory.',
              { handler: 'create-page', cause: err },
            );
            return;
          }
          throw err;
        }
        const candidateDocName = stripDocExtension(filePath);
        if (isSystemDoc(candidateDocName) || isConfigDoc(candidateDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${candidateDocName}' is a reserved document name.`,
            { handler: 'create-page' },
          );
          return;
        }
        // Reject managed-artifact + reserved-directory targets. Now that
        // `.ok/skills/**` is indexed/served content, a raw create-page into
        // `.ok/skills/<name>/SKILL.md` would write directly with ZERO skill-schema
        // validation (no name/description checks, no XML-tag ban) and surface as a
        // malformed phantom skill. Skills/templates must go through their own
        // validating write/install spines; every other `.ok/` child is excluded
        // from the content scope anyway. The reserved-path test catches raw
        // filesystem paths with a `.ok`/`.git` segment at any depth;
        // `isManagedArtifactDocName` catches the synthetic `__skill__/` /
        // `__template__/` doc-name forms.
        //
        // `filePath` is the LEXICAL request string, but `resolveContentEntryPath`
        // resolves with `path.resolve`, which does not follow symlinks — so a
        // request like `sneaky/x.md`, where `sneaky` is a symlink to `.ok`, has
        // no `.ok` segment lexically yet physically lands in the reserved
        // subtree (and does NOT trip the symlink-escape guard, since `.ok` stays
        // inside the content root). Run the reserved-path test on the CANONICAL
        // relative path too, so the write is judged by where it actually lands.
        const canonicalRelPath = canonicalRelPathForNewTarget(fullPath, resolvedContentDir, log);
        if (
          isReservedProjectStatePath(filePath) ||
          isReservedProjectStatePath(canonicalRelPath) ||
          isManagedArtifactDocName(candidateDocName)
        ) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${candidateDocName}' is a reserved document name.`,
            {
              handler: 'create-page',
              detail:
                'Cannot create a page inside .ok or .git — skills and templates are authored through their own validating flows.',
            },
          );
          return;
        }
        // Optional template parameter: when set, instantiate the new
        // doc from the resolved template's body (with {{date}} / {{user}}
        // substitution applied) instead of an empty file. Resolution walks
        // the parent folder's templates_available[] — local + inherited,
        // closest-wins.
        const templateName =
          typeof (body as Record<string, unknown>).template === 'string'
            ? ((body as Record<string, unknown>).template as string).trim()
            : '';
        let initialContent = '';
        let templateScopeForLog: 'local' | 'inherited' | undefined;
        if (templateName.length > 0) {
          if (!/^[A-Za-z0-9_-]+$/.test(templateName)) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Template name must match [A-Za-z0-9_-]+.',
              { handler: 'create-page' },
            );
            return;
          }
          const parentFolder = filePath.includes('/')
            ? filePath.slice(0, filePath.lastIndexOf('/'))
            : '';
          const available = resolveTemplatesAvailable(resolvedContentDir, parentFolder);
          const matched = available.find((t) => t.name === templateName);
          if (!matched) {
            const availableLabel =
              available.length === 0
                ? '(none)'
                : available.map((t) => `"${t.name}" (${t.scope})`).join(', ');
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              `Template "${templateName}" does not resolve for folder "${parentFolder || '(root)'}". Available: ${availableLabel}`,
              { handler: 'create-page' },
            );
            return;
          }
          // `matched` came from `resolveTemplatesAvailable`, which constrains
          // every entry to a realpath inside BOTH its own `.ok/templates/`
          // directory AND the project root (see its containment contract) — a
          // template symlinked out of the project, or elsewhere inside it such
          // as `.ok/local/` or `.git/`, is dropped from the menu and so never
          // resolves here. The read below is therefore already contained; no
          // per-consumer symlink guard needed.
          const templateAbs = resolve(resolvedContentDir, matched.path);
          let templateRaw: string;
          try {
            templateRaw = readFileSync(templateAbs, 'utf-8');
          } catch (err) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              `Failed to read template at ${matched.path}.`,
              { handler: 'create-page', cause: err },
            );
            return;
          }
          // The new doc IS the template's starter content (doc-frontmatter +
          // markdown) with the `template:` identity stripped. `instantiateDoc`
          // normalizes single-block and legacy two-block templates the same way
          // and preserves `{{date}}`/`{{user}}` tokens verbatim for substitution.
          const templateStarter = instantiateDoc(templateRaw);
          // {{user}} substitutes the calling principal's display name; falls
          // back to empty string when no principal is loaded.
          const userDisplayName =
            actor.kind === 'agent' || actor.kind === 'principal' ? (actor.displayName ?? '') : '';
          initialContent = applySubstitution(templateStarter, {
            date: todayIsoUtc(),
            user: userDisplayName,
          });
          templateScopeForLog = matched.scope;
        }

        const docName = stripDocExtension(filePath);
        // Synchronous through recordContributor below: an async yield between
        // the write and the contributor recording lets a pending shadow-commit
        // timer drain the accumulator without this file's attribution.
        const createOutcome = fileOpsService.createPage({
          fullPath,
          docName,
          initialContent,
        });
        if (!createOutcome.ok) {
          errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'File already exists.', {
            handler: 'create-page',
            cause: createOutcome.cause,
          });
          return;
        }
        switch (actor.kind) {
          case 'agent':
          case 'principal':
            recordContributor(
              docName,
              actor.writerId,
              actor.displayName,
              actor.colorSeed,
              undefined,
              actor.actor,
            );
            break;
          case 'anonymous':
            // UI-driven create with no loaded principal — no contributor recorded.
            break;
          default: {
            const _exhaustive: never = actor;
            throw new Error(
              `Unhandled actor kind in handleCreatePage: ${String((_exhaustive as { kind?: unknown }).kind)}`,
            );
          }
        }
        // Best-effort for real (see the skill-put site): never hold a create
        // response on the derived-index command queue.
        void recordDerivedDocumentBestEffort(docName, initialContent, 'create-page');
        signalChannel?.('files');
        if (templateScopeForLog !== undefined) {
          // Cardinality-bounded structured event — `templateScope` is one of
          // two values; `templateName` is bounded by the user's actual
          // templates. Mirrors the structured-event style in activity-log.ts.
          console.warn(
            JSON.stringify({
              event: 'template-instantiate',
              templateName,
              templateScope: templateScopeForLog,
              docName,
            }),
          );
        }
        successResponse(res, 200, CreatePageSuccessSchema, { docName }, { handler: 'create-page' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to create page.', {
          handler: 'create-page',
          cause: e,
        });
      }
    },
    { handler: 'create-page', method: 'POST' },
  );

  const handleCreateFolder = withValidation(
    CreateFolderRequestSchema,
    async (_req, res, body) => {
      try {
        const bodyObj = body as unknown as Record<string, unknown>;
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'create-folder',
          });
          return;
        }
        const folderPath = body.path;
        if (!isValidRelativeContentPath(folderPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path must be a relative content path.',
            { handler: 'create-folder' },
          );
          return;
        }
        if (isReservedProjectStatePath(folderPath) || canonicalTargetIsReserved(folderPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            '.ok and .git are reserved directories.',
            { handler: 'create-folder' },
          );
          return;
        }
        if (contentFilter?.isDirExcluded(folderPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Destination folder is excluded by the workspace content config.',
            { handler: 'create-folder' },
          );
          return;
        }

        const outcome = fileOpsService.createFolder(folderPath);
        if (!outcome.ok) {
          errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'Folder already exists.', {
            handler: 'create-folder',
          });
          return;
        }
        successResponse(
          res,
          200,
          CreateFolderSuccessSchema,
          { path: folderPath },
          { handler: 'create-folder' },
        );
      } catch (e) {
        // The service resolves the path lexically-validated only, so a symlink
        // out of the content root surfaces here as a containment rejection — a
        // caller fault, mapped to the same 400 create-page and rename-path emit,
        // never the generic 500 (which mis-logs it as a server fault).
        if (isContainmentRejection(e)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:path-escape',
            'path must not escape content directory.',
            { handler: 'create-folder', cause: e },
          );
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to create folder.', {
          handler: 'create-folder',
          cause: e,
        });
      }
    },
    { handler: 'create-folder', method: 'POST' },
  );

  const handleDuplicatePath = withValidation(
    DuplicatePathRequestSchema,
    async (_req, res, body) => {
      try {
        const bodyObj = body as unknown as Record<string, unknown>;
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'duplicate-path',
          });
          return;
        }

        const { kind } = body;
        const requestedPath = body.path;
        const requestedDocName = kind === 'file' ? stripDocExtension(requestedPath) : requestedPath;
        if (!isValidRelativeContentPath(requestedPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path must be a relative content path.',
            { handler: 'duplicate-path' },
          );
          return;
        }
        if (
          isReservedProjectStatePath(requestedPath) ||
          canonicalTargetIsReserved(requestedPath) ||
          (kind === 'file' && (isSystemDoc(requestedDocName) || isConfigDoc(requestedDocName))) ||
          (kind === 'folder' && isReservedSyntheticFolderPath(requestedPath))
        ) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            'Reserved paths cannot be duplicated.',
            { handler: 'duplicate-path' },
          );
          return;
        }

        if (kind === 'file') {
          probeAndRegisterSourceFileExtension(contentDir, requestedPath);
        }

        const outcome = await fileOpsService.duplicatePath(kind, requestedPath, requestedDocName);
        if (!outcome.ok) {
          switch (outcome.kind) {
            case 'not-found':
              errorResponse(res, 404, 'urn:ok:error:doc-not-found', `${kind} does not exist.`, {
                handler: 'duplicate-path',
              });
              return;
            case 'type-mismatch':
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                `Target path is not a ${kind}.`,
                { handler: 'duplicate-path' },
              );
              return;
            case 'conflict':
              respondDocInConflict(
                res,
                new DocInConflictError({ file: outcome.file }),
                'duplicate-path',
              );
              return;
            case 'destination-excluded':
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                kind === 'file'
                  ? 'Duplicated document destination is excluded by the project content config.'
                  : 'Duplicated folder destination is excluded by the project content config.',
                { handler: 'duplicate-path' },
              );
              return;
            case 'already-exists':
              errorResponse(
                res,
                409,
                'urn:ok:error:doc-already-exists',
                `A ${kind} at the duplicate destination already exists.`,
                { handler: 'duplicate-path', cause: outcome.cause },
              );
              return;
            default: {
              const _exhaustive: never = outcome;
              throw new Error(
                `Unhandled duplicate outcome: ${String((_exhaustive as { kind?: unknown }).kind)}`,
              );
            }
          }
        }
        const { duplicatedPath, duplicatedDocNames } = outcome;

        switch (actor.kind) {
          case 'agent':
          case 'principal':
            for (const docName of duplicatedDocNames) {
              recordContributor(
                docName,
                actor.writerId,
                actor.displayName,
                actor.colorSeed,
                undefined,
                actor.actor,
              );
            }
            break;
          case 'anonymous':
            break;
          default: {
            const _exhaustive: never = actor;
            throw new Error(
              `Unhandled actor kind in handleDuplicatePath: ${String((_exhaustive as { kind?: unknown }).kind)}`,
            );
          }
        }

        signalChannel?.('files');
        successResponse(
          res,
          200,
          DuplicatePathSuccessSchema,
          { kind, path: duplicatedPath, duplicatedDocNames },
          { handler: 'duplicate-path' },
        );
      } catch (e) {
        if (e instanceof DuplicateNameExhaustedError) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            'All available duplicate name slots are occupied for this path.',
            { handler: 'duplicate-path', cause: e },
          );
          return;
        }
        const filesystemProblem = classifyDuplicatePathFilesystemProblem(e);
        if (filesystemProblem) {
          errorResponse(
            res,
            filesystemProblem.status,
            filesystemProblem.type,
            filesystemProblem.title,
            { handler: 'duplicate-path', cause: e },
          );
          return;
        }
        if (isContainmentRejection(e)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:path-escape',
            'path must not escape content directory.',
            { handler: 'duplicate-path', cause: e },
          );
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to duplicate path.', {
          handler: 'duplicate-path',
          cause: e,
        });
      }
    },
    { handler: 'duplicate-path', method: 'POST' },
  );

  const handleRenamePath = withValidation(
    RenamePathRequestSchema,
    async (_req, res, body) => {
      try {
        const bodyObj = body as unknown as Record<string, unknown>;
        const actor = extractActorIdentity(bodyObj, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'rename-path',
          });
          return;
        }
        const { kind, fromPath, toPath } = body;
        if (!isValidRelativeContentPath(fromPath) || !isValidRelativeContentPath(toPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Paths must be relative content paths.',
            { handler: 'rename-path' },
          );
          return;
        }
        if (
          kind === 'file' &&
          (isSystemDoc(fromPath) ||
            isSystemDoc(toPath) ||
            isConfigDoc(fromPath) ||
            isConfigDoc(toPath))
        ) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            'Reserved document names cannot be renamed.',
            { handler: 'rename-path' },
          );
          return;
        }
        // Reject paths with a `.ok` or `.git` segment at any depth — root
        // `.ok/` holds OK config (`config.yml`, `frontmatter.yml`,
        // `templates/`) plus the per-machine `local/` runtime subtree
        // (server.lock, principal.json, cache, etc.), and nested
        // `<folder>/.ok/` holds folder metadata + templates. Symmetric with
        // the `__system__` carve-out. The `AGENTS.md` file inside `.ok/` is a
        // tracked content file by design, but a rename TO or FROM these
        // directories would clobber OK bookkeeping.
        if (
          isReservedProjectStatePath(fromPath) ||
          isReservedProjectStatePath(toPath) ||
          canonicalTargetIsReserved(fromPath) ||
          canonicalTargetIsReserved(toPath)
        ) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            '.ok and .git are reserved directories.',
            {
              handler: 'rename-path',
            },
          );
          return;
        }
        if (fromPath === toPath) {
          successResponse(
            res,
            200,
            RenamePathSuccessSchema,
            { renamed: [], renamedAssets: [], rewrittenDocs: [] },
            { handler: 'rename-path' },
          );
          return;
        }
        const operationKind =
          kind === 'asset' && isSupportedDocFile(fromPath) && isSupportedDocFile(toPath)
            ? 'file'
            : kind;
        if (operationKind === 'asset') {
          let result: {
            renamedAssets: RenamedAssetMapping[];
            rewrittenDocs: ManagedRenameRewrittenDoc[];
          };
          try {
            result =
              isSupportedDocFile(fromPath) && !isSupportedDocFile(toPath)
                ? await _performDocumentToFileRename(fromPath, toPath)
                : await _performAssetRename(fromPath, toPath);
          } catch (err) {
            if (err instanceof DocInConflictError) {
              respondDocInConflict(res, err, 'rename-path');
              return;
            }
            const { status, type, error } = toManagedRenamePublicError(err);
            errorResponse(res, status, type, error, {
              handler: 'rename-path',
              cause: err,
            });
            return;
          }

          if (result.renamedAssets.length > 0) {
            invalidateReferencedAssetsCache();
          }

          let summaryResponse: SummaryResponse | undefined;
          if (result.renamedAssets.length > 0 && result.rewrittenDocs.length > 0) {
            const subject = `Renamed asset ${fromPath} → ${toPath}`;
            summaryResponse = attributeRenameWriteToActor(
              actor,
              subject,
              result.rewrittenDocs.map(({ docName }) => ({ docName, subject })),
              {
                context: 'handleRenamePath asset branch',
                onAnonymous: () => {
                  log.debug(
                    {
                      kind: 'asset',
                      fromPath,
                      toPath,
                      affectedDocs: result.rewrittenDocs.length,
                      affectedAssets: result.renamedAssets.length,
                    },
                    '[rename-path] anonymous actor; no contributor recorded (no agentId in body and getPrincipal() returned null)',
                  );
                },
              },
            );
          }
          renameAttributionCounter().add(1, {
            kind: 'rename-asset',
            attribution_kind: actor.kind,
          });

          if (flushContributors) {
            try {
              await flushContributors();
            } catch (flushErr) {
              log.warn(
                { err: flushErr },
                '[rename-path] flushContributors failed after asset rename (commitSha backfill may be deferred)',
              );
            }
          }

          successResponse(
            res,
            200,
            RenamePathSuccessSchema,
            {
              renamed: [],
              renamedAssets: result.renamedAssets,
              rewrittenDocs: result.rewrittenDocs,
              ...(summaryResponse ? { summary: summaryResponse } : {}),
            },
            { handler: 'rename-path' },
          );
          return;
        }
        // Register the source's actual on-disk extension before downstream
        // checks so admission, conflict checks, and existsSync probes all see
        // the right value when the file watcher hasn't yet observed the source
        // (boot race).
        if (operationKind === 'file') {
          probeAndRegisterSourceFileExtension(contentDir, fromPath);
        }
        // Conflict-aware refusal. Renaming a conflicted source doc would
        // shift the file path while the merge stages still live at the
        // old path — the disk-watcher → reconcile loop would then see two
        // paths racing the same content. For a folder rename we ALSO
        // refuse if any affected child carries 'conflict': the per-doc
        // rewrite spine (`applyManagedRenameMapToLoadedDocument` →
        // `composeAndWriteRawBody`) is a sibling primitive to
        // `applyAgentMarkdownWrite` and does NOT inherit its gate.
        // Mirrors handleDeletePath's affected-docs scan.
        //
        // Dual-source check: hocuspocus.documents.get() returns undefined
        // for docs evicted from memory (e.g., after boot-time
        // restoreLifecycleFromConflictsJson disconnects them). Falling back
        // to ConflictStore via SyncEngine catches that eviction race —
        // mirrors the dual-source pattern used in handleSyncConflictContent's
        // 404 gate.
        // Enumerate from disk (not the lagging file index) so the conflict
        // pre-check sees every on-disk child of the folder — same root cause
        // as the spine's `affectedDocNames`.
        const renameAffectedDocNames =
          operationKind === 'file'
            ? [docNameForFileOperationPath(contentDir, fromPath)]
            : listManagedDocNamesUnderFolderFromDisk(
                resolveContentEntryPath(contentDir, 'folder', fromPath),
              );
        const renameEngine = getSyncEngine?.();
        const renameTrackedFiles = new Set(
          renameEngine ? renameEngine.getConflicts().map((c) => c.file) : [],
        );
        for (const affected of renameAffectedDocNames) {
          const affectedDocName = affected;
          const doc = hocuspocus.documents.get(affectedDocName);
          const filePath = docNameToRelativePath(affectedDocName);
          const conflictedByLifecycle = doc !== undefined && isDocInConflict(doc);
          const conflictedByStore = renameTrackedFiles.has(filePath);
          if (conflictedByLifecycle || conflictedByStore) {
            respondDocInConflict(res, new DocInConflictError({ file: filePath }), 'rename-path');
            return;
          }
        }

        if (contentFilter) {
          // Mirror `resolveContentEntryPath`'s explicit-extension detection so
          // a destination like `bar.mdx` is checked verbatim instead of as
          // `bar.mdx.md` (which would miss `*.mdx` exclusion patterns).
          const sourceExt = isSupportedDocFile(fromPath)
            ? extname(fromPath)
            : getDocExtension(fromPath);
          const excluded =
            operationKind === 'file'
              ? contentFilter.isExcluded(
                  isSupportedDocFile(toPath) ? toPath : `${toPath}${sourceExt}`,
                )
              : contentFilter.isDirExcluded(toPath);
          if (excluded) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              `Destination ${operationKind === 'file' ? 'document' : 'folder'} is excluded by the project content config.`,
              { handler: 'rename-path' },
            );
            return;
          }
        }

        // Thread the actor identity through to the rewrite spine so the
        // rename log entry carries the right writerId. Anonymous → service
        // writer fallback is handled inside the spine.
        const renameActor =
          actor.kind === 'agent' || actor.kind === 'principal'
            ? {
                writerId: actor.writerId,
                displayName: actor.displayName,
                colorSeed: actor.colorSeed,
                actorMetadata: actor.actor,
              }
            : undefined;

        let result: {
          renamed: RenamedDocMapping[];
          renamedAssets: RenamedAssetMapping[];
          rewrittenDocs: ManagedRenameRewrittenDoc[];
        };
        try {
          result = await _performManagedRenameForDocs(
            fromPath,
            toPath,
            operationKind,
            renameActor ? { actor: renameActor } : {},
          );
        } catch (err) {
          // The spine's own conflict assertions cover a WIDER set than the
          // pre-check above: backlink-source and asset-referencing docs
          // rewritten as a side effect of the rename. Mirror the asset
          // branch so those surface as the documented 409 doc-in-conflict
          // envelope instead of falling through `toManagedRenamePublicError`
          // to a generic 500.
          if (err instanceof DocInConflictError) {
            respondDocInConflict(res, err, 'rename-path');
            return;
          }
          if (err instanceof ManagedRenameCollisionError) {
            errorResponse(res, 409, 'urn:ok:error:doc-already-exists', withPeriod(err.message), {
              handler: 'rename-path',
              extensions: { colliding: err.colliding },
              cause: err,
            });
            return;
          }
          throw err;
        }

        if (result.renamed.length === 0 && result.renamedAssets.length === 0) {
          successResponse(
            res,
            200,
            RenamePathSuccessSchema,
            { renamed: [], renamedAssets: [], rewrittenDocs: [] },
            { handler: 'rename-path' },
          );
          return;
        }

        if (result.renamedAssets.length > 0) {
          invalidateReferencedAssetsCache();
        }

        let summaryResponse: SummaryResponse | undefined;
        const logicalRenames = result.renamed.filter(
          ({ fromDocName, toDocName }) => fromDocName !== toDocName,
        );
        if (logicalRenames.length > 0) {
          summaryResponse = attributeRenameWriteToActor(
            actor,
            `Renamed ${fromPath} → ${toPath}`,
            logicalRenames.map(({ fromDocName, toDocName }) => ({
              docName: toDocName,
              subject: formatRenameSubject(fromDocName, toDocName),
            })),
            {
              context: 'handleRenamePath',
              onAnonymous: () => {
                log.debug(
                  { kind, fromPath, toPath, affectedDocs: result.renamed.length },
                  '[rename-path] anonymous actor — no contributor recorded (no agentId in body and getPrincipal() returned null)',
                );
              },
            },
          );
        }
        renameAttributionCounter().add(1, {
          kind: `rename-${operationKind}`,
          attribution_kind: actor.kind,
        });

        // Flush pending contributors so the rename-log entry's commitSha is
        // backfilled by `commitToWipRefInner` BEFORE the API responds.
        // Without this, a "pure rename without subsequent edit" leaves
        // commitSha as '' until the next persistence drain (which may never
        // happen) — the timeline rename-history mitigation depends on
        // commitSha being a real 40-char SHA at read time. Mirrors the
        // pattern at handleRollback (post-rollback flushContributors call).
        if (flushContributors) {
          try {
            await flushContributors();
          } catch (flushErr) {
            log.warn(
              { err: flushErr },
              '[rename-path] flushContributors failed (commitSha backfill may be deferred)',
            );
          }
        }

        successResponse(
          res,
          200,
          RenamePathSuccessSchema,
          {
            renamed: result.renamed,
            renamedAssets: result.renamedAssets,
            rewrittenDocs: result.rewrittenDocs,
            ...(summaryResponse ? { summary: summaryResponse } : {}),
          },
          { handler: 'rename-path' },
        );
      } catch (e) {
        const { status, type, error } = toManagedRenamePublicError(e);
        errorResponse(res, status, type, error, {
          handler: 'rename-path',
          cause: e,
        });
      }
    },
    { handler: 'rename-path', method: 'POST' },
  );

  const handleDeletePath = withValidation(
    DeletePathRequestSchema,
    async (_req, res, body) => {
      try {
        extractAgentIdentity(body as unknown as Record<string, unknown>); // attribution threading
        const { kind, path } = body;
        if (!isValidRelativeContentPath(path)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'path must be a relative content path.',
            { handler: 'delete-path' },
          );
          return;
        }
        const assetResolution =
          kind === 'asset' ? resolveExtensionlessAssetPath(path) : { path, ambiguous: false };
        if (assetResolution.ambiguous) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Asset path without an extension matches multiple files.',
            { handler: 'delete-path' },
          );
          return;
        }
        const operationPath = assetResolution.path;
        const operationKind = kind === 'asset' && isSupportedDocFile(operationPath) ? 'file' : kind;
        if (operationKind === 'file') {
          probeAndRegisterSourceFileExtension(contentDir, operationPath);
        }
        // The canonical arm is load-bearing HERE above all: delete resolves the
        // target through a symlinked directory and runs `tracedRmSync(...,
        // { recursive: true })`, so a lexically-clean `escape-hatch/local` that
        // realpaths to `.ok/local` would recursively remove server.lock /
        // principal.json / cache (or `.git/objects`). The lexical check cannot
        // see through the link; the canonical one can.
        if (isReservedProjectStatePath(operationPath) || canonicalTargetIsReserved(operationPath)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            '.ok and .git are reserved directories.',
            { handler: 'delete-path' },
          );
          return;
        }

        const outcome = await fileOpsService.deletePath(operationKind, operationPath);
        if (!outcome.ok) {
          if (outcome.kind === 'not-found') {
            errorResponse(
              res,
              404,
              'urn:ok:error:doc-not-found',
              `${operationKind} does not exist.`,
              { handler: 'delete-path' },
            );
          } else if (outcome.kind === 'type-mismatch') {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              `Target path is not a ${operationKind}.`,
              { handler: 'delete-path' },
            );
          } else {
            respondDocInConflict(
              res,
              new DocInConflictError({ file: outcome.file }),
              'delete-path',
            );
          }
          return;
        }
        successResponse(
          res,
          200,
          DeletePathSuccessSchema,
          { deletedDocNames: outcome.deletedDocNames },
          { handler: 'delete-path' },
        );
      } catch (e) {
        if (isContainmentRejection(e)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:path-escape',
            'path must not escape content directory.',
            { handler: 'delete-path', cause: e },
          );
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to delete path.', {
          handler: 'delete-path',
          cause: e,
        });
      }
    },
    { handler: 'delete-path', method: 'POST' },
  );

  // Two-step Trash flow: the renderer calls
  // `bridge.shell.trashItem` (Step 1) which moves the file to ~/.Trash via
  // `shell.trashItem`. On success, the renderer POSTs here (Step 2) to
  // synchronously cleanup server-side state — close Hocuspocus docs, mark
  // `recentlyRemovedDocs`, purge the file index, broadcast CC1 files.
  // Does NOT touch disk (the file is already gone from contentDir).
  //
  // Idempotent: if the file-watcher already processed the OS-level deletion
  // between Step 1 and Step 2, `listAffectedDocNames` returns an empty array
  // and the handler returns 200 with `deletedDocNames: []` rather than 404 —
  // the desired end state (gone) is still true.
  const handleTrashCleanup = withValidation(
    TrashCleanupRequestSchema,
    async (_req, res, body) => {
      return withSpan(
        'ok.fs.trash_cleanup',
        {
          attributes: {
            'ok.cleanup.kind': body.kind,
            'ok.cleanup.path': normalizeFsPath(body.path),
            'ok.cleanup.path.role': classifyFsPath(body.path),
          },
        },
        async () => {
          try {
            const bodyObj = body as unknown as Record<string, unknown>;
            const actor = extractActorIdentity(bodyObj, getPrincipal);
            if (actor.kind === 'invalid-summary') {
              errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
                handler: 'trash-cleanup',
              });
              return;
            }
            const { kind, path } = body;
            if (!isValidRelativeContentPath(path)) {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                'path must be a relative content path.',
                { handler: 'trash-cleanup' },
              );
              return;
            }
            const operationKind = kind === 'asset' && isSupportedDocFile(path) ? 'file' : kind;
            const operationDocName = stripDocExtension(path);
            if (operationKind === 'file') {
              probeAndRegisterSourceFileExtension(contentDir, path);
            }
            // Defense in depth — synthetic docs never reach disk so cleanup
            // against them is meaningless; mirrors the gate handleDeletePath
            // implicitly enforces via `resolveContentEntryPath` + existsSync.
            // Folder kind is checked separately: a `kind: 'folder', path:
            // '__config__'` payload would otherwise reach listAffectedDocNames
            // + captureAndCloseDocuments on the synthetic config docs inside
            // that namespace before the per-doc guard at the recently-removed
            // loop fires.
            const isReservedFolder =
              operationKind === 'folder' && isReservedSyntheticFolderPath(path);
            if (
              (operationKind === 'file' &&
                (isSystemDoc(operationDocName) || isConfigDoc(operationDocName))) ||
              isReservedFolder ||
              isReservedProjectStatePath(path)
            ) {
              errorResponse(
                res,
                400,
                'urn:ok:error:reserved-doc-name',
                `'${path}' is a reserved document name.`,
                { handler: 'trash-cleanup' },
              );
              return;
            }
            const { deletedDocNames } = await fileOpsService.trashCleanup(
              operationKind,
              path,
              operationDocName,
              'handleTrashCleanup',
            );
            successResponse(
              res,
              200,
              TrashCleanupSuccessSchema,
              { deletedDocNames },
              { handler: 'trash-cleanup' },
            );
          } catch (e) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'Failed to clean up after trash.',
              {
                handler: 'trash-cleanup',
                cause: e,
              },
            );
          }
        },
      );
    },
    { handler: 'trash-cleanup', method: 'POST' },
  );

  async function handleUploadAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'upload-asset',
        extraHeaders: { Allow: 'POST' },
      });
      return;
    }

    let uploadResult: UploadResult | undefined;
    try {
      uploadResult = await readUploadBody(req, projectDir ?? contentDir);
    } catch (e) {
      // All body-parse failures land as UploadWriteError with a URN-form
      // reason. Tempfile cleanup is handled inside readUploadBody's error
      // path. Anonymous emit (no extractAgentIdentity yet) is semantically
      // OK — no Y.Doc mutation has been attempted.
      if (e instanceof UploadWriteError) {
        errorResponse(res, uploadStatusFor(e.reason), e.reason, uploadTitleFor(e.reason), {
          handler: 'upload-asset',
          cause: e,
        });
        return;
      }
      errorResponse(res, 400, 'urn:ok:error:malformed-upload', 'Failed to parse upload.', {
        handler: 'upload-asset',
        cause: e,
      });
      return;
    }

    const {
      filename,
      tempPath,
      sha,
      byteLength,
      parentDocName: rawParentDocName,
      placement: rawPlacement,
    } = uploadResult;

    // Belt-and-braces cleanup: if anything below this point errors or
    // early-returns, the tempfile must go away. Every early-return path
    // below that does NOT consume tempPath via linkTempToFinal* runs this.
    const cleanupTempfile = () => {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // best-effort; orphan sweep reaps stragglers
        }
      }
    };

    // Validate metadata fields (parentDocName etc.) via the shared
    // `validateBody` middleware. Body-shape failure emits 400
    // `urn:ok:error:invalid-request` BEFORE `extractAgentIdentity` runs —
    // an anonymous response is semantically correct here because no Y.Doc
    // mutation is attempted. Mirrors `withValidation`'s policy for JSON
    // handlers.
    const validated = validateBody(
      UploadRequestSchema,
      { parentDocName: rawParentDocName, placement: rawPlacement || undefined },
      res,
      {
        handler: 'upload-asset',
      },
    );
    if (!validated.ok) {
      cleanupTempfile();
      return;
    }
    const { parentDocName, placement } = validated.value;

    // Identity extracted from query params (multipart body precludes JSON).
    // Capture agentId / agentName so structured upload logs carry
    // attribution — mirrors precedent #24/#25 and lets operators trace
    // unexpected file-creation events back to the originating agent
    // during incident investigation. Both fields follow bounded shapes
    // (agentId matches AGENT_ID_RE; agentName is sanitized) so they
    // remain cardinality-safe for log indexing.
    //
    // CRUCIAL: identity extraction must precede every SEMANTIC error
    // emission below (path-escape, no-file-received, storage-error). Body-
    // shape errors above (urn:ok:error:invalid-request, urn:ok:error:malformed-upload)
    // are anonymous because no Y.Doc mutation is attempted. The
    // attribution-sweep-coverage ordering check enforces this distinction
    // (precedent #24).
    const { agentId, agentName } = extractAgentIdentity(
      Object.fromEntries(new URL(req.url ?? '', 'http://localhost').searchParams.entries()),
    );

    if (byteLength === 0) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:no-file-received', 'No file received.', {
        handler: 'upload-asset',
      });
      return;
    }

    // Reject path-escape attempts.
    if (
      parentDocName.includes('\x00') ||
      parentDocName.includes('..') ||
      parentDocName.startsWith('/')
    ) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
        handler: 'upload-asset',
      });
      return;
    }
    // Same lexical precondition as the five sibling file-ops, scoped to the
    // component the server actually resolves: only `dirname(parentDocName)`
    // ever reaches `resolveUploadDestDir` — the basename is discarded on every
    // branch — and on the sidebar external-file-drop path that basename is a
    // raw OS filename (backslash is a legal filename character on macOS and
    // Linux), so validating the whole string rejects ordinary drops. The check
    // is load-bearing for the reserved gate below: `canonicalTargetIsReserved`
    // swallows a failed resolution to `false`, and `resolveContentEntryPath`
    // throws on any `.` or empty segment — so without it a `./`-prefixed
    // parentDocName would skate past the canonical arm. `dirname('alpha')` is
    // `'.'` (a root-level doc), which the predicate rejects but is fine here.
    const parentDirComponent = dirname(parentDocName);
    if (parentDirComponent !== '.' && !isValidRelativeContentPath(parentDirComponent)) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
        handler: 'upload-asset',
      });
      return;
    }
    // Reserved-subtree gate, same two arms as the sibling file-ops. `.ok`/
    // `.git` sit INSIDE the content root, so the escape checks above and the
    // ones in `storeUpload` all pass for `parentDocName: '.ok/skills/x'` — a
    // literal path, no symlink needed — and the upload would land agent-loaded
    // content in `.ok/skills/` with none of the skill-schema validation.
    // Deliberately blanket: this also refuses upload into the two `.ok/`
    // subtrees the content filter admits as editable docs (`.ok/skills/**` and
    // `<folder>/.ok/templates/**`) — asset upload sits on the create side of
    // the reserved boundary, like create-page. This is a fast fail on the
    // request field; the authoritative check runs on the resolved destination
    // inside `storeUpload` (kind `reserved-destination`), which also covers the
    // configured `attachmentFolderPath` arm the request field never sees.
    if (
      isReservedProjectStatePath(parentDocName) ||
      (parentDirComponent !== '.' && canonicalTargetIsReserved(parentDirComponent))
    ) {
      cleanupTempfile();
      errorResponse(
        res,
        400,
        'urn:ok:error:reserved-doc-name',
        '.ok and .git are reserved directories.',
        { handler: 'upload-asset' },
      );
      return;
    }

    const outcome = await assetService.storeUpload({
      tempPath,
      sha,
      byteLength,
      filename,
      parentDocName,
      placement,
    });
    if (outcome.ok) {
      log.info(
        {
          event: 'upload',
          endpoint: req.url ?? '/api/upload',
          agentId,
          agentName,
          dedup: outcome.deduped,
          mime: outcome.mime,
          size: byteLength,
          // `destPath` is the contentDir-relative asset path. High-
          // cardinality by nature — fine as a log field consumed by text-
          // search / by-incident filtering; NEVER promote it to a metric
          // label (per-asset label explosion).
          destPath: outcome.path,
          httpStatus: 200,
        },
        outcome.deduped ? '[upload] dedup hit' : '[upload] write ok',
      );
      // RFC 9457 §3 success path: drop the `ok: true` wrapper. Wire shape
      // is `{ src, path, deduped }`; clients discriminate on HTTP status.
      successResponse(
        res,
        200,
        UploadAssetSuccessSchema,
        { src: outcome.src, path: outcome.path, deduped: outcome.deduped },
        { handler: 'upload-asset' },
      );
      return;
    }
    switch (outcome.kind) {
      case 'config-error':
        log.error(
          { err: outcome.cause },
          '[upload] project config has invalid content.attachmentFolderPath',
        );
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Server configuration error: invalid attachment folder path.',
          { handler: 'upload-asset', cause: outcome.cause },
        );
        return;
      case 'invalid-attachment-folder':
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid attachment folder path.', {
          handler: 'upload-asset',
        });
        return;
      case 'path-escape':
        errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
          handler: 'upload-asset',
          ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
        });
        return;
      case 'reserved-destination':
        errorResponse(
          res,
          400,
          'urn:ok:error:reserved-doc-name',
          '.ok and .git are reserved directories.',
          { handler: 'upload-asset' },
        );
        return;
      case 'dest-validation-error':
        log.error(
          { err: outcome.cause, destDir: outcome.destDir },
          '[upload] failed to validate destination directory',
        );
        errorResponse(res, 500, 'urn:ok:error:storage-error', 'Storage error.', {
          handler: 'upload-asset',
          cause: outcome.cause,
        });
        return;
      case 'mkdir-failed':
        errorResponse(
          res,
          uploadStatusFor(outcome.reason),
          outcome.reason,
          uploadTitleFor(outcome.reason),
          {
            handler: 'upload-asset',
            cause: outcome.cause,
            detail: 'failed to create attachment directory',
          },
        );
        return;
      case 'write-failed':
        log.error(
          {
            event: 'upload',
            endpoint: req.url ?? '/api/upload',
            requestId: getRequestId(req),
            agentId,
            agentName,
            filename: outcome.filename,
            size: byteLength,
            reason: outcome.reason,
            httpStatus: uploadStatusFor(outcome.reason),
            err: outcome.cause,
          },
          '[upload] write failed',
        );
        errorResponse(
          res,
          uploadStatusFor(outcome.reason),
          outcome.reason,
          uploadTitleFor(outcome.reason),
          { handler: 'upload-asset', cause: outcome.cause },
        );
        return;
    }
  }

  return createApiRouteGroup(
    {
      '/api/create-page': handleCreatePage,
      '/api/create-folder': handleCreateFolder,
      '/api/duplicate-path': handleDuplicatePath,
      '/api/rename-path': handleRenamePath,
      '/api/delete-path': handleDeletePath,
      '/api/trash/cleanup': handleTrashCleanup,
      '/api/upload': handleUploadAsset,
    },
    {
      mutating: [
        '/api/create-page',
        '/api/create-folder',
        '/api/duplicate-path',
        '/api/rename-path',
        '/api/delete-path',
        '/api/trash/cleanup',
        '/api/upload',
      ],
    },
  );
}
