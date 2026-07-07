/**
 * Skill install reconcile — the detect / adopt / heal pass that runs on project
 * open (and on skill create/delete). It brings the on-disk reality into line
 * with the symlink install model: every editor skill entry is either absent or
 * a symlink into `.ok/skills/<name>`; no real-dir skill copies linger in editor
 * dirs. Install state is the on-disk symlink reality — the marker is only a
 * cache, refreshed here as a side effect.
 *
 * Per-entry taxonomy for an editor skill dir entry `<name>`:
 *
 * | on-disk state                                   | meaning        | action                       |
 * |-------------------------------------------------|----------------|------------------------------|
 * | symlink → `.ok/skills/<name>`                   | managed        | none                         |
 * | absent                                          | not installed  | none                         |
 * | symlink, broken / wrong target, source present  | drifted link   | heal → re-point              |
 * | symlink, no `.ok/skills/<name>` source          | orphan link    | remove the dangling link     |
 * | real dir, `.ok/skills/<name>` absent            | foreign/legacy | adopt → move in + symlink *(only if project OK-managed; else leave untouched)* |
 * | real dir, source present, same content          | redundant copy | replace with a symlink       |
 * | real dir, same skill (frontmatter-only diff)     | redundant copy | replace with a symlink       |
 * | real dir, source present, different skill        | collision      | suffix-adopt `<name>-<editor>` *(only if project OK-managed; else leave untouched)* |
 *
 * **Project-managed gate.** The two IMPORT rows (adopt, collision) write a
 * NON-`.ok` skill into `.ok/skills`, so they only run when the project is
 * OK-managed (`manageEditorSkills`, default off — `isProjectSkillManaged`,
 * `skill-management.ts`). Off ⇒ the foreign editor entry is left untouched
 * (`result.skipped`). Membership in `.ok/skills` is the ownership boundary: every
 * other row manages a skill OK already owns and runs regardless of the gate.
 *
 * "Same content" is byte-equality; "same skill" additionally treats two copies
 * as one when their SKILL.md differs only in frontmatter serialization (folded
 * vs flow YAML) or additive fields (one carries `argument-hint`, the other does
 * not) with an identical body and identical sibling files. Only a genuinely
 * different skill — different body, or a shared frontmatter field with a
 * conflicting value — is a collision. Without this, the cross-harness skill sync
 * (which reformats / extends frontmatter across runs) would make every managed
 * skill re-collide on each boot and spawn `<name>-<editor>` duplicates.
 *
 * Detection scans every editor's skills root AND the generic `.agents/skills`
 * broadcast dir, since a foreign skill can pre-exist in any of them. OK's own
 * shipped bundle (`open-knowledge` / `open-knowledge-discovery`) is a copy
 * exception and is left untouched.
 *
 * Adopt moves a foreign source into `.ok/skills`, making it a managed
 * (versionable) skill. Shadow attribution of a boot-time adopt is deferred to
 * the source's next edit through the normal skills-write spine — the moved
 * bytes land safely under `.ok/skills` and are never deleted (collisions are
 * suffix-adopted, recoverable).
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
  SKILL_NAME_REGEX,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import {
  tracedCpSync,
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmSync,
  tracedSymlinkSync,
} from './fs-traced.ts';
import { readInstalledSkills, recordSkillInstall } from './installed-skills-marker.ts';
import { getLogger } from './logger.ts';
import { isProjectSkillManaged } from './skill-management.ts';
import { hostSkillsRootEscapes, validateSkillForInstall } from './skill-projection.ts';

const logger = getLogger('skill-reconcile');

/** OK's shipped bundles — copy-installed, excluded from the reconcile invariant. */
const SHIPPED_BUNDLE_NAMES = new Set(['open-knowledge', 'open-knowledge-discovery']);

/** Per-editor action recorded for one reconciled entry. */
interface ReconcileAction {
  name: string;
  /** The editor whose dir held the entry; `null` for the generic `.agents` dir. */
  editor: EditorId | null;
}

