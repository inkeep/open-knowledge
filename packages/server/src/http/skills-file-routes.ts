import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  EmptyRequestSchema,
  type Principal,
  projectSkillContentDocName,
  SkillFileDeleteSuccessSchema,
  SkillFileGetSuccessSchema,
  SkillFilePutRequestSchema,
  SkillFilePutSuccessSchema,
  SkillFileRenameRequestSchema,
  SkillFileRenameSuccessSchema,
} from '@inkeep/open-knowledge-core';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { composeAndWriteRawBody } from '../bridge-intake.ts';
import {
  applySkillBundleFileDelete,
  applySkillBundleFileRename,
  applySkillBundleFileWrite,
  BUNDLE_FILE_MAX_BYTES,
  BUNDLE_MAX_FILES,
  countBundleFiles,
} from '../content/skills-write.ts';
import type {
  DerivedDocumentIndexApiPort,
  DerivedDocumentIndexMutation,
} from '../derived-document-index.ts';
import { SUPPORTED_DOC_EXTENSIONS } from '../doc-extensions.ts';
import type { StoreFailure } from '../document-durability-state.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import type { PinoLogger } from '../logger.ts';
import { isInternalBundleSkillName } from '../skill-bundles.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { methodRouter } from './method-router.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsFileRouteDeps {
  validateSkillName: (name: string, res: ServerResponse, handler: string) => boolean;
  parseSkillScope: (
    raw: string | null,
    res: ServerResponse,
    handler: string,
  ) => 'project' | 'global' | null;
  skillsHome: string;
  projectDir: string | undefined;
  resolveBuiltinSkillDir: (
    base: string,
    name: string,
    scope: 'project' | 'global',
    host?: string,
  ) => { dir: string; skillMd: string; hosts: string[]; relPath: string } | null;
  resolveSkillDirForRead: (
    scope: 'project' | 'global',
    name: string,
    host?: string,
  ) => string | null;
  derivedDocumentIndex: DerivedDocumentIndexApiPort | undefined;
  getPrincipal: (() => Principal | null) | undefined;
  rejectReservedBuiltinSkill: (name: string, res: ServerResponse, handler: string) => boolean;
  contentDir: string;
  attributeOkArtifactWrite: (
    actor: ReturnType<typeof extractActorIdentity>,
    artifactKey: string,
    subject: string,
    previousPaths?: Array<{ from: string; to: string }>,
  ) => void;
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  checkSkillDocConflictGate: (docName: string, handler: string, res: ServerResponse) => boolean;
  extractAgentIdentity: (body: Record<string, unknown>) => {
    rawAgentId: string | undefined;
    agentId: string;
    agentName: string;
    colorSeed: string;
    clientName: string | undefined;
    clientVersion: string | undefined;
    label: string | undefined;
  };
  sessionManager: AgentSessionManager;
  respondStaleExternalWrite: (res: ServerResponse, handler: string, docName: string) => void;
  flushDiskAndDetectOutcome: (
    docName: string,
  ) => Promise<
    | { kind: 'failure'; failure: StoreFailure }
    | { kind: 'divergence' }
    | { kind: 'stale-external-write' }
    | null
  >;
  respondPersistenceFailure: (res: ServerResponse, failure: StoreFailure, handler: string) => void;
  respondDiskDivergence: (res: ServerResponse, handler: string) => void;
  okArtifactKey: (
    kind: 'template' | 'folder-frontmatter' | 'folder' | 'skill',
    folder: string,
    name?: string,
  ) => string;
  resolveSkillsRoot: (scope: 'project' | 'global') => string;
  extractActorIdentityFromQuery: (
    url: URL,
    principal: (() => Principal | null) | undefined,
  ) => ReturnType<typeof extractActorIdentity>;
  captureAndCloseDocuments: (
    docNames: string[],
    lifecycleStatus: 'deleted-upstream' | 'renamed',
  ) => Promise<Map<string, string>>;
  log: PinoLogger;
  commitOkArtifactWrite: (context: string) => Promise<void>;
  recordDerivedMutationsBestEffort: (
    mutations: DerivedDocumentIndexMutation[],
    reason: string,
  ) => Promise<void>;
}

