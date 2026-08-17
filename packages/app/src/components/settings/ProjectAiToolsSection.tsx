/**
 * Settings → This project → AI tools — the project-scoped sibling of
 * `AiToolsSection.tsx`. Where that surface manages OK's user-global footprint
 * (per-editor USER MCP entries, the shell-PATH shim, user-global skills), this
 * one manages the per-project footprint of the currently-open project:
 * per-editor project MCP config files (`.mcp.json`, `.cursor/mcp.json`,
 * `.codex/config.toml`, …) and the project runtime skill. These live in the
 * project folder and travel with it via git — a `project` (shared), not
 * `project-local` (per-machine), storage scope. Checkboxes reflect
 * LIVE installed state; each click applies immediately (check = install,
 * uncheck = uninstall) over the `projectIntegrations` bridge, which resolves
 * the window's project in main.
 *
 * The one thing the global section doesn't carry: per-editor follow-up honesty.
 * A written project config is not always a connected one — Claude Code needs a
 * one-time approval, Cursor sits silently disabled until manually enabled,
 * Codex auto-connects on a trusted project. Each installed row states its next
 * step so a project-only install isn't a silent dead-end.
 *
 * Desktop-only — the sidebar item is gated on the Electron preload bridge, and
 * this component renders a fallback if mounted without it.
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { Trans, useLingui } from '@lingui/react/macro';
import { Info } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SkillConsentRow } from '@/components/SkillConsentRow';
import { SkillInstallConfirmDialog } from '@/components/SkillInstallConfirmDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  OkProjectIntegrationsFollowUp,
  OkProjectIntegrationsSetRequest,
  OkProjectIntegrationsStatus,
} from '@/lib/desktop-bridge-types';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';
import { SettingsSectionHeader } from './SettingsSectionHeader';

type EditorRow = OkProjectIntegrationsStatus['editors'][number];
type ComponentRef = OkProjectIntegrationsSetRequest['component'];

/** Stable per-row key for the in-flight marker. */
function editorKey(id: string): string {
  return `editor:${id}`;
}
const SKILL_KEY = 'skill';

/**
 * Per-row disclosure tooltip. A sibling of the row's Label — a button inside
 * the label would sit in its activation path.
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
      {/* The base TooltipContent is a flex ROW — without the single-column
          wrapper, sibling <p>s render side by side. */}
      <TooltipContent side="left" className="max-w-sm text-left">
        <div className="flex min-w-0 flex-col gap-1">{children}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** The manual step, if any, an installed editor still needs before OK's tools
 *  actually connect for this project. Rendered only on installed/foreign rows. */
function FollowUpHint({
  followUp,
  testId,
}: {
  followUp: OkProjectIntegrationsFollowUp;
  testId: string;
}) {
  if (followUp === 'none') return null;
  return (
    // Live region: the hint appears the moment a row toggles to installed, so
    // its "one more step" is announced rather than silently painted.
    <span role="status" className="text-xs text-amber-600 dark:text-amber-400" data-testid={testId}>
      {followUp === 'approve-once' ? (
        <Trans comment="Next step for a Claude Code project MCP row">
          One more step: run <code className="inline-code">claude</code> in this project and approve
          OpenKnowledge once.
        </Trans>
      ) : followUp === 'enable-manually' ? (
        <Trans comment="Next step for a Cursor project MCP row — Cursor leaves project servers disabled">
          One more step: enable it in Cursor → Settings → Tools & MCP (Cursor leaves project servers
          off until you turn them on).
        </Trans>
      ) : (
        <Trans comment="Next step for a Codex project MCP row">
          Connects automatically the next time you open this project in a trusted Codex session.
        </Trans>
      )}
    </span>
  );
}