export interface ReconcileResult {
  healed: ReconcileAction[];
  adopted: ReconcileAction[];
  replaced: ReconcileAction[];
  collided: ReconcileAction[];
  orphansRemoved: ReconcileAction[];
  /**
   * Foreign editor-dir skills (no `.ok/skills/<name>` source, or a colliding
   * different skill) left UNTOUCHED because the project is not OK-managed
   * (`manageEditorSkills` off). These would have been adopted/suffix-adopted only
   * after an explicit import opt-in — see `skill-management.ts`.
   */
  skipped: ReconcileAction[];
}

/** Detection root = an editor skills dir to scan, with its editor id (null = generic `.agents`). */
interface DetectionRoot {
  /** Project-relative skills root, e.g. `.claude/skills`. */
  rel: string;
  editor: EditorId | null;
}

function detectionRoots(): DetectionRoot[] {
  const roots: DetectionRoot[] = [];
  for (const id of PROJECT_SKILL_EDITOR_IDS) {
    const rel = EDITOR_PROJECT_SKILL_ROOT[id];
    if (rel !== null) roots.push({ rel, editor: id });
  }
  // The generic broadcast dir is scanned for foreign skills but is not any
  // editor's per-editor install root, so it carries no marker host.
  roots.push({ rel: '.agents/skills', editor: null });
  return roots;
}

/** The link target for an in-project source: relative (portable). */
function relativeLinkTarget(hostRoot: string, sourceDir: string): string {
  const rel = relative(hostRoot, resolve(sourceDir));
  return isAbsolute(rel) ? resolve(sourceDir) : rel;
}

/** Beyond this total byte size we skip the byte-compare and treat the dirs as
 *  NOT equal (a collision) — runs at boot, so we don't block startup reading a
 *  multi-MB reference dataset. "Not equal" is the safe default: the collision
 *  path preserves both copies (suffix-adopt), never deletes. */
const DIRS_EQUAL_MAX_BYTES = 1_048_576;

/** Recursively compare two dirs by file set + byte content (size-capped). */
function dirsEqual(a: string, b: string): boolean {
  const listA = listFiles(a);
  const listB = listFiles(b);
  if (listA.length !== listB.length) return false;
  let total = 0;
  for (let i = 0; i < listA.length; i += 1) {
    if (listA[i] !== listB[i]) return false;
    const rel = listA[i] as string;
    const fileA = join(a, rel);
    const fileB = join(b, rel);
    total += statSync(fileA).size + statSync(fileB).size;
    if (total > DIRS_EQUAL_MAX_BYTES) return false; // too large to byte-compare cheaply
    if (!readFileSync(fileA).equals(readFileSync(fileB))) return false;
  }
  return true;
}

/**
 * Parse a SKILL.md into its frontmatter object + body. Frontmatter is parsed as
 * YAML so serialization differences (a folded multi-line `description:` vs the
 * same value on one line) collapse to the same object. Unparseable frontmatter
 * yields `{}` — the body comparison still gates, and the safe fallback is
 * "not the same" (a collision preserves both copies). The cross-harness
 * auto-gen annotation lives in the body and is identical for two copies of the
 * same source skill, so it needs no special handling.
 */
function parseSkillManifest(md: string): { fm: Record<string, unknown>; body: string } {
  const { frontmatter: fenced, body } = stripFrontmatter(md);
  let fm: Record<string, unknown> = {};
  if (fenced !== '') {
    try {
      const parsed = parseYaml(unwrapFrontmatterFences(fenced));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fm = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed YAML — treat as no fields; the body compare still discriminates.
    }
  }
  return { fm, body };
}

/**
 * Are two SKILL.md manifests the SAME skill? Bodies must match exactly, and no
 * frontmatter key present in BOTH may carry a different value. A field present
 * on only one side (e.g. a newer snapshot gained `argument-hint`) is ADDITIVE
 * and does NOT make them different skills — it is the same skill at a different
 * frontmatter completeness. A genuine value conflict on a shared key (or any
 * body difference) returns false. One-directional key iteration is sufficient:
 * keys unique to either side are additive; shared keys are all visited here.
 */
function skillManifestsSame(mdA: string, mdB: string): boolean {
  const a = parseSkillManifest(mdA);
  const b = parseSkillManifest(mdB);
  if (a.body !== b.body) return false;
  for (const key of Object.keys(a.fm)) {
    if (key in b.fm && JSON.stringify(a.fm[key]) !== JSON.stringify(b.fm[key])) return false;
  }
  return true;
}

