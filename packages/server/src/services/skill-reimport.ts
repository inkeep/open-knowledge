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

/**
 * The shared skill-reimport spine: given an already-fetched upstream skill dir
 * plus the lockfile entry it came from, decide whether anything changed,
 * overwrite the bundle IN PLACE (same name — no `-imported` rename), prune the
 * files upstream dropped, attribute + shadow-commit (project scope), refresh the
 * lockfile entry, and re-project into editor dirs. Returns an outcome; the
 * transport writes the response. Used by `/api/skill/reimport` (one skill, one
 * clone) and `/api/skills/reimport-bulk` (many skills, one clone per source).
 * The CALLER owns the fetch and its temp-dir cleanup.
 */

type ActorIdentity = ReturnType<typeof extractActorIdentity>;

/**
 * What the spine concluded. Returned rather than written so the bulk path can
 * run it once per skill against a SINGLE clone and report per-skill rows.
 */
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
  /** The retired store root, used only to tell an in-place bundle from a resident. */
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
  /** The content-doc attribution key for a skill (`<dir>/SKILL`). */
  skillArtifactKey: (name: string) => string;
  /** Tear down live Y.Docs for markdown files the upstream dropped, before unlink. */
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
    /** The upstream skill dir inside the caller's fetched clone. */
    acquiredDir: string;
    name: string;
    scope: 'project' | 'global';
    /** The lockfile entry this skill was installed from (possibly synthesized). */
    entry: SkillLockEntry;
    lockPath: string;
    /** The resolved upstream sha from the caller's fetch. */
    ref?: string;
    actor: ActorIdentity;
    /** Preview only — report the two bodies for the confirm dialog, write nothing. */
    dryRun?: boolean;
  }): Promise<SkillReimportOutcome>;
}

/**
 * Which upstream dir a skill re-selects, in precedence order: the recorded dir
 * basename, the local skill's name, a bundle whose frontmatter carries that
 * name, the renamed-pack alias, then the sole skill in a single-skill source.
 *
 * The rename alias matters because a pre-rename install asks for a name the repo
 * no longer ships; that resolves today only while the superseded listing is
 * still up, so retiring old listings must not break Update for everyone who
 * installed from one.
 *
 * `frontmatterNameOf` is injected because the real one reads and hashes every
 * byte of a bundle — the precedence is the part worth pinning, not the parse.
 */
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

/**
 * Is the local bundle already what upstream ships, and which of its files did
 * upstream drop?
 *
 * New lock entries carry the prior upstream manifest, which lets us delete only
 * files the upstream used to own. For legacy entries, the whole local bundle is
 * a safe ownership witness only while it still matches the recorded local
 * baseline. Once local bytes diverge, an untracked file may be user-authored and
 * must never be inferred away.
 */
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

/**
 * Split requested skill names by the upstream each records, so a bulk update
 * clones once per SOURCE rather than once per skill — the same amortization
 * bulk import exists for. Names with no lock entry come back separately: there
 * is no upstream to update them from.
 */
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
      // The bundle's REAL root at either scope (in-place-first; store fallback),
      // so Update rewrites the bundle where it actually lives. Global skills are
      // provenance-tracked via `~/.ok/skills-lock.json` (seeded runtime skills
      // record it from birth) but UNVERSIONED — no shadow attribution below.
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

      // Pre-flight the caps by stat, BEFORE the parse materializes every byte —
      // `importedBundleLimitError` below runs on an already-built array, which a
      // repo of half-gigabyte blobs never reaches.
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
      // Already up to date — nothing to write. (The temp dir is the caller's to
      // drop, so nothing is cleaned up here.)
      if (upToDate) {
        return { ok: true, body: { name, updated: false, source: entry.source, warnings: [] } };
      }

      // Overwrite the skill in place (same name — no `-imported` rename), same
      // sanctioned writers + frontmatter canonicalization as import.
      const acquiredDoc = deps.parseFrontmatterDoc(acquired.skillMd);
      const skillBody = acquiredDoc.body;
      const acquiredPack = packMarkerOf(acquiredDoc.frontmatter);

      // Preview: upstream differs — report the two bodies for the confirm dialog
      // and write nothing. (Reached only when the hashes diverge, above.)
      if (params.dryRun) {
        // Auto-update gate input: a PROJECT bundle with tracked files updates
        // through the repo (pull / CI), never the per-machine auto loop — two
        // machines auto-updating with autoSync on churn-wars the lockfile and
        // bundle.
        let gitTracked: boolean | undefined;
        if (scope === 'project' && deps.projectDir) {
          try {
            const pg = simpleGit({ baseDir: deps.projectDir, timeout: { block: 15_000 } });
            const rel = relative(deps.projectDir, resolve(skillsRoot, name)).split(sep).join('/');
            gitTracked = (await pg.raw('ls-files', '--', rel)).trim().length > 0;
          } catch {
            gitTracked = undefined; // not a git repo / unborn index — no gate
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
      // Same one upstream key as import: an update must not strip the identity
      // marker its own install carried, or the first Update would undo it.
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
      // The caller's `entry` predates the upstream fetch — re-read inside the
      // serialized mutation so a concurrent import's entry survives this write.
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

      // Re-project the refreshed skill into the configured editor dirs (same
      // best-effort copy projection as import — a failure must not fail the
      // update; reconcile re-projects on the next open). An IN-PLACE skill's
      // bundle already IS an editor dir — no projection.
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
