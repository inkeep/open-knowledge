import { existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SKILL_IMPORT_MAX_BUNDLE_FILES,
  SKILL_IMPORT_MAX_FILE_BYTES,
  SKILL_IMPORT_MAX_TOTAL_BYTES,
  type SkillImportSuccessSchema,
} from '@inkeep/open-knowledge-core';
import {
  acquiredBundleTooLarge,
  findByContentHash,
  inspectPluginSource,
  parseSkillDir,
  SKILLS_LOCK_REL,
  upsertLockEntry,
} from '@inkeep/open-knowledge-core/skills-catalog';
import type { z } from 'zod';
import {
  applySkillBundleFileWrite,
  applySkillDelete,
  applySkillWrite,
} from '../content/skills-write.ts';
import type { extractActorIdentity } from '../extract-actor-identity.ts';
import { sanitizeFilename } from '../filename-sanitize.ts';
import { resolveDefaultSkillHomeRel, skillHomeCandidateFolders } from '../in-place-skills.ts';
import { getLogger } from '../logger.ts';
import {
  projectInPlaceSkill,
  resolveSkillTargets,
  skillHostDir,
  skillProjectionRoots,
} from '../skill-projection.ts';
import { mutateSkillsLock, readSkillsLockFile } from '../skills-lock-store.ts';

/**
 * The shared skill-import spine (steps 2-6): given an on-disk skill dir +
 * provenance, dedupe by content hash, land under a free `-imported` name on
 * collision, write SKILL.md + bundle files via the sanctioned writers,
 * attribute + shadow-commit (project scope), record the lockfile entry, and
 * best-effort project into editor dirs. Returns an outcome; the transport
 * writes the response. Used by `/api/skill/import` (by-reference),
 * `/api/skill-upload` (by-bytes), and `/api/skills/import-bulk` (many
 * skills, one clone). The CALLER owns temp-dir cleanup (its `finally`), so
 * this never cleans up.
 */

const log = getLogger('skill-import');

type ActorIdentity = ReturnType<typeof extractActorIdentity>;

export const SKILL_IMPORT_WRITE_LIMITS = {
  maxFileBytes: SKILL_IMPORT_MAX_FILE_BYTES,
  maxFiles: SKILL_IMPORT_MAX_BUNDLE_FILES,
} as const;

export function importedBundleLimitError(
  acquired: NonNullable<ReturnType<typeof parseSkillDir>>,
): string | null {
  if (acquired.files.length > SKILL_IMPORT_MAX_BUNDLE_FILES) {
    return `Skill has ${acquired.files.length} dependent files; the import cap is ${SKILL_IMPORT_MAX_BUNDLE_FILES}.`;
  }
  let totalBytes = Buffer.byteLength(acquired.skillMd);
  for (const file of acquired.files) {
    const bytes = file.bytes?.byteLength ?? Buffer.byteLength(file.content ?? '');
    if (bytes > SKILL_IMPORT_MAX_FILE_BYTES) {
      return `${file.relPath} is ${bytes} bytes; the import per-file cap is ${SKILL_IMPORT_MAX_FILE_BYTES}.`;
    }
    totalBytes += bytes;
  }
  return totalBytes > SKILL_IMPORT_MAX_TOTAL_BYTES
    ? `Skill is ${totalBytes} bytes; the import bundle cap is ${SKILL_IMPORT_MAX_TOTAL_BYTES}.`
    : null;
}

/**
 * What the spine concluded. Returned rather than written so the bulk path
 * can run it once per skill against a SINGLE clone and report per-skill
 * rows; the transport's `respondSkillImport` applies the single-skill HTTP
 * shape.
 */
export type SkillImportOutcome =
  | { ok: true; body: z.infer<typeof SkillImportSuccessSchema> }
  | {
      ok: false;
      status: 400 | 422 | 500;
      urn: 'urn:ok:error:invalid-request' | 'urn:ok:error:internal-server-error';
      title: string;
      detail?: string;
      cause?: unknown;
    };

export interface SkillImportDeps {
  contentDir: string;
  skillsHome: string;
  projectDir?: string;
  resolveSkillDirForRead: (scope: 'project' | 'global', name: string) => string | null;
  parseFrontmatterDoc: (raw: string) => { frontmatter: Record<string, unknown>; body: string };
  attributeOkArtifactWrite: (actor: ActorIdentity, keyPath: string, summary: string) => void;
  commitOkArtifactWrite: (context: string) => Promise<void>;
  shadowHeadSha: (writerId?: string, verifyPathRel?: string) => Promise<string | undefined>;
  artifactWriterId: (actor: ActorIdentity) => string | undefined;
  effectiveInstallMode: (
    scope: 'project' | 'global',
    name: string,
    entry: { hosts: readonly string[]; linkedHosts: readonly string[] },
  ) => 'copy' | 'link';
  signalFiles: () => void;
}