/**
 * Are two skill DIRS the same skill differing only in SKILL.md frontmatter
 * serialization or additive fields? Same file set, every non-`SKILL.md` file
 * byte-identical (scripts / references are code — a real diff there is a genuine
 * variant), and the two `SKILL.md` manifests pass `skillManifestsSame`.
 *
 * This is the gate that prevents the cross-harness sync's reformatted /
 * field-extended host copies (folded vs flow `description:`, a newly-added
 * `argument-hint:`) from misreading as a collision and spawning duplicate
 * `<name>-<editor>` skills. Byte-equality (`dirsEqual`) is the fast path; this is
 * the identity-aware fallback before declaring a true collision.
 */
function sameSkillModuloFrontmatter(a: string, b: string): boolean {
  const listA = listFiles(a);
  const listB = listFiles(b);
  if (listA.length !== listB.length) return false;
  let total = 0;
  for (let i = 0; i < listA.length; i += 1) {
    if (listA[i] !== listB[i]) return false;
    const rel = listA[i] as string;
    const fileA = join(a, rel);
    const fileB = join(b, rel);
    total += statSync(fileA).size + statSync(fileB).size;
    if (total > DIRS_EQUAL_MAX_BYTES) return false; // too large to compare cheaply → not-same (safe)
    const bufA = readFileSync(fileA);
    const bufB = readFileSync(fileB);
    if (bufA.equals(bufB)) continue;
    // Only SKILL.md may differ (modulo frontmatter); any other file diff is a real variant.
    if (rel !== 'SKILL.md') return false;
    if (!skillManifestsSame(bufA.toString('utf8'), bufB.toString('utf8'))) return false;
  }
  return true;
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Move a directory, falling back to copy+remove when rename crosses devices. */
function moveDir(from: string, to: string): void {
  tracedMkdirSync(dirname(to), { recursive: true });
  try {
    tracedRenameSync(from, to);
  } catch (err: unknown) {
    // ONLY fall back to copy+remove on a cross-device rename. A bare catch would
    // copy+delete on EACCES/ENOSPC/ENOENT too — a partial copy followed by a
    // successful delete destroys the user's source.
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    tracedCpSync(from, to, { recursive: true });
    tracedRmSync(from, { recursive: true, force: true });
  }
}

/** Place a symlink at `linkPath` pointing to the in-project `sourceDir`. */
function linkInto(hostRoot: string, linkPath: string, sourceDir: string): void {
  tracedRmSync(linkPath, { recursive: true, force: true });
  tracedMkdirSync(hostRoot, { recursive: true });
  tracedSymlinkSync(relativeLinkTarget(hostRoot, sourceDir), linkPath, 'dir');
}

/** Does an editor entry symlink resolve to the expected `.ok/skills/<name>` source? */
function pointsAtSource(linkPath: string, sourceDir: string): boolean {
  try {
    const raw = readlinkSync(linkPath);
    const resolved = isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw);
    return resolve(resolved) === resolve(sourceDir);
  } catch {
    return false;
  }
}

/**
 * Count the distinct editor-dir skills that an import would ADOPT — real-dir
 * skills (valid name, not OK's shipped bundle) that are NOT already a managed /
 * redundant copy of an existing `.ok/skills/<name>`. These are exactly the
 * entries the gated adopt + collision branches act on when the project is
 * OK-managed; with management off they are left untouched. Deduped by name
 * across detection roots (a skill mirrored into both `.agents` and `.codex`
 * counts once) so the count reads as "N skills you could import", not N copies.
 * Drives the import-prompt affordance — non-mutating.
 */
