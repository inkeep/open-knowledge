/**
 * Skill install reconcile — the heal pass that runs on project open (and on
 * skill create/delete). It brings editor-dir entries of skills OK ALREADY OWNS
 * (a `.ok/skills/<name>` source exists) into line with the symlink install
 * model. Install state is the on-disk symlink reality — the marker is only a
 * cache, refreshed here as a side effect.
 *
 * Per-entry taxonomy for an editor skill dir entry `<name>`:
 *
 * | on-disk state                                   | meaning        | action                       |
 * |-------------------------------------------------|----------------|------------------------------|
 * | symlink → `.ok/skills/<name>`                   | managed        | none                         |
 * | absent                                          | not installed  | none                         |
 * | symlink → existing path outside `.ok/skills`    | foreign link   | leave untouched              |
 * | symlink dangling or into `.ok/skills`, source present | drifted link | heal → re-point          |
 * | symlink dangling or into `.ok/skills`, no source | orphan link   | remove the dangling link     |
 * | real dir, source present, same content          | redundant copy | replace with a symlink       |
 * | real dir, same skill (frontmatter-only diff)     | redundant copy | replace with a symlink       |
 * | real dir, no source / different skill            | in-place skill | none (indexed in place)      |
 *
 * There is NO adopt path: a real-dir editor skill that isn't a copy of an
 * existing `.ok/skills` source is an IN-PLACE skill — the in-place
 * registry versions it where it lives; reconcile never moves or rewrites it
 * (`result.skipped` counts them, diagnostic-only). Membership in `.ok/skills`
 * is the ownership boundary for every mutating row above. The same boundary
 * governs symlinks: a link whose target resolves to a real path OUTSIDE
 * `.ok/skills` (e.g. a repo that checks editor-dir links into its own shared
 * skill store) is foreign and is never healed or removed — only dangling links
 * and links into `.ok/skills` are reconcile-managed.
 *
 * "Same content" is byte-equality; "same skill" additionally treats two copies
 * as one when their SKILL.md differs only in frontmatter serialization (folded
 * vs flow YAML) or additive fields (one carries `argument-hint`, the other does
 * not) with an identical body and identical sibling files. Without this, the
 * cross-harness skill sync (which reformats / extends frontmatter across runs)
 * would misread every managed skill as a distinct in-place skill on each boot.
 *
 * Detection scans every editor's skills root AND the generic `.agents/skills`
 * broadcast dir. OK's own shipped bundle (`open-knowledge` /
 * `open-knowledge-discovery`) is a copy exception and is left untouched.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
  SKILL_NAME_REGEX,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import { tracedMkdirSync, tracedRmSync, tracedSymlinkSync } from './fs-traced.ts';
import { readInstalledSkills, recordSkillInstall } from './installed-skills-marker.ts';
import { getLogger } from './logger.ts';
import { INTERNAL_BUNDLE_SKILL_NAMES } from './skill-bundles.ts';
import { hostSkillsRootEscapes, validateSkillForInstall } from './skill-projection.ts';

const logger = getLogger('skill-reconcile');

/**
 * OK's shipped bundle skills — copy-installed, excluded from the reconcile
 * sweep. Derived from the canonical bundle list (not a hand-maintained literal)
 * so it can't drift: a foreign editor-host dir named after a built-in bundle
 * must never be adopted into `.ok/skills/`, where the reserved name would
 * become an authored skill the write API forbids.
 */
const SHIPPED_BUNDLE_NAMES = INTERNAL_BUNDLE_SKILL_NAMES;

/** Per-editor action recorded for one reconciled entry. */
interface ReconcileAction {
  name: string;
  /** The editor whose dir held the entry; `null` for the generic `.agents` dir. */
  editor: EditorId | null;
}

