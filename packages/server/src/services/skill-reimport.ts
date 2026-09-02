import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { RENAMED_PACK_SKILLS, type SkillReimportSuccessSchema } from '@inkeep/open-knowledge-core';
import {
  acquiredBundleTooLarge,
  packMarkerOf,
  parseSkillDir,
  type SkillLockEntry,
  type SkillsLock,
  upsertLockEntry,
} from '@inkeep/open-knowledge-core/skills-catalog';
import simpleGit from 'simple-git';
import type { z } from 'zod';
import {
  applySkillBundleFileDelete,
  applySkillBundleFileWrite,
  applySkillWrite,
} from '../content/skills-write.ts';
import type { extractActorIdentity } from '../extract-actor-identity.ts';
import { mutateSkillsLock } from '../skills-lock-store.ts';
import { importedBundleLimitError, SKILL_IMPORT_WRITE_LIMITS } from './skill-import.ts';

type ActorIdentity = ReturnType<typeof extractActorIdentity>;

export type SkillReimportOutcome =
  | { ok: true; body: z.infer<typeof SkillReimportSuccessSchema> }
  | {
      ok: false;
      status: 400 | 404 | 422 | 500;
      urn:
        | 'urn:ok:error:invalid-request'
        | 'urn:ok:error:not-found'
        | 'urn:ok:error:internal-server-error';
      title: string;
      detail?: string;
      cause?: unknown;
    };

export interface SkillReimportDeps {
  contentDir: string;
  skillsHome: string;
  projectDir?: string;
  legacyStoreRoot: string;
  effectiveSkillRoot: (
    scope: 'project' | 'global',
    name: string,
  ) => { root: string; dirRel: string; realDir: string | null };
  parseFrontmatterDoc: (raw: string) => { frontmatter: Record<string, unknown>; body: string };
  attributeOkArtifactWrite: (actor: ActorIdentity, keyPath: string, summary: string) => void;
  commitOkArtifactWrite: (context: string) => Promise<void>;
  shadowHeadSha: (writerId?: string, verifyPathRel?: string) => Promise<string | undefined>;
  artifactWriterId: (actor: ActorIdentity) => string | undefined;
  skillArtifactKey: (name: string) => string;
  captureAndCloseDocuments: (docNames: string[], status: 'deleted-upstream') => Promise<unknown>;
  projectImportedSkillCopy: (args: {
    skillsRoot: string;
    name: string;
    scope: 'project' | 'global';
    hasScripts: boolean;
    handler: string;
  }) => Promise<void>;
  signalFiles: () => void;
}

export interface SkillReimportService {
  runSkillReimport(params: {
    acquiredDir: string;
    name: string;
    scope: 'project' | 'global';
    entry: SkillLockEntry;
    lockPath: string;
    ref?: string;
    actor: ActorIdentity;
    dryRun?: boolean;
  }): Promise<SkillReimportOutcome>;
}

export function pickReimportDir<T extends { name: string; dir: string }>(
  dirs: readonly T[],
  opts: {
    recordedSkill?: string;
    localName: string;
    frontmatterNameOf: (dir: string) => string | undefined;
  },
): T | undefined {
  const { recordedSkill, localName, frontmatterNameOf } = opts;
  return (
    (recordedSkill ? dirs.find((d) => d.name === recordedSkill) : undefined) ??
    dirs.find((d) => d.name === localName) ??
    dirs.find((d) => frontmatterNameOf(d.dir) === localName) ??
    dirs.find((d) => d.name === RENAMED_PACK_SKILLS[recordedSkill ?? localName]) ??
    (dirs.length === 1 ? dirs[0] : undefined)
  );
}

