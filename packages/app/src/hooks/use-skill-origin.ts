import { type SkillOrigin, type SkillScope, skillsShSkillLinks } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSkillUpdateAvailable } from '@/hooks/use-skill-update-available';
import { useSkills } from '@/hooks/use-skills';
import { reimportSkill, revertSkill } from '@/lib/skills-api';

function skillsShUrl(origin: SkillOrigin, localName: string): string | null {
  if (!origin.publisher) return null;
  return skillsShSkillLinks(origin.source, origin.skill ?? localName)?.skillsUrl ?? null;
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

const autoApplied = new Set<string>();

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
  updateAvailable: boolean;
  modified: boolean;
  autoUpdate: boolean;
  gitTracked: boolean;
  setAutoUpdate: (enabled: boolean) => Promise<void>;
  revertable: boolean;
  reimport: () => Promise<void>;
  reimporting: boolean;
  previewUpdate: () => Promise<{ localBody: string; upstreamBody: string } | null>;
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
  const adoptMatch = origin ? /^adopt:(.+)$/.exec(origin.source) : null;
  const harnessLabel = adoptMatch
    ? adoptMatch[1].charAt(0).toUpperCase() + adoptMatch[1].slice(1)
    : null;
  const canReimport = !!origin && !harnessLabel;
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
    recheckUpdate();
  }

  useEffect(() => {
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
    github: origin ? skillOriginUrl(origin, name) : null,
    displaySource,
    importedTitle: importedLabel ? t`Imported ${importedLabel}` : null,
    canReimport,
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