export function countImportableEditorSkills(opts: {
  projectDir: string;
  skillsRoot: string;
}): number {
  const { projectDir, skillsRoot } = opts;
  const importable = new Set<string>();
  for (const { rel } of detectionRoots()) {
    const hostRoot = resolve(projectDir, rel);
    if (!existsSync(hostRoot) || hostSkillsRootEscapes(projectDir, hostRoot)) continue;
    let entries: string[];
    try {
      entries = readdirSync(hostRoot);
    } catch (err) {
      // A host root we can see but not read (EACCES/corruption) is skipped —
      // log it so a permissions issue doesn't silently masquerade as "nothing
      // to reconcile" (no heal/adopt/orphan-removal, no evidence why).
      logger.warn(
        { hostRoot, err: (err as Error).message },
        'reconcile: skipped unreadable host skills root',
      );
      continue;
    }
    for (const name of entries) {
      if (SHIPPED_BUNDLE_NAMES.has(name) || !SKILL_NAME_REGEX.test(name)) continue;
      const entryPath = join(hostRoot, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(entryPath);
      } catch {
        continue;
      }
      // Only real dirs are import candidates — symlinks are already managed
      // (or orphan links handled by reconcile), never adopted.
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const sourceDir = resolve(skillsRoot, name);
      if (
        existsSync(sourceDir) &&
        (dirsEqual(entryPath, sourceDir) || sameSkillModuloFrontmatter(entryPath, sourceDir))
      ) {
        // Redundant copy of an already-managed `.ok` skill — collapses to a
        // symlink regardless of the gate, so it is not "importable".
        continue;
      }
      importable.add(name);
    }
  }
  return importable.size;
}

/**
 * Reconcile every editor skill dir under `projectDir` against the `.ok/skills`
 * source tree. Best-effort + isolated: one entry's failure is logged and
 * skipped, never aborting the pass. Marker host sets are refreshed for adopts /
 * redundant-copy replacements so the Skills list badges them Installed.
 */
