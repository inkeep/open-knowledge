import {
  AGENTS_SKILLS_ROOT,
  isSkillInstallTarget,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { INSTALL_EDITORS, type SkillHostToggles } from '@/components/SkillInstallMenu';
import { importSkill, installSkill, placeSkill } from '@/lib/skills-api';

/**
 * Install flow for an un-imported Explore / skills.sh preview. The per-agent menu
 * (`SkillInstallMenuItems`) drives it — but the skill doesn't exist in OK yet, so
 * the FIRST agent toggle imports it (at the chosen scope) and then installs. The
 * imported on-disk name can collision-rename, so this can't reuse
 * `useSkillHostToggles` (which keys off a live `SkillsListEntry`); it owns the
 * import-once → install cycle and exposes the same `SkillHostToggles` shape so the
 * shared menu renders unchanged. "Import" is implied — the user only ever sees
 * "Install". Scope locks after the first import (moving scope mid-flight would be
 * a re-import).
 */
export function useExplorePreviewInstall({
  source,
  name,
  initialScope,
  marketplace,
}: {
  source: string;
  name: string;
  initialScope: SkillScope;
  /** The source is a skills.sh listing (Explore), so the install is reported to
   *  skills.sh and counts toward that listing. False for the plugin-copy flow,
   *  whose source is a local harness cache dir. */
  marketplace?: boolean;
}): {
  scope: SkillScope;
  setScope: (s: SkillScope) => void;
  scopeLocked: boolean;
  /** The on-disk skill name once imported (else null) — the caller transitions the
   *  preview tab into this real skill when the install menu closes. */
  importedName: string | null;
  /** The scope the bundle ACTUALLY landed at, captured at import time (else
   *  null). The caller must redirect against this, not the live `scope` state:
   *  `scope` is a user-settable selector that can move after the import, and
   *  opening a skill resolves its doc by (scope, name), so a disagreement sends
   *  the tab at a document that does not exist. */
  importedScope: SkillScope | null;
  /** Import WITHOUT installing anywhere (the custom-path flow) — returns the
   *  on-disk name, or null on failure (toast already shown). */
  importNow: () => Promise<string | null>;
  toggles: SkillHostToggles;
} {
  const { t } = useLingui();
  const [scope, setScope] = useState<SkillScope>(initialScope);
  const [importedName, setImportedName] = useState<string | null>(null);
  // Mirrors `importedScopeRef` into render state so the caller's redirect can
  // read it; the ref alone is invisible to React.
  const [importedScope, setImportedScope] = useState<SkillScope | null>(null);
  const [hosts, setHosts] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const liveHostsRef = useRef<readonly string[]>([]);
  const importedNameRef = useRef<string | null>(null);
  const importedScopeRef = useRef<SkillScope | null>(null);
  const importPromiseRef = useRef<Promise<string | null> | null>(null);
  const desiredHostsRef = useRef<readonly string[]>([]);
  const commitRunningRef = useRef(false);

  async function ensureImported(): Promise<string | null> {
    if (importedNameRef.current) return importedNameRef.current;
    if (importPromiseRef.current) return importPromiseRef.current;
    // `install: false` — every explore flow installs EXPLICITLY (toggles are
    // set-exact; custom-path places): the default-editor auto-projection would
    // silently install into editors the user never picked.
    const importScope = scope;
    const pending = importSkill({
      source,
      skill: name,
      scope: importScope,
      install: false,
      ...(marketplace ? { marketplace: true } : {}),
    }).then((res) => {
      if (!res.ok) {
        toast.error(t`Install failed: ${res.error}`);
        return null;
      }
      importedNameRef.current = res.name;
      importedScopeRef.current = importScope;
      setImportedScope(importScope);
      setImportedName(res.name);
      return res.name;
    });
    importPromiseRef.current = pending;
    const result = await pending;
    importPromiseRef.current = null;
    return result;
  }

  async function commit(nextHosts: readonly string[]) {
    liveHostsRef.current = nextHosts;
    desiredHostsRef.current = nextHosts;
    setHosts(nextHosts);
    if (commitRunningRef.current) return;
    commitRunningRef.current = true;
    setBusy(true);
    while (true) {
      const requestedHosts = desiredHostsRef.current;
      const skillName = await ensureImported();
      const importScope = importedScopeRef.current;
      if (!skillName || !importScope) break;
      // A just-imported skill has no existing location to reclassify, so it
      // takes the symlink default outright: one real folder, links elsewhere.
      const result = await installSkill({
        scope: importScope,
        name: skillName,
        targets: [...requestedHosts],
        linkMode: true,
      });
      if (!result.ok) {
        toast.error(t`Couldn't install: ${result.error}`);
        break;
      }
      if (requestedHosts === desiredHostsRef.current) {
        const nonEditorHosts = liveHostsRef.current.filter((host) => !isSkillInstallTarget(host));
        const resolvedHosts = [...new Set([...nonEditorHosts, ...result.hosts])];
        liveHostsRef.current = resolvedHosts;
        setHosts(resolvedHosts);
        break;
      }
    }
    commitRunningRef.current = false;
    setBusy(false);
  }

  const toggles: SkillHostToggles = {
    hostSet: new Set(hosts),
    installed: hosts.length > 0,
    installing: busy,
    toggleEditor(editor, on) {
      // The `.agents` hub isn't an editor-projection target on the legacy
      // (store-backed) install path — route it through import + place into
      // `.agents/skills`. The preview redirects to the real skill tab on
      // import, whose menu handles the hub natively from there.
      if (editor === 'agents') {
        if (!on) return;
        void (async () => {
          setBusy(true);
          const skillName = await ensureImported();
          const importScope = importedScopeRef.current;
          if (skillName && importScope) {
            const result = await placeSkill({
              scope: importScope,
              name: skillName,
              dir: AGENTS_SKILLS_ROOT,
              mode: 'copy',
            });
            if (result.ok) {
              const nextHosts = [...new Set([...liveHostsRef.current, 'agents'])];
              liveHostsRef.current = nextHosts;
              setHosts(nextHosts);
            } else {
              toast.error(t`Couldn't install: ${result.error}`);
            }
          }
          setBusy(false);
        })();
        return;
      }
      const next = new Set(liveHostsRef.current);
      if (on) next.add(editor);
      else next.delete(editor);
      void commit([...next]);
    },
    installAll() {
      void commit([...INSTALL_EDITORS]);
    },
    linkMode: true,
    // A preview has no installed location, so the location verbs are OMITTED
    // rather than stubbed: the menu gates each control on its verb existing, so
    // a control that cannot work here cannot render here either.
    placeAt(root, mode) {
      // Import-once, then place — same implied-import contract as the toggles.
      void (async () => {
        setBusy(true);
        const skillName = await ensureImported();
        const importScope = importedScopeRef.current;
        if (skillName && importScope) {
          const result = await placeSkill({ scope: importScope, name: skillName, dir: root, mode });
          if (!result.ok) toast.error(t`Couldn't install: ${result.error}`);
        }
        setBusy(false);
      })();
    },
  };

  return {
    scope,
    setScope,
    scopeLocked: importedName !== null || busy,
    importedName,
    importedScope,
    importNow: ensureImported,
    toggles,
  };
}
