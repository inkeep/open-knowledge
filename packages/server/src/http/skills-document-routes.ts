import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ProblemType,
  SkillMoveStateCode,
  SkillRetentionLedgerCode,
  SkillSourceStateCode,
} from '@inkeep/open-knowledge-core';
import {
  EmptyRequestSchema,
  externalSkillLiveDocName,
  isSkillInstallTarget,
  type Principal,
  SkillDeleteSuccessSchema,
  SkillDuplicateRequestSchema,
  SkillDuplicateSuccessSchema,
  SkillEditExternalRequestSchema,
  SkillEditExternalSuccessSchema,
  SkillGetSuccessSchema,
  SkillMoveRequestSchema,
  SkillMoveScopeRequestSchema,
  SkillMoveScopeSuccessSchema,
  SkillMoveSuccessSchema,
  SkillPutRequestSchema,
  SkillPutSuccessSchema,
  skillLiveDocName,
} from '@inkeep/open-knowledge-core';
import type { SkillHostId } from '@inkeep/open-knowledge-core/skills-catalog';
import {
  parseSkillDir,
  SKILLS_LOCK_REL,
  type SkillsLock,
} from '@inkeep/open-knowledge-core/skills-catalog';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { composeAndWriteRawBody } from '../bridge-intake.ts';
import { isLinkIndexExcludedDoc } from '../cc1-broadcast.ts';
import {
  applySkillDelete,
  applySkillDirNameSync,
  applySkillMove,
  applySkillWrite,
  composeSkillContent,
} from '../content/skills-write.ts';
import type { ContentFilter } from '../content-filter.ts';
import type {
  DerivedDocumentIndexApiPort,
  DerivedDocumentIndexMutation,
} from '../derived-document-index.ts';
import type { StoreFailure } from '../document-durability-state.ts';
import { registerExternalSkill } from '../external-skill-registry.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import { describeFmEditError } from '../fm-edit-error.ts';
import { tracedCpSync, tracedMkdirSync, tracedRmSync } from '../fs-traced.ts';
import {
  resolveDefaultSkillHomeRel,
  scanGlobalInPlaceSkills,
  scanHostRootAliases,
  scanInPlaceSkills,
} from '../in-place-skills.ts';
import {
  readInstalledSkills,
  recordSkillInstall,
  removeSkillInstall,
} from '../installed-skills-marker.ts';
import type { PinoLogger } from '../logger.ts';
import { getLogger } from '../logger.ts';
import { isInternalBundleSkillName } from '../skill-bundles.ts';
import {
  clearSkillMoveRetention,
  readSkillMoveRetention,
  recordSkillMoveRetention,
  type SkillMoveRetentionRead,
  type SkillMoveRetentionRecord,
} from '../skill-move-retained-store.ts';
import { clearSkillPlacements } from '../skill-placements.ts';
import {
  projectSkill,
  readSkillBundledFiles,
  removeInPlaceSkillCopies,
  resolvedHosts,
  reverseProjectSkill,
  skillProjectionRoots,
  validateSkillForInstall,
} from '../skill-projection.ts';
import { rewriteSkillRefsAcrossScope, type SkillRefRewrite } from '../skill-ref-rename.ts';
import { mutateSkillsLock, readSkillsLockFile } from '../skills-lock-store.ts';
import { getMeter } from '../telemetry.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import type { ErrorExtensions, HttpErrorStatus } from './error-response.ts';
import { errorResponse } from './error-response.ts';
import { methodRouter } from './method-router.ts';
import { getRequestId } from './request-id.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsDocumentRouteDeps {
  validateSkillName: (
    name: string,
    res: ServerResponse,
    handler: string,
    extensions?: ErrorExtensions,
  ) => boolean;
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
  parseFrontmatterDoc: (raw: string) => { frontmatter: Record<string, unknown>; body: string };
  resolveSkillDirForRead: (
    scope: 'project' | 'global',
    name: string,
    host?: string,
  ) => string | null;
  skillRelPath: (abs: string, scope: 'project' | 'global') => string;
  derivedDocumentIndex: Pick<DerivedDocumentIndexApiPort, 'recordDirectMutations'> | undefined;
  contentFilter: ContentFilter | undefined;
  bumpSkillsCatalogGen: () => void;
  settleSkillCatalog: () => void;
  invalidateSkillCatalog: () => void;
  scheduleDeferredIgnoreRebuild: () => void;
  recordDerivedDocumentBestEffort: (
    documentName: string,
    markdown: string,
    reason: string,
  ) => Promise<void>;
  getPrincipal: (() => Principal | null) | undefined;
  rejectReservedBuiltinSkill: (name: string, res: ServerResponse, handler: string) => boolean;
  contentDir: string;
  attributeOkArtifactWrite: (
    actor: ReturnType<typeof extractActorIdentity>,
    artifactKey: string,
    subject: string,
    previousPaths?: Array<{ from: string; to: string }>,
  ) => void;
  scheduleOkArtifactFlush: (context: string) => void;
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
  commitOkArtifactWrite: (context: string) => Promise<unknown>;
  skillInstallBase: (scope: 'project' | 'global') => string | undefined;
  uninstallSkillFromHostDirs: (
    base: string,
    name: string,
    scope: 'project' | 'global',
    opts?: { purge?: { contentHash: string } },
  ) => Promise<boolean>;
  renameTrackedPathInGit: (
    projectDir: string | undefined,
    sourcePath: string,
    destinationPath: string,
  ) => Promise<boolean>;
  renamePathOnDisk: (sourcePath: string, destinationPath: string) => void;
  localSkillHash: (skillsRoot: string, name: string) => string | undefined;
  shadowHeadSha: (writerId?: string, verifyPathRel?: string) => Promise<string | undefined>;
  artifactWriterId: (actor: ReturnType<typeof extractActorIdentity>) => string | undefined;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  effectiveSkillRoot: (
    scope: 'project' | 'global',
    name: string,
    host?: string,
  ) => { root: string; dirRel: string; realDir: string | null };
}