export function planReimportDiff(input: {
  upstreamHash: string;
  upstreamFiles: readonly string[];
  entry: Pick<SkillLockEntry, 'contentHash' | 'files' | 'localHash'>;
  local: { contentHash: string; files: readonly string[] } | null;
}): { upToDate: boolean; removedUpstream: string[] } {
  const upstreamPaths = new Set(input.upstreamFiles);
  const localPaths = new Set(input.local?.files ?? []);
  const priorUpstreamPaths =
    input.entry.files ??
    (input.entry.localHash !== undefined && input.local?.contentHash === input.entry.localHash
      ? [...localPaths]
      : []);
  const removedUpstream = priorUpstreamPaths
    .filter((path) => !upstreamPaths.has(path))
    .filter((path) => localPaths.has(path));
  return {
    upToDate: input.upstreamHash === input.entry.contentHash && removedUpstream.length === 0,
    removedUpstream,
  };
}

export function groupReimportNamesBySource(
  names: readonly string[],
  entryFor: (name: string) => SkillLockEntry | null,
): { bySource: { source: string; names: string[] }[]; unrecorded: string[] } {
  const bySource = new Map<string, string[]>();
  const unrecorded: string[] = [];
  for (const name of new Set(names)) {
    const entry = entryFor(name);
    if (!entry) {
      unrecorded.push(name);
      continue;
    }
    const bucket = bySource.get(entry.source);
    if (bucket) bucket.push(name);
    else bySource.set(entry.source, [name]);
  }
  return {
    bySource: [...bySource].map(([source, sourceNames]) => ({ source, names: sourceNames })),
    unrecorded,
  };
}

