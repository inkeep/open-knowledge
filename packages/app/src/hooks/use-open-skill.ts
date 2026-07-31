import type { SkillScope } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useSkills } from '@/hooks/use-skills';
import { hashFromDocName, replaceHashWithoutNavigation } from '@/lib/doc-hash';
import { skillEntryLiveDocName, skillLiveDocName } from '@/lib/managed-artifact-doc-name';
import { listSkills } from '@/lib/skills-api';

/**
 * Open a skill's live editor tab the ROBUST way — a direct `openTarget({kind:'doc'})`
 * that bypasses the hash → `resolveNavigationTarget` path.
 *
 * The hash path resolves a PROJECT skill's content doc (`.ok/skills/<name>/SKILL`)
 * through the page index, which lags a create/import/rename by the async `files`
 * refetch — so a freshly-created project skill opened via the hash resolves to the
 * READ-ONLY asset viewer and strands the user until the index catches up. Global
 * skills (`__skill__/…`) resolve fine either way, which is why the strand is
 * project-skill-specific. Every "open a skill" surface (create-blank, import,
 * detected-adopt, sidebar click) must route here so none can regress to the strand.
 * `skillLiveDocName` maps each scope to its real doc, so this is scope-agnostic.
 */
export function useOpenSkill(): (
  scope: SkillScope,
  name: string,
  opts?: { replaceActive?: boolean; path?: string },
) => void {
  const { openTarget } = useDocumentContext();
  const skillsState = useSkills();
  return (scope, name, opts) => {
    const open = (docName: string) => {
      // `replace-active` swaps the currently-active tab in place (e.g. transition an
      // explore PREVIEW tab into the real skill after install) — one tab, no separate
      // close, so nothing can resurrect the old preview.
      openTarget(
        { kind: 'doc', target: docName, docName },
        opts?.replaceActive ? { tabBehavior: 'replace-active' } : undefined,
      );
      replaceHashWithoutNavigation(hashFromDocName(docName));
    };
    // Entry-first: an existing skill's REAL doc (in-place skills live at
    // editor-dir paths, not the store). A fresh create's entry hasn't landed
    // in the list yet — its server-reported `path` bridges the gap.
    const entry =
      skillsState.status === 'ready'
        ? skillsState.data.find((sk) => sk.scope === scope && sk.name === name)
        : undefined;
    if (entry) return open(skillEntryLiveDocName(entry));
    if (scope === 'project' && opts?.path) return open(opts.path.replace(/\.mdx?$/i, ''));
    // Global: the managed `__skill__/global/<name>` doc resolves store-or-native
    // server-side, so it is always safe to open directly.
    if (scope === 'global') return open(skillLiveDocName(scope, name));
    // PROJECT with no entry and no path: NEVER mint the store-shaped fallback —
    // opening `.ok/skills/<name>/SKILL` creates a PHANTOM doc that persistence
    // materializes and the sweeper deletes in a loop. Resolve the real path
    // from a fresh list fetch instead; a miss is an honest error.
    void (async () => {
      try {
        const res = await listSkills('project');
        if (!res.ok) {
          toast.error(t`Couldn't open "${name}": ${res.error}`);
          return;
        }
        const fresh = res.skills.find((sk) => sk.scope === scope && sk.name === name);
        if (!fresh) {
          toast.error(t`Couldn't open "${name}" — it isn't in the project's skills yet.`);
          return;
        }
        open(skillEntryLiveDocName(fresh));
      } catch (err) {
        toast.error(
          t`Couldn't open "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };
}