export function createSkillsFileRoutes(deps: SkillsFileRouteDeps): ApiRouteGroup {
  const {
    validateSkillName,
    parseSkillScope,
    skillsHome,
    projectDir,
    resolveBuiltinSkillDir,
    resolveSkillDirForRead,
    resolveSkillsRoot,
    getPrincipal,
    rejectReservedBuiltinSkill,
    contentDir,
    checkSkillDocConflictGate,
    extractAgentIdentity,
    sessionManager,
    flushDiskAndDetectOutcome,
    respondStaleExternalWrite,
    respondPersistenceFailure,
    respondDiskDivergence,
    attributeOkArtifactWrite,
    okArtifactKey,
    commitOkArtifactWrite,
    signalChannel,
    extractActorIdentityFromQuery,
    captureAndCloseDocuments,
    derivedDocumentIndex,
    log,
    recordDerivedMutationsBestEffort,
  } = deps;
  function classifySkillFilePath(rel: string): 'reference' | 'script' | 'file' | null {
    if (rel.includes('\x00')) return null;
    const segments = rel
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s !== '' && s !== '.');
    if (segments.length < 1 || segments.some((s) => s === '..')) return null;
    if (segments.length === 1 && (segments[0] as string).toLowerCase() === 'skill.md') return null;
    if (segments[0] === 'references' && segments.length >= 2) return 'reference';
    if (segments[0] === 'scripts' && segments.length >= 2) return 'script';
    return 'file';
  }

  function isProjectMdReference(
    scope: 'project' | 'global',
    kind: 'reference' | 'script' | 'file',
    rel: string,
  ): boolean {
    return scope === 'project' && kind === 'reference' && rel.toLowerCase().endsWith('.md');
  }

  function nestedProjectRefDocNames(realDir: string, dirRel: string): string[] {
    const base = resolve(realDir, dirRel);
    const dirDocPrefix = relative(contentDir, realDir).split(sep).join('/');
    let entries: string[];
    try {
      entries = readdirSync(base, { recursive: true, encoding: 'utf-8' });
    } catch {
      return [];
    }
    return entries
      .filter((e) => /\.md$/i.test(e))
      .map((e) => `${dirDocPrefix}/${dirRel}/${e.split(sep).join('/').replace(/\.md$/i, '')}`);
  }

  function projectRefContentDocName(name: string, rel: string): string {
    const extLess = rel.replace(/\.md$/i, '');
    return `${projectSkillContentDocName(name).replace(/\/SKILL$/, '')}/${extLess}`;
  }

  const handleSkillFileGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-file-get')) return;
        const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-file-get');
        if (scope === null) return;
        const rel = url.searchParams.get('path') ?? '';
        const builtinBase = isInternalBundleSkillName(name)
          ? scope === 'global'
            ? skillsHome
            : projectDir
          : undefined;
        const builtinHost = url.searchParams.get('host') ?? undefined;
        const builtin = builtinBase
          ? resolveBuiltinSkillDir(builtinBase, name, scope, builtinHost)
          : null;
        if (rel === '' || rel.includes('\x00')) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid skill file path.', {
            handler: 'skill-file-get',
          });
          return;
        }
        const kind =
          (builtin && rel === 'SKILL.md' ? 'reference' : classifySkillFilePath(rel)) ?? 'reference';
        const host = builtinHost;
        const resolvedSkillDir = builtinBase
          ? (builtin?.dir ?? null)
          : resolveSkillDirForRead(scope, name, host);
        if (resolvedSkillDir === null && host !== undefined) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-file-get',
            detail: `No skill "${name}" (${scope}) in ${host}.`,
          });
          return;
        }
        const skillDir = resolvedSkillDir ?? resolve(resolveSkillsRoot(scope), name);
        const abs = resolve(skillDir, rel);
        if (abs !== skillDir && !abs.startsWith(`${skillDir}${sep}`)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Skill file path escapes the skill dir.',
            {
              handler: 'skill-file-get',
            },
          );
          return;
        }
        let resolvedAbs = abs;
        let resolvedRel = rel;
        if (!existsSync(resolvedAbs)) {
          const docStem = rel.match(/^(.*)\.(?:md|mdx)$/);
          const sibling = docStem
            ? SUPPORTED_DOC_EXTENSIONS.map((ext) => `${docStem[1]}${ext}`).find(
                (candidate) => candidate !== rel && existsSync(resolve(skillDir, candidate)),
              )
            : undefined;
          if (sibling === undefined) {
            errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill file not found.', {
              handler: 'skill-file-get',
              detail: `${rel} not found in skill "${name}" (${scope}).`,
            });
            return;
          }
          resolvedRel = sibling;
          resolvedAbs = resolve(skillDir, sibling);
        }
        const buf = await readFile(resolvedAbs);
        if (buf.includes(0)) {
          errorResponse(
            res,
            415,
            'urn:ok:error:invalid-request',
            'Skill file is binary — only text bundle files are readable via MCP.',
            { handler: 'skill-file-get' },
          );
          return;
        }
        successResponse(
          res,
          200,
          SkillFileGetSuccessSchema,
          { path: resolvedRel.replace(/\\/g, '/'), kind, text: buf.toString('utf-8') },
          { handler: 'skill-file-get' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read skill file.',
          {
            handler: 'skill-file-get',
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-file-get', method: 'GET', skipBodyParse: true },
  );

  const handleSkillFilePut = withValidation(
    SkillFilePutRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-file-put',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-file-put')) return;
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-file-put')) return;
        const kind = classifySkillFilePath(body.path);
        if (kind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid skill file path (must name a file inside the skill dir, no `..`).',
            { handler: 'skill-file-put' },
          );
          return;
        }
        if (Buffer.byteLength(body.content, 'utf-8') > BUNDLE_FILE_MAX_BYTES) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Skill file exceeds the 256 KB per-file cap.',
            { handler: 'skill-file-put' },
          );
          return;
        }
        const skillDirAbs = resolveSkillDirForRead(body.scope, body.name);
        if (skillDirAbs === null || !existsSync(join(skillDirAbs, 'SKILL.md'))) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-file-put',
            detail: `Create skill "${body.name}" before adding bundle files.`,
          });
          return;
        }
        const fileBase = body.scope === 'project' ? contentDir : skillsHome;
        const skillDirRel = relative(fileBase, skillDirAbs).split(sep).join('/');
        const rel = body.path.replace(/\\/g, '/');
        const routedThroughContent = isProjectMdReference(body.scope, kind, rel);
        let created: boolean;

        if (routedThroughContent) {
          /**
           * A project `.md` reference routes through the sanctioned paired-write primitive
           * (precedent #24 / #38), the same branch as the SKILL.md body.
           */
          const refDocName = `${skillDirRel}/${rel.replace(/\.mdx?$/i, '')}`;
          if (checkSkillDocConflictGate(refDocName, 'skill-file-put', res)) return;
          created = !existsSync(resolve(skillDirAbs, rel));
          if (created && countBundleFiles(skillDirAbs) >= BUNDLE_MAX_FILES) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              `Skill "${body.name}" already holds ${BUNDLE_MAX_FILES} bundle files (the cap) — delete one before adding another.`,
              { handler: 'skill-file-put' },
            );
            return;
          }
          const { agentId, agentName, colorSeed, clientName } = extractAgentIdentity(
            body as unknown as Record<string, unknown>,
          );
          const session = await sessionManager.getSession(refDocName, agentId, {
            displayName: agentName,
            colorSeed,
            clientName,
          });
          session.dc.document.transact(() => {
            composeAndWriteRawBody(session.dc.document, body.content, 'agent');
          }, session.origin);
          const flushOutcome = await flushDiskAndDetectOutcome(refDocName);
          if (flushOutcome?.kind === 'failure') {
            respondPersistenceFailure(res, flushOutcome.failure, 'skill-file-put');
            return;
          }
          if (flushOutcome?.kind === 'divergence') {
            respondDiskDivergence(res, 'skill-file-put');
            return;
          }
          if (flushOutcome?.kind === 'stale-external-write') {
            respondStaleExternalWrite(res, 'skill-file-put', refDocName);
            return;
          }
        } else {
          const fsResult = applySkillBundleFileWrite({
            skillsRoot: dirname(skillDirAbs),
            name: body.name,
            relPath: rel,
            content: body.content,
          });
          if (!fsResult.ok) {
            const status =
              fsResult.error.code === 'WRITE_ERROR'
                ? 500
                : fsResult.error.code === 'SKILL_NOT_FOUND'
                  ? 404
                  : 400;
            errorResponse(
              res,
              status,
              status === 500
                ? 'urn:ok:error:internal-server-error'
                : status === 404
                  ? 'urn:ok:error:not-found'
                  : 'urn:ok:error:invalid-request',
              status === 500 ? 'Failed to write skill file.' : 'Invalid skill file request.',
              {
                handler: 'skill-file-put',
                detail: fsResult.error.code,
                cause: new Error(fsResult.error.message),
              },
            );
            return;
          }
          created = fsResult.created;
        }

        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `${created ? 'skill-file-create' : 'skill-file-edit'}: ${skillDirRel}/${rel}`,
          );
          void commitOkArtifactWrite('skill-file-put');
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillFilePutSuccessSchema,
          { path: rel, created, kind, content: routedThroughContent },
          { handler: 'skill-file-put' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to write skill file.',
          {
            handler: 'skill-file-put',
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-file-put', method: 'PUT' },
  );

  const handleSkillFileDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const sp = url.searchParams;
        const name = sp.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-file-delete')) return;
        if (rejectReservedBuiltinSkill(name, res, 'skill-file-delete')) return;
        const scope = parseSkillScope(sp.get('scope'), res, 'skill-file-delete');
        if (scope === null) return;
        const rel = (sp.get('path') ?? '').replace(/\\/g, '/');
        const kind = classifySkillFilePath(rel);
        if (kind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Invalid skill file path (must name a file inside the skill dir).',
            { handler: 'skill-file-delete' },
          );
          return;
        }
        const actor = extractActorIdentityFromQuery(url, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-file-delete',
          });
          return;
        }
        const realDir = resolveSkillDirForRead(scope, name);
        const skillsRoot = realDir !== null ? dirname(realDir) : resolveSkillsRoot(scope);

        const bundleAbs = resolve(realDir ?? join(skillsRoot, name), rel);
        if (existsSync(bundleAbs) && isProjectMdReference(scope, kind, rel)) {
          const extLess = rel.replace(/\.md$/i, '');
          const refDoc =
            realDir !== null
              ? `${relative(contentDir, realDir).split(sep).join('/')}/${extLess}`
              : projectRefContentDocName(name, rel);
          await captureAndCloseDocuments([refDoc], 'deleted-upstream');
        } else if (
          scope === 'project' &&
          realDir !== null &&
          existsSync(bundleAbs) &&
          statSync(bundleAbs).isDirectory()
        ) {
          const docs = nestedProjectRefDocNames(realDir, rel);
          if (docs.length > 0) await captureAndCloseDocuments(docs, 'deleted-upstream');
        }

        const result = applySkillBundleFileDelete({ skillsRoot, name, relPath: rel });
        if (!result.ok) {
          const status = result.error.code === 'UNLINK_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            status === 500 ? 'Failed to delete skill file.' : 'Invalid skill file request.',
            {
              handler: 'skill-file-delete',
              detail: result.error.code,
              cause: new Error(result.error.message),
            },
          );
          return;
        }
        if (result.existed && scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', name),
            `skill-file-delete: ${
              realDir !== null
                ? `${relative(contentDir, realDir).split(sep).join('/')}/${rel}`
                : `${name}/${rel}`
            }`,
          );
          void commitOkArtifactWrite('skill-file-delete');
        }
        if (result.existed) signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillFileDeleteSuccessSchema,
          { path: rel, existed: result.existed, kind },
          { handler: 'skill-file-delete' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to delete skill file.',
          {
            handler: 'skill-file-delete',
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-file-delete', method: 'DELETE', skipBodyParse: true },
  );

  const handleSkillFile = methodRouter(
    { GET: handleSkillFileGet, PUT: handleSkillFilePut, DELETE: handleSkillFileDelete },
    { handler: 'skill-file' },
  );
  const handleSkillFileRename = withValidation(
    SkillFileRenameRequestSchema,
    async (_req, res, body) => {
      try {
        if (!validateSkillName(body.name, res, 'skill-file-rename')) return;
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-file-rename')) return;
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-file-rename',
          });
          return;
        }
        const from = body.from.replace(/\\/g, '/');
        const to = body.to.replace(/\\/g, '/');
        const fromKind = classifySkillFilePath(from);
        const toKind = classifySkillFilePath(to);
        if (fromKind === null || toKind === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Both paths must stay inside the skill dir.',
            { handler: 'skill-file-rename', detail: fromKind === null ? from : to },
          );
          return;
        }
        const realDir = resolveSkillDirForRead(body.scope, body.name);
        if (realDir === null) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-file-rename',
          });
          return;
        }
        const skillsRoot = dirname(realDir);

        const fromIsDoc = isProjectMdReference(body.scope, fromKind, from);
        const toIsDoc = isProjectMdReference(body.scope, toKind, to);
        const dirRel = relative(contentDir, realDir).split(sep).join('/');
        const fromDocName = fromIsDoc ? `${dirRel}/${from.replace(/\.md$/i, '')}` : null;
        const toDocName = toIsDoc ? `${dirRel}/${to.replace(/\.md$/i, '')}` : null;

        if (
          fromDocName !== null &&
          checkSkillDocConflictGate(fromDocName, 'skill-file-rename', res)
        )
          return;
        if (fromDocName !== null) {
          await captureAndCloseDocuments([fromDocName], 'deleted-upstream');
        } else if (body.scope === 'project') {
          const fromAbs = resolve(realDir, from);
          if (existsSync(fromAbs) && statSync(fromAbs).isDirectory()) {
            const docs = nestedProjectRefDocNames(realDir, from);
            if (docs.length > 0) await captureAndCloseDocuments(docs, 'deleted-upstream');
          }
        }

        const result = applySkillBundleFileRename({
          skillsRoot,
          name: body.name,
          relPath: from,
          toRelPath: to,
        });
        if (!result.ok) {
          const status = result.error.code === 'RENAME_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            result.error.message,
            { handler: 'skill-file-rename', detail: result.error.code },
          );
          return;
        }

        if (derivedDocumentIndex) {
          const mutations: DerivedDocumentIndexMutation[] = [];
          if (fromDocName !== null && toDocName !== null) {
            try {
              mutations.push({
                kind: 'rename',
                oldDocumentName: fromDocName,
                newDocumentName: toDocName,
                markdown: readFileSync(resolve(skillsRoot, body.name, to), 'utf-8'),
              });
            } catch {
              mutations.push({ kind: 'delete', documentName: fromDocName });
            }
          } else if (fromDocName !== null) {
            mutations.push({ kind: 'delete', documentName: fromDocName });
          } else if (toDocName !== null) {
            try {
              mutations.push({
                kind: 'upsert',
                documentName: toDocName,
                markdown: readFileSync(resolve(skillsRoot, body.name, to), 'utf-8'),
              });
            } catch {}
          }
          await recordDerivedMutationsBestEffort(mutations, 'skill-file-rename');
        }

        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `skill-file-rename: ${body.name}/${from} -> ${to}`,
          );
          void commitOkArtifactWrite('skill-file-rename');
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillFileRenameSuccessSchema,
          {
            from,
            to,
            ...(fromDocName !== null ? { fromDocName } : {}),
            ...(toDocName !== null ? { toDocName } : {}),
          },
          { handler: 'skill-file-rename' },
        );
      } catch (err) {
        log.error({ err }, '[skill-file-rename] failed');
        if (!res.headersSent) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'Failed to rename skill file.',
            { handler: 'skill-file-rename' },
          );
        }
      }
    },
    { handler: 'skill-file-rename', method: 'POST' },
  );

  return createApiRouteGroup(
    { '/api/skill-file': handleSkillFile, '/api/skill-file/rename': handleSkillFileRename },
    { mutating: ['/api/skill-file', '/api/skill-file/rename'] },
  );
}
