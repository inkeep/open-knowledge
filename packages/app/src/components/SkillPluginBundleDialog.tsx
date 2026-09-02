import {
  EDITOR_LABELS,
  type PluginBundleMetadata,
  type SkillScope,
  type SkillTargetEditor,
} from '@inkeep/open-knowledge-core';

import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { AgentIconCluster } from '@/components/AgentIconCluster';
import { INSTALL_EDITORS } from '@/components/SkillInstallMenu';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useSkillTargets } from '@/hooks/use-skill-targets';
import { useSkills } from '@/hooks/use-skills';
import { customPlacementRoot, SKILL_SCOPE_ORDER, useSkillScopeLabels } from '@/lib/skill-scope';
import {
  discoverSkillsInSource,
  importSkillsBulk,
  installSkill,
  placeSkill,
} from '@/lib/skills-api';

export interface SkillBundleDisclosure {
  plugin: string | null;
  names: readonly string[];
  descriptions?: Readonly<Record<string, string | null>>;
  capabilities?: PluginBundleMetadata['capabilities'];
  repositoryUrl?: string;
}

interface SkillBundleInstallOverride {
  scope: SkillScope;
  installSelected: (names: readonly string[]) => Promise<ReadonlyMap<string, string> | null>;
}

interface SkillPluginBundleDialogProps {
  bundle: SkillBundleDisclosure | null;
  source: string;
  defaultScope: SkillScope;
  installOverride?: SkillBundleInstallOverride;
  onInstalled?: (landed: ReadonlyMap<string, string>) => void;
  onOpenChange: (open: boolean) => void;
  returnFocus?: () => void;
}

export function SkillPluginBundleDialog(props: SkillPluginBundleDialogProps) {
  if (!props.bundle) return null;
  return <OpenSkillPluginBundleDialog {...props} bundle={props.bundle} />;
}

