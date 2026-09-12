import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  isOpenKnowledgeSkillsSource,
  type Principal,
  RENAMED_PACK_SKILLS,
  type SkillImportBulkResult,
  SkillImportRequestSchema,
  SkillImportSuccessSchema,
  SkillsImportBulkRequestSchema,
  SkillsImportBulkSuccessSchema,
} from '@inkeep/open-knowledge-core';
import {
  discoverSkillDirs,
  fetchSource,
  parseSkillDir,
  parseSource,
  readSkillDirMeta,
  readWellKnownIndex,
  resolveSkillsShImportSource,
  SkillFetchError,
  type SourceSpec,
  type WellKnownIndex,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { type Entry, fromBuffer as yauzlFromBuffer, type ZipFile } from 'yauzl';
import type { ContentFilter } from '../content-filter.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import { tracedMkdirSync, tracedRmSync, tracedWriteFileSync } from '../fs-traced.ts';
import { getLogger } from '../logger.ts';
import { createMultipartParser, type MultipartParser } from '../multipart.ts';
import type { SkillImportOutcome, SkillImportService } from '../services/skill-import.ts';
import { rejectDisallowedGitSpec } from '../skill-git-spec-guard.ts';
import { resolveSkillInstallReportSettings } from '../skill-install-report-config.ts';
import { reportSkillInstall } from '../skills-sh-install-report.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsImportRouteDeps {
  projectDir: string | undefined;
  getPrincipal: (() => Principal | null) | undefined;
  skillImportService: SkillImportService;
  bumpSkillsCatalogGen: () => void;
  contentFilter: ContentFilter | undefined;
  scheduleDeferredIgnoreRebuild: () => void;
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  parseSkillScope: (
    raw: string | null,
    res: ServerResponse,
    handler: string,
  ) => 'project' | 'global' | null;
}

