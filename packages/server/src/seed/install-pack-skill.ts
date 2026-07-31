/**
 * Install a starter pack's project-local skills (`open-knowledge-pack-<packId>`,
 * plus `…-<packId>-<member>` for a pack decomposed into scenario skills).
 *
 * Two parts, so a pack skill behaves like any other authored project skill
 * (the editable-fork model — a pack initializes a skill once, then it's yours):
 *   1. Author the SOURCE into `<projectDir>/.ok/skills/<name>/` — this is what
 *      makes it show up in the Skills list (`/api/skills` enumerates `.ok/skills/`)
 *      and be editable. Without this the pack skill was invisible — projected
 *      into editor host dirs but absent from the library.
 *   2. Project that source into each editor already set up for this project
 *      (its platform `open-knowledge` skill is present), and record the
 *      install marker so the row badges Installed + names its hosts.
 *
 * Single install site for ALL seed entry points — `ok seed` (CLI), the desktop
 * IPC handler, and the `POST /api/seed/apply` HTTP route all funnel through
 * `applySeed`, which calls this. Keeping it in the server seed module (rather
 * than the CLI) is why the in-app paths get the pack skill too.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  OPENKNOWLEDGE_SKILLS_REPO,
  PROJECT_SKILL_EDITOR_IDS,
} from '@inkeep/open-knowledge-core';
import {
  emptySkillsLock,
  parseSkillDir,
  parseSkillsLock,
  SKILLS_LOCK_REL,
  upsertLockEntry,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { tracedCpSync, tracedMkdirSync, tracedRmSync, tracedWriteFileSync } from '../fs-traced.ts';
import { resolveDefaultSkillHomeRel, scanInPlaceSkills } from '../in-place-skills.ts';
import { getLogger } from '../logger.ts';
import { BUNDLE_SKILL_NAME } from '../skill-bundles.ts';
import { resolveSkillInstallReportSettings } from '../skill-install-report-config.ts';
import { listPackSkillSources, type PackSkillSource } from '../skill-pack-sources.ts';
import { hostSkillsRootEscapes, projectInPlaceSkill } from '../skill-projection.ts';
import { reportSkillInstall } from '../skills-sh-install-report.ts';

/**
 * Display labels for the editors that keep project-local skills (returned in the
 * seed summary). The editor-id set and each host-dir path come from core's
 * `PROJECT_SKILL_EDITOR_IDS` / `EDITOR_PROJECT_SKILL_ROOT` (single source), so a
 * new skill-surface editor flows here automatically; only the label is local.
 */
const PROJECT_SKILL_EDITOR_LABELS: Partial<Record<EditorId, string>> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
};

/** Leaf name of the platform skill `ok init` installs (the shipped project bundle). */
const PLATFORM_SKILL_NAME = BUNDLE_SKILL_NAME.project;

/**
 * Every project-local skill a pack ships; empty when it ships none. Binds the
 * seed domain's `checkDesktop:true`, so a co-installed OK Desktop's (possibly
 * newer) bundle wins. Shared by the installer below and `planSeed`.
 */
export function resolvePackSkillSources(packId: string): PackSkillSource[] {
  return listPackSkillSources(packId, { checkDesktop: true });
}

/**
 * Author every skill under `packs/<packId>` as a `.ok/skills/` project skill +
 * project each into the set-up editors. Returns the labels of editors the pack's
 * skills were installed for (de-duplicated across skills).
 *
 * No-op (returns `[]`) when the pack ships no skill. Per-editor failures are
 * swallowed so one bad editor dir never blocks the rest or the seed itself.
 *
 * Idempotent, but NOT clobbering: the editable source under `.ok/skills/` is
 * authored only on first install (when its `SKILL.md` is absent). A pack skill
 * is the editable-fork model — once a pack initializes it, it's the user's, and
 * re-running seed (CLI / desktop IPC / `POST /api/seed/apply`) must preserve
 * their edits + shadow history rather than reset to the shipped body. This
 * mirrors `applySeed`'s file-entry path (`if (existsSync) continue`). Projection
 * + the install marker still refresh every call, so a newly-set-up editor picks
 * up an already-authored skill.
 */
/**
 * Record a seeded pack skill's upstream provenance in `.ok/skills-lock.json` so it
 * updates through the SAME reimport path as any imported skill — the source is the
 * deterministic `open-knowledge-skills` projection, the skill selector is the skill's
 * own name. Never clobbers an existing entry (a real import wins); best-effort so a
 * lock write failure never fails the seed.
 */
