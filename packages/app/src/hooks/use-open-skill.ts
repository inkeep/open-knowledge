import type { SkillScope } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useSkills } from '@/hooks/use-skills';
import {
  hashFromDocName,
  pushHashWithoutNavigation,
  replaceHashWithoutNavigation,
} from '@/lib/doc-hash';
import { skillEntryLiveDocName, skillLiveDocName } from '@/lib/managed-artifact-doc-name';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';
import { requestSkillTrackPrompt } from '@/lib/skill-track-prompt-store';
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
  opts?: {
    replaceActive?: boolean;
    path?: string;
    /** Replace the history entry instead of pushing one — for an open that
     *  SUPERSEDES what the user is looking at (the preview tab becoming the
     *  real skill after an install), not merely one that reuses the tab. */
    replaceHistory?: boolean;
    /** Host qualifier of a NON-default same-named GLOBAL bundle (the clicked
     *  entry's `hostQualifier`). Without it the by-name lookup below lands on
     *  the FIRST list entry — the default bundle — so both collided sidebar
     *  rows opened one tab and edits went to the wrong file. */
    host?: string;
  },
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
      // PUSH for a user-initiated open; REPLACE only when this open supersedes
      // the entry the user is standing on.
      //
      // Deliberately NOT keyed on `replaceActive`: that means "reuse the TAB"
      // (the preview-tabs preference, on by default) and says nothing about
      // history. Conflating them makes every ordinary skill click replace, which
      // eats the entry it came from — opening a skill from the Skills home
      // overwrote `#/__skills__`, so Back skipped it and landed on whatever
      // preceded it. Caught by `navigation-history.e2e.ts`.
      const hash = hashFromDocName(docName);
      if (opts?.replaceHistory) replaceHashWithoutNavigation(hash);
      else pushHashWithoutNavigation(hash);
    };
    // Entry-first: an existing skill's REAL doc (in-place skills live at
    // editor-dir paths, not the store). A fresh create's entry hasn't landed
    // in the list yet — its server-reported `path` bridges the gap.
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
    // A gitignored bundle is listed but never indexed, so there is no doc to
    // open — every surface that routes through here would otherwise hand the
    // user an empty tab and no reason. Explain it once, from the one place all
    // of them come through, and offer the `.gitignore` line that fixes it.
    // `canonicalPath` present means the bundle is mounted through a symlink and
    // the server judged `ignored` on the resolved path, which is the one this
    // opener uses — so the flag and the open agree. Kept explicit because the
    // two were computed from different paths once, and that combination refused
    // to open a skill that opened fine.
    if (entry?.ignored === true && entry.managed !== true) {
      // The flag can be STALE: a list fetch that raced a create/import computed
      // `ignored` before the server admitted the new bundle, and stranding on
      // that snapshot makes the just-created skill silently unopenable (the row
      // stays selected, so even re-clicks are swallowed). Re-verify against a
      // fresh list and only surface the track prompt when the skill is still
      // ignored there.
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
        } catch {
          // Unreachable list — fall through to the honest prompt.
        }
        requestSkillTrackPrompt({ scope: stale.scope, name: stale.name });
      })();
      return;
    }
    // A SYMLINKED bundle's canonical doc is a plain file wherever the symlink
    // points (e.g. an in-repo plugin source tree). Opening that doc from a
    // SKILLS surface dumped the user into the source tree with no skill chrome
    // and no explanation — "it's a file here, not a skill". The skill-shaped
    // face of these is the read-only linked preview: the file stays the
    // editable source of truth (and still opens as a plain doc from Files),
    // the preview carries the skill identity, the symlink disclosure, and the
    // lifecycle controls. Managed built-ins keep their own preview flavor.
    // Both separators: `absolutePath` is a server-native path, and on
    // Windows `lastIndexOf('/')` is -1 — slice(0, -1) would trim one char
    // off the FILENAME instead of extracting the directory.
    const bundleDirOf = (absolutePath: string): string => {
      const cut = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'));
      return cut > 0 ? absolutePath.slice(0, cut) : absolutePath;
    };
    // A managed BUILT-IN is read-only everywhere: every surface that opens it
    // by name gets the preview, not the live doc. The sidebar routed managed
    // rows itself, but this shared opener (skill-ref chips, the palette, deep
    // links) fell through to the editable doc — an editable built-in.
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
    // Global: the managed `__skill__/global/<name>` doc resolves store-or-native
    // server-side, so it is always safe to open directly.
    if (scope === 'global') return open(skillLiveDocName(scope, name, opts?.host));
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