export function ProjectAiToolsSection() {
  const { t } = useLingui();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const [status, setStatus] = useState<OkProjectIntegrationsStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  // The project skill is a single row, so the confirm state is just its mode —
  // no per-row id like the user-global section needs.
  const [confirmMode, setConfirmMode] = useState<'install' | 'uninstall' | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge.projectIntegrations
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

  // No `finally` — the React Compiler can't lower TryStatement finalizers; the
  // catch swallows, so the trailing setPending(null) runs on both paths.
  async function applyToggle(component: ComponentRef, enabled: boolean): Promise<void> {
    if (!bridge) return;
    setPending(component.kind === 'editor' ? editorKey(component.id) : SKILL_KEY);
    try {
      const result = await bridge.projectIntegrations.setComponent({ component, enabled });
      setStatus(result.status);
      if (!result.ok) toast.error(result.error);
    } catch (err) {
      toast.error(
        t`Couldn't apply the change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setPending(null);
  }

  const header = (
    <SettingsSectionHeader
      titleId="settings-project-ai-tools-title"
      title={<Trans>AI tools</Trans>}
      scope="project"
    >
      <Trans>
        Connect the AI tools you use to this specific project. These files live in the project
        folder, so anyone who opens it gets the same setup.
      </Trans>
    </SettingsSectionHeader>
  );

  if (!bridge || loadFailed) {
    return (
      <section aria-labelledby="settings-project-ai-tools-title" className="space-y-4">
        {header}
        <p className="text-sm text-muted-foreground" data-testid="project-ai-tools-unavailable">
          <Trans>
            Project AI tool management is only available in the OpenKnowledge desktop app.
          </Trans>
        </p>
      </section>
    );
  }

  if (status === null) {
    return (
      <section aria-labelledby="settings-project-ai-tools-title" className="space-y-4">
        {header}
        <div className="space-y-2" data-testid="project-ai-tools-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </section>
    );
  }

  if (!status.hasProject) {
    return (
      <section aria-labelledby="settings-project-ai-tools-title" className="space-y-4">
        {header}
        <p className="text-sm text-muted-foreground" data-testid="project-ai-tools-no-project">
          <Trans>Open a project to manage its AI tool connections.</Trans>
        </p>
      </section>
    );
  }

  const busy = pending !== null || !status.available;

  return (
    <section aria-labelledby="settings-project-ai-tools-title" className="space-y-4">
      {header}

      {!status.available && (
        <p
          className="text-sm text-amber-600 dark:text-amber-400"
          data-testid="project-ai-tools-read-only"
        >
          <Trans>Managing project AI tools is unavailable in this build.</Trans>
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          <Trans comment="Group label above the per-editor project MCP list in Settings → This project → AI tools">
            MCP connections
          </Trans>
        </span>
        <ul className="rounded-md border border-border bg-card/50 divide-y divide-border overflow-hidden">
          {status.editors.map((editor) => (
            <EditorRowItem
              key={editor.id}
              editor={editor}
              busy={busy}
              onToggle={(enabled) => void applyToggle({ kind: 'editor', id: editor.id }, enabled)}
            />
          ))}
        </ul>
      </div>

      {status.skill !== null && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            <Trans comment="Group label above the project runtime-skill row in Settings → This project → AI tools">
              Project skill
            </Trans>
          </span>
          <p
            className="text-xs text-muted-foreground"
            data-testid="project-ai-tools-skill-scope-note"
          >
            <Trans comment="Tells the user the project skill is committed to the repo, unlike the user-global skills">
              This skill lives in the project folder, so it installs for everyone who opens this
              project — not just you.
            </Trans>
          </p>
          <ul className="rounded-md border border-border bg-card/50 overflow-hidden">
            <li className="hover:bg-accent">
              <SkillConsentRow
                name="open-knowledge"
                description={
                  status.skill.description ||
                  t`Teaches coding agents in this project to read and write through OpenKnowledge.`
                }
                // Defensive: a main process older than this renderer sends no
                // hosts. An empty set renders the row's own no-destination copy
                // rather than crashing the whole section.
                hosts={status.skill.hosts ?? []}
                size={status.skill.size}
                onActivate={
                  status.skill.sourceDir
                    ? () => {
                        const source = status.skill?.sourceDir;
                        if (!source) return;
                        openSkillPreviewTab({
                          flavor: 'builtin',
                          source,
                          name: 'open-knowledge',
                          subtitle: '',
                          level: 'project',
                        });
                      }
                    : undefined
                }
                control={
                  status.skill.installed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmMode('uninstall')}
                      data-testid="project-ai-tools-skill-uninstall"
                    >
                      <Trans>Uninstall</Trans>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy || (status.skill.hosts ?? []).length === 0}
                      onClick={() => setConfirmMode('install')}
                      data-testid="project-ai-tools-skill-install"
                    >
                      <Trans>Install</Trans>
                    </Button>
                  )
                }
              />
            </li>
          </ul>
        </div>
      )}

      {status.skill !== null && confirmMode && (
        <SkillInstallConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmMode(null);
          }}
          mode={confirmMode}
          name="open-knowledge"
          description={
            status.skill.description ||
            t`Teaches coding agents in this project to read and write through OpenKnowledge.`
          }
          paths={status.skill.paths}
          size={status.skill.size}
          onConfirm={() => {
            const next = confirmMode === 'install';
            setConfirmMode(null);
            void applyToggle({ kind: 'skill' }, next);
          }}
        />
      )}
    </section>
  );
}

function EditorRowItem({
  editor,
  busy,
  onToggle,
}: {
  editor: EditorRow;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useLingui();
  const checked = editor.state === 'installed' || editor.state === 'foreign';
  const disabled = busy || editor.state === 'unmanageable';
  const statusLabel =
    editor.state === 'installed'
      ? t`Installed`
      : editor.state === 'foreign'
        ? t`Custom open-knowledge entry — not managed by OpenKnowledge`
        : editor.state === 'unmanageable'
          ? t`Can't safely edit this project config`
          : null;
  const statusClass =
    editor.state === 'foreign' || editor.state === 'unmanageable'
      ? 'text-xs text-amber-600 dark:text-amber-400'
      : 'text-xs text-muted-foreground';
  return (
    <li className={disabled ? 'flex items-start' : 'flex items-start hover:bg-accent'}>
      <Label
        htmlFor={`project-ai-tools-editor-${editor.id}`}
        className={
          disabled
            ? 'flex flex-1 items-start gap-2.5 px-3 py-2.5 font-normal'
            : 'flex flex-1 cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal'
        }
      >
        <Checkbox
          id={`project-ai-tools-editor-${editor.id}`}
          checked={checked}
          disabled={disabled}
          onCheckedChange={() => onToggle(!checked)}
          className="mt-0.5"
          data-testid={`project-ai-tools-editor-checkbox-${editor.id}`}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{editor.label}</span>
          {statusLabel !== null && (
            <span
              className={statusClass}
              data-testid={`project-ai-tools-editor-status-${editor.id}`}
            >
              {statusLabel}
            </span>
          )}
          {checked && (
            <FollowUpHint
              followUp={editor.followUp}
              testId={`project-ai-tools-editor-followup-${editor.id}`}
            />
          )}
        </span>
      </Label>
      <RowInfoTooltip testId={`project-ai-tools-editor-info-${editor.id}`}>
        <p className="opacity-70">
          <Trans>File</Trans>
        </p>
        <p>
          <code className="break-all">{editor.configPath}</code>
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
}