export function createSkillReimportService(deps: SkillReimportDeps): SkillReimportService {
  return {
    async runSkillReimport(params) {
      const { acquiredDir, name, scope, entry, lockPath, ref, actor } = params;
      const reimportBase = scope === 'global' ? deps.skillsHome : deps.contentDir;
      const {
        root: skillsRoot,
        dirRel: skillDirRel,
        realDir,
      } = deps.effectiveSkillRoot(scope, name);
      const inPlaceSkill = !skillDirRel.startsWith(`${deps.legacyStoreRoot}/`);
      if (realDir === null || !existsSync(resolve(reimportBase, skillDirRel, 'SKILL.md'))) {
        return {
          ok: false,
          status: 404,
          urn: 'urn:ok:error:not-found',
          title: 'Skill is not installed.',
          detail: 'SKILL_ABSENT',
        };
      }

      const oversize = acquiredBundleTooLarge(acquiredDir);
      if (oversize) {
        return {
          ok: false,
          status: 400,
          urn: 'urn:ok:error:invalid-request',
          title: 'Skill bundle exceeds import limits.',
          detail: oversize,
        };
      }
      const acquired = parseSkillDir(acquiredDir);
      if (!acquired) {
        return {
          ok: false,
          status: 422,
          urn: 'urn:ok:error:invalid-request',
          title: 'Source has no readable skill.',
        };
      }
      const limitError = importedBundleLimitError(acquired);
      if (limitError) {
        return {
          ok: false,
          status: 400,
          urn: 'urn:ok:error:invalid-request',
          title: 'Skill bundle exceeds import limits.',
          detail: limitError,
        };
      }

      const localBefore = parseSkillDir(resolve(skillsRoot, name));
      const { upToDate, removedUpstream } = planReimportDiff({
        upstreamHash: acquired.contentHash,
        upstreamFiles: acquired.files.map((f) => f.relPath),
        entry,
        local: localBefore
          ? { contentHash: localBefore.contentHash, files: localBefore.files.map((f) => f.relPath) }
          : null,
      });
      if (upToDate) {
        return { ok: true, body: { name, updated: false, source: entry.source, warnings: [] } };
      }

      const acquiredDoc = deps.parseFrontmatterDoc(acquired.skillMd);
      const skillBody = acquiredDoc.body;
      const acquiredPack = packMarkerOf(acquiredDoc.frontmatter);

      if (params.dryRun) {
        let gitTracked: boolean | undefined;
        if (scope === 'project' && deps.projectDir) {
          try {
            const pg = simpleGit({ baseDir: deps.projectDir, timeout: { block: 15_000 } });
            const rel = relative(deps.projectDir, resolve(skillsRoot, name)).split(sep).join('/');
            gitTracked = (await pg.raw('ls-files', '--', rel)).trim().length > 0;
          } catch {
            gitTracked = undefined;
          }
        }
        return {
          ok: true,
          body: {
            name,
            updated: true,
            source: entry.source,
            localBody: deps.parseFrontmatterDoc(localBefore?.skillMd ?? '').body,
            upstreamBody: skillBody,
            ...(gitTracked !== undefined ? { gitTracked } : {}),
            warnings: [],
          },
        };
      }

      if (scope === 'project') {
        const removedMarkdownDocs = removedUpstream
          .filter((path) => /\.mdx?$/i.test(path))
          .map((path) => `${skillDirRel}/${path.replace(/\.mdx?$/i, '')}`);
        if (removedMarkdownDocs.length > 0) {
          await deps.captureAndCloseDocuments(removedMarkdownDocs, 'deleted-upstream');
        }
      }
      const wr = applySkillWrite({
        skillsRoot,
        name,
        body: skillBody,
        frontmatter: {
          name,
          description: acquired.description,
          ...(acquiredPack !== undefined ? { metadata: { pack: acquiredPack } } : {}),
        },
      });
      if (!wr.ok) {
        return {
          ok: false,
          status: 400,
          urn: 'urn:ok:error:invalid-request',
          title: 'Failed to write skill.',
          detail: wr.error.code,
          cause: new Error(wr.error.message),
        };
      }
      const warnings = [...wr.warnings];
      for (const f of acquired.files) {
        const br = applySkillBundleFileWrite({
          skillsRoot,
          name,
          relPath: f.relPath,
          content: f.content,
          bytes: f.bytes,
          limits: SKILL_IMPORT_WRITE_LIMITS,
        });
        if (!br.ok) {
          return {
            ok: false,
            status: 500,
            urn: 'urn:ok:error:internal-server-error',
            title: 'Failed to write the complete refreshed skill bundle.',
            detail: `${f.relPath}: ${br.error.code}`,
            cause: new Error(br.error.message),
          };
        }
      }
      for (const relPath of removedUpstream) {
        const deleted = applySkillBundleFileDelete({ skillsRoot, name, relPath });
        if (!deleted.ok) {
          return {
            ok: false,
            status: 500,
            urn: 'urn:ok:error:internal-server-error',
            title: 'Failed to reconcile files removed upstream.',
            detail: `${relPath}: ${deleted.error.code}`,
            cause: new Error(deleted.error.message),
          };
        }
      }

      if (scope === 'project') {
        deps.attributeOkArtifactWrite(
          actor,
          deps.skillArtifactKey(name),
          `skill-reimport: ${entry.source} -> ${skillDirRel}`,
        );
        await deps.commitOkArtifactWrite('skill-reimport');
      }

      const reimportLocalHash = parseSkillDir(resolve(skillsRoot, name))?.contentHash;
      const reimportBaselineRef =
        scope === 'project'
          ? await deps.shadowHeadSha(deps.artifactWriterId(actor), skillDirRel)
          : undefined;
      await mutateSkillsLock(lockPath, (current: SkillsLock) =>
        upsertLockEntry(current, name, {
          ...(current.skills[name] ?? entry),
          contentHash: acquired.contentHash,
          files: acquired.files.map((file) => file.relPath),
          ...(reimportLocalHash !== undefined ? { localHash: reimportLocalHash } : {}),
          ...(reimportBaselineRef !== undefined ? { baselineRef: reimportBaselineRef } : {}),
          ref,
          importedAt: new Date().toISOString(),
        }),
      );

      if (!inPlaceSkill && scope === 'project') {
        await deps.projectImportedSkillCopy({
          skillsRoot,
          name,
          scope: 'project',
          hasScripts: acquired.files.some((f) => f.relPath.startsWith('scripts/')),
          handler: 'skill-reimport',
        });
      }

      deps.signalFiles();
      return { ok: true, body: { name, updated: true, source: entry.source, warnings } };
    },
  };
}