export async function reconcileSkillInstalls(opts: {
  projectDir: string;
  /** Absolute `.ok/skills` dir holding authored (project-scope) sources. */
  skillsRoot: string;
}): Promise<ReconcileResult> {
  const { projectDir, skillsRoot } = opts;
  const result: ReconcileResult = {
    healed: [],
    adopted: [],
    replaced: [],
    collided: [],
    orphansRemoved: [],
    skipped: [],
  };
  // Project-level gate: may OK ADOPT non-`.ok` editor skills here? Default off.
  // Read once per pass (env + the per-machine marker). Managing skills that
  // already have a `.ok/skills` entry — heal / orphan / redundant-collapse — is
  // independent of this and always runs.
  const managed = isProjectSkillManaged(projectDir);
  // Marker host additions to apply after the FS pass (name → set of editor ids).
  const markerAdds = new Map<string, Set<EditorId>>();
  const addMarkerHost = (name: string, editor: EditorId | null) => {
    if (editor === null) return;
    const set = markerAdds.get(name) ?? new Set<EditorId>();
    set.add(editor);
    markerAdds.set(name, set);
  };

  for (const { rel, editor } of detectionRoots()) {
    const hostRoot = resolve(projectDir, rel);
    if (!existsSync(hostRoot)) continue;
    // A host root that itself symlink-escapes the project is never written through.
    if (hostSkillsRootEscapes(projectDir, hostRoot)) continue;

    let entries: string[];
    try {
      entries = readdirSync(hostRoot);
    } catch (err) {
      // A host root we can see but not read (EACCES/corruption) is skipped —
      // log it so a permissions issue doesn't silently masquerade as "nothing
      // to reconcile" (no heal/adopt/orphan-removal, no evidence why).
      logger.warn(
        { hostRoot, err: (err as Error).message },
        'reconcile: skipped unreadable host skills root',
      );
      continue;
    }

    for (const name of entries) {
      if (SHIPPED_BUNDLE_NAMES.has(name)) continue;
      const entryPath = join(hostRoot, name);
      const sourceDir = resolve(skillsRoot, name);
      const sourceExists = existsSync(sourceDir);
      try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
          if (pointsAtSource(entryPath, sourceDir) && sourceExists) continue; // managed, OK
          if (sourceExists) {
            linkInto(hostRoot, entryPath, sourceDir); // heal drifted link
            result.healed.push({ name, editor });
          } else {
            tracedRmSync(entryPath, { recursive: true, force: true }); // orphan link
            result.orphansRemoved.push({ name, editor });
          }
          continue;
        }
        if (!stat.isDirectory()) continue; // ignore stray files

        // Only adopt foreign real-dir copies whose name is a valid skill id.
        // A host-dir entry like `My Skill/` or `notes.bak/` is not a skill and
        // must not be projected into `.ok/skills/` (where the name becomes the
        // skill identity). The symlink heal/orphan paths above stay name-agnostic
        // — managed links always already carry a valid name.
        if (!SKILL_NAME_REGEX.test(name)) {
          logger.warn(
            { skill: name, editor },
            'reconcile: skipping host-dir entry with a non-skill name',
          );
          continue;
        }

        // ALWAYS-ON: a real-dir copy of an EXISTING `.ok` skill (byte-identical, or
        // the same skill differing only in SKILL.md frontmatter serialization /
        // additive fields per `sameSkillModuloFrontmatter` — the cross-harness sync
        // reformats / field-extends host copies across runs) → collapse to a
        // symlink. This manages a skill OK already owns (it has a `.ok/skills`
        // entry), so it runs regardless of the project-managed gate. linkInto
        // removes entryPath internally before linking.
        if (
          sourceExists &&
          (dirsEqual(entryPath, sourceDir) || sameSkillModuloFrontmatter(entryPath, sourceDir))
        ) {
          linkInto(hostRoot, entryPath, sourceDir);
          result.replaced.push({ name, editor });
          addMarkerHost(name, editor);
          continue;
        }

        // Beyond here we would IMPORT a non-`.ok` skill — either adopt a foreign
        // real-dir with no source, or suffix-adopt a colliding different skill.
        // Both are gated on the project being OK-managed (`manageEditorSkills`).
        // Default off: leave the foreign editor skill UNTOUCHED — OK does not own
        // skills the user never asked it to manage. Membership in `.ok/skills` is
        // the ownership boundary; an explicit import opt-in flips this on.
        if (!managed) {
          result.skipped.push({ name, editor });
          continue;
        }

        if (!sourceExists) {
          // Foreign / legacy copy: adopt into `.ok/skills`, then symlink.
          moveDir(entryPath, sourceDir);
          linkInto(hostRoot, entryPath, sourceDir);
          result.adopted.push({ name, editor });
          addMarkerHost(name, editor);
        } else {
          // Collision: a genuinely different skill shares the name (body differs,
          // or a shared frontmatter field carries a conflicting value). Suffix-adopt
          // the foreign copy (never delete — recoverable), link it under the
          // suffixed name, and leave the OK-managed `<name>` for an explicit
          // install rather than silently re-pointing it here.
          const suffixed = `${name}-${editor ?? 'agents'}`;
          const suffixedSource = resolve(skillsRoot, suffixed);
          if (existsSync(suffixedSource)) {
            // The suffixed slot is already taken by another foreign copy. NEVER
            // delete the user's content (the invariant above) — skip and let them
            // resolve manually rather than destroying it.
            logger.warn(
              { skill: name, editor, suffixed },
              'collision: suffixed slot already occupied — skipping (manual resolution needed)',
            );
            continue;
          }
          moveDir(entryPath, suffixedSource);
          linkInto(hostRoot, join(hostRoot, suffixed), suffixedSource);
          result.collided.push({ name, editor });
          addMarkerHost(suffixed, editor);
        }
      } catch (err) {
        logger.warn({ err, skill: name, editor }, 'reconcile skipped one skill entry after error');
      }
    }
  }

  // Refresh the marker for newly adopted / replaced skills so the list badges
  // them Installed. Truth is detection; this keeps the cache consistent.
  if (markerAdds.size > 0) {
    const marker = readInstalledSkills(projectDir);
    for (const [name, editors] of markerAdds) {
      const sourceDir = resolve(skillsRoot, name);
      if (!existsSync(sourceDir)) continue;
      const prior = marker.skills[name];
      const hosts = Array.from(new Set([...(prior?.hosts ?? []), ...editors]));
      try {
        await recordSkillInstall(projectDir, name, {
          hosts,
          scope: prior?.scope ?? 'project',
          scripts: prior?.scripts ?? validateSkillForInstall(sourceDir, name).hasScripts,
          installedAt: prior?.installedAt ?? new Date().toISOString(),
        });
      } catch (err) {
        logger.warn({ err, skill: name }, 'reconcile marker update failed (non-fatal)');
      }
    }
  }

  return result;
}