function recordPackSkillProvenance(projectDir: string, name: string, skillDir: string): void {
  try {
    const acquired = parseSkillDir(skillDir);
    if (!acquired) return;
    const lockPath = join(projectDir, ...SKILLS_LOCK_REL);
    const lock = existsSync(lockPath)
      ? (parseSkillsLock(readFileSync(lockPath, 'utf-8')) ?? emptySkillsLock())
      : emptySkillsLock();
    if (lock.skills[name]) return;
    tracedMkdirSync(dirname(lockPath), { recursive: true });
    const updated = upsertLockEntry(lock, name, {
      source: OPENKNOWLEDGE_SKILLS_REPO,
      skill: name,
      contentHash: acquired.contentHash,
      importedAt: new Date().toISOString(),
    });
    tracedWriteFileSync(lockPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8');
  } catch (err) {
    getLogger('seed').warn({ err, name }, 'pack skill provenance not recorded');
  }
}

export async function installPackSkill(projectDir: string, packId: string): Promise<string[]> {
  const sources = resolvePackSkillSources(packId);
  if (sources.length === 0) return [];

  // The editors ALREADY set up for this project — the platform `open-knowledge`
  // skill is present. Computed once; every pack skill projects into the same set.
  const setUpHosts = PROJECT_SKILL_EDITOR_IDS.filter((id) => {
    const rel = EDITOR_PROJECT_SKILL_ROOT[id];
    if (rel === null) return false;
    return existsSync(join(projectDir, rel, PLATFORM_SKILL_NAME, 'SKILL.md'));
  });

  // Resolved once per seed, not per skill — a pack can ship a dozen.
  const reportSettings = resolveSkillInstallReportSettings();
  const installed = new Set<string>();
  // The scan (not any marker) is truth under the in-place model — one scan
  // covers the absent-check for every pack skill.
  const existingNames = new Set(scanInPlaceSkills(projectDir).map((sk) => sk.name));
  const homeRel = resolveDefaultSkillHomeRel(projectDir, 'project');
  // The default home can be an editor dir that SYMLINKS OUT of the project
  // (the escape class the projection guard refuses) — authoring through it
  // would write outside the repo. Refuse the whole pack-skill install then;
  // the old `.ok/skills` landing was only incidentally immune.
  if (hostSkillsRootEscapes(projectDir, join(projectDir, homeRel))) {
    getLogger('seed').warn(
      { packId, homeRel },
      'default skill home escapes the project (symlinked out) — pack skills not installed',
    );
    return [];
  }
  // The editor whose root HOLDS the source loads it directly — it counts as
  // installed even though fan-out (rightly) skips the canonical's own root.
  const homeHost = (Object.entries(EDITOR_PROJECT_SKILL_ROOT) as [EditorId, string | null][]).find(
    ([, root]) => root === homeRel,
  )?.[0];
  for (const { name, sourceDir, excludeDirs } of sources) {
    // (1) Author the SOURCE in place at the project's default skill home —
    // the same landing every create/import uses (store retirement; the old
    // `.ok/skills` authoring rode the boot migration forever). Authored ONLY
    // when the skill exists NOWHERE (in-place scan + legacy store): a present
    // skill is a (possibly user-edited) fork we must not clobber.
    const skillDir = join(projectDir, homeRel, name);
    const legacyStoreDir = join(projectDir, '.ok', 'skills', name);
    const alreadyPresent =
      existingNames.has(name) ||
      existsSync(join(skillDir, 'SKILL.md')) ||
      existsSync(join(legacyStoreDir, 'SKILL.md'));
    const sourceHome = existsSync(join(legacyStoreDir, 'SKILL.md')) ? legacyStoreDir : skillDir;
    if (!alreadyPresent) {
      try {
        tracedRmSync(skillDir, { recursive: true, force: true });
        tracedMkdirSync(join(projectDir, homeRel), { recursive: true });
        // A decomposed pack's root dir CONTAINS its member skill dirs; each member
        // installs as its own top-level skill, so filter them out of the root copy.
        tracedCpSync(sourceDir, skillDir, {
          recursive: true,
          filter: (src) => !excludeDirs.some((dir) => src === join(sourceDir, dir)),
        });
      } catch (err) {
        // A real disk failure (EACCES / ENOSPC / I/O) — NOT the benign
        // "pack ships no skill" (empty `sources` above). Log it so a seed that
        // silently installed 0 editors is diagnosable rather than mistaken for normal.
        getLogger('seed').warn(
          { err, packId, skillDir },
          'pack skill source authoring failed — skill not installed',
        );
        continue;
      }

      // Provenance for the reimport-based update path (no bespoke pack-update handler).
      recordPackSkillProvenance(projectDir, name, skillDir);
      // Count it on skills.sh. Pack skills ship inside the app bundle, so there
      // is nothing to fetch from the marketplace and the event is the only way
      // the listing reflects them. Inside the `!alreadyPresent` branch AND
      // deduped per machine by the reporter, so re-running seed reports nothing.
      void reportSkillInstall(
        { source: OPENKNOWLEDGE_SKILLS_REPO, skills: [name] },
        { home: reportSettings.home, enabled: reportSettings.enabled },
      );
    }

    // (2) Fan the source into each set-up editor via the guarded in-place
    // primitive (copy mode — the go-forward model; a DIFFERENT same-name dir
    // is left untouched). The source's own host is excluded naturally (the
    // primitive skips the canonical's root). No install marker: the in-place
    // scan is the host-set truth.
    const canonicalAbs = existsSync(join(sourceHome, 'SKILL.md')) ? sourceHome : skillDir;
    const canonicalHash = parseSkillDir(canonicalAbs)?.contentHash;
    if (canonicalHash === undefined) continue;
    const fanned = projectInPlaceSkill({
      canonicalAbs,
      canonicalHash,
      canonicalRootRel: homeRel,
      name,
      cwd: projectDir,
      targets: setUpHosts,
      mode: 'copy',
    });
    for (const id of fanned.hosts) {
      installed.add(PROJECT_SKILL_EDITOR_LABELS[id as EditorId] ?? id);
    }
    if (homeHost !== undefined && setUpHosts.includes(homeHost)) {
      installed.add(PROJECT_SKILL_EDITOR_LABELS[homeHost] ?? homeHost);
    }
  }

  return [...installed];
}
