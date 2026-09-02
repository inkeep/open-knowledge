import {
  AGENTS_SKILLS_ROOT,
  isSkillInstallTarget,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { INSTALL_EDITORS, type SkillHostToggles } from '@/components/SkillInstallMenu';
import { useSkills } from '@/hooks/use-skills';
import { importSkill, installSkill, placeSkill } from '@/lib/skills-api';

export function useExplorePreviewInstall({
  source,
  name,
  initialScope,
  marketplace,
}: {
  source: string;
  name: string;
  initialScope: SkillScope;
  marketplace?: boolean;
}): {
  scope: SkillScope;
  setScope: (s: SkillScope) => void;
  scopeLocked: boolean;
  importedName: string | null;
  importedPath: string | null;
  importedScope: SkillScope | null;
  importNow: () => Promise<string | null>;
  toggles: SkillHostToggles;
} {
  const { t } = useLingui();
  const [scope, setScope] = useState<SkillScope>(initialScope);
  const allSkills = useSkills();
  const installableEditorsForScope = (): Set<string> | null => {
    if (allSkills.status !== 'ready') return null;
    const list = allSkills.data.find((s) => s.scope === scope)?.installableEditors;
    return list ? new Set<string>(list) : null;
  };
  const [importedName, setImportedName] = useState<string | null>(null);
  const [importedPath, setImportedPath] = useState<string | null>(null);
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
      setImportedPath(res.path ?? null);
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
      const installable = installableEditorsForScope();
      void commit(
        installable === null
          ? [...INSTALL_EDITORS]
          : INSTALL_EDITORS.filter((e) => installable.has(e)),
      );
    },
    linkMode: true,
    placeAt(root, mode) {
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
    importedPath,
    importedScope,
    importNow: ensureImported,
    toggles,
  };
}