export function createSkillsImportRoutes(deps: SkillsImportRouteDeps): ApiRouteGroup {
  const {
    projectDir,
    getPrincipal,
    skillImportService,
    bumpSkillsCatalogGen,
    contentFilter,
    scheduleDeferredIgnoreRebuild,
    signalChannel,
    parseSkillScope,
  } = deps;
  function publisherFromSource(source: string): string | undefined {
    const m = /github\.com[/:]([\w.-]+)\//.exec(source);
    return m ? m[1] : undefined;
  }

  function respondSkillImport(res: ServerResponse, outcome: SkillImportOutcome): void {
    if (outcome.ok) {
      successResponse(res, 200, SkillImportSuccessSchema, outcome.body, {
        handler: 'skill-import',
      });
      return;
    }
    errorResponse(res, outcome.status, outcome.urn, outcome.title, {
      handler: 'skill-import',
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
    });
  }

  const handleSkillImport = withValidation(
    SkillImportRequestSchema,
    async (_req, res, body) => {
      let cleanup: () => void = () => {};
      try {
        if (!projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skill-import',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-import',
          });
          return;
        }
        const scope = body.scope;

        let acquiredDir: string | null = null;
        let sourceLabel: string;
        let ref: string | undefined;
        let publisher: string | undefined;
        let upstreamSkill: string | undefined;
        let resolvedSourceForReport = body.source;

        {
          const rawSource = body.source;
          try {
            const skillsSh = await resolveSkillsShImportSource(rawSource, body.skill);
            const resolvedSource = skillsSh?.source ?? rawSource;
            resolvedSourceForReport = resolvedSource;
            const selectedSkill = body.skill ?? skillsSh?.skill;
            const spec = skillsSh?.spec ?? parseSource(resolvedSource);
            if (!spec) {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                'Unrecognized import source.',
                {
                  handler: 'skill-import',
                  detail:
                    'Expected owner/repo, a git URL, a website source, a local path, or a skills.sh URL.',
                },
              );
              return;
            }
            if (rejectDisallowedGitSpec(res, spec, 'skill-import')) return;
            const fetched = await fetchSource(spec);
            cleanup = fetched.cleanup;
            ref = fetched.ref;
            const dirs = discoverSkillDirs(fetched.dir);
            if (dirs.length === 0) {
              errorResponse(res, 404, 'urn:ok:error:not-found', 'No SKILL.md found in source.', {
                handler: 'skill-import',
              });
              return;
            }
            let pick = dirs[0];
            if (selectedSkill) {
              const found =
                dirs.find((d) => d.name === selectedSkill) ??
                dirs.find((d) => readSkillDirMeta(d.dir)?.name === selectedSkill) ??
                dirs.find((d) => d.name === RENAMED_PACK_SKILLS[selectedSkill]);
              if (!found) {
                errorResponse(res, 404, 'urn:ok:error:not-found', 'Named skill not in source.', {
                  handler: 'skill-import',
                  detail: `--skill "${selectedSkill}" not among: ${dirs.map((d) => d.name).join(', ')}.`,
                });
                return;
              }
              pick = found;
            } else if (dirs.length > 1) {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                'Source has multiple skills; pass `skill` to choose one.',
                { handler: 'skill-import', detail: dirs.map((d) => d.name).join(', ') },
              );
              return;
            }
            acquiredDir = pick.dir;
            upstreamSkill = pick.name;
            sourceLabel = rawSource;
            publisher = skillsSh?.publisher ?? publisherFromSource(resolvedSource);
          } catch (e) {
            if (e instanceof SkillFetchError) {
              errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
                handler: 'skill-import',
                cause: e,
              });
              return;
            }
            throw e;
          }
        }

        if (!acquiredDir) {
          errorResponse(res, 422, 'urn:ok:error:invalid-request', 'Source has no readable skill.', {
            handler: 'skill-import',
          });
          return;
        }
        const outcome = await skillImportService.runSkillImport({
          acquiredDir,
          scope,
          sourceLabel,
          ref,
          publisher,
          upstreamSkill,
          actor,
          skipProjection: body.install === false,
        });
        if (
          outcome.ok &&
          (body.marketplace === true || isOpenKnowledgeSkillsSource(resolvedSourceForReport))
        ) {
          void reportSkillInstall(
            { source: resolvedSourceForReport, skills: [outcome.body.name] },
            resolveSkillInstallReportSettings(),
          );
        }
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();
        signalChannel?.('files');

        respondSkillImport(res, outcome);
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to import skill.', {
          handler: 'skill-import',
          cause: e,
        });
      } finally {
        cleanup();
      }
    },
    { handler: 'skill-import', method: 'POST' },
  );

  const handleSkillsImportBulk = withValidation(
    SkillsImportBulkRequestSchema,
    async (_req, res, body) => {
      let cleanup: () => void = () => {};
      try {
        if (!projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skills-import-bulk',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skills-import-bulk',
          });
          return;
        }
        const rawSource = body.source;
        let siteSpec: (SourceSpec & { kind: 'well-known' }) | null = null;
        let siteIndex: WellKnownIndex | null = null;
        let dirs: ReturnType<typeof discoverSkillDirs> = [];
        let ref: string | undefined;
        let publisher: string | undefined;
        let resolvedSourceForReport = rawSource;
        try {
          const skillsSh = await resolveSkillsShImportSource(rawSource, body.skills[0]);
          const resolvedSource = skillsSh?.source ?? rawSource;
          resolvedSourceForReport = resolvedSource;
          const spec = skillsSh?.spec ?? parseSource(resolvedSource);
          if (!spec) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unrecognized import source.', {
              handler: 'skills-import-bulk',
              detail:
                'Expected owner/repo, a git URL, a website source, a local path, or a skills.sh URL.',
            });
            return;
          }
          if (rejectDisallowedGitSpec(res, spec, 'skills-import-bulk')) return;
          publisher = skillsSh?.publisher ?? publisherFromSource(resolvedSource);
          if (spec.kind === 'well-known') {
            siteSpec = spec;
            siteIndex = await readWellKnownIndex(spec.origin);
          } else {
            const fetched = await fetchSource(spec);
            cleanup = fetched.cleanup;
            ref = fetched.ref;
            dirs = discoverSkillDirs(fetched.dir);
          }
        } catch (e) {
          if (e instanceof SkillFetchError) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
              handler: 'skills-import-bulk',
              cause: e,
            });
            return;
          }
          throw e;
        }
        if (siteSpec === null && dirs.length === 0) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'No SKILL.md found in source.', {
            handler: 'skills-import-bulk',
          });
          return;
        }
        const results: SkillImportBulkResult[] = [];
        for (const requested of new Set(body.skills)) {
          let acquiredDir: string;
          let upstreamSkill: string;
          let perSkill: () => void = () => {};
          if (siteSpec !== null) {
            try {
              const one = await fetchSource(
                { ...siteSpec, skill: requested },
                siteIndex ? { index: siteIndex } : {},
              );
              acquiredDir = one.dir;
              perSkill = one.cleanup;
              upstreamSkill = requested;
            } catch (e) {
              results.push({
                requested,
                status: e instanceof SkillFetchError ? 'not-found' : 'failed',
                warnings: [],
                warningCodes: [],
                ...(e instanceof SkillFetchError ? {} : { error: String(e) }),
              });
              continue;
            }
          } else {
            const found =
              dirs.find((d) => d.name === requested) ??
              dirs.find((d) => parseSkillDir(d.dir)?.name === requested) ??
              dirs.find((d) => d.name === RENAMED_PACK_SKILLS[requested]);
            if (!found) {
              results.push({ requested, status: 'not-found', warnings: [], warningCodes: [] });
              continue;
            }
            acquiredDir = found.dir;
            upstreamSkill = found.name;
          }
          try {
            const outcome = await skillImportService.runSkillImport({
              acquiredDir,
              scope: body.scope,
              sourceLabel: rawSource,
              ref,
              publisher,
              upstreamSkill,
              actor,
              skipProjection: body.install === false,
            });
            if (!outcome.ok) {
              getLogger('skills-import-bulk').warn(
                { skill: requested, err: outcome.cause, detail: outcome.detail },
                'bulk import: one skill failed (rest continue)',
              );
              results.push({
                requested,
                status: 'failed',
                warnings: [],
                warningCodes: [],
                error: outcome.detail ?? outcome.title,
              });
              continue;
            }
            results.push({
              requested,
              status: outcome.body.alreadyImported ? 'already-imported' : 'imported',
              name: outcome.body.name,
              ...(outcome.body.collisionRenamedFrom !== undefined
                ? { collisionRenamedFrom: outcome.body.collisionRenamedFrom }
                : {}),
              warnings: outcome.body.warnings,
              warningCodes: outcome.body.warningCodes,
            });
          } catch (e) {
            getLogger('skills-import-bulk').warn(
              { skill: requested, err: e },
              'bulk import: one skill threw (rest continue)',
            );
            results.push({
              requested,
              status: 'failed',
              warnings: [],
              warningCodes: [],
              error: e instanceof Error ? e.message : String(e),
            });
          } finally {
            perSkill();
          }
        }
        if (body.marketplace === true || isOpenKnowledgeSkillsSource(resolvedSourceForReport)) {
          const importedNames = results
            .filter((r) => r.status === 'imported')
            .map((r) => r.requested);
          if (importedNames.length > 0) {
            void reportSkillInstall(
              { source: resolvedSourceForReport, skills: importedNames },
              resolveSkillInstallReportSettings(),
            );
          }
        }
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();
        signalChannel?.('files');

        successResponse(
          res,
          200,
          SkillsImportBulkSuccessSchema,
          {
            results,
            imported: results.filter((r) => r.status === 'imported').length,
            alreadyImported: results.filter((r) => r.status === 'already-imported').length,
            failed: results.filter((r) => r.status === 'failed' || r.status === 'not-found').length,
          },
          { handler: 'skills-import-bulk' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to import skills.', {
          handler: 'skills-import-bulk',
          cause: e,
        });
      } finally {
        cleanup();
      }
    },
    { handler: 'skills-import-bulk', method: 'POST' },
  );

  const UPLOAD_MAX_FILES = 200;
  const UPLOAD_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
  const UPLOAD_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

  function resolveUploadPath(root: string, rel: string): string | null {
    const norm = rel.split('\\').join('/').replace(/^\/+/, '');
    if (norm === '' || norm.split('/').some((seg) => seg === '..')) return null;
    const abs = resolve(root, norm);
    if (abs !== root && !abs.startsWith(root + sep)) return null;
    return abs;
  }

  interface UploadedPart {
    relPath: string;
    data: Buffer;
  }

  function readSkillUploadParts(req: IncomingMessage): Promise<UploadedPart[]> {
    return new Promise((resolveP, reject) => {
      let bb: MultipartParser;
      try {
        bb = createMultipartParser(req, {
          files: UPLOAD_MAX_FILES,
          fields: 10,
          fieldSize: 2 * 1024,
          fileSize: UPLOAD_MAX_ENTRY_BYTES,
        });
      } catch (err) {
        reject(err);
        return;
      }
      const parts: UploadedPart[] = [];
      let total = 0;
      let aborted: Error | null = null;
      const abort = (err: Error) => {
        if (aborted) return;
        aborted = err;
        req.unpipe(bb);
        req.destroy();
        bb.destroy();
        reject(err);
      };
      bb.on('file', (_field, stream, info) => {
        const chunks: Buffer[] = [];
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (aborted) return;
          total += c.length;
          if (total > UPLOAD_MAX_TOTAL_BYTES) {
            abort(new Error('Upload too large.'));
            return;
          }
          chunks.push(c);
        });
        stream.on('limit', () => {
          truncated = true;
        });
        stream.on('end', () => {
          if (aborted) return;
          if (truncated) {
            aborted = new Error(`File "${info.filename}" exceeds the per-file size limit.`);
            return;
          }
          parts.push({ relPath: info.filename || 'file', data: Buffer.concat(chunks) });
        });
      });
      bb.on('error', reject);
      bb.on('close', () => (aborted ? reject(aborted) : resolveP(parts)));
      req.pipe(bb);
    });
  }

  function unzipBufferToDir(buffer: Buffer, destDir: string): Promise<void> {
    return new Promise((resolveP, reject) => {
      yauzlFromBuffer(buffer, { lazyEntries: true }, (err, zip?: ZipFile) => {
        if (err || !zip) {
          reject(err ?? new Error('Unreadable archive.'));
          return;
        }
        let total = 0;
        let entries = 0;
        const fail = (e: unknown) => {
          try {
            zip.close();
          } catch {}
          reject(e instanceof Error ? e : new Error(String(e)));
        };
        zip.on('entry', (entry: Entry) => {
          if (++entries > UPLOAD_MAX_FILES) {
            fail(new Error('Archive has too many entries.'));
            return;
          }
          const abs = resolveUploadPath(destDir, entry.fileName);
          if (!abs) {
            fail(new Error(`Unsafe archive entry: ${entry.fileName}`));
            return;
          }
          if (entry.fileName.endsWith('/')) {
            tracedMkdirSync(abs, { recursive: true });
            zip.readEntry();
            return;
          }
          if (entry.uncompressedSize > UPLOAD_MAX_ENTRY_BYTES) {
            fail(new Error(`Archive entry too large: ${entry.fileName}`));
            return;
          }
          zip.openReadStream(entry, (e2, rs) => {
            if (e2 || !rs) {
              fail(e2 ?? new Error('Could not read archive entry.'));
              return;
            }
            const chunks: Buffer[] = [];
            rs.on('data', (c: Buffer) => {
              total += c.length;
              if (total > UPLOAD_MAX_TOTAL_BYTES) {
                rs.destroy();
                fail(new Error('Archive expands beyond the size limit.'));
                return;
              }
              chunks.push(c);
            });
            rs.on('error', fail);
            rs.on('end', () => {
              try {
                tracedMkdirSync(dirname(abs), { recursive: true });
                tracedWriteFileSync(abs, Buffer.concat(chunks));
              } catch (writeErr) {
                fail(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
                return;
              }
              zip.readEntry();
            });
          });
        });
        zip.on('end', () => resolveP());
        zip.on('error', fail);
        zip.readEntry();
      });
    });
  }

  async function handleSkillUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-upload-'));
    const cleanup = () => {
      try {
        tracedRmSync(tmp, { recursive: true, force: true });
      } catch {}
    };
    try {
      if (!projectDir) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
          handler: 'skill-upload',
          detail: 'NO_PROJECT_ROOT',
        });
        return;
      }
      if ((req.method ?? '').toUpperCase() !== 'POST') {
        errorResponse(res, 405, 'urn:ok:error:invalid-request', 'Use POST to upload a skill.', {
          handler: 'skill-upload',
        });
        return;
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const scope = parseSkillScope(url.searchParams.get('scope'), res, 'skill-upload');
      if (!scope) return;
      const queryField = (key: string): string | undefined =>
        url.searchParams.get(key) ?? undefined;
      const actor = extractActorIdentity(
        {
          agentId: queryField('agentId'),
          agentName: queryField('agentName'),
          colorSeed: queryField('colorSeed'),
          clientName: queryField('clientName'),
          summary: queryField('summary'),
        },
        getPrincipal,
      );
      if (actor.kind === 'invalid-summary') {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
          handler: 'skill-upload',
        });
        return;
      }

      let parts: UploadedPart[];
      try {
        parts = await readSkillUploadParts(req);
      } catch (e) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not read the upload.', {
          handler: 'skill-upload',
          cause: e,
        });
        return;
      }
      if (parts.length === 0) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No files uploaded.', {
          handler: 'skill-upload',
        });
        return;
      }

      const single = parts.length === 1 ? parts[0] : null;
      const zipName = single && /\.(zip|skill)$/i.test(single.relPath) ? single.relPath : null;
      if (single && zipName) {
        try {
          await unzipBufferToDir(single.data, tmp);
        } catch (e) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not unpack the archive.', {
            handler: 'skill-upload',
            cause: e,
          });
          return;
        }
      } else {
        for (const part of parts) {
          const abs = resolveUploadPath(tmp, part.relPath);
          if (!abs) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unsafe file path in upload.', {
              handler: 'skill-upload',
              detail: part.relPath,
            });
            return;
          }
          tracedMkdirSync(dirname(abs), { recursive: true });
          tracedWriteFileSync(abs, part.data);
        }
      }

      const dirs = discoverSkillDirs(tmp);
      if (dirs.length === 0) {
        errorResponse(res, 404, 'urn:ok:error:not-found', 'No SKILL.md found in the upload.', {
          handler: 'skill-upload',
        });
        return;
      }
      if (dirs.length > 1) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Upload contains multiple skills; upload one at a time.',
          { handler: 'skill-upload', detail: dirs.map((d) => d.name).join(', ') },
        );
        return;
      }
      const pick = dirs[0];
      respondSkillImport(
        res,
        await skillImportService.runSkillImport({
          acquiredDir: pick.dir,
          scope,
          sourceLabel: `upload:${zipName ?? pick.name}`,
          upstreamSkill: pick.name,
          actor,
        }),
      );
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to upload skill.', {
        handler: 'skill-upload',
        cause: e,
      });
    } finally {
      cleanup();
    }
  }

  return createApiRouteGroup(
    {
      '/api/skill/import': handleSkillImport,
      '/api/skills/import-bulk': handleSkillsImportBulk,
      '/api/skill-upload': handleSkillUpload,
    },
    { mutating: ['/api/skill/import', '/api/skills/import-bulk', '/api/skill-upload'] },
  );
}