export function createSkillsDocumentRoutes(deps: SkillsDocumentRouteDeps): ApiRouteGroup {
  const {
    validateSkillName,
    parseSkillScope,
    skillsHome,
    projectDir,
    resolveBuiltinSkillDir,
    parseFrontmatterDoc,
    resolveSkillDirForRead,
    skillRelPath,
    derivedDocumentIndex,
    contentFilter,
    bumpSkillsCatalogGen,
    settleSkillCatalog,
    invalidateSkillCatalog,
    scheduleDeferredIgnoreRebuild,
    recordDerivedDocumentBestEffort,
    getPrincipal,
    rejectReservedBuiltinSkill,
    contentDir,
    attributeOkArtifactWrite,
    scheduleOkArtifactFlush,
    signalChannel,
    checkSkillDocConflictGate,
    extractAgentIdentity,
    sessionManager,
    flushDiskAndDetectOutcome,
    respondStaleExternalWrite,
    respondPersistenceFailure,
    respondDiskDivergence,
    okArtifactKey,
    resolveSkillsRoot,
    extractActorIdentityFromQuery,
    captureAndCloseDocuments,
    log,
    commitOkArtifactWrite,
    skillInstallBase,
    uninstallSkillFromHostDirs,
    renameTrackedPathInGit,
    renamePathOnDisk,
    localSkillHash,
    shadowHeadSha,
    artifactWriterId,
    checkLocalOpSecurity,
    effectiveSkillRoot,
  } = deps;

  function projectionModeFor(scope: 'project' | 'global', name: string): 'symlink' | 'copy' {
    const base = scope === 'project' ? projectDir : skillsHome;
    if (!base) return 'symlink';
    try {
      const lock = readSkillsLockFile(join(base, ...SKILLS_LOCK_REL));
      return lock.skills[name] !== undefined ? 'copy' : 'symlink';
    } catch {
      return 'symlink';
    }
  }

  function skillLockPath(scope: 'project' | 'global'): string | null {
    const base = scope === 'project' ? projectDir : skillsHome;
    return base ? join(base, ...SKILLS_LOCK_REL) : null;
  }

  function rekeySkillLockEntry(
    scope: 'project' | 'global',
    fromName: string,
    toName: string,
    patch: Partial<SkillsLock['skills'][string]> = {},
  ): Promise<void> {
    const lockPath = skillLockPath(scope);
    if (!lockPath) return Promise.resolve();
    return mutateSkillsLock(lockPath, (lock) => {
      const entry = lock.skills[fromName];
      if (!entry) return lock;
      const skills = { ...lock.skills };
      delete skills[fromName];
      skills[toName] = { ...entry, ...patch };
      return { ...lock, skills };
    });
  }

  async function transferSkillLockEntry(
    fromScope: 'project' | 'global',
    toScope: 'project' | 'global',
    name: string,
    toName: string = name,
  ): Promise<boolean> {
    const fromPath = skillLockPath(fromScope);
    const toPath = skillLockPath(toScope);
    if (!fromPath || !toPath) return false;
    const entry = readSkillsLockFile(fromPath).skills[name];
    if (!entry) return false;

    const movedEntry = { ...entry };
    if (toScope === 'global') delete movedEntry.baselineRef;
    await mutateSkillsLock(toPath, (lock) => ({
      ...lock,
      skills: { ...lock.skills, [toName]: movedEntry },
    }));
    await mutateSkillsLock(fromPath, (lock) => {
      const remaining = { ...lock.skills };
      delete remaining[name];
      return { ...lock, skills: remaining };
    });
    return true;
  }

  function updateSkillLockEntry(
    scope: 'project' | 'global',
    name: string,
    patch: Partial<SkillsLock['skills'][string]>,
  ): Promise<void> {
    const lockPath = skillLockPath(scope);
    if (!lockPath) return Promise.resolve();
    return mutateSkillsLock(lockPath, (lock) => {
      const entry = lock.skills[name];
      if (!entry) return lock;
      return { ...lock, skills: { ...lock.skills, [name]: { ...entry, ...patch } } };
    });
  }

  function listProjectMdReferences(skillsRoot: string, name: string): string[] {
    const refsDir = resolve(skillsRoot, name, 'references');
    if (!existsSync(refsDir)) return [];
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(resolve(dir, entry.name), rel);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          out.push(`references/${rel}`);
        }
      }
    };
    walk(refsDir, '');
    return out;
  }

  async function reindexMovedProjectSkillDocs(
    skillsRoot: string,
    fromName: string,
    toName: string,
  ): Promise<void> {
    if (!derivedDocumentIndex) {
      getLogger('skill-move').warn(
        { fromName, toName },
        'no derived-document index available — skipping re-index of the moved skill (its old entries will be dropped with no replacement)',
      );
      return;
    }
    const derivedMutations: DerivedDocumentIndexMutation[] = [];
    const collectReindex = (oldDocName: string, newDocName: string, absFile: string): void => {
      let markdown: string;
      try {
        markdown = readFileSync(absFile, 'utf-8');
      } catch (err) {
        getLogger('skill-move').warn(
          { err, absFile, oldDocName, newDocName },
          'relocated skill file unreadable after move — dropping the old index entry with no replacement',
        );
        derivedMutations.push({ kind: 'delete', documentName: oldDocName });
        return;
      }
      derivedMutations.push({
        kind: 'rename',
        oldDocumentName: oldDocName,
        newDocumentName: newDocName,
        markdown,
      });
    };

    const rootRel = relative(contentDir, skillsRoot).split(sep).join('/');
    const docFor = (n: string, rel?: string): string =>
      `${rootRel}/${n}/${rel ? rel.replace(/\.mdx?$/i, '') : 'SKILL'}`;
    collectReindex(docFor(fromName), docFor(toName), resolve(skillsRoot, toName, 'SKILL.md'));
    for (const rel of listProjectMdReferences(skillsRoot, toName)) {
      collectReindex(docFor(fromName, rel), docFor(toName, rel), resolve(skillsRoot, toName, rel));
    }
    await derivedDocumentIndex.recordDirectMutations(derivedMutations);
  }

  async function reindexRewrittenSkillRefDocs(
    rewrites: readonly SkillRefRewrite[],
    movedName: string,
  ): Promise<void> {
    if (!derivedDocumentIndex || rewrites.length === 0) return;
    const mutations: DerivedDocumentIndexMutation[] = [];
    for (const rw of rewrites) {
      if (rw.dir.split('/').pop() === movedName) continue;
      mutations.push({
        kind: 'link-rewrite',
        documentName: `${rw.dir}/${rw.rel.replace(/\.mdx?$/i, '')}`,
        markdown: rw.markdown,
      });
    }
    if (mutations.length > 0) await derivedDocumentIndex.recordDirectMutations(mutations);
  }

  const handleSkillGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-get')) return;
        const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-get');
        if (scope === null) return;

        if (isInternalBundleSkillName(name)) {
          const base = scope === 'global' ? skillsHome : projectDir;
          const builtin = base
            ? resolveBuiltinSkillDir(base, name, scope, url.searchParams.get('host') ?? undefined)
            : null;
          if (builtin) {
            const { frontmatter, body } = parseFrontmatterDoc(
              await readFile(builtin.skillMd, 'utf-8'),
            );
            successResponse(
              res,
              200,
              SkillGetSuccessSchema,
              {
                skill: {
                  name,
                  scope,
                  path: builtin.relPath,
                  frontmatter: {
                    name: typeof frontmatter.name === 'string' ? frontmatter.name : name,
                    description:
                      typeof frontmatter.description === 'string' ? frontmatter.description : '',
                  },
                  body,
                  files: readSkillBundledFiles(builtin.dir),
                  managed: true,
                },
              },
              { handler: 'skill-get' },
            );
            return;
          }
        }
        const host = url.searchParams.get('host') ?? undefined;
        const skillDirAbs = resolveSkillDirForRead(scope, name, host);
        if (skillDirAbs === null) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-get',
            detail:
              host === undefined
                ? `Skill "${name}" not found in ${scope} scope.`
                : `No skill "${name}" (${scope}) in ${host}.`,
          });
          return;
        }
        const skillMd = resolve(skillDirAbs, 'SKILL.md');
        const { frontmatter, body } = parseFrontmatterDoc(await readFile(skillMd, 'utf-8'));
        successResponse(
          res,
          200,
          SkillGetSuccessSchema,
          {
            skill: {
              name,
              scope,
              path: skillRelPath(skillMd, scope),
              frontmatter: {
                name: typeof frontmatter.name === 'string' ? frontmatter.name : name,
                description:
                  typeof frontmatter.description === 'string' ? frontmatter.description : '',
              },
              body,
              files: readSkillBundledFiles(skillDirAbs),
            },
          },
          { handler: 'skill-get' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read skill.', {
          handler: 'skill-get',
          cause: e,
        });
      }
    },
    { handler: 'skill-get', method: 'GET', skipBodyParse: true },
  );

  async function seedSkillDerivedViews(docName: string, markdown: string): Promise<void> {
    if (!derivedDocumentIndex || isLinkIndexExcludedDoc(docName)) return;
    if (contentFilter) {
      bumpSkillsCatalogGen();
      contentFilter.refreshInPlaceSkillDirs();
      scheduleDeferredIgnoreRebuild();
    }
    void recordDerivedDocumentBestEffort(docName, markdown, 'skill-put');
  }

  const handleSkillPut = withValidation(
    SkillPutRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-put',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-put')) return;
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-put')) return;

        const composed = composeSkillContent({
          name: body.name,
          body: typeof body.body === 'string' ? body.body : '',
          frontmatter: { name: body.frontmatter.name, description: body.frontmatter.description },
        });
        if (!composed.ok) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid skill request.', {
            handler: 'skill-put',
            detail: composed.error.code,
            cause: new Error(composed.error.message),
          });
          return;
        }

        const putBase = body.scope === 'project' ? contentDir : skillsHome;
        const existingAbs = resolveSkillDirForRead(body.scope, body.name);
        if (existingAbs === null) {
          const homeRel = resolveDefaultSkillHomeRel(putBase, body.scope);
          if (homeRel === null) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'No agent skill host is available.',
              { handler: 'skill-put', detail: 'NO_USABLE_SKILL_HOME' },
            );
            return;
          }
          const wr = applySkillWrite({
            skillsRoot: resolve(putBase, homeRel),
            name: body.name,
            body: typeof body.body === 'string' ? body.body : '',
            frontmatter: {
              name: body.frontmatter.name,
              description: body.frontmatter.description,
            },
          });
          if (!wr.ok) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid skill request.', {
              handler: 'skill-put',
              detail: wr.error.code,
              cause: new Error(wr.error.message),
            });
            return;
          }
          if (body.scope === 'project') {
            attributeOkArtifactWrite(
              actor,
              `${homeRel}/${body.name}/SKILL`,
              `skill-create: ${homeRel}/${body.name}/SKILL.md`,
            );
            scheduleOkArtifactFlush('skill-put');
          }
          await seedSkillDerivedViews(
            body.scope === 'project'
              ? `${homeRel}/${body.name}/SKILL`
              : skillLiveDocName('global', body.name),
            composed.content,
          );
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillPutSuccessSchema,
            {
              path: `${homeRel}/${body.name}/SKILL.md`,
              created: true,
              warnings: wr.warnings,
              warningCodes: wr.warningCodes,
            },
            { handler: 'skill-put' },
          );
          return;
        }
        const created = false;
        const dirRel = relative(putBase, existingAbs).split(sep).join('/');
        const relPath = `${dirRel}/SKILL.md`;
        const docName =
          body.scope === 'project' ? `${dirRel}/SKILL` : skillLiveDocName(body.scope, body.name);

        if (checkSkillDocConflictGate(docName, 'skill-put', res)) return;

        /**
         * CRDT write (precedent #24 / #38): the full SKILL.md goes through the doc's
         * `Y.Text('source')` via the sanctioned paired-write primitive under the per-session
         * frozen origin.
         */
        const { agentId, agentName, colorSeed, clientName } = extractAgentIdentity(
          body as unknown as Record<string, unknown>,
        );
        const session = await sessionManager.getSession(docName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        session.dc.document.transact(() => {
          composeAndWriteRawBody(session.dc.document, composed.content, 'agent');
        }, session.origin);

        const flushOutcome = await flushDiskAndDetectOutcome(docName);
        if (flushOutcome?.kind === 'failure') {
          respondPersistenceFailure(res, flushOutcome.failure, 'skill-put');
          return;
        }
        if (flushOutcome?.kind === 'divergence') {
          respondDiskDivergence(res, 'skill-put');
          return;
        }
        if (flushOutcome?.kind === 'stale-external-write') {
          respondStaleExternalWrite(res, 'skill-put', docName);
          return;
        }

        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.name),
            `${created ? 'skill-create' : 'skill-edit'}: ${relPath}`,
          );
          scheduleOkArtifactFlush('skill-put');
        }
        await seedSkillDerivedViews(docName, composed.content);
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillPutSuccessSchema,
          {
            path: relPath,
            created,
            warnings: composed.warnings,
            warningCodes: composed.warningCodes,
          },
          { handler: 'skill-put' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to write skill.', {
          handler: 'skill-put',
          cause: e,
        });
      }
    },
    { handler: 'skill-put', method: 'PUT' },
  );

  function sweepSkillOccurrences(scope: 'project' | 'global', name: string): SkillHostId[] {
    const base = scope === 'project' ? contentDir : skillsHome;
    const inPlace = (
      scope === 'project' ? scanInPlaceSkills(contentDir) : scanGlobalInPlaceSkills(skillsHome)
    ).find((sk) => sk.name === name);
    if (!inPlace) return [];
    return removeInPlaceSkillCopies({
      canonicalAbs: resolve(base, inPlace.dir),
      canonicalHash: inPlace.contentHash,
      name,
      cwd: base,
      targets: inPlace.hosts.filter((h): h is SkillHostId => isSkillInstallTarget(h)),
      roots: skillProjectionRoots(scope),
    });
  }

  const handleSkillDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateSkillName(name, res, 'skill-delete')) return;
        const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-delete');
        if (scope === null) return;
        const host = url.searchParams.get('host') ?? undefined;
        const { root: skillsRoot, dirRel, realDir } = effectiveSkillRoot(scope, name, host);
        const retentionBase = host === undefined ? skillInstallBase(scope) : undefined;
        const priorRetention =
          retentionBase !== undefined
            ? readSkillMoveRetention(retentionBase, scope, name)
            : ({ state: 'none' } as const);
        const preDeleteHash =
          priorRetention.state === 'record' &&
          priorRetention.record.sourceState !== 'intact' &&
          priorRetention.record.retainedContentHash !== '' &&
          realDir !== null
            ? readSkillContentHash(realDir)
            : undefined;
        if (host !== undefined && realDir === null) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-delete',
            detail: `No skill "${name}" (${scope}) in ${host}.`,
          });
          return;
        }

        const actor = extractActorIdentityFromQuery(url, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-delete',
          });
          return;
        }

        await captureAndCloseDocuments(
          scope === 'project'
            ? [...new Set([`${dirRel}/SKILL`, skillLiveDocName(scope, name)])]
            : [skillLiveDocName(scope, name, host)],
          'deleted-upstream',
        );

        if (host === undefined) sweepSkillOccurrences(scope, name);
        const result = applySkillDelete({ skillsRoot, name });
        const storeRoot = resolveSkillsRoot(scope);
        if (
          host === undefined &&
          result.ok &&
          storeRoot !== skillsRoot &&
          existsSync(resolve(storeRoot, name, 'SKILL.md'))
        ) {
          const storeSweep = applySkillDelete({ skillsRoot: storeRoot, name });
          if (!storeSweep.ok) {
            log.warn(
              { name, scope, detail: storeSweep.error.code },
              '[skill-delete] legacy store resident survived the delete',
            );
          }
        }
        if (!result.ok) {
          const status = result.error.code === 'UNLINK_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            status === 500 ? 'Failed to delete skill.' : 'Invalid skill request.',
            {
              handler: 'skill-delete',
              detail: result.error.code,
              cause: new Error(result.error.message),
            },
          );
          return;
        }
        if (result.existed) {
          if (scope === 'project') {
            attributeOkArtifactWrite(actor, dirRel, `skill-delete: ${dirRel}`);
            bumpSkillsCatalogGen();
            void commitOkArtifactWrite('skill-delete');
          }
          signalChannel?.('files');
        }
        const uninstallBase = skillInstallBase(scope);
        const deleteWarnings: string[] = [];
        if (host === undefined && uninstallBase) {
          try {
            await uninstallSkillFromHostDirs(uninstallBase, name, scope);
          } catch (err) {
            log.error(
              { requestId: getRequestId(req), handler: 'skill-delete', name, scope, err },
              '[skill-delete] skill content removed, but install bookkeeping could not be updated',
            );
            deleteWarnings.push(
              `The skill was deleted, but this server could not update its install records (${thrownMessage(err)}). A stale entry may remain until that file is repaired.`,
            );
          }
        }
        if (host === undefined) {
          if (priorRetention.state === 'record' && priorRetention.record.sourceState !== 'intact') {
            const record = priorRetention.record;
            const verified =
              record.retainedContentHash !== '' &&
              preDeleteHash?.ok === true &&
              record.retainedContentHash === preDeleteHash.hash;
            const unverifiable =
              preDeleteHash !== undefined && !preDeleteHash.ok && preDeleteHash.kind !== 'absent';
            const origin = record.from !== '' ? `a move of "${record.from}"` : 'an earlier move';
            const when = record.retainedAt ? ` on ${record.retainedAt}` : '';
            if (verified || unverifiable) {
              log.error(
                {
                  requestId: getRequestId(req),
                  handler: 'skill-delete',
                  name,
                  scope,
                  from: record.from,
                  retainedAt: record.retainedAt,
                  sourceState: record.sourceState,
                  verified,
                  ...(unverifiable && preDeleteHash.kind === 'read-error'
                    ? { err: preDeleteHash.cause }
                    : {}),
                },
                verified
                  ? '[skill-delete] deleted a copy this server retained when an earlier move failed to remove its source; the source was never verified unchanged, so files that only existed here may now be gone'
                  : '[skill-delete] deleted a directory carrying an unverified retained-copy record; this server could not read that directory before removing it, so it could not confirm whether it was the copy an earlier failed move retained',
              );
            }
            if (verified) {
              deleteWarnings.push(
                `A recovery copy was deleted: ${origin} failed to remove its source${when}, and this server kept this copy in case it held files that failed removal had already deleted. That source was never verified unchanged. Check the other location before relying on this deletion.`,
              );
            } else if (unverifiable) {
              deleteWarnings.push(
                `A directory this server could not read was deleted: ${origin} failed to remove its source${when}, and this server has a record of keeping a copy under this name in case it held files that failed removal had already deleted. It could not read the directory before removing it, so it could not confirm whether that was the copy it kept. Check the other location before assuming nothing was lost.`,
              );
            }
          }
          await clearSkillMoveRetentionQuietly(retentionBase, scope, name, {
            requestId: getRequestId(req),
            handler: 'skill-delete',
          });
        }
        successResponse(
          res,
          200,
          SkillDeleteSuccessSchema,
          {
            existed: result.existed,
            path: result.path,
            ...(deleteWarnings.length > 0 ? { warnings: deleteWarnings } : {}),
          },
          { handler: 'skill-delete' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to delete skill.', {
          handler: 'skill-delete',
          cause: e,
        });
      }
    },
    { handler: 'skill-delete', method: 'DELETE', skipBodyParse: true },
  );

  const handleSkillMove = withValidation(
    SkillMoveRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-move',
          });
          return;
        }
        if (!validateSkillName(body.fromName, res, 'skill-move')) return;
        if (!validateSkillName(body.toName, res, 'skill-move')) return;
        if (rejectReservedBuiltinSkill(body.toName, res, 'skill-move')) return;
        const { root: skillsRoot, dirRel: fromDirRel } = effectiveSkillRoot(
          body.scope,
          body.fromName,
        );
        const occupiedToDir = resolveSkillDirForRead(body.scope, body.toName);
        if (occupiedToDir !== null) {
          const retentionBase = skillInstallBase(body.scope);
          const ledger =
            retentionBase !== undefined
              ? readSkillMoveRetention(retentionBase, body.scope, body.toName)
              : ({ state: 'none' } as const);
          const occupant = readSkillContentHash(occupiedToDir);
          const { verdict, detail } = describeRetainedOccupant(
            effectiveSkillRoot(body.scope, body.toName).dirRel,
            ledger,
            occupant,
          );
          if (ledger.state === 'record' && verdict.kind === 'plain-collision') {
            await clearSkillMoveRetentionQuietly(retentionBase, body.scope, body.toName, {
              requestId: getRequestId(_req),
              handler: 'skill-move',
            });
          }
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            `A skill named "${body.toName}" already exists.`,
            {
              handler: 'skill-move',
              detail: detail ?? 'Delete or rename it first; this move will not overwrite it.',
              ...(!occupant.ok && occupant.kind === 'read-error'
                ? { cause: occupant.cause }
                : ledger.state === 'unreadable' && ledger.cause !== undefined
                  ? { cause: ledger.cause }
                  : {}),
            },
          );
          return;
        }

        const moveBase = skillInstallBase(body.scope);
        const priorInstall = moveBase
          ? readInstalledSkills(moveBase).skills[body.fromName]
          : undefined;
        const fromScanBase = body.scope === 'project' ? contentDir : skillsHome;
        const renameScanEntry = (
          body.scope === 'project'
            ? scanInPlaceSkills(contentDir)
            : scanGlobalInPlaceSkills(skillsHome)
        ).find((sk) => sk.name === body.fromName);
        const renameCanonicalRootRel = renameScanEntry ? dirname(renameScanEntry.dir) : null;
        const renameAliasAudience =
          renameCanonicalRootRel !== null
            ? Object.entries(scanHostRootAliases(fromScanBase, body.scope))
                .filter(([, target]) => target === renameCanonicalRootRel)
                .map(([editor]) => editor)
            : [];
        const priorHosts = [
          ...new Set([
            ...(priorInstall ? resolvedHosts(priorInstall.hosts, body.scope) : []),
            ...(renameScanEntry ? resolvedHosts(renameScanEntry.hosts, body.scope) : []),
            ...resolvedHosts(renameAliasAudience, body.scope),
          ]),
        ];

        await captureAndCloseDocuments(
          body.scope === 'project'
            ? [...new Set([`${fromDirRel}/SKILL`, skillLiveDocName(body.scope, body.fromName)])]
            : [skillLiveDocName(body.scope, body.fromName)],
          'renamed',
        );

        sweepSkillOccurrences(body.scope, body.fromName);
        const result = await applySkillMove({
          skillsRoot,
          fromName: body.fromName,
          toName: body.toName,
          relocate: async (fromAbs, toAbs) => {
            const movedWithGit = await renameTrackedPathInGit(projectDir, fromAbs, toAbs);
            if (!movedWithGit) renamePathOnDisk(fromAbs, toAbs);
            return movedWithGit;
          },
        });
        if (!result.ok) {
          if (result.error.code === 'SKILL_NOT_FOUND') {
            errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
              handler: 'skill-move',
              detail: result.error.message,
            });
            return;
          }
          if (result.error.code === 'SKILL_EXISTS') {
            errorResponse(res, 409, 'urn:ok:error:doc-already-exists', result.error.message, {
              handler: 'skill-move',
              detail: result.error.code,
            });
            return;
          }
          const status = result.error.code === 'MOVE_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            status === 500 ? 'Failed to move skill.' : 'Invalid skill move request.',
            {
              handler: 'skill-move',
              detail: result.error.code,
              cause: new Error(result.error.message),
            },
          );
          return;
        }

        let contentEditError: { code: string; message: string } | null = null;
        const movedSkillMd = resolve(skillsRoot, body.toName, 'SKILL.md');
        let parsedBody = '';
        let parsedDescription = '';
        try {
          const parsed = parseFrontmatterDoc(readFileSync(movedSkillMd, 'utf-8'));
          parsedBody = parsed.body;
          if (typeof parsed.frontmatter.description === 'string') {
            parsedDescription = parsed.frontmatter.description;
          }
        } catch {}
        const writeBody = typeof body.body === 'string' ? body.body : parsedBody;
        const writeDescription =
          body.frontmatter !== undefined ? body.frontmatter.description : parsedDescription;
        const rewrite = applySkillWrite({
          skillsRoot,
          name: body.toName,
          body: writeBody,
          frontmatter: { name: body.toName, description: writeDescription },
        });
        if (!rewrite.ok) contentEditError = rewrite.error;

        let refRewrites: SkillRefRewrite[] = [];
        if (!contentEditError) {
          try {
            refRewrites = rewriteSkillRefsAcrossScope({
              base: body.scope === 'project' ? contentDir : skillsHome,
              scope: body.scope,
              fromName: body.fromName,
              toName: body.toName,
            });
          } catch (err) {
            getLogger('skill-move').warn(
              { err, fromName: body.fromName, toName: body.toName },
              'skill-ref rewrite failed — rename succeeded, refs to the old name are left as authored',
            );
          }
        }

        if (body.scope === 'project' && !contentEditError) {
          invalidateSkillCatalog();
          void reindexMovedProjectSkillDocs(skillsRoot, body.fromName, body.toName)
            .then(() => reindexRewrittenSkillRefDocs(refRewrites, body.toName))
            .catch(() => {});
        }

        const fromKeyPath = skillRelPath(resolve(skillsRoot, body.fromName), body.scope);
        const toKeyPath = skillRelPath(resolve(skillsRoot, body.toName), body.scope);
        const renamedLocalHash = localSkillHash(skillsRoot, body.toName);
        const moveWarnings: string[] = [];
        const warnBookkeeping = (err: unknown, records: string): void => {
          log.error(
            { err, fromName: body.fromName, toName: body.toName, scope: body.scope },
            'skill renamed, but its bookkeeping could not be updated',
          );
          moveWarnings.push(
            `The skill was renamed to "${body.toName}", but this server could not update its ${records} (${thrownMessage(err)}). A stale entry may remain until that file is repaired.`,
          );
        };
        try {
          await rekeySkillLockEntry(body.scope, body.fromName, body.toName, {
            localHash: renamedLocalHash,
          });
        } catch (err) {
          warnBookkeeping(err, 'import records');
        }
        if (body.scope === 'project') {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.toName),
            `skill-rename: ${fromKeyPath} -> ${toKeyPath}`,
            [{ from: fromKeyPath, to: toKeyPath }],
          );
          void (async () => {
            try {
              await commitOkArtifactWrite('skill-move');
              const baselineRef = await shadowHeadSha(artifactWriterId(actor), toKeyPath);
              if (baselineRef !== undefined) {
                await updateSkillLockEntry('project', body.toName, { baselineRef });
              }
            } catch (err) {
              getLogger('skill-move').warn(
                { err, toName: body.toName },
                'deferred shadow flush / revert-baseline failed — Revert stays unarmed until the next flush',
              );
            }
          })();
        }

        if (moveBase) {
          try {
            await removeSkillInstall(moveBase, body.fromName);
          } catch (err) {
            warnBookkeeping(err, 'install records');
          }
          reverseProjectSkill(
            body.fromName,
            moveBase,
            priorHosts,
            skillProjectionRoots(body.scope),
          );
          const movedDir = resolve(skillsRoot, body.toName);
          if (priorHosts.length > 0) {
            const newHosts = projectSkill(
              movedDir,
              body.toName,
              moveBase,
              priorHosts,
              projectionModeFor(body.scope, body.toName),
              skillProjectionRoots(body.scope),
            );
            try {
              await recordSkillInstall(moveBase, body.toName, {
                ...priorInstall,
                scope: body.scope,
                hosts: newHosts,
                scripts:
                  priorInstall?.scripts ??
                  validateSkillForInstall(movedDir, body.toName).hasScripts,
                installedAt: priorInstall?.installedAt ?? new Date().toISOString(),
              });
            } catch (err) {
              warnBookkeeping(err, 'install records');
            }
          }
        }
        signalChannel?.('files');

        if (contentEditError) {
          const isServerError = contentEditError.code === 'WRITE_ERROR';
          errorResponse(
            res,
            isServerError ? 500 : 400,
            isServerError ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            `Skill renamed to "${body.toName}", but updating its SKILL.md failed — its name frontmatter may not match the new directory.`,
            {
              handler: 'skill-move',
              detail: contentEditError.code,
              cause: new Error(contentEditError.message),
            },
          );
          return;
        }
        successResponse(
          res,
          200,
          SkillMoveSuccessSchema,
          {
            from: fromKeyPath,
            to: toKeyPath,
            committed: result.committed,
            ...(moveWarnings.length > 0 ? { warnings: moveWarnings } : {}),
          },
          { handler: 'skill-move' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to move skill.', {
          handler: 'skill-move',
          cause: e,
        });
      }
    },
    { handler: 'skill-move', method: 'POST' },
  );

  const handleSkillEditExternal = withValidation(
    SkillEditExternalRequestSchema,
    async (_req, res, body) => {
      const { name, home } = body;
      if (!validateSkillName(name, res, 'skill-edit-external')) return;
      let realDir: string;
      try {
        realDir = realpathSync(home);
      } catch {
        errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill directory not found.', {
          handler: 'skill-edit-external',
          detail: 'HOME_NOT_FOUND',
        });
        return;
      }
      if (!statSync(realDir).isDirectory() || !existsSync(resolve(realDir, 'SKILL.md'))) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Not a skill directory (no SKILL.md).',
          { handler: 'skill-edit-external' },
        );
        return;
      }
      registerExternalSkill(name, realDir);
      successResponse(
        res,
        200,
        SkillEditExternalSuccessSchema,
        { docName: externalSkillLiveDocName(name) },
        { handler: 'skill-edit-external' },
      );
    },
    {
      handler: 'skill-edit-external',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'skill-edit-external' }),
    },
  );

  type SkillOccupantHash =
    | { ok: true; hash: string }
    | { ok: false; kind: 'no-manifest'; reason: string }
    | { ok: false; kind: 'absent'; reason: string }
    | { ok: false; kind: 'read-error'; reason: string; cause: unknown };

  type RetainedOccupantVerdict =
    | { kind: 'retained'; record: SkillMoveRetentionRecord }
    | { kind: 'ledger-unreadable' }
    | { kind: 'occupant-unverifiable' }
    | { kind: 'retained-slot-unverifiable' }
    | { kind: 'occupant-unreadable' }
    | { kind: 'stray-occupant' }
    | { kind: 'plain-collision' };

  const RETENTION_LEDGER_CODE_BY_VERDICT: Record<
    RetainedOccupantVerdict['kind'],
    SkillRetentionLedgerCode | undefined
  > = {
    retained: undefined,
    'plain-collision': undefined,
    'stray-occupant': undefined,
    'ledger-unreadable': 'unreadable',
    'occupant-unverifiable': 'occupant-unverifiable',
    'retained-slot-unverifiable': 'occupant-unverifiable',
    'occupant-unreadable': 'occupant-unverifiable',
  };

  let _skillMoveScopeOutcomeCounter: ReturnType<
    ReturnType<typeof getMeter>['createCounter']
  > | null = null;
  function skillMoveScopeOutcomeCounter(): ReturnType<
    ReturnType<typeof getMeter>['createCounter']
  > {
    _skillMoveScopeOutcomeCounter ||= getMeter().createCounter('ok.skill_move_scope.outcome', {
      description:
        'Count of cross-scope skill-move handler invocations by terminal outcome, one per invocation. Bounded labels: move_state ∈ SKILL_MOVE_STATE_CODES plus `success`; source_state ∈ SKILL_SOURCE_STATE_CODES plus `none`; retention_ledger ∈ SKILL_RETENTION_LEDGER_CODES plus `none`. Skill names, filesystem paths, droppedLocations, problem detail text, error messages and request IDs are never labels. Transport-level and schema-level rejections happen outside the handler and stay covered by ok.api.error.',
    });
    return _skillMoveScopeOutcomeCounter;
  }

  function recordMoveScopeOutcome(
    moveState: SkillMoveStateCode | 'success',
    sourceState?: SkillSourceStateCode,
    retentionLedger?: SkillRetentionLedgerCode,
    context?: {
      requestId?: string;
      status?: number;
      instance?: string;
      droppedLocationCount?: number;
      logLevel?: 'debug' | 'warn' | 'error';
      message?: string;
    },
  ): void {
    skillMoveScopeOutcomeCounter().add(1, {
      move_state: moveState,
      source_state: sourceState ?? 'none',
      retention_ledger: retentionLedger ?? 'none',
    });
    getLogger('skill-move-scope')[
      context?.logLevel ?? ((context?.status ?? 200) >= 500 ? 'error' : 'warn')
    ](
      {
        event: 'skill-move-scope.outcome',
        ...(context?.instance !== undefined ? { instance: context.instance } : {}),
        ...(context?.requestId !== undefined ? { requestId: context.requestId } : {}),
        handler: 'skill-move-scope',
        ...(context?.status !== undefined ? { status: context.status } : {}),
        moveState,
        sourceState: sourceState ?? null,
        retentionLedger: retentionLedger ?? null,
        droppedLocationCount: context?.droppedLocationCount ?? 0,
      },
      context?.message ?? 'cross-scope skill move did not complete',
    );
  }

  function readSkillContentHash(dir: string): SkillOccupantHash {
    try {
      const parsed = parseSkillDir(dir);
      if (parsed !== null) return { ok: true, hash: parsed.contentHash };
      return existsSync(dir)
        ? { ok: false, kind: 'no-manifest', reason: 'it has no readable SKILL.md' }
        : { ok: false, kind: 'absent', reason: 'it does not exist' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return {
        ok: false,
        kind: 'read-error',
        reason: code ? `it could not be read (${code})` : 'it could not be read',
        cause: err,
      };
    }
  }

  function describeRetainedOccupant(
    toDirRel: string,
    ledger: SkillMoveRetentionRead,
    occupant: SkillOccupantHash,
  ): { verdict: RetainedOccupantVerdict; detail: string | undefined } {
    const record = ledger.state === 'record' ? ledger.record : null;
    const retained =
      record !== null &&
      record.retainedContentHash !== '' &&
      occupant.ok &&
      record.retainedContentHash === occupant.hash
        ? record
        : null;
    const origin =
      record !== null && record.from !== '' ? `a move of "${record.from}"` : 'an earlier move';
    const when = record?.retainedAt ? ` on ${record.retainedAt}` : '';
    if (retained?.sourceState === 'intact') {
      return {
        verdict: { kind: 'retained', record: retained },
        detail: `${toDirRel} is a copy this server retained${when} when ${origin} failed to remove the source. That source was verified unchanged, so this copy is a redundant duplicate whose install records never transferred: remove it, then retry. This call wrote nothing.`,
      };
    }
    if (retained !== null) {
      return {
        verdict: { kind: 'retained', record: retained },
        detail: `${toDirRel} is a copy this server retained${when} when ${origin} failed to remove the source. Do NOT delete it before reconciling it against the source: it may hold the only copy of files that failed removal already deleted. Reconcile the two locations, then remove whichever copy is redundant. This call wrote nothing.`,
      };
    }
    if (ledger.state === 'unreadable') {
      return {
        verdict: { kind: 'ledger-unreadable' },
        detail: `A directory already exists at ${toDirRel}, and this server could not read its retained-destination ledger (${ledger.reason}), so it cannot tell whether that directory is a copy an earlier failed move retained. Do NOT delete it before comparing it against the source. This call wrote nothing.`,
      };
    }
    if (record !== null && !occupant.ok && occupant.kind === 'no-manifest') {
      return {
        verdict: { kind: 'retained-slot-unverifiable' },
        detail: `A directory already exists at ${toDirRel} with no readable SKILL.md, and this server has a record of retaining a copy under this name${when} when ${origin} failed to remove the source. Nothing in it could be matched against that record, so verify it against the source before assuming it is that copy.`,
      };
    }
    if (record !== null && !occupant.ok) {
      return {
        verdict: { kind: 'occupant-unverifiable' },
        detail: `A directory already exists at ${toDirRel}, and this server has a record of retaining a copy under that name${when} from ${origin}, but it could not read that directory to confirm the copy is the one it retained (${occupant.reason}). Do NOT delete it before comparing it against the source. This call wrote nothing.`,
      };
    }
    if (!occupant.ok && occupant.kind === 'read-error') {
      return {
        verdict: { kind: 'occupant-unreadable' },
        detail: `A directory exists at ${toDirRel} and this server could not read it to determine whether it is a skill (${occupant.reason}). Verify it against the source before removing it; this move will not overwrite it. This call wrote nothing.`,
      };
    }
    if (!occupant.ok && occupant.kind === 'no-manifest') {
      return {
        verdict: { kind: 'stray-occupant' },
        detail: `A directory exists at ${toDirRel} with no readable SKILL.md. Verify it against the source before removing it; this move will not overwrite it. This call wrote nothing.`,
      };
    }
    return { verdict: { kind: 'plain-collision' }, detail: undefined };
  }

  async function clearSkillMoveRetentionQuietly(
    base: string | undefined,
    scope: 'project' | 'global',
    name: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (base === undefined) return;
    try {
      await clearSkillMoveRetention(base, scope, name);
    } catch (err) {
      getLogger('skill-move-scope').warn(
        {
          event: 'skill-move-scope.retention-clear-failed',
          scope,
          name,
          ...context,
          err,
        },
        'could not clear a retained-destination record — a later collision on this name may still report it as retained',
      );
    }
  }

  type MoveScopeFailureOutcome =
    | {
        moveState: 'destination-retained' | 'destination-retained-blocking';
        sourceState: SkillSourceStateCode;
        retentionLedger?: never;
      }
    | {
        moveState: 'nothing-written';
        sourceState?: never;
        retentionLedger?: SkillRetentionLedgerCode;
      }
    | {
        moveState:
          | 'destination-removed'
          | 'destination-stray'
          | 'destination-unreadable'
          | 'partially-applied';
        sourceState?: never;
        retentionLedger?: never;
      };

  const thrownMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  const MOVE_SCOPE_TOUCHED_DISK: Record<SkillMoveStateCode, boolean> = {
    'nothing-written': false,
    'destination-removed': true,
    'destination-stray': true,
    'destination-retained': true,
    'destination-retained-blocking': false,
    'destination-unreadable': true,
    'partially-applied': true,
  };

  const handleSkillMoveScope = withValidation(
    SkillMoveScopeRequestSchema,
    async (_req, res, body) => {
      let actor: ReturnType<typeof extractActorIdentity>;
      try {
        actor = extractActorIdentity(body as unknown as Record<string, unknown>, getPrincipal);
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to move skill across scopes.',
          {
            handler: 'skill-move-scope',
            detail: 'Could not resolve who is making the request. Nothing was written.',
            extensions: { moveState: 'nothing-written', droppedLocations: [] },
            cause: e,
          },
        );
        recordMoveScopeOutcome('nothing-written', undefined, undefined, {
          requestId: getRequestId(_req),
          status: 400,
        });
        return;
      }
      const settle = settleSkillCatalog;
      let wrote = false;
      let mutated = false;
      let droppedLocations: string[] = [];
      const failMove = (
        status: HttpErrorStatus,
        type: ProblemType,
        title: string,
        options: MoveScopeFailureOutcome & {
          detail?: string;
          cause?: unknown;
          logLevel?: 'debug' | 'warn' | 'error';
        },
      ): void => {
        const instance = `urn:uuid:${randomUUID()}`;
        recordMoveScopeOutcome(options.moveState, options.sourceState, options.retentionLedger, {
          instance,
          requestId: getRequestId(_req),
          status,
          droppedLocationCount: droppedLocations.length,
          ...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
        });
        if (mutated || MOVE_SCOPE_TOUCHED_DISK[options.moveState]) settle();
        errorResponse(res, status, type, title, {
          instance,
          handler: 'skill-move-scope',
          ...(options.detail !== undefined ? { detail: options.detail } : {}),
          extensions: {
            moveState: options.moveState,
            droppedLocations,
            ...(options.sourceState !== undefined ? { sourceState: options.sourceState } : {}),
            ...(options.retentionLedger !== undefined
              ? { retentionLedger: options.retentionLedger }
              : {}),
          },
          ...(options.cause !== undefined ? { cause: options.cause } : {}),
          ...(options.logLevel ? { logLevel: options.logLevel } : {}),
        });
      };
      try {
        if (actor.kind === 'invalid-summary') {
          failMove(400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            moveState: 'nothing-written',
          });
          return;
        }
        const { name, fromScope, toScope } = body;
        const toName = body.toName ?? name;
        const nameRefusal: ErrorExtensions = {
          moveState: 'nothing-written',
          droppedLocations: [],
        } satisfies { moveState: SkillMoveStateCode; droppedLocations: string[] };
        if (!validateSkillName(name, res, 'skill-move-scope', nameRefusal)) {
          recordMoveScopeOutcome('nothing-written', undefined, undefined, {
            requestId: getRequestId(_req),
            status: 400,
          });
          return;
        }
        if (!validateSkillName(toName, res, 'skill-move-scope', nameRefusal)) {
          recordMoveScopeOutcome('nothing-written', undefined, undefined, {
            requestId: getRequestId(_req),
            status: 400,
          });
          return;
        }
        if (isInternalBundleSkillName(name)) {
          failMove(
            400,
            'urn:ok:error:invalid-request',
            `"${name}" is a built-in skill and always lives at its own scope.`,
            { moveState: 'nothing-written', detail: 'BUILTIN_SCOPE_FIXED' },
          );
          return;
        }
        if (isInternalBundleSkillName(toName)) {
          failMove(
            400,
            'urn:ok:error:invalid-request',
            `"${toName}" is a built-in skill name and cannot be used as a destination name.`,
            { moveState: 'nothing-written', detail: 'BUILTIN_SCOPE_FIXED' },
          );
          return;
        }
        if (fromScope === toScope) {
          failMove(
            400,
            'urn:ok:error:invalid-request',
            'Source and destination scope are the same.',
            { moveState: 'nothing-written' },
          );
          return;
        }
        if (toScope === 'project' && !projectDir) {
          failMove(
            400,
            'urn:ok:error:invalid-request',
            'Cannot move to project scope — no project root is resolved for this server.',
            { moveState: 'nothing-written', detail: 'NO_PROJECT_ROOT' },
          );
          return;
        }

        const { root: fromRoot, dirRel: fromDirRel, realDir } = effectiveSkillRoot(fromScope, name);
        const fromDir = resolve(fromRoot, name);
        const fromContentDir = (() => {
          try {
            return realpathSync(fromDir);
          } catch {
            return fromDir;
          }
        })();
        const toBase2 = toScope === 'project' ? contentDir : skillsHome;
        const toHomeRel = resolveDefaultSkillHomeRel(toBase2, toScope);
        if (toHomeRel === null) {
          failMove(
            400,
            'urn:ok:error:invalid-request',
            'No agent skill host is available in the destination scope.',
            { moveState: 'nothing-written', detail: 'NO_USABLE_SKILL_HOME' },
          );
          return;
        }
        const toRoot = resolve(toBase2, toHomeRel);
        const toDir = resolve(toRoot, toName);
        const toDirRel = relative(toBase2, toDir).split(sep).join('/');
        if (realDir === null || !existsSync(fromDir)) {
          failMove(404, 'urn:ok:error:not-found', 'Skill not found.', {
            moveState: 'nothing-written',
            detail: `Skill "${name}" not found in ${fromScope} scope.`,
          });
          return;
        }
        if (
          resolve(realDir) === resolve(toDir) ||
          (existsSync(toDir) && realpathSync(realDir) === realpathSync(toDir))
        ) {
          failMove(
            409,
            'urn:ok:error:doc-already-exists',
            'The source and destination resolve to the same skill directory.',
            { moveState: 'nothing-written', detail: 'SAME_STORAGE' },
          );
          return;
        }
        if (resolveSkillDirForRead(toScope, toName) !== null || existsSync(toDir)) {
          const retentionBase = skillInstallBase(toScope);
          const ledger =
            retentionBase !== undefined && existsSync(toDir)
              ? readSkillMoveRetention(retentionBase, toScope, toName)
              : ({ state: 'none' } as const);
          const occupant = readSkillContentHash(toDir);
          const { verdict, detail: retainedDetail } = describeRetainedOccupant(
            toDirRel,
            ledger,
            occupant,
          );
          if (ledger.state === 'record' && verdict.kind === 'plain-collision') {
            await clearSkillMoveRetentionQuietly(retentionBase, toScope, toName, {
              requestId: getRequestId(_req),
              handler: 'skill-move-scope',
              toDirRel,
            });
          }
          const retentionLedgerCode = RETENTION_LEDGER_CODE_BY_VERDICT[verdict.kind];
          const collisionOutcome: MoveScopeFailureOutcome =
            verdict.kind === 'retained'
              ? {
                  moveState: 'destination-retained-blocking',
                  sourceState: verdict.record.sourceState,
                }
              : {
                  moveState: 'nothing-written',
                  ...(retentionLedgerCode !== undefined
                    ? { retentionLedger: retentionLedgerCode }
                    : {}),
                };
          failMove(
            409,
            'urn:ok:error:doc-already-exists',
            `A ${toScope} skill named "${toName}" already exists.`,
            {
              ...collisionOutcome,
              detail:
                retainedDetail ?? 'Delete or rename it first; this move will not overwrite it.',
              ...(!occupant.ok && occupant.kind === 'read-error'
                ? { cause: occupant.cause }
                : ledger.state === 'unreadable' && ledger.cause !== undefined
                  ? { cause: ledger.cause }
                  : {}),
            },
          );
          return;
        }

        const fromBase = skillInstallBase(fromScope);
        const toBase = skillInstallBase(toScope);
        const priorInstall = fromBase ? readInstalledSkills(fromBase).skills[name] : undefined;
        const fromScanBase = fromScope === 'project' ? contentDir : skillsHome;
        const scanEntry = (
          fromScope === 'project'
            ? scanInPlaceSkills(contentDir)
            : scanGlobalInPlaceSkills(skillsHome)
        ).find((sk) => sk.name === name);
        const canonicalRootRel = scanEntry ? dirname(scanEntry.dir) : null;
        const aliasAudience =
          canonicalRootRel !== null
            ? Object.entries(scanHostRootAliases(fromScanBase, fromScope))
                .filter(([, target]) => target === canonicalRootRel)
                .map(([editor]) => editor)
            : [];
        const priorHosts = [
          ...new Set([
            ...(priorInstall ? resolvedHosts(priorInstall.hosts, fromScope) : []),
            ...(scanEntry ? resolvedHosts(scanEntry.hosts, fromScope) : []),
            ...resolvedHosts(aliasAudience, fromScope),
          ]),
        ];
        const unprojectable = (hosts: readonly string[]): string[] =>
          hosts.filter((host) => resolvedHosts([host], toScope).length === 0);
        const unhostableAtDestination = [
          ...new Set([
            ...unprojectable(priorInstall?.hosts ?? []),
            ...unprojectable(scanEntry?.hosts ?? []),
          ]),
        ].sort();

        mutated = true;
        await captureAndCloseDocuments(
          [
            ...new Set([
              ...(fromScope === 'project' ? [`${fromDirRel}/SKILL`] : []),
              skillLiveDocName(fromScope, name),
              skillLiveDocName(toScope, toName),
            ]),
          ],
          'renamed',
        );

        wrote = true;
        tracedMkdirSync(toRoot, { recursive: true });
        tracedCpSync(fromContentDir, toDir, { recursive: true, dereference: true });
        if (toName !== name) {
          const failCopiedRename = (
            status: 400 | 500,
            detail: string,
            cause?: unknown,
            logLevel?: 'debug' | 'warn' | 'error',
          ): void => {
            const cleanup = applySkillDelete({ skillsRoot: toRoot, name: toName });
            failMove(
              cleanup.ok ? status : 500,
              cleanup.ok && status === 400
                ? 'urn:ok:error:invalid-request'
                : 'urn:ok:error:internal-server-error',
              cleanup.ok
                ? 'Failed to rename the copied skill; destination copy removed.'
                : 'Failed to rename the copied skill; destination cleanup failed.',
              {
                moveState: cleanup.ok ? 'destination-removed' : 'destination-stray',
                detail: cleanup.ok
                  ? `Rename failed (${detail}). The source "${fromScope}:${name}" was not removed.`
                  : `Rename failed (${detail}); destination cleanup failed (${cleanup.error.code}). The source "${fromScope}:${name}" was not removed. A partial copy may remain at "${toScope}:${toName}" (${toDirRel}). Inspect the destination before retrying.`,
                cause: cleanup.ok ? cause : new Error(cleanup.error.message, { cause }),
                ...(logLevel ? { logLevel } : {}),
              },
            );
          };
          try {
            const copied = parseSkillDir(toDir);
            if (copied === null) {
              failCopiedRename(400, 'UNREADABLE_SKILL', new Error('UNREADABLE_SKILL'), 'error');
              return;
            }
            const synced = applySkillDirNameSync({
              skillDir: toDir,
              toName,
              skillMd: copied.skillMd,
            });
            if (!synced.ok) {
              if (synced.stage === 'patch') {
                const failure = describeFmEditError(synced.error);
                failCopiedRename(400, failure, new Error(failure), 'error');
              } else {
                failCopiedRename(500, 'RENAME_FAILED', synced.cause);
              }
              return;
            }
          } catch (error) {
            failCopiedRename(500, 'RENAME_FAILED', error);
            return;
          }
        }

        if (!existsSync(join(toDir, 'SKILL.md'))) {
          const cleanup = applySkillDelete({ skillsRoot: toRoot, name: toName });
          failMove(
            500,
            'urn:ok:error:internal-server-error',
            cleanup.ok
              ? 'The copied skill is unreadable; destination copy removed.'
              : 'The copied skill is unreadable; destination cleanup failed.',
            {
              moveState: cleanup.ok ? 'destination-removed' : 'destination-stray',
              detail: cleanup.ok
                ? `No readable SKILL.md at the destination copy (${toDirRel}); it was removed. The source "${fromScope}:${name}" was not touched and is unchanged.`
                : `No readable SKILL.md at the destination copy (${toDirRel}); cleanup failed (${cleanup.error.code}). The source "${fromScope}:${name}" was not touched and is unchanged. A partial copy remains at "${toScope}:${toName}". Inspect the destination before retrying.`,
              ...(cleanup.ok ? {} : { cause: new Error(cleanup.error.message) }),
            },
          );
          return;
        }

        droppedLocations = [...new Set(sweepSkillOccurrences(fromScope, name))].sort();
        const del = applySkillDelete({ skillsRoot: fromRoot, name });
        if (del.ok && fromContentDir !== fromDir) {
          const realScanBase = (() => {
            try {
              return realpathSync(fromScanBase);
            } catch {
              return fromScanBase;
            }
          })();
          const relFromBase = relative(realScanBase, fromContentDir);
          if (relFromBase !== '' && !relFromBase.startsWith('..') && !isAbsolute(relFromBase)) {
            tracedRmSync(fromContentDir, { recursive: true, force: true });
          }
        }
        if (!del.ok) {
          let rescanError: unknown;
          const sourceState = ((): SkillSourceStateCode => {
            if (!scanEntry) return 'unknown';
            try {
              const rescanned = parseSkillDir(fromDir);
              if (!rescanned) return 'lossy';
              return rescanned.contentHash === scanEntry.contentHash ? 'intact' : 'lossy';
            } catch (error) {
              rescanError = error;
              return 'unknown';
            }
          })();
          let retentionRecorded = false;
          const retainedHash = readSkillContentHash(toDir);
          if (toBase !== undefined) {
            let retentionError: unknown = retainedHash.ok
              ? undefined
              : new Error(`the destination copy could not be hashed (${retainedHash.reason})`, {
                  cause: retainedHash.kind === 'read-error' ? retainedHash.cause : undefined,
                });
            if (retainedHash.ok) {
              try {
                await recordSkillMoveRetention(toBase, toScope, toName, {
                  retainedAt: new Date().toISOString(),
                  from: `${fromScope}:${name}`,
                  to: `${toScope}:${toName}`,
                  sourceState,
                  reason: del.error.code,
                  retainedContentHash: retainedHash.hash,
                });
                retentionRecorded = true;
              } catch (err) {
                retentionError = err;
              }
            }
            if (!retentionRecorded) {
              getLogger('skill-move-scope').error(
                {
                  event: 'skill-move-scope.retention-record-failed',
                  requestId: getRequestId(_req),
                  handler: 'skill-move-scope',
                  toScope,
                  toDirRel,
                  sourceState,
                  err: retentionError,
                },
                'could not record the retained destination copy — a retry will report an ordinary name collision instead of a retained copy',
              );
            }
          }
          const retentionUnrecordedNote = retentionRecorded
            ? ''
            : retainedHash.ok
              ? ` This server could not record the retention, so a retry will not recognise ${toDirRel} as a copy it retained and will report an ordinary name collision instead.`
              : ` This server could not read the destination copy at ${toDirRel} to confirm it is intact (${retainedHash.reason}), so do not rely on it for recovery until you have inspected it yourself. It was not recorded as a retained copy either, so a retry will report an ordinary name collision instead.`;
          failMove(
            500,
            'urn:ok:error:internal-server-error',
            'Failed to move skill (source removal failed); destination copy retained for recovery.',
            {
              moveState: 'destination-retained',
              sourceState,
              detail:
                sourceState === 'intact'
                  ? `Source removal failed (${del.error.code}) without deleting anything. The source "${fromScope}:${name}" is unchanged at its original scope, so no files were lost. The destination copy "${toScope}:${toName}" at ${toDirRel} is a duplicate whose install records have not transferred; remove it before retrying.${retentionUnrecordedNote}`
                  : sourceState === 'lossy'
                    ? `Source removal failed (${del.error.code}). The source "${fromScope}:${name}" may be partially removed. The destination copy "${toScope}:${toName}" remains at ${toDirRel}; its install records have not transferred. Inspect both locations before retrying, and recover missing source files from the retained copy.${retentionUnrecordedNote}`
                    : `Source removal failed (${del.error.code}). The source "${fromScope}:${name}" could not be verified against a known content hash, so whether any files were lost is unknown. The destination copy "${toScope}:${toName}" remains at ${toDirRel}; its install records have not transferred. Compare both locations before removing either.${retentionUnrecordedNote}`,
              cause: rescanError
                ? new Error(del.error.message, { cause: rescanError })
                : new Error(del.error.message),
            },
          );
          return;
        }

        await clearSkillMoveRetentionQuietly(toBase, toScope, toName, {
          requestId: getRequestId(_req),
          handler: 'skill-move-scope',
          toDirRel,
        });

        const moveScopeWarnings: string[] = [];
        let movedLockEntry = false;
        try {
          movedLockEntry = await transferSkillLockEntry(fromScope, toScope, name, toName);

          if (fromBase) {
            await uninstallSkillFromHostDirs(
              fromBase,
              name,
              fromScope,
              scanEntry ? { purge: { contentHash: scanEntry.contentHash } } : {},
            );
          }
          if (fromBase) await clearSkillPlacements(fromBase, name);
          if (toBase && priorHosts.length > 0) {
            const newHosts = projectSkill(
              toDir,
              toName,
              toBase,
              priorHosts,
              projectionModeFor(toScope, toName),
              skillProjectionRoots(toScope),
            );
            await recordSkillInstall(toBase, toName, {
              ...priorInstall,
              scope: toScope,
              hosts: newHosts,
              scripts: priorInstall?.scripts ?? validateSkillForInstall(toDir, toName).hasScripts,
              installedAt: priorInstall?.installedAt ?? new Date().toISOString(),
            });
          }

          if (movedLockEntry) {
            const movedLocalHash = localSkillHash(toRoot, toName);
            await updateSkillLockEntry(toScope, toName, { localHash: movedLocalHash });
          }
        } catch (err) {
          getLogger('skill-move-scope').error(
            { err, name, toName, fromScope, toScope, requestId: getRequestId(_req) },
            'skill moved across scopes, but its bookkeeping could not be updated',
          );
          moveScopeWarnings.push(
            `The skill moved to ${toScope}, but this server could not update its install records (${thrownMessage(err)}). A stale entry may remain until that file is repaired.`,
          );
        }

        if (!existsSync(join(toDir, 'SKILL.md'))) {
          failMove(
            500,
            'urn:ok:error:internal-server-error',
            'The source was removed, but the destination skill is unreadable.',
            {
              moveState: 'destination-unreadable',
              detail: `Inspect "${toScope}:${toName}" at ${toDirRel} before retrying. Restore the skill from a backup, or check the project Timeline / shadow-repo history for an earlier version if available.`,
            },
          );
          return;
        }

        if (fromScope === 'project' || toScope === 'project') {
          attributeOkArtifactWrite(
            actor,
            fromScope === 'project' ? fromDirRel : relative(contentDir, toDir).split(sep).join('/'),
            `skill-move-scope: ${fromScope} -> ${toScope} ${name}${toName !== name ? ` -> ${toName}` : ''}`,
          );
          const toKeyForBaseline = relative(contentDir, toDir).split(sep).join('/');
          const wantBaseline = Boolean(movedLockEntry) && toScope === 'project';
          const deferredRequestId = getRequestId(_req);
          void (async () => {
            const flush = await commitOkArtifactWrite('skill-move-scope');
            if (!wantBaseline) return;
            if (flush !== 'flushed') {
              getLogger('skill-move-scope').warn(
                {
                  event: 'skill-move-scope.revert-baseline-unset',
                  requestId: deferredRequestId,
                  handler: 'skill-move-scope',
                  toScope,
                  toName,
                  flush,
                },
                'the deferred shadow flush did not complete, so this move did not establish or update its Revert baseline; any baseline an earlier write recorded is unchanged',
              );
              return;
            }
            try {
              const baselineRef = await shadowHeadSha(artifactWriterId(actor), toKeyForBaseline);
              if (baselineRef === undefined) {
                getLogger('skill-move-scope').warn(
                  {
                    event: 'skill-move-scope.revert-baseline-unset',
                    requestId: deferredRequestId,
                    handler: 'skill-move-scope',
                    toScope,
                    toName,
                    flush,
                  },
                  'no shadow head was readable after the flush, so this move did not establish or update its Revert baseline; any baseline an earlier write recorded is unchanged',
                );
                return;
              }
              await updateSkillLockEntry(toScope, toName, { baselineRef });
            } catch (err) {
              getLogger('skill-move-scope').warn(
                {
                  event: 'skill-move-scope.baseline-update-failed',
                  requestId: deferredRequestId,
                  handler: 'skill-move-scope',
                  toScope,
                  toName,
                  err,
                },
                'could not record the Revert baseline for the moved skill, so this move did not establish or update its baseline; any baseline an earlier write recorded is unchanged',
              );
            }
          })();
        }

        settle();
        recordMoveScopeOutcome('success', undefined, undefined, {
          requestId: getRequestId(_req),
          status: 200,
          droppedLocationCount: unhostableAtDestination.length,
          logLevel: 'debug',
          message: 'cross-scope skill move completed',
        });
        successResponse(
          res,
          200,
          SkillMoveScopeSuccessSchema,
          {
            scope: toScope,
            path: toDirRel,
            droppedLocations: unhostableAtDestination,
            ...(moveScopeWarnings.length > 0 ? { warnings: moveScopeWarnings } : {}),
          },
          { handler: 'skill-move-scope' },
        );
      } catch (e) {
        failMove(
          500,
          'urn:ok:error:internal-server-error',
          wrote
            ? 'Failed to move skill across scopes; the move may be partially applied.'
            : 'Failed to move skill across scopes; nothing was written.',
          {
            moveState: wrote ? 'partially-applied' : 'nothing-written',
            detail: wrote
              ? `Inspect the source "${body.fromScope}:${body.name}" and destination "${body.toScope}:${body.toName ?? body.name}" before retrying. Preserve any remaining copies and recover missing files from a backup or available project Timeline / shadow-repo history.`
              : `The failure happened before any file was copied, so no files were copied or removed for "${body.fromScope}:${body.name}" or "${body.toScope}:${body.toName ?? body.name}". Retrying is safe once the underlying error clears.`,
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-move-scope', method: 'POST' },
  );

  const handleSkillDuplicate = withValidation(
    SkillDuplicateRequestSchema,
    async (_req, res, body) => {
      const settle = settleSkillCatalog;
      let touchedDisk = false;
      let copyStarted = false;
      let copied = false;
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-duplicate',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-duplicate')) return;
        if (!validateSkillName(body.toName, res, 'skill-duplicate')) return;
        if (rejectReservedBuiltinSkill(body.toName, res, 'skill-duplicate')) return;

        const sourceDir = resolveSkillDirForRead(body.scope, body.name);
        if (sourceDir === null || !existsSync(join(sourceDir, 'SKILL.md'))) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-duplicate',
            detail: 'SOURCE_NOT_FOUND',
          });
          return;
        }
        const base = body.scope === 'project' ? contentDir : skillsHome;
        const targetHomeRel = resolveDefaultSkillHomeRel(base, body.scope);
        if (targetHomeRel === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'No agent skill host is available.',
            { handler: 'skill-duplicate', detail: 'NO_USABLE_SKILL_HOME' },
          );
          return;
        }
        const targetRoot = resolve(base, targetHomeRel);
        const targetDir = resolve(targetRoot, body.toName);
        if (resolveSkillDirForRead(body.scope, body.toName) !== null || existsSync(targetDir)) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            `A ${body.scope} skill named "${body.toName}" already exists.`,
            { handler: 'skill-duplicate' },
          );
          return;
        }

        const source = parseSkillDir(sourceDir);
        if (!source) {
          errorResponse(res, 422, 'urn:ok:error:invalid-request', 'Source has no readable skill.', {
            handler: 'skill-duplicate',
          });
          return;
        }
        const targetDirRel = relative(base, targetDir).split(sep).join('/');
        touchedDisk = true;
        tracedMkdirSync(targetRoot, { recursive: true });
        copyStarted = true;
        tracedCpSync(sourceDir, targetDir, { recursive: true, dereference: true });
        copied = true;
        const failCopiedDuplicate = (
          status: 400 | 500,
          detail: string,
          cause: unknown,
          logLevel?: 'debug' | 'warn' | 'error',
        ): void => {
          const cleanup = applySkillDelete({ skillsRoot: targetRoot, name: body.toName });
          settle();
          errorResponse(
            res,
            cleanup.ok ? status : 500,
            cleanup.ok && status === 400
              ? 'urn:ok:error:invalid-request'
              : 'urn:ok:error:internal-server-error',
            cleanup.ok
              ? 'Failed to write duplicated skill; destination copy removed.'
              : 'Failed to write duplicated skill; destination cleanup failed.',
            {
              handler: 'skill-duplicate',
              detail: cleanup.ok
                ? `Duplicate failed (${detail}). The source "${body.scope}:${body.name}" was not touched.`
                : `Duplicate failed (${detail}); destination cleanup failed (${cleanup.error.code}). The source "${body.scope}:${body.name}" was not touched. A partial copy may remain at "${body.scope}:${body.toName}" (${targetDirRel}). Inspect the destination before retrying.`,
              cause: cleanup.ok ? cause : new Error(cleanup.error.message, { cause }),
              ...(logLevel ? { logLevel } : {}),
            },
          );
        };
        const synced = applySkillDirNameSync({
          skillDir: targetDir,
          toName: body.toName,
          skillMd: source.skillMd,
        });
        if (!synced.ok) {
          if (synced.stage === 'patch') {
            const failure = describeFmEditError(synced.error);
            failCopiedDuplicate(400, failure, new Error(failure), 'error');
          } else {
            failCopiedDuplicate(500, 'WRITE_FAILED', synced.cause);
          }
          return;
        }

        if (body.scope === 'project') {
          const targetRel = relative(contentDir, targetDir).split(sep).join('/');
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('skill', '', body.toName),
            `skill-duplicate: ${body.name} -> ${targetRel}`,
          );
          void commitOkArtifactWrite('skill-duplicate');
        }
        settle();

        successResponse(
          res,
          200,
          SkillDuplicateSuccessSchema,
          { name: body.toName },
          { handler: 'skill-duplicate' },
        );
      } catch (e) {
        if (touchedDisk) settle();
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to duplicate skill.',
          {
            handler: 'skill-duplicate',
            ...(copied
              ? {
                  detail: `A complete copy was created at "${body.scope}:${body.toName}" and was left in place. Inspect it before retrying.`,
                }
              : copyStarted
                ? {
                    detail: `A copy of "${body.scope}:${body.name}" was started at "${body.scope}:${body.toName}" and may be incomplete; it was left in place, and its SKILL.md may still carry the source's name. Inspect or remove it before retrying.`,
                  }
                : {}),
            cause: e,
          },
        );
      }
    },
    { handler: 'skill-duplicate', method: 'POST' },
  );

  const handleSkill = methodRouter(
    { GET: handleSkillGet, PUT: handleSkillPut, POST: handleSkillMove, DELETE: handleSkillDelete },
    { handler: 'skill' },
  );

  return createApiRouteGroup(
    {
      '/api/skill': handleSkill,
      '/api/skill/edit-external': handleSkillEditExternal,
      '/api/skill/duplicate': handleSkillDuplicate,
      '/api/skill/move-scope': handleSkillMoveScope,
    },
    {
      mutating: [
        '/api/skill',
        '/api/skill/edit-external',
        '/api/skill/duplicate',
        '/api/skill/move-scope',
      ],
    },
  );
}
