import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  applyPatchToFm,
  detectFmRegion,
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
import { tracedCpSync, tracedMkdirSync, tracedRmSync, tracedWriteFileSync } from '../fs-traced.ts';
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
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { methodRouter } from './method-router.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsDocumentRouteDeps {
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
  commitOkArtifactWrite: (context: string) => Promise<void>;
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
      skills: { ...lock.skills, [name]: movedEntry },
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
              warnings: [...composed.warnings, ...wr.warnings],
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
          { path: relPath, created, warnings: composed.warnings },
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

  function sweepSkillOccurrences(scope: 'project' | 'global', name: string): void {
    const base = scope === 'project' ? contentDir : skillsHome;
    const inPlace = (
      scope === 'project' ? scanInPlaceSkills(contentDir) : scanGlobalInPlaceSkills(skillsHome)
    ).find((sk) => sk.name === name);
    if (!inPlace) return;
    removeInPlaceSkillCopies({
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
        if (host === undefined && uninstallBase) {
          await uninstallSkillFromHostDirs(uninstallBase, name, scope);
        }
        successResponse(
          res,
          200,
          SkillDeleteSuccessSchema,
          { existed: result.existed, path: result.path },
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
        if (resolveSkillDirForRead(body.scope, body.toName) !== null) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            `A skill named "${body.toName}" already exists.`,
            { handler: 'skill-move' },
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
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          void reindexMovedProjectSkillDocs(skillsRoot, body.fromName, body.toName)
            .then(() => reindexRewrittenSkillRefDocs(refRewrites, body.toName))
            .catch(() => {});
          scheduleDeferredIgnoreRebuild();
        }

        const fromKeyPath = skillRelPath(resolve(skillsRoot, body.fromName), body.scope);
        const toKeyPath = skillRelPath(resolve(skillsRoot, body.toName), body.scope);
        const renamedLocalHash = localSkillHash(skillsRoot, body.toName);
        await rekeySkillLockEntry(body.scope, body.fromName, body.toName, {
          localHash: renamedLocalHash,
        });
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
          await removeSkillInstall(moveBase, body.fromName);
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
            await recordSkillInstall(moveBase, body.toName, {
              ...priorInstall,
              scope: body.scope,
              hosts: newHosts,
              scripts:
                priorInstall?.scripts ?? validateSkillForInstall(movedDir, body.toName).hasScripts,
              installedAt: priorInstall?.installedAt ?? new Date().toISOString(),
            });
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

  const handleSkillMoveScope = withValidation(
    SkillMoveScopeRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-move-scope',
          });
          return;
        }
        const { name, fromScope, toScope } = body;
        if (!validateSkillName(name, res, 'skill-move-scope')) return;
        if (isInternalBundleSkillName(name)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            `"${name}" is a built-in skill and always lives at its own scope.`,
            { handler: 'skill-move-scope', detail: 'BUILTIN_SCOPE_FIXED' },
          );
          return;
        }
        if (fromScope === toScope) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Source and destination scope are the same.',
            { handler: 'skill-move-scope' },
          );
          return;
        }
        if (toScope === 'project' && !projectDir) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Cannot move to project scope — no project root is resolved for this server.',
            { handler: 'skill-move-scope', detail: 'NO_PROJECT_ROOT' },
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
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'No agent skill host is available in the destination scope.',
            { handler: 'skill-move-scope', detail: 'NO_USABLE_SKILL_HOME' },
          );
          return;
        }
        const toRoot = resolve(toBase2, toHomeRel);
        const toDir = resolve(toRoot, name);
        if (realDir === null || !existsSync(fromDir)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-move-scope',
            detail: `Skill "${name}" not found in ${fromScope} scope.`,
          });
          return;
        }
        if (
          resolve(realDir) === resolve(toDir) ||
          (existsSync(toDir) && realpathSync(realDir) === realpathSync(toDir))
        ) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            'The source and destination resolve to the same skill directory.',
            { handler: 'skill-move-scope', detail: 'SAME_STORAGE' },
          );
          return;
        }
        if (resolveSkillDirForRead(toScope, name) !== null || existsSync(toDir)) {
          errorResponse(
            res,
            409,
            'urn:ok:error:doc-already-exists',
            `A ${toScope} skill named "${name}" already exists.`,
            { handler: 'skill-move-scope' },
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

        await captureAndCloseDocuments(
          [
            ...new Set([
              ...(fromScope === 'project' ? [`${fromDirRel}/SKILL`] : []),
              skillLiveDocName(fromScope, name),
              skillLiveDocName(toScope, name),
            ]),
          ],
          'renamed',
        );

        tracedMkdirSync(toRoot, { recursive: true });
        tracedCpSync(fromContentDir, toDir, { recursive: true, dereference: true });

        sweepSkillOccurrences(fromScope, name);
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
          applySkillDelete({ skillsRoot: toRoot, name });
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'Failed to move skill (source removal failed); rolled back the copy.',
            {
              handler: 'skill-move-scope',
              detail: del.error.code,
              cause: new Error(del.error.message),
            },
          );
          return;
        }

        const movedLockEntry = await transferSkillLockEntry(fromScope, toScope, name);

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
            name,
            toBase,
            priorHosts,
            projectionModeFor(toScope, body.name),
            skillProjectionRoots(toScope),
          );
          await recordSkillInstall(toBase, name, {
            ...priorInstall,
            scope: toScope,
            hosts: newHosts,
            scripts: priorInstall?.scripts ?? validateSkillForInstall(toDir, name).hasScripts,
            installedAt: priorInstall?.installedAt ?? new Date().toISOString(),
          });
        }

        if (movedLockEntry) {
          const movedLocalHash = localSkillHash(toRoot, name);
          await updateSkillLockEntry(toScope, name, { localHash: movedLocalHash });
        }
        if (fromScope === 'project' || toScope === 'project') {
          attributeOkArtifactWrite(
            actor,
            fromScope === 'project' ? fromDirRel : relative(contentDir, toDir).split(sep).join('/'),
            `skill-move-scope: ${fromScope} -> ${toScope} ${name}`,
          );
          const toKeyForBaseline = relative(contentDir, toDir).split(sep).join('/');
          const wantBaseline = Boolean(movedLockEntry) && toScope === 'project';
          void (async () => {
            try {
              await commitOkArtifactWrite('skill-move-scope');
              if (wantBaseline) {
                const baselineRef = await shadowHeadSha(artifactWriterId(actor), toKeyForBaseline);
                if (baselineRef !== undefined) {
                  await updateSkillLockEntry(toScope, name, { baselineRef });
                }
              }
            } catch (err) {
              getLogger('skill-move-scope').warn(
                { err, name },
                'deferred shadow flush / revert-baseline failed — Revert stays unarmed until the next flush',
              );
            }
          })();
        }

        if (!existsSync(join(toDir, 'SKILL.md'))) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'The move did not leave a readable skill at the destination; nothing was reported as moved.',
            { handler: 'skill-move-scope', detail: relative(toBase2, toDir).split(sep).join('/') },
          );
          return;
        }

        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();

        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillMoveScopeSuccessSchema,
          { scope: toScope, path: relative(toBase2, toDir).split(sep).join('/') },
          { handler: 'skill-move-scope' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to move skill across scopes.',
          { handler: 'skill-move-scope', cause: e },
        );
      }
    },
    { handler: 'skill-move-scope', method: 'POST' },
  );

  const handleSkillDuplicate = withValidation(
    SkillDuplicateRequestSchema,
    async (_req, res, body) => {
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
        tracedMkdirSync(targetRoot, { recursive: true });
        tracedCpSync(sourceDir, targetDir, { recursive: true, dereference: true });
        const { fenced, body: sourceBody } = detectFmRegion(source.skillMd);
        // presence-exempt: no CRDT write, no agent identity
        const renamed = applyPatchToFm(fenced, { name: body.toName });
        if (!renamed.ok) {
          applySkillDelete({ skillsRoot: targetRoot, name: body.toName });
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Failed to write duplicated skill.',
            {
              handler: 'skill-duplicate',
              detail: renamed.error.kind,
            },
          );
          return;
        }
        try {
          tracedWriteFileSync(join(targetDir, 'SKILL.md'), `${renamed.nextFenced}${sourceBody}`);
        } catch (error) {
          applySkillDelete({ skillsRoot: targetRoot, name: body.toName });
          throw error;
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
        signalChannel?.('files');
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();

        successResponse(
          res,
          200,
          SkillDuplicateSuccessSchema,
          { name: body.toName },
          { handler: 'skill-duplicate' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to duplicate skill.',
          { handler: 'skill-duplicate', cause: e },
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
