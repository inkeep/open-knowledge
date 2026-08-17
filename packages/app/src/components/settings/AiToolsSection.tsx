/**
 * Settings → User → AI tools & CLI — the persistent, stateful sibling of the
 * first-launch "Connect your AI tools to OpenKnowledge" consent dialog
 * (`McpConsentDialogBody.tsx`). Same three component groups (shell-PATH shim,
 * per-editor MCP entries, user-global Agent Skills). The PATH and MCP rows are
 * checkboxes that reflect LIVE installed state and apply on click (check =
 * install, uncheck = uninstall), each with an info tooltip disclosing the file +
 * entry it touches. Agent Skills instead use an explicit Install/Uninstall button
 * behind a confirm modal — a single click never writes — with the skill's reach
 * and context cost disclosed on the row itself. One component mutates at a time
 * (main serializes; the UI disables the group while a toggle is in flight).
 *
 * Desktop-only — the sidebar item is gated on the Electron preload bridge, and
 * this component renders a fallback if mounted without it.
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { EDITOR_SETUP_DOC_SLUG } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Info } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SkillConsentRow } from '@/components/SkillConsentRow';
import { SkillInstallConfirmDialog } from '@/components/SkillInstallConfirmDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OkIntegrationsSetRequest, OkIntegrationsStatus } from '@/lib/desktop-bridge-types';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';
import { mark } from '@/lib/perf';
import { SettingsSectionHeader } from './SettingsSectionHeader';

type ComponentRef = OkIntegrationsSetRequest['component'];

/** Stable per-row key for the in-flight marker. */
function componentKey(component: ComponentRef): string {
  if (component.kind === 'editor') return `editor:${component.id}`;
  if (component.kind === 'skill') return `skill:${component.id}`;
  return 'path';
}

/**
 * Per-row disclosure tooltip: exactly which file/entry (or folders) the
 * checkbox touches. Rendered as a sibling of the row's Label — a button
 * inside the label would sit in its activation path.
 */
function RowInfoTooltip({ testId, children }: { testId: string; children: ReactNode }) {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="mt-1.5 mr-1.5 h-6 w-6 shrink-0 text-muted-foreground opacity-60 hover:opacity-100"
          aria-label={t`What this checkbox changes`}
          data-testid={testId}
        >
          <Info className="size-3.5" />
        </Button>
      </TooltipTrigger>
      {/* The base TooltipContent is a flex ROW (inline-flex items-center) —
          without the single-column wrapper, sibling <p>s render side by side. */}
      <TooltipContent side="left" className="max-w-sm text-left">
        <div className="flex min-w-0 flex-col gap-1">{children}</div>
      </TooltipContent>
    </Tooltip>
  );
}

