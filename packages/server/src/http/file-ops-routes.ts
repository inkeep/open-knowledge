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

function readUploadBody(req: IncomingMessage, projectDir: string): Promise<UploadResult> {
  return new Promise((resolveP, reject) => {
    let bb: MultipartParser;
    try {
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
    let fileEventFired = false;

    const fail = (reason: UploadWriteReason, cause: unknown) => {
      if (settled) return;
      settled = true;
      if (writeStream && tempPath) {
        const staged = tempPath;
        writeStream.once('close', () => {
          try {
            unlinkSync(staged);
          } catch {}
        });
      }
      writeStream?.destroy();
      if (tempPath) {
        try {
          unlinkSync(tempPath);
        } catch {}
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
          const nodeErr = err as NodeJS.ErrnoException;
          fail(classifyWriteError(nodeErr), err);
        });
    });

    bb.on('error', (err) => {
      fail('urn:ok:error:malformed-upload', err);
    });

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

    req.on('close', () => {
      if (settled || pipelineError) return;
      if (!req.complete) {
        fail('urn:ok:error:malformed-upload', new Error('client disconnected'));
      }
    });

    req.pipe(bb);
  });
}

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
        const resolvedContentDir = resolve(contentDir);
        let fullPath: string;
        try {
          fullPath = resolveContentEntryPath(contentDir, 'file', filePath);
        } catch (err) {
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
          const templateStarter = instantiateDoc(templateRaw);
          const userDisplayName =
            actor.kind === 'agent' || actor.kind === 'principal' ? (actor.displayName ?? '') : '';
          initialContent = applySubstitution(templateStarter, {
            date: todayIsoUtc(),
            user: userDisplayName,
          });
          templateScopeForLog = matched.scope;
        }

        const docName = stripDocExtension(filePath);
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
            break;
          default: {
            const _exhaustive: never = actor;
            throw new Error(
              `Unhandled actor kind in handleCreatePage: ${String((_exhaustive as { kind?: unknown }).kind)}`,
            );
          }
        }
        void recordDerivedDocumentBestEffort(docName, initialContent, 'create-page');
        signalChannel?.('files');
        if (templateScopeForLog !== undefined) {
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
        if (operationKind === 'file') {
          probeAndRegisterSourceFileExtension(contentDir, fromPath);
        }
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
        extractAgentIdentity(body as unknown as Record<string, unknown>);
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

    const cleanupTempfile = () => {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {}
      }
    };

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

    // attribution — mirrors precedent #24/#25 and lets operators trace
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
    const parentDirComponent = dirname(parentDocName);
    if (parentDirComponent !== '.' && !isValidRelativeContentPath(parentDirComponent)) {
      cleanupTempfile();
      errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
        handler: 'upload-asset',
      });
      return;
    }
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
          destPath: outcome.path,
          httpStatus: 200,
        },
        outcome.deduped ? '[upload] dedup hit' : '[upload] write ok',
      );
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
