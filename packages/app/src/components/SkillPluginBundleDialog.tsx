import {
  EDITOR_LABELS,
  type PluginBundleMetadata,
  type SkillScope,
  type SkillTargetEditor,
} from '@inkeep/open-knowledge-core';

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useSkillTargets } from '@/hooks/use-skill-targets';
import { SKILL_SCOPE_ORDER, useSkillScopeLabels } from '@/lib/skill-scope';
import { discoverSkillsInSource, importSkillsBulk, installSkill } from '@/lib/skills-api';

/**
 * One source that carries several skills, normalized across the two ways we
 * learn that. A cloned repo can declare a PLUGIN manifest (`plugin` names it,
 * and the manifest also lists capabilities OK never installs); a website
 * source has no manifest at all — its `.well-known` index simply lists every
 * skill on that origin, which is a bundle in every sense that matters here
 * (`plugin: null`). Both feed the same picker.
 */
export interface SkillBundleDisclosure {
  /** Plugin name when a manifest declares one; null for a bare multi-skill source. */
  plugin: string | null;
  /** Every skill the source carries, including the one being previewed. */
  names: readonly string[];
  /** Executable capabilities the plugin ships. Named only, never installed. */
  capabilities?: PluginBundleMetadata['capabilities'];
  repositoryUrl?: string;
}

/**
 * Pick which of a source's bundled skills to install. Reached from the
 * "part of a plugin" / "this source has N skills" disclosure on an un-imported
 * preview.
 *
 * A PICKER, deliberately not a one-click "install all 41": dozens of unreviewed
 * skills all competing to trigger is a worse outcome than the three the user
 * actually wanted, and every row here lands in the agent's context. The whole
 * selection imports through ONE server-side clone
 * (`POST /api/skills/import-bulk`), which is the reason this exists rather than
 * the per-skill Install menu run N times.
 */
export function SkillPluginBundleDialog({
  bundle,
  source,
  defaultScope,
  onInstalled,
  onOpenChange,
}: {
  /** `null` keeps the dialog closed. */
  bundle: SkillBundleDisclosure | null;
  /** The import source the preview was opened with (repo, site, or skills.sh URL). */
  source: string;
  defaultScope: SkillScope;
  /** Skills that landed, keyed BOTH by what was requested and by the on-disk
   *  name (they differ on a collision rename). The preview tab that hosts this
   *  banner uses it to stop showing a preview of a skill the user now owns. */
  onInstalled?: (landed: ReadonlyMap<string, string>) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const scopeId = useId();
  const scopeLabels = useSkillScopeLabels();
  const [scope, setScope] = useState<SkillScope>(defaultScope);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Descriptions come from the same enumeration the Import picker uses. The
  // manifest's `bundledSkills` is the fallback: names alone still install, and a
  // flaked discover shouldn't empty the list.
  const [described, setDescribed] = useState<ReadonlyMap<string, string | null>>(new Map());
  // Which agents the selection is projected into. Seeded from the project's
  // configured targets — the set the server would have auto-projected into —
  // so the common case is one click, and any other set is a deliberate change.
  const skillTargets = useSkillTargets();
  const [editors, setEditors] = useState<ReadonlySet<SkillTargetEditor> | null>(null);
  const configuredTargets =
    skillTargets.state.status === 'ready' ? skillTargets.state.data.targets : null;
  const effectiveEditors: ReadonlySet<SkillTargetEditor> =
    editors ?? new Set(configuredTargets ?? []);

  const open = bundle !== null;
  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setEditors(null);
    setScope(defaultScope);
    const ctrl = new AbortController();
    void discoverSkillsInSource(source, ctrl.signal).then((res) => {
      if (ctrl.signal.aborted || !res.ok) return;
      setDescribed(new Map(res.skills.map((s) => [s.name, s.description])));
    });
    return () => ctrl.abort();
  }, [open, source, defaultScope]);

  if (!bundle) return null;
  const { plugin, names } = bundle;
  const allSelected = selected.size === names.length && names.length > 0;

  function toggle(name: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(name);
    else next.delete(name);
    setSelected(next);
  }

  async function install() {
    setBusy(true);
    // Acquire with `install: false`, then project explicitly into the agents the
    // user ticked. Letting the server auto-project would silently install into
    // whatever it detects, which is the one thing a destination picker exists to
    // prevent — and the same set-exact contract the single-skill menu uses.
    const result = await importSkillsBulk({
      source,
      skills: [...selected],
      scope,
      install: false,
      // The bundle disclosure only exists on the Explore (skills.sh) flavor —
      // same marketplace-provenance condition the single-skill path uses — so
      // the whole selection is reported as one batched install event.
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
      // Sequential: each is a local projection, and the shared placements ledger
      // is a read-modify-write that concurrent installs would clobber.
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
    setBusy(false);
    const { imported, alreadyImported, failed } = result;
    if (failed > 0) {
      // Name the failures: a count alone leaves the user unable to retry the
      // right rows. The successes are already on disk either way.
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
    // Report what landed BEFORE closing: the host may replace this whole subtree
    // (a preview tab swaps itself for the real skill), and a callback fired
    // after that never arrives. Keyed by BOTH the requested name and the on-disk
    // one — a collision rename makes them differ, and the caller may know either.
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
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onOpenChange(false);
      }}
    >
      <DialogContent className="sm:max-w-lg">
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
          <div className="flex flex-col gap-2">
            <Label htmlFor={scopeId}>
              <Trans>Level</Trans>
            </Label>
            <Select value={scope} onValueChange={(v) => setScope(v as SkillScope)}>
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
              {INSTALL_EDITORS.map((editor) => (
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
            </div>
            {effectiveEditors.size === 0 ? (
              // Not an error: the skills still land as project skills you can
              // install later. Say so, so an empty set doesn't read as a failure.
              <p className="text-1sm text-muted-foreground">
                <Trans>No agents selected — the skills are saved but not installed anywhere.</Trans>
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between">
            <p className="font-medium text-xs font-mono text-muted-foreground/80 uppercase tracking-wider">
              <Trans>
                {selected.size} of {names.length} selected
              </Trans>
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setSelected(allSelected ? new Set() : new Set(names))}
            >
              {allSelected ? <Trans>Clear</Trans> : <Trans>Select all</Trans>}
            </Button>
          </div>
          {/* The list scrolls inside the dialog: a 40-skill plugin would
              otherwise push the footer off-screen. */}
          <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
            {names.map((name) => {
              const description = described.get(name);
              return (
                <Label
                  key={name}
                  className="flex cursor-pointer items-start gap-3 p-3 text-sm font-normal hover:bg-muted/40"
                >
                  <Checkbox
                    checked={selected.has(name)}
                    disabled={busy}
                    onCheckedChange={(checked) => toggle(name, checked === true)}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono">{name}</span>
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
            ) : (
              <Trans>Install selected</Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
