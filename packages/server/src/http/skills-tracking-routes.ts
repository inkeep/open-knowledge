import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, resolve, sep } from 'node:path';
import {
  LEGACY_SKILL_STORE_ROOT,
  SkillTrackInGitRequestSchema,
  SkillTrackInGitSuccessSchema,
} from '@inkeep/open-knowledge-core';
import type { ContentFilter } from '../content-filter.ts';
import { scanInPlaceSkills } from '../in-place-skills.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { catchErrors } from './catch-errors.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsTrackingRouteDeps {
  contentDir: string;
  projectDir: string | undefined;
  contentFilter: ContentFilter | undefined;
  validateSkillName: (name: string, res: ServerResponse, handler: string) => boolean;
  indexedSkillContentPath: (absolutePath: string, contentDir: string) => string | null;
  bumpSkillsCatalogGen: () => void;
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
}

export function createSkillsTrackingRoutes(deps: SkillsTrackingRouteDeps): ApiRouteGroup {
  const {
    contentDir,
    projectDir,
    contentFilter,
    validateSkillName,
    indexedSkillContentPath,
    bumpSkillsCatalogGen,
    signalChannel,
  } = deps;
  function trackInGitLine(skillDirRel: string): string {
    const root = dirname(skillDirRel);
    return `!/${root.split(sep).join('/')}/`;
  }

  const handleSkillTrackInGit = withValidation(
    SkillTrackInGitRequestSchema,
    catchErrors(
      async (_req, res, body) => {
        if (!validateSkillName(body.name, res, 'skill-track-in-git')) return;
        if (body.scope !== 'project') {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Only project skills live in the repository; a global skill is outside any .gitignore.',
            { handler: 'skill-track-in-git' },
          );
          return;
        }
        if (!projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project directory.', {
            handler: 'skill-track-in-git',
          });
          return;
        }
        const inPlace = scanInPlaceSkills(contentDir).find((s) => s.name === body.name);
        const mountedDirRel = inPlace?.dir ?? `${LEGACY_SKILL_STORE_ROOT}/${body.name}`;
        const indexedFileRel =
          indexedSkillContentPath(resolve(contentDir, mountedDirRel, 'SKILL.md'), contentDir) ??
          `${mountedDirRel}/SKILL.md`;
        const skillDirRel = dirname(indexedFileRel);
        const skillFileRel = indexedFileRel;
        const line = trackInGitLine(skillDirRel);
        const gitignoreRel = '.gitignore';
        const gitignoreAbs = resolve(contentDir, gitignoreRel);

        if (contentFilter && !contentFilter.isPathIgnored(skillFileRel)) {
          successResponse(
            res,
            200,
            SkillTrackInGitSuccessSchema,
            { line, gitignorePath: gitignoreRel, applied: false, alreadyTracked: true },
            { handler: 'skill-track-in-git' },
          );
          return;
        }
        if (body.apply !== true) {
          successResponse(
            res,
            200,
            SkillTrackInGitSuccessSchema,
            { line, gitignorePath: gitignoreRel, applied: false },
            { handler: 'skill-track-in-git' },
          );
          return;
        }

        const before = existsSync(gitignoreAbs) ? readFileSync(gitignoreAbs, 'utf-8') : null;
        const lines = (before ?? '').split('\n');
        if (lines.some((l) => l.trim() === line)) {
          errorResponse(
            res,
            409,
            'urn:ok:error:invalid-request',
            `"${line}" is already in ${gitignoreRel}, but ${skillFileRel} is still ignored — another rule excludes it.`,
            { handler: 'skill-track-in-git' },
          );
          return;
        }
        const next = `${before === null || before.endsWith('\n') || before === '' ? (before ?? '') : `${before}\n`}${line}\n`;
        writeFileSync(gitignoreAbs, next, 'utf-8');
        bumpSkillsCatalogGen();
        await contentFilter?.rebuildIgnorePatterns();

        if (contentFilter?.isPathIgnored(skillFileRel)) {
          if (before === null) rmSync(gitignoreAbs, { force: true });
          else writeFileSync(gitignoreAbs, before, 'utf-8');
          bumpSkillsCatalogGen();
          await contentFilter.rebuildIgnorePatterns();
          errorResponse(
            res,
            409,
            'urn:ok:error:invalid-request',
            `Adding "${line}" did not make ${skillFileRel} trackable — another .gitignore rule excludes a parent directory. ${gitignoreRel} was left unchanged.`,
            { handler: 'skill-track-in-git' },
          );
          return;
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillTrackInGitSuccessSchema,
          { line, gitignorePath: gitignoreRel, applied: true },
          { handler: 'skill-track-in-git' },
        );
      },
      { handler: 'skill-track-in-git', title: 'Failed to update .gitignore.' },
    ),
    { handler: 'skill-track-in-git', method: 'POST' },
  );

  return createApiRouteGroup(
    { '/api/skill/track-in-git': handleSkillTrackInGit },
    { mutating: ['/api/skill/track-in-git'] },
  );
}
