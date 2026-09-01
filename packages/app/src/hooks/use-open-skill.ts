import type { SkillScope } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useSkills, whenSkillsListContains } from '@/hooks/use-skills';
import {
  hashFromDocName,
  pushHashWithoutNavigation,
  replaceHashWithoutNavigation,
} from '@/lib/doc-hash';
import { beginSkillWrite, endSkillWrite } from '@/lib/documents-events';
import { skillEntryLiveDocName, skillLiveDocName } from '@/lib/managed-artifact-doc-name';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';
import { requestSkillTrackPrompt } from '@/lib/skill-track-prompt-store';
import { listSkills } from '@/lib/skills-api';

export function useOpenSkill(): (
  scope: SkillScope,
  name: string,
  opts?: {
    replaceActive?: boolean;
    path?: string;
    replaceHistory?: boolean;
    host?: string;
  },
) => void {
  const { openTarget } = useDocumentContext();
  const skillsState = useSkills();
  return (scope, name, opts) => {
    const open = (docName: string) => {
      const listed =
        skillsState.status === 'ready' &&
        skillsState.data.some((sk) => sk.scope === scope && sk.name === name);
      if (!listed) {
        beginSkillWrite(scope, name);
        void whenSkillsListContains(scope, name).then(() => endSkillWrite(scope, name));
      }
      openTarget(
        { kind: 'doc', target: docName, docName },
        opts?.replaceActive ? { tabBehavior: 'replace-active' } : undefined,
      );
      const hash = hashFromDocName(docName);
      if (opts?.replaceHistory) replaceHashWithoutNavigation(hash);
      else pushHashWithoutNavigation(hash);
    };
    const entry =
      skillsState.status === 'ready'
        ? skillsState.data.find(
            (sk) =>
              sk.scope === scope &&
              sk.name === name &&
              (opts?.host === undefined
                ? sk.hostQualifier === undefined
                : sk.hostQualifier === opts.host),
          )
        : undefined;
    if (entry?.ignored === true && entry.managed !== true) {
      const stale = entry;
      void (async () => {
        try {
          const res = await listSkills(scope);
          const fresh = res.ok
            ? res.skills.find(
                (sk) =>
                  sk.scope === scope &&
                  sk.name === name &&
                  (opts?.host === undefined
                    ? sk.hostQualifier === undefined
                    : sk.hostQualifier === opts.host),
              )
            : undefined;
          if (fresh && fresh.ignored !== true) {
            open(skillEntryLiveDocName(fresh));
            return;
          }
        } catch {}
        requestSkillTrackPrompt({ scope: stale.scope, name: stale.name });
      })();
      return;
    }
    const bundleDirOf = (absolutePath: string): string => {
      const cut = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'));
      return cut > 0 ? absolutePath.slice(0, cut) : absolutePath;
    };
    if (entry?.managed === true && entry.absolutePath !== undefined) {
      openSkillPreviewTab({
        flavor: 'builtin',
        source: bundleDirOf(entry.absolutePath),
        name: entry.name,
        subtitle: '',
        level: entry.scope,
      });
      return;
    }
    if (
      entry &&
      entry.scope === 'project' &&
      entry.managed !== true &&
      entry.canonicalPath !== undefined &&
      entry.absolutePath !== undefined
    ) {
      openSkillPreviewTab({
        flavor: 'linked',
        source: bundleDirOf(entry.absolutePath),
        name: entry.name,
        subtitle: '',
        level: entry.scope,
      });
      return;
    }
    if (entry) return open(skillEntryLiveDocName(entry));
    if (scope === 'project' && opts?.path) return open(opts.path.replace(/\.mdx?$/i, ''));
    if (scope === 'global') return open(skillLiveDocName(scope, name, opts?.host));
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
