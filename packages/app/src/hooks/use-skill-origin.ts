import type { SkillOrigin, SkillScope } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSkillUpdateAvailable } from '@/hooks/use-skill-update-available';
import { useSkills } from '@/hooks/use-skills';
import { reimportSkill, revertSkill } from '@/lib/skills-api';

/**
 * Best-effort GitHub link for an import source. `owner/repo[/subpath]` shorthand
 * and github.com URLs resolve to the repo page; local paths / non-GitHub git
 * URLs return null (the source string is still shown, just not linked).
 */
/** skills.sh page URL when the import recorded a publisher; the slug falls
 *  back to the local name (they match unless the source folder was renamed). */
function skillsShUrl(origin: SkillOrigin, localName: string): string | null {
  if (!origin.publisher) return null;
  const slug = origin.skill ?? localName;
  return `https://www.skills.sh/${encodeURIComponent(origin.publisher)}/skills/${encodeURIComponent(slug)}`;
}

export function githubUrl(source: string): string | null {
  const s = source.trim();
  if (/^https?:\/\//i.test(s)) return s.includes('github.com') ? s.replace(/\.git$/, '') : null;
  if (/^(?:\.|\/|~|file:|git@)/.test(s)) return null;
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/.exec(s);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

export function skillOriginUrl(origin: SkillOrigin, localName: string): string | null {
  return skillsShUrl(origin, localName) ?? origin.marketplaceUrl ?? githubUrl(origin.source);
}

/**
 * Import provenance + "Update from source" re-pull for a skill tab, shared by the
 * toolbar's provenance line (`SkillOriginInline`) and its narrow-width overflow
 * menu (`SkillToolbarControls`) — the provenance line hides on a narrow pane, so
 * the Update action has to survive in the overflow, and both surfaces need the
 * same re-pull logic + eligibility check.
 *
 * `canReimport` is false for hand-authored skills (no origin) AND for skills
 * adopted from an editor's own copy: those carry an `adopt:<harness>` source with
 * no fetchable remote (the source is now a symlink to the `.ok/skills` copy), so
 * a re-pull would only error — provenance reads as plain "From <harness>".
 */
// Session-scoped auto-update dedupe (see the effect in `useSkillOrigin`).
const autoApplied = new Set<string>();

/** Remote instructions require explicit continuing trust; local paths keep the
 * existing stay-in-sync default because the source is already on this machine. */
export function skillAutoUpdateEnabled(origin: SkillOrigin | null): boolean {
  if (!origin) return false;
  if (origin.autoUpdate !== undefined) return origin.autoUpdate;
  const source = origin.source.trim();
  return (
    source.startsWith('/') ||
    source.startsWith('.') ||
    source.startsWith('~') ||
    source.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(source) ||
    source.startsWith('\\\\')
  );
}

export function useSkillOrigin({ scope, name }: { scope: SkillScope; name: string }): {
  origin: SkillOrigin | null;
  github: string | null;
  displaySource: string | null;
  importedTitle: string | null;
  canReimport: boolean;
  /** Upstream source has a newer version than what's installed — the Update button
   *  shows only when this is true (not a permanent check-for-updates control). */
  updateAvailable: boolean;
  /** Skill's on-disk content diverges from what was installed (see `modified` in
   *  the skills list). Drives the "Modified" indicator; only meaningful for an
   *  imported project skill whose lockfile carries a write-time baseline. */
  modified: boolean;
  /** Per-skill auto-update: local sources default on; remote sources require
   *  explicit opt-in. When on, an available upstream update applies on skill
   *  open unless the skill is locally modified or git-tracked. */
  autoUpdate: boolean;
  /** The bundle has tracked files in the project git — auto-update refuses;
   *  the toggle disables with this as its reason. */
  gitTracked: boolean;
  /** Persist the auto-update toggle to the lockfile. */
  setAutoUpdate: (enabled: boolean) => Promise<void>;
  /** A shadow-repo install baseline exists (git project) — Revert can restore it.
   *  False in a non-git project, where a modified skill has no bytes to revert to. */
  revertable: boolean;
  /** Apply the upstream update in place (overwrites local edits). */
  reimport: () => Promise<void>;
  reimporting: boolean;
  /** Fetch upstream and return the two SKILL.md bodies for a confirm-diff,
   *  without writing. `null` on error (a toast is surfaced) or when already up to
   *  date. Used before `reimport()` when the skill is locally modified. */
  previewUpdate: () => Promise<{ localBody: string; upstreamBody: string } | null>;
  /** Discard local edits, restoring the installed baseline. */
  revert: () => Promise<void>;
  reverting: boolean;
} {
  const { t } = useLingui();
  const skillsState = useSkills();
  const entry =
    skillsState.status === 'ready'
      ? skillsState.data.find((s) => s.scope === scope && s.name === name)
      : undefined;
  const origin = entry?.origin ?? null;
  // `adopt:<harness>` sources have no fetchable remote, so they're not reimportable.
  const adoptMatch = origin ? /^adopt:(.+)$/.exec(origin.source) : null;
  const harnessLabel = adoptMatch
    ? adoptMatch[1].charAt(0).toUpperCase() + adoptMatch[1].slice(1)
    : null;
  const canReimport = !!origin && !harnessLabel;
  // Only surface "Update" when upstream actually has a newer version — not a permanent check-for-updates button.
  const {
    available: updateAvailable,
    gitTracked,
    recheck: recheckUpdate,
  } = useSkillUpdateAvailable(scope, name, canReimport);
  const [reimporting, setReimporting] = useState(false);
  const [reverting, setReverting] = useState(false);
  const autoUpdate = skillAutoUpdateEnabled(origin);
  const modified = entry?.modified ?? false;

  async function reimport() {
    setReimporting(true);
    const result = await reimportSkill({ scope, name });
    setReimporting(false);
    if (!result.ok) {
      toast.error(t`Update failed: ${result.error}`);
      return;
    }
    if (result.updated) toast.success(t`Updated "${name}" from ${result.source}`);
    else toast.success(t`"${name}" is already up to date`);
    for (const w of result.warnings) toast.warning(w);
    // Just applied the update → re-check so the Update button hides again.
    recheckUpdate();
  }

  // Auto-update: with the toggle on and the skill clean, apply an available
  // upstream update as soon as it's detected on skill open. Remote sources only
  // reach this path after explicit opt-in. A locally
  // MODIFIED skill never auto-applies (the Update button keeps its confirm-diff
  // path). The once-per-session guard is MODULE-level: hidden Activity panes can
  // mount a second toolbar for the same skill, and reimport() only flips
  // updateAvailable off after an async recheck.
  useEffect(() => {
    // Git-tracked bundles update through the repo (pull / CI) — never the
    // per-machine auto loop (two machines + autoSync = churn war).
    if (!updateAvailable || !autoUpdate || modified || reimporting || gitTracked) return;
    const key = `${scope}:${name}`;
    if (autoApplied.has(key)) return;
    autoApplied.add(key);
    void reimport();
  });

  async function previewUpdate() {
    const result = await reimportSkill({ scope, name, dryRun: true });
    if (!result.ok) {
      toast.error(t`Update failed: ${result.error}`);
      return null;
    }
    if (!result.updated || result.upstreamBody === undefined) {
      toast.success(t`"${name}" is already up to date`);
      return null;
    }
    return { localBody: result.localBody ?? '', upstreamBody: result.upstreamBody };
  }

  async function revert() {
    setReverting(true);
    const result = await revertSkill({ name });
    setReverting(false);
    if (!result.ok) {
      toast.error(t`Revert failed: ${result.error}`);
      return;
    }
    toast.success(t`Reverted "${name}" to the installed version`);
    for (const w of result.warnings) toast.warning(w);
  }

  // A copy made from a harness plugin ("Edit a copy"): the lockfile source is
  // the raw plugin dir — say "the <plugin> plugin", not a machine path.
  const pluginMatch = origin
    ? (/\/plugins\/cache\/[^/]+\/([^/]+)\//.exec(origin.source) ??
      /\/plugins\/marketplaces\/([^/]+)\//.exec(origin.source))
    : null;
  const displaySource = origin
    ? harnessLabel
      ? t`From ${harnessLabel}`
      : pluginMatch
        ? t`From the ${pluginMatch[1]} plugin`
        : origin.source
    : null;
  const parsed = origin ? new Date(origin.importedAt) : null;
  const importedLabel =
    parsed && !Number.isNaN(parsed.getTime())
      ? parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      : (origin?.importedAt ?? null);

  return {
    origin,
    // The provenance chip prefers the skills.sh page (the marketplace identity)
    // and falls back to the GitHub repo for plain repo imports.
    github: origin ? skillOriginUrl(origin, name) : null,
    displaySource,
    importedTitle: importedLabel ? t`Imported ${importedLabel}` : null,
    canReimport,
    /** Upstream has a newer version than what's installed — gate the Update button. */
    updateAvailable,
    modified,
    autoUpdate,
    gitTracked,
    setAutoUpdate: async (enabled: boolean) => {
      const result = await reimportSkill({ scope, name, setAutoUpdate: enabled });
      if (!result.ok) {
        toast.error(t`Couldn't save the auto-update setting: ${result.error}`);
        return;
      }
      toast.success(enabled ? t`Auto-update on for "${name}"` : t`Auto-update off for "${name}"`);
    },
    revertable: entry?.revertable ?? false,
    reimport,
    reimporting,
    previewUpdate,
    revert,
    reverting,
  };
}