export function AiToolsSection() {
  const { t } = useLingui();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const [status, setStatus] = useState<OkIntegrationsStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    skillId: string;
    mode: 'install' | 'uninstall';
  } | null>(null);
  const [showAllEditors, setShowAllEditors] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge.integrations
      .status()
      .then((snapshot) => {
        if (!cancelled) setStatus(snapshot);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // No `finally` — the React Compiler can't lower TryStatement finalizers
  // (BuildHIR::lowerStatement Todo); the catch swallows, so the trailing
  // setPending(null) runs on both paths.
  async function applyToggle(component: ComponentRef, enabled: boolean): Promise<void> {
    if (!bridge) return;
    setPending(componentKey(component));
    try {
      const result = await bridge.integrations.setComponent({ component, enabled });
      setStatus(result.status);
      if (!result.ok) toast.error(result.error);
    } catch (err) {
      toast.error(
        t`Couldn't apply the change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setPending(null);
  }

  // Settings install/uninstall runs behind the confirm modal — never a single
  // click. The modal fires this only once the user has acknowledged the
  // destination set it currently shows; mark the attempt with its surface +
  // reach, close the modal, then route through the same bridge path the editor
  // and path rows use (setComponent → reclaim), never the skills HTTP API.
  async function onConfirmSkill(): Promise<void> {
    if (!confirm) return;
    const target = status?.skills.find((s) => s.id === confirm.skillId);
    mark('ok/skill/install', {
      surface: 'settings',
      mode: confirm.mode,
      skill: confirm.skillId,
      hostCount: target?.resolvedHosts.length ?? 0,
    });
    const { skillId, mode } = confirm;
    setConfirm(null);
    await applyToggle({ kind: 'skill', id: skillId }, mode === 'install');
  }

  // Yours first, the rest folded. A row is primary when OK has WIRED it
  // (`installed`, `foreign`, or `unmanageable` — its config file exists, which is
  // what makes the tool real), or when the editor is detected.
  //
  // Detection ORDERS but never CLAIMS. That is one rule across every agent list:
  // the external-apps group lets its probe pick a row's default, this one lets
  // the probe pick a row's position, and neither prints an assertion of presence
  // on the row. No surface prints `Detected on this machine`, precisely so the
  // signal can stay useful for ranking without being read as a fact.
  //
  // The signal is a probe of the machine — a CLI on the login-shell PATH, or the
  // app the OS says owns the URL scheme — and it answers "is this tool here",
  // not "did the user set it up with us". Those are different questions, so
  // ranking is the most it earns. A row it lifts still shows `How to set up`,
  // never a presence claim.
  const editors = status?.editors ?? [];
  const isPrimaryEditor = (e: (typeof editors)[number]): boolean =>
    e.state !== 'not-installed' || e.detected;
  const primaryEditors = editors.filter(isPrimaryEditor);
  // Nothing configured and nothing detected would otherwise fold the entire list
  // away and leave an empty box under the heading. A fold that hides everything
  // is not a fold.
  const foldable = primaryEditors.length > 0 && primaryEditors.length < editors.length;
  const shownEditors =
    !foldable || showAllEditors
      ? [...editors].sort((a, b) => Number(isPrimaryEditor(b)) - Number(isPrimaryEditor(a)))
      : primaryEditors;
  const hiddenCount = foldable ? editors.length - primaryEditors.length : 0;

  const header = (
    <SettingsSectionHeader
      titleId="settings-ai-tools-title"
      title={<Trans>AI tools & CLI</Trans>}
      scope="user"
    >
      <Trans>
        Give the AI tools you use access to read and update your projects. Checking a box sets it up
        right away; unchecking removes it.
      </Trans>
    </SettingsSectionHeader>
  );

  if (!bridge || loadFailed) {
    return (
      <section aria-labelledby="settings-ai-tools-title" className="space-y-4">
        {header}
        <p className="text-sm text-muted-foreground" data-testid="ai-tools-unavailable">
          <Trans>AI tool management is only available in the OpenKnowledge desktop app.</Trans>
        </p>
      </section>
    );
  }

  if (status === null) {
    return (
      <section aria-labelledby="settings-ai-tools-title" className="space-y-4">
        {header}
        <div className="space-y-2" data-testid="ai-tools-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </section>
    );
  }

  const busy = pending !== null || !status.available;
  const showPathRow = status.path.shellDetected || status.path.installed;
  // Re-resolved from live status each render, so the modal always discloses the
  // destinations currently on the status snapshot — it re-confirms on its own if
  // they drift while it is open.
  const confirmSkill = confirm
    ? (status.skills.find((s) => s.id === confirm.skillId) ?? null)
    : null;

  return (
    <section aria-labelledby="settings-ai-tools-title" className="space-y-4">
      {header}

      {!status.available && (
        <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="ai-tools-read-only">
          <Trans>Managing AI tools is unavailable in this build.</Trans>
        </p>
      )}

      {showPathRow && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            <Trans comment="Group label above the shell-PATH row in Settings → AI tools & CLI">
              Terminal
            </Trans>
          </span>
          {/* Row hover lives on the container so the info-button strip grays
              with the rest of the row instead of reading as its own column. */}
          <div className="flex items-start overflow-hidden rounded-md border border-border bg-card/50 hover:bg-accent">
            <Label
              htmlFor="ai-tools-path"
              className="flex flex-1 cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal"
            >
              <Checkbox
                id="ai-tools-path"
                checked={status.path.installed}
                disabled={busy}
                onCheckedChange={() => void applyToggle({ kind: 'path' }, !status.path.installed)}
                className="mt-0.5"
                data-testid="ai-tools-path-checkbox"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  <Trans comment="Checkbox in Settings → AI tools & CLI that adds the ok CLI to the user's shell PATH">
                    Add the <code className="inline-code">ok</code> command to your terminal
                  </Trans>
                </span>
                <span className="text-xs text-muted-foreground" data-testid="ai-tools-path-status">
                  {status.path.installed
                    ? t`Installed — ok is available in external terminals. Unchecking removes it; OpenKnowledge's built-in terminal and AI tools keep working.`
                    : t`Adds a managed block to ${status.path.rcFilesToTouch.join(', ')}`}
                </span>
              </span>
            </Label>
            <RowInfoTooltip testId="ai-tools-path-info">
              <p className="opacity-70">
                <Trans>Adds a managed block to</Trans>
              </p>
              {status.path.rcFilesToTouch.map((file) => (
                <p key={file}>
                  <code className="break-all">{file}</code>
                </p>
              ))}
              <p className="pt-1">
                <Trans>
                  <code>~/.ok/bin</code> and <code>~/.ok/env.sh</code> stay either way — the app
                  always maintains them.
                </Trans>
              </p>
            </RowInfoTooltip>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          <Trans comment="Group label above the per-editor MCP list in Settings → AI tools & CLI — each row wires OpenKnowledge's MCP server into that tool">
            MCP connections
          </Trans>
        </span>
        <ul className="rounded-md border border-border bg-card/50 divide-y divide-border overflow-hidden">
          {shownEditors.map((editor) => {
            const checked = editor.state === 'installed' || editor.state === 'foreign';
            const disabled = busy || editor.state === 'unmanageable';
            // Every never-configured tool gets the setup-guide link, detected or
            // not. A row offering to configure a tool must not also assert the
            // user has it: those two claims on one row contradict each other, and
            // the row is the weakest place to stake presence. `detected` orders
            // the list below; it never speaks here.
            const showSetupLink = editor.state === 'not-installed';
            const setupUrl = `https://openknowledge.ai/docs/integrations/${EDITOR_SETUP_DOC_SLUG[editor.id]}`;
            const statusLabel =
              editor.state === 'installed'
                ? t`Installed`
                : editor.state === 'foreign'
                  ? t`Custom open-knowledge entry — not managed by OpenKnowledge`
                  : editor.state === 'unmanageable'
                    ? t`Can't safely edit this tool's config`
                    : null;
            const statusClass =
              editor.state === 'foreign' || editor.state === 'unmanageable'
                ? 'text-xs text-amber-600 dark:text-amber-400'
                : 'text-xs text-muted-foreground';
            return (
              <li
                key={editor.id}
                className={disabled ? 'flex items-start' : 'flex items-start hover:bg-accent'}
              >
                <Label
                  htmlFor={`ai-tools-editor-${editor.id}`}
                  className={
                    disabled
                      ? 'flex flex-1 items-start gap-2.5 px-3 py-2.5 font-normal'
                      : 'flex flex-1 cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal'
                  }
                >
                  <Checkbox
                    id={`ai-tools-editor-${editor.id}`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={() =>
                      void applyToggle({ kind: 'editor', id: editor.id }, !checked)
                    }
                    className="mt-0.5"
                    data-testid={`ai-tools-editor-checkbox-${editor.id}`}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">{editor.label}</span>
                    {statusLabel !== null && (
                      <span
                        className={statusClass}
                        data-testid={`ai-tools-editor-status-${editor.id}`}
                      >
                        {statusLabel}
                      </span>
                    )}
                  </span>
                </Label>
                {/* Sibling of the Label, not a descendant — an anchor must never
                    sit inside a label's activation path. */}
                {showSetupLink && (
                  <a
                    href={setupUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => dispatchExternalLinkClick(e, setupUrl)}
                    onAuxClick={(e) => dispatchExternalLinkClick(e, setupUrl)}
                    aria-label={t`How to set up ${editor.label} (opens in browser)`}
                    className="flex shrink-0 items-center gap-0.5 px-2 py-2.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    data-testid={`ai-tools-editor-status-${editor.id}`}
                  >
                    <Trans comment="Link on an undetected tool row to its OpenKnowledge setup guide">
                      How to set up
                    </Trans>
                    <ArrowUpRight className="size-3" aria-hidden />
                  </a>
                )}
                <RowInfoTooltip testId={`ai-tools-editor-info-${editor.id}`}>
                  <p className="opacity-70">
                    <Trans>File</Trans>
                  </p>
                  <p>
                    <code className="break-all">
                      {editor.configPath ?? t`unavailable on this platform`}
                    </code>
                  </p>
                  <p className="pt-1 opacity-70">
                    <Trans>Entry</Trans>
                  </p>
                  <p>
                    <code className="break-all">{editor.entryLocator}</code>
                  </p>
                </RowInfoTooltip>
              </li>
            );
          })}
          {hiddenCount > 0 ? (
            <li>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowAllEditors((v) => !v)}
                className="w-full justify-center rounded-none font-normal text-muted-foreground text-xs"
                data-testid="ai-tools-editors-show-more"
              >
                {/* Never names what the probe thinks of the hidden rows: an
                    "N not found" label would reassert the same unbacked detection
                    claim this surface removed, one line lower. The noun is left off
                    to reuse the
                    Configure agents msgid verbatim — a counted noun would need
                    plural forms in every locale to buy a word the "MCP
                    connections" heading above already supplies. */}
                {showAllEditors ? t`Show less` : t`Show ${hiddenCount} more`}
              </Button>
            </li>
          ) : null}
        </ul>
      </div>

      {status.skills.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            <Trans comment="Group label above the skill rows in Settings → AI tools & CLI">
              Agent Skills
            </Trans>
          </span>
          <p className="text-xs text-muted-foreground" data-testid="ai-tools-skill-fanout-note">
            <Trans comment="Tells the user a skill installs to every detected AI tool, independent of the per-tool MCP connections listed above">
              Skills install to every AI tool detected on this machine, independent of the MCP
              connections you chose above.
            </Trans>
          </p>
          <ul className="rounded-md border border-border bg-card/50 divide-y divide-border overflow-hidden">
            {status.skills.map((skill) => {
              const hosts = skill.resolvedHosts.map((h) => h.editor);
              const canInstall = hosts.length > 0;
              // Bound as `name` so the accessible names reuse the catalog's
              // existing `Install {name}` / `Uninstall {name}` msgids rather
              // than minting `Install {0}` variants needing fresh translation
              // in all eleven locales.
              const name = skill.name;
              return (
                <li key={skill.id} className="hover:bg-accent">
                  <SkillConsentRow
                    name={skill.name}
                    description={skill.description}
                    hosts={hosts}
                    size={skill.size}
                    onActivate={
                      skill.sourceDir
                        ? () => {
                            mark('ok/skill/preview-open', { surface: 'settings', skill: skill.id });
                            openSkillPreviewTab({
                              flavor: 'builtin',
                              source: skill.sourceDir,
                              name: skill.name,
                              subtitle: '',
                              level: 'global',
                            });
                          }
                        : undefined
                    }
                    control={
                      skill.installed ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirm({ skillId: skill.id, mode: 'uninstall' })}
                          aria-label={t`Uninstall ${name}`}
                          data-testid={`ai-tools-skill-uninstall-${skill.id}`}
                        >
                          <Trans>Uninstall</Trans>
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy || !canInstall}
                          onClick={() => setConfirm({ skillId: skill.id, mode: 'install' })}
                          aria-label={t`Install ${name}`}
                          data-testid={`ai-tools-skill-install-${skill.id}`}
                        >
                          <Trans>Install</Trans>
                        </Button>
                      )
                    }
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {confirmSkill && confirm && (
        <SkillInstallConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirm(null);
          }}
          mode={confirm.mode}
          name={confirmSkill.name}
          description={confirmSkill.description}
          paths={confirmSkill.paths}
          size={confirmSkill.size}
          onConfirm={() => void onConfirmSkill()}
        />
      )}
    </section>
  );
}