function OpenSkillPluginBundleDialog({
  bundle,
  source,
  defaultScope,
  installOverride,
  onInstalled,
  onOpenChange,
  returnFocus,
}: SkillPluginBundleDialogProps & { bundle: SkillBundleDisclosure }) {
  const { t } = useLingui();
  const scopeId = useId();
  const scopeLabels = useSkillScopeLabels();
  const [scope, setScope] = useState<SkillScope>(installOverride?.scope ?? defaultScope);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() =>
    installOverride ? new Set(bundle.names) : new Set(),
  );
  const [busy, setBusy] = useState(false);
  const [described, setDescribed] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(Object.entries(bundle.descriptions ?? {})),
  );
  const skillTargets = useSkillTargets();
  const [editors, setEditors] = useState<ReadonlySet<SkillTargetEditor> | null>(null);
  const configuredTargets =
    skillTargets.state.status === 'ready' ? skillTargets.state.data.targets : null;
  const effectiveEditors: ReadonlySet<SkillTargetEditor> =
    editors ?? new Set(configuredTargets ?? []);
  const skillsState = useSkills();
  const installableList =
    skillsState.status === 'ready'
      ? skillsState.data.find((s) => s.scope === scope)?.installableEditors
      : undefined;
  const offeredEditors = INSTALL_EDITORS.filter(
    (e) => !installableList || installableList.includes(e) || effectiveEditors.has(e),
  );
  const installedNames: ReadonlySet<string> =
    skillsState.status === 'ready'
      ? new Set(skillsState.data.filter((s) => s.scope === scope).map((s) => s.name))
      : new Set();
  const [customRoots, setCustomRoots] = useState<ReadonlySet<string>>(new Set());
  const offeredCustomRoots: readonly string[] = (() => {
    const roots = new Set<string>();
    if (skillTargets.state.status === 'ready') {
      for (const f of skillTargets.state.data.folders ?? []) {
        if (f.scope !== scope) continue;
        if ((INSTALL_EDITORS as readonly string[]).includes(f.host)) continue;
        if (f.root) roots.add(f.root);
      }
    }
    if (skillsState.status === 'ready') {
      for (const s of skillsState.data) {
        if (s.scope !== scope) continue;
        for (const cp of s.customPlacements ?? []) {
          const root = customPlacementRoot(cp);
          if (root) roots.add(root);
        }
      }
    }
    return [...roots].sort();
  })();

  const usesInstallOverride = installOverride !== undefined;
  useEffect(() => {
    if (usesInstallOverride) return;
    const ctrl = new AbortController();
    void discoverSkillsInSource(source, ctrl.signal).then((res) => {
      if (ctrl.signal.aborted || !res.ok) return;
      setDescribed(new Map(res.skills.map((s) => [s.name, s.description])));
    });
    return () => ctrl.abort();
  }, [source, usesInstallOverride]);

  const { plugin, names } = bundle;
  const selectableNames = names.filter((n) => !installedNames.has(n));
  const allSelected = selected.size === selectableNames.length && selectableNames.length > 0;

  function toggle(name: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(name);
    else next.delete(name);
    setSelected(next);
  }

  async function install() {
    setBusy(true);
    if (installOverride) {
      const landed = await installOverride.installSelected([...selected]);
      setBusy(false);
      if (landed === null) return;
      if (landed.size > 0) onInstalled?.(landed);
      onOpenChange(false);
      return;
    }
    const result = await importSkillsBulk({
      source,
      skills: [...selected],
      scope,
      install: false,
      marketplace: true,
    });
    if (!result.ok) {
      setBusy(false);
      toast.error(t`Couldn't install from ${plugin ?? source}: ${result.error}`);
      return;
    }
    const landed = result.results
      .map((r) => r.name)
      .filter((n): n is string => typeof n === 'string');
    const agents = [...effectiveEditors];
    if (agents.length > 0) {
      for (const skillName of landed) {
        const projected = await installSkill({
          scope,
          name: skillName,
          targets: agents,
          linkMode: true,
        });
        if (!projected.ok) toast.error(t`Couldn't install ${skillName}: ${projected.error}`);
      }
    }
    for (const root of customRoots) {
      for (const skillName of landed) {
        const placed = await placeSkill({ scope, name: skillName, dir: root, mode: 'link' });
        if (!placed.ok) toast.error(t`Couldn't place ${skillName} in ${root}: ${placed.error}`);
      }
    }
    setBusy(false);
    const { imported, alreadyImported, failed } = result;
    if (failed > 0) {
      const failedNames = result.results
        .filter((r) => r.status === 'failed' || r.status === 'not-found')
        .map((r) => r.requested)
        .join(', ');
      toast.error(t`Installed ${imported}, but ${failed} failed: ${failedNames}`);
    } else if (imported === 0) {
      toast.info(t`Already installed — nothing new to import.`);
    } else if (alreadyImported > 0) {
      toast.success(t`Installed ${imported} skills (${alreadyImported} were already present)`);
    } else {
      toast.success(t`Installed ${imported} skills from ${plugin ?? source}`);
    }
    const landedByRequest = new Map<string, string>();
    for (const r of result.results) {
      if (r.status !== 'imported' && r.status !== 'already-imported') continue;
      landedByRequest.set(r.requested, r.name ?? r.requested);
    }
    if (landedByRequest.size > 0) onInstalled?.(landedByRequest);
    onOpenChange(false);
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onOpenChange(false);
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return;
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {plugin ? <Trans>Install from {plugin}</Trans> : <Trans>Install from {source}</Trans>}
          </DialogTitle>
          <DialogDescription>
            {plugin ? (
              <Trans>
                Pick the skills to install. Each one lands as an editable skill you own; the
                plugin's hooks, commands, and MCP servers are not installed.
              </Trans>
            ) : (
              <Trans>
                Pick the skills to install. Each one lands as an editable skill you own.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="font-medium text-xs font-mono text-foreground/70 uppercase tracking-wider">
              <Trans>
                {selected.size} of {selectableNames.length} selected
              </Trans>
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setSelected(allSelected ? new Set() : new Set(selectableNames))}
            >
              {allSelected ? <Trans>Clear</Trans> : <Trans>Select all</Trans>}
            </Button>
          </div>
          {}
          <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
            {names.map((name) => {
              const description = described.get(name);
              const installed = installedNames.has(name);
              return (
                <Label
                  key={name}
                  className="flex cursor-pointer items-start gap-3 p-3 text-sm font-normal hover:bg-muted/40"
                >
                  <Checkbox
                    checked={installed || selected.has(name)}
                    disabled={busy || installed}
                    onCheckedChange={(checked) => toggle(name, checked === true)}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{name}</span>
                      {installed ? (
                        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                          <Trans>Installed</Trans>
                        </span>
                      ) : null}
                    </span>
                    {description ? (
                      <span className="text-1sm text-muted-foreground line-clamp-2">
                        {description}
                      </span>
                    ) : null}
                  </span>
                </Label>
              );
            })}
          </div>
          {}
          <div
            className="flex flex-wrap items-center gap-1.5 text-1sm text-muted-foreground"
            data-testid="plugin-bundle-destination"
          >
            {scope === 'project' ? (
              <Trans>Installs into this project</Trans>
            ) : (
              <Trans>Installs for all your projects</Trans>
            )}
            {usesInstallOverride ? null : (
              <>
                <span aria-hidden>·</span>
                {effectiveEditors.size + customRoots.size > 0 ? (
                  <AgentIconCluster
                    hosts={[...effectiveEditors, ...customRoots]}
                    iconClassName="size-3.5"
                  />
                ) : (
                  <Trans>no agents — saved, not installed anywhere</Trans>
                )}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-1"
                      disabled={busy}
                      data-testid="plugin-bundle-change-destination"
                    >
                      <Trans>Change</Trans>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="flex w-72 flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={scopeId}>
                        <Trans>Available in</Trans>
                      </Label>
                      <Select
                        value={scope}
                        disabled={busy}
                        onValueChange={(v) => setScope(v as SkillScope)}
                      >
                        <SelectTrigger id={scopeId} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SKILL_SCOPE_ORDER.map((s) => (
                            <SelectItem key={s} value={s}>
                              {scopeLabels[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label>
                        <Trans>Install into</Trans>
                      </Label>
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {offeredEditors.map((editor) => (
                          <Label
                            key={editor}
                            className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                          >
                            <Checkbox
                              checked={effectiveEditors.has(editor)}
                              disabled={busy}
                              onCheckedChange={(checked) => {
                                const next = new Set(effectiveEditors);
                                if (checked === true) next.add(editor);
                                else next.delete(editor);
                                setEditors(next);
                              }}
                            />
                            {EDITOR_LABELS[editor] ?? editor}
                          </Label>
                        ))}
                        {}
                        {offeredCustomRoots.map((root) => (
                          <Label
                            key={root}
                            className="flex cursor-pointer items-center gap-2 font-normal text-sm"
                          >
                            <Checkbox
                              checked={customRoots.has(root)}
                              disabled={busy}
                              onCheckedChange={(checked) => {
                                const next = new Set(customRoots);
                                if (checked === true) next.add(root);
                                else next.delete(root);
                                setCustomRoots(next);
                              }}
                            />
                            <span className="font-mono text-xs">{root}</span>
                          </Label>
                        ))}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            className="font-mono uppercase"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            data-testid="plugin-bundle-install"
            disabled={busy || selected.size === 0}
            onClick={() => void install()}
          >
            {busy ? (
              <>
                <Spinner aria-hidden="true" className="size-4" />
                <Trans>Installing</Trans>
              </>
            ) : selected.size === 0 ? (
              <Trans>Install</Trans>
            ) : (
              <Plural value={selected.size} one="Install # skill" other="Install # skills" />
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