export interface SkillImportService {
  runSkillImport(params: {
    acquiredDir: string;
    scope: 'project' | 'global';
    sourceLabel: string;
    ref?: string;
    publisher?: string;
    upstreamSkill?: string;
    actor: ActorIdentity;
    /** Skip the default-editor auto-projection — for callers that install
     *  explicitly afterwards (explore preview toggles / custom-path place). */
    skipProjection?: boolean;
  }): Promise<SkillImportOutcome>;
}

export function createSkillImportService(deps: SkillImportDeps): SkillImportService {
  function localSkillHash(skillsRoot: string, name: string): string | undefined {
    return parseSkillDir(resolve(skillsRoot, name))?.contentHash;
  }

  return {
    async runSkillImport(params) {
      const { acquiredDir, scope, sourceLabel, ref, publisher, upstreamSkill, actor } = params;
      if (!deps.projectDir) {
        return {
          ok: false,
          status: 400,
          urn: 'urn:ok:error:invalid-request',
          title: 'No project root resolved.',
          detail: 'NO_PROJECT_ROOT',
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

      // 2. Dedupe by contentHash via the lockfile (re-import is a no-op).
      const lockPath = join(
        scope === 'project' ? deps.projectDir : deps.skillsHome,
        ...SKILLS_LOCK_REL,
      );
      const lock = readSkillsLockFile(lockPath);
      // WRITE-PATH INVERSION (store retirement, step 1): NEW imports land
      // IN-PLACE at the vendor-neutral `.agents/skills` hub — versioned, listed,
      // and read at their real path from day one. The store gains no new
      // residents; existing store bundles keep working until their migration.
      const importBase = scope === 'project' ? deps.contentDir : deps.skillsHome;
      const importHomeRel = resolveDefaultSkillHomeRel(importBase, scope);
      if (importHomeRel === null) {
        // Actionable, not just accurate: this refusal is reachable by anyone
        // importing into a project (or home) that has adopted no agent folder,
        // and "no host available" leaves them with nothing to do about it. The
        // folder list comes from the resolver's own candidate set, so onboarding
        // a new host cannot leave this message naming a stale one.
        return {
          ok: false,
          status: 400,
          urn: 'urn:ok:error:invalid-request',
          title: `Open Knowledge only writes skills into an agent folder that already exists (${skillHomeCandidateFolders(scope).join(', ')}) and never creates one for you. Create the folder your agent uses, then import again.`,
          detail: 'NO_USABLE_SKILL_HOME',
        };
      }
      const importRoot = resolve(importBase, importHomeRel);
      const dupName = findByContentHash(lock, acquired.contentHash);
      if (dupName && deps.resolveSkillDirForRead(scope, dupName) !== null) {
        return {
          ok: true,
          body: {
            name: dupName,
            path: `${dupName}/SKILL.md`,
            created: false,
            alreadyImported: true,
            provenance: { source: sourceLabel, ref, contentHash: acquired.contentHash, publisher },
            warnings: [],
          },
        };
      }

      // 3. Collision with an existing skill → land under a free `-imported` name.
      // `acquired.name` is attacker-controlled (imported SKILL.md frontmatter).
      // applySkillWrite's validateName blocks a malformed WRITE, but the existence
      // probes below resolve the name against skillsRoot — sanitize first so a
      // `../…` name can't turn firstFreeSkillName into a filesystem existence
      // oracle. No-op for a normal `[a-z0-9-]` name. (defense-in-depth)
      const probeName = sanitizeFilename(acquired.name);
      // Collision probe spans the WHOLE registry (store + every in-place host
      // dir), not just the import root — a same-name skill at `.claude/skills`
      // would fork against the new `.agents` bundle.
      const nameTaken = (n: string) =>
        deps.resolveSkillDirForRead(scope, n) !== null ||
        existsSync(resolve(importRoot, n, 'SKILL.md'));
      const collided = nameTaken(probeName);
      let targetName = probeName;
      if (collided) {
        targetName = `${probeName}-imported`;
        let n = 2;
        while (nameTaken(targetName)) {
          targetName = `${probeName}-imported-${n}`;
          n += 1;
        }
      }

      // 4. Write SKILL.md + every bundle file via the sanctioned writers. The
      // frontmatter is canonicalized to {name,description} (OK's skill model);
      // upstream version lives in the lockfile, not the SKILL.md.
      const skillBody = deps.parseFrontmatterDoc(acquired.skillMd).body;
      const wr = applySkillWrite({
        skillsRoot: importRoot,
        name: targetName,
        body: skillBody,
        frontmatter: { name: targetName, description: acquired.description },
      });
      if (!wr.ok) {
        return {
          ok: false,
          status: 400,
          urn: 'urn:ok:error:invalid-request',
          title: 'Failed to write imported skill.',
          detail: wr.error.code,
          cause: new Error(wr.error.message),
        };
      }
      const warnings = [...wr.warnings];
      for (const f of acquired.files) {
        const br = applySkillBundleFileWrite({
          skillsRoot: importRoot,
          name: targetName,
          relPath: f.relPath,
          content: f.content,
          bytes: f.bytes,
          limits: SKILL_IMPORT_WRITE_LIMITS,
        });
        if (!br.ok) {
          const rollback = applySkillDelete({ skillsRoot: importRoot, name: targetName });
          return {
            ok: false,
            status: rollback.ok ? 400 : 500,
            urn: rollback.ok
              ? 'urn:ok:error:invalid-request'
              : 'urn:ok:error:internal-server-error',
            title: 'Failed to write the complete imported skill bundle.',
            detail: `${f.relPath}: ${br.error.code}`,
            cause: new Error(
              rollback.ok
                ? br.error.message
                : `${br.error.message}; rollback: ${rollback.error.message}`,
            ),
          };
        }
      }

      // 5. Attribute + shadow-commit (project scope; global is unversioned).
      if (scope === 'project') {
        // Attribute under the content-doc key (`<dir>/SKILL`) that `/api/history`
        // filters on — same fix as the create path; the bare dir key fell through
        // the OkActor match so an imported skill's first version never showed in
        // (or was restorable from) its history.
        deps.attributeOkArtifactWrite(
          actor,
          `${importHomeRel}/${targetName}/SKILL`,
          `skill-import: ${sourceLabel} -> ${importHomeRel}/${targetName}/SKILL.md`,
        );
        await deps.commitOkArtifactWrite('skill-import');
      }

      // 6. Record upstream in the lockfile.
      const importedLocalHash = localSkillHash(importRoot, targetName);
      const importedPlugin = inspectPluginSource(sourceLabel);
      // baselineRef only for project scope — global is unversioned (no commit above).
      const importedBaselineRef =
        scope === 'project'
          ? await deps.shadowHeadSha(deps.artifactWriterId(actor), `${importHomeRel}/${targetName}`)
          : undefined;
      // Re-read inside the serialized mutation: `lock` above was snapshotted before
      // the fetch, and writing that snapshot back would erase any entry a
      // concurrent import added while this one was cloning.
      await mutateSkillsLock(lockPath, (current) =>
        upsertLockEntry(current, targetName, {
          source: sourceLabel,
          ...(importedPlugin ? { pluginProvider: importedPlugin.provider } : {}),
          ref,
          contentHash: acquired.contentHash,
          files: acquired.files.map((file) => file.relPath),
          ...(importedLocalHash !== undefined ? { localHash: importedLocalHash } : {}),
          ...(importedBaselineRef !== undefined ? { baselineRef: importedBaselineRef } : {}),
          publisher,
          importedAt: new Date().toISOString(),
          ...(upstreamSkill !== undefined ? { skill: upstreamSkill } : {}),
        }),
      );

      // Fan the freshly-imported IN-PLACE skill out to the configured editors so
      // it is live in Claude/Cursor/Codex on import (guarded copy/link
      // primitives — never clobbers a differing dir). Best-effort: a projection
      // failure must not fail the import. Skipped when the caller installs
      // explicitly afterwards (`install: false`). Copies auto-pair into the
      // placements ledger at the next re-sync, so forward refresh covers them.
      if (params.skipProjection !== true) {
        try {
          const targets = resolveSkillTargets(importBase);
          if (targets.length > 0) {
            const canonicalAbs = resolve(importRoot, targetName);
            // A re-import lands on a skill that may already occupy editor dirs as
            // copies; only a genuinely fresh one takes the symlink default.
            const projectionRoots = skillProjectionRoots(scope);
            // A re-import can land on dests that already exist; those that are
            // symlinks keep the symlink default, matching what is already there.
            const occupied = targets.filter((editor) => {
              const dest = skillHostDir(importBase, editor, targetName, projectionRoots);
              return dest !== null && dest !== canonicalAbs && existsSync(dest);
            });
            const occupiedLinks = occupied.filter((editor) => {
              const dest = skillHostDir(importBase, editor, targetName, projectionRoots);
              try {
                return dest !== null && lstatSync(dest).isSymbolicLink();
              } catch {
                return false;
              }
            });
            projectInPlaceSkill({
              canonicalAbs,
              canonicalHash: parseSkillDir(canonicalAbs)?.contentHash ?? '',
              canonicalRootRel: importHomeRel,
              name: targetName,
              cwd: importBase,
              targets,
              mode: deps.effectiveInstallMode(scope, targetName, {
                hosts: ['<source>', ...occupied],
                linkedHosts: occupiedLinks,
              }),
              roots: skillProjectionRoots(scope),
            });
          }
        } catch (err) {
          log.warn({ err, skill: targetName }, 'post-import editor fan-out failed (import kept)');
        }
      }

      deps.signalFiles();
      return {
        ok: true,
        body: {
          name: targetName,
          path: `${importHomeRel}/${targetName}/SKILL.md`,
          created: wr.created,
          alreadyImported: false,
          ...(collided ? { collisionRenamedFrom: acquired.name } : {}),
          provenance: { source: sourceLabel, ref, contentHash: acquired.contentHash, publisher },
          warnings,
        },
      };
    },
  };
}
