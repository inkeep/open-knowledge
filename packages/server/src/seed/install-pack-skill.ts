/**
 * Install a starter pack's project-local skill (`open-knowledge-pack-<packId>`).
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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
} from '@inkeep/open-knowledge-core';
import { resolveBundledSkillDir } from '../build-skill-zip.ts';
import { tracedCpSync, tracedMkdirSync, tracedRmSync } from '../fs-traced.ts';
import { recordSkillInstall } from '../installed-skills-marker.ts';
import { getLogger } from '../logger.ts';
import { BUNDLE_SKILL_NAME } from '../skill-bundles.ts';
import { projectSkill } from '../skill-projection.ts';

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
 * Resolve a pack's project-local skill — its `open-knowledge-pack-<id>` name and
 * the bundled source dir — or `null` when the pack ships no skill. Single source
 * for the naming convention + the "does this pack ship a skill?" probe, shared by
 * the installer (below) and the scaffold planner (`planSeed`, which reports a
 * pending skill so a folders-present-but-skill-absent project isn't mistaken for
 * fully set up).
 */
export function resolvePackSkillSource(packId: string): { name: string; sourceDir: string } | null {
  let sourceDir: string;
  try {
    // checkDesktop:true so a co-installed OK Desktop's (possibly newer) bundle wins.
    sourceDir = resolveBundledSkillDir(`packs/${packId}`, { checkDesktop: true });
  } catch {
    return null;
  }
  return { name: `open-knowledge-pack-${packId}`, sourceDir };
}

/**
 * Author `packs/<packId>` as a `.ok/skills/` project skill + project it into
 * each set-up editor. Returns the labels of editors the skill was installed for.
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
export async function installPackSkill(projectDir: string, packId: string): Promise<string[]> {
  const resolved = resolvePackSkillSource(packId);
  if (!resolved) return [];
  const { name, sourceDir } = resolved;

  // (1) Author the editable source under `.ok/skills/` — what makes it show in
  // the Skills list + forkable. Authored ONLY when absent: a present SKILL.md is
  // a (possibly user-edited) fork we must not clobber. The projection + marker
  // steps below still run so re-seed reconciles a new editor without re-copying.
  const okSkillDir = join(projectDir, '.ok', 'skills', name);
  if (!existsSync(join(okSkillDir, 'SKILL.md'))) {
    try {
      tracedRmSync(okSkillDir, { recursive: true, force: true });
      tracedMkdirSync(join(projectDir, '.ok', 'skills'), { recursive: true });
      tracedCpSync(sourceDir, okSkillDir, { recursive: true });
    } catch (err) {
      // A real disk failure (EACCES / ENOSPC / I/O) — NOT the benign
      // "pack ships no skill" (resolved === null above). Log it so a seed that
      // silently installed 0 editors is diagnosable rather than mistaken for normal.
      getLogger('seed').warn(
        { err, packId, okSkillDir },
        'pack skill source authoring failed — skill not installed',
      );
      return [];
    }
  }

  // (2) Project the `.ok/skills/` source into each editor ALREADY set up for
  // this project. Projection is a symlink (the shared `projectSkill` primitive
  // owns the symlink-escape guard + host-dir resolution) — NOT a copy, so the
  // boot-time reconcile doesn't immediately rewrite a copied dir to a symlink
  // (the write-then-undo churn this used to cause). "Set up" = the editor's
  // platform `open-knowledge` skill is present.
  const setUpHosts = PROJECT_SKILL_EDITOR_IDS.filter((id) => {
    const rel = EDITOR_PROJECT_SKILL_ROOT[id];
    if (rel === null) return false;
    return existsSync(join(projectDir, rel, PLATFORM_SKILL_NAME, 'SKILL.md'));
  });
  const hosts = projectSkill(okSkillDir, name, projectDir, setUpHosts);
  const installed = hosts.map((id) => PROJECT_SKILL_EDITOR_LABELS[id] ?? id);

  // (3) Record the marker so the Skills list badges it Installed + lists
  // hosts. Best-effort — a marker write failure must not fail the seed.
  if (hosts.length > 0) {
    try {
      await recordSkillInstall(projectDir, name, {
        hosts,
        scope: 'project',
        scripts: existsSync(join(okSkillDir, 'scripts')),
        installedAt: new Date().toISOString(),
      });
    } catch {
      // marker is a convenience; the source + projections already landed
    }
  }

  return installed;
}