export interface ReconcileResult {
  healed: ReconcileAction[];
  replaced: ReconcileAction[];
  orphansRemoved: ReconcileAction[];
  /**
   * Editor-dir skills with no `.ok/skills/<name>` source (or a genuinely
   * different skill sharing a source's name) — these are IN-PLACE skills
   * versioned where they live, and reconcile never touches them — plus
   * symlinks resolving to a real path outside `.ok/skills` (foreign installs,
   * skipped unconditionally: OK does not own them). Diagnostic-only count.
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
  roots.push({ rel: AGENTS_SKILLS_ROOT, editor: null });
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
 * `<name>-<editor>` skills. Identity-aware: byte-identical files pass trivially,
 * and only SKILL.md may differ (modulo frontmatter) before declaring a collision.
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
 * Is this symlink a FOREIGN install — a link whose target resolves to a real
 * path outside `.ok/skills`? Such links are user/repo-managed (e.g. a monorepo
 * checks editor-dir links into its own shared skill store); reconcile must
 * neither remove them as orphans nor re-point them at a same-named `.ok`
 * source. Dangling links and links into `.ok/skills` return false and stay
 * reconcile-managed.
 */
function isForeignSymlink(linkPath: string, skillsRoot: string): boolean {
  try {
    const raw = readlinkSync(linkPath);
    const target = isAbsolute(raw) ? resolve(raw) : resolve(dirname(linkPath), raw);
    if (!existsSync(target)) return false; // dangling — reconcile-managed
    const rel = relative(resolve(skillsRoot), target);
    return rel !== '' && (rel.startsWith('..') || isAbsolute(rel));
  } catch (err) {
    // Unreadable link (EACCES/EIO) falls through to the heal/orphan path,
    // which may delete it — log so that outcome is traceable to its cause.
    logger.warn(
      { linkPath, err },
      'isForeignSymlink: could not resolve symlink; treating as reconcile-managed',
    );
    return false;
  }
}

/** Editor-suffix tokens a collision suffix-adopt appends (`<name>-<editor>`, or `-agents` for the generic dir). */
const SUFFIX_TOKENS: readonly string[] = [...PROJECT_SKILL_EDITOR_IDS, 'agents'];

/** If `name` ends in a known `-<editor>` collision suffix, return the base name; else null. */
function suffixBase(name: string): string | null {
  for (const token of SUFFIX_TOKENS) {
    const suffix = `-${token}`;
    if (name.length > suffix.length && name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return null;
}

/**
 * One-shot, idempotent collapse of accreted `<name>-<editor>` suffix duplicates
 * in `.ok/skills`. The collision suffix-adopt path (above) spawned these when a
 * version-skewed harness copy was misread as a distinct skill; the
 * `sameSkillModuloFrontmatter` identity gate now prevents NEW ones, but the
 * already-on-disk dupes never get collapsed. For each `.ok/skills/<name>-<token>`
 * whose base `.ok/skills/<name>` exists AND is identity-equal, re-point any
 * harness symlink from the suffixed source to the base, then remove the suffixed
 * source. Never touches a base, and never a genuinely-different suffixed skill —
 * the reconcile never-delete invariant. Idempotent: once the suffixed dir is
 * gone, subsequent runs find nothing to collapse.
 *
 * CRDT-safety caveat: `.ok/skills/<name>/SKILL` is CRDT content (skills-as-
 * content), and this pass holds no handle to the live document manager, so it
 * cannot prove a suffixed dir isn't backing a loaded Y.Doc. It is scoped to the
 * dormant DUPLICATE artifact (never the base a user edits) and only when
 * byte/identity-equal, which makes a desync improbable; the residual risk (a
 * client editing the suffixed dupe during a runtime opt-in reconcile) is
 * accepted and logged, pending a future live-doc guard.
 */
function collapseAccretedSuffixDupes(opts: { projectDir: string; skillsRoot: string }): void {
  const { projectDir, skillsRoot } = opts;
  if (!existsSync(skillsRoot)) return;
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return;
  }
  const roots = detectionRoots();
  for (const suffixed of entries) {
    const base = suffixBase(suffixed);
    if (base === null) continue;
    const suffixedDir = resolve(skillsRoot, suffixed);
    const baseDir = resolve(skillsRoot, base);
    if (!existsSync(baseDir)) continue;
    try {
      const stat = lstatSync(suffixedDir);
      // Only a real source dir is a collapse candidate (a symlink is not an
      // accreted `.ok/skills` source). SKILL.md must be present on both sides.
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (!existsSync(join(suffixedDir, 'SKILL.md')) || !existsSync(join(baseDir, 'SKILL.md'))) {
        continue;
      }
      if (!sameSkillModuloFrontmatter(baseDir, suffixedDir)) continue;
      for (const { rel } of roots) {
        const hostRoot = resolve(projectDir, rel);
        if (hostSkillsRootEscapes(projectDir, hostRoot)) continue;
        const linkPath = join(hostRoot, suffixed);
        if (pointsAtSource(linkPath, suffixedDir)) linkInto(hostRoot, linkPath, baseDir);
      }
      tracedRmSync(suffixedDir, { recursive: true, force: true });
      logger.info({ base, suffixed }, 'collapsed accreted suffix-duplicate skill into its base');
    } catch (err) {
      logger.warn({ err, base, suffixed }, 'suffix-dupe collapse skipped one entry after error');
    }
  }
}

/**
 * Reconcile every editor skill dir under `projectDir` against the `.ok/skills`
 * source tree. Best-effort + isolated: one entry's failure is logged and
 * skipped, never aborting the pass. Marker host sets are refreshed for
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
    replaced: [],
    orphansRemoved: [],
    skipped: [],
  };
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
      logger.warn({ hostRoot, err }, 'reconcile: skipped unreadable host skills root');
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
          if (isForeignSymlink(entryPath, skillsRoot)) {
            result.skipped.push({ name, editor }); // foreign link — not OK's to manage
            continue;
          }
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

        // Only manage real-dir copies whose name is a valid skill id. A host-dir
        // entry like `My Skill/` or `notes.bak/` is not a skill. The symlink
        // heal/orphan paths above stay name-agnostic — managed links always
        // already carry a valid name.
        if (!SKILL_NAME_REGEX.test(name)) {
          logger.warn(
            { skill: name, editor },
            'reconcile: skipping host-dir entry with a non-skill name',
          );
          continue;
        }

        // A real-dir copy of an EXISTING `.ok` skill (byte-identical, or the
        // same skill differing only in SKILL.md frontmatter serialization /
        // additive fields per `sameSkillModuloFrontmatter` — the cross-harness
        // sync reformats / field-extends host copies across runs) → collapse to
        // a symlink. This manages a skill OK already owns (it has a `.ok/skills`
        // entry). linkInto removes entryPath internally before linking.
        if (sourceExists && sameSkillModuloFrontmatter(entryPath, sourceDir)) {
          linkInto(hostRoot, entryPath, sourceDir);
          result.replaced.push({ name, editor });
          addMarkerHost(name, editor);
          continue;
        }

        // Anything else is an IN-PLACE skill (no `.ok/skills` source, or a
        // genuinely different skill sharing a source's name). It is
        // versioned where it lives via the in-place registry — reconcile NEVER
        // moves, rewrites, or symlinks it.
        result.skipped.push({ name, editor });
      } catch (err) {
        logger.warn({ err, skill: name, editor }, 'reconcile skipped one skill entry after error');
      }
    }
  }

  // Refresh the marker for newly replaced skills so the list badges
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

  // Hygiene: collapse any accreted `<name>-<editor>` suffix duplicates now that
  // links are settled (runs after the main pass so it re-points, rather than
  // racing, the just-healed links). Guarded + idempotent; never deletes a base.
  try {
    collapseAccretedSuffixDupes({ projectDir, skillsRoot });
  } catch (err) {
    logger.warn({ err }, 'suffix-dupe collapse pass failed (non-fatal)');
  }

  return result;
}
