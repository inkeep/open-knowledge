/**
 * The project's AI-tool decision — one checkbox covering every detected tool,
 * with a "What changes?" popover naming the exact project-relative files it
 * writes. Shared by the create-project dialog and the open-folder consent
 * dialog, the two surfaces that set a project up from scratch.
 *
 * Both place it at the top level: whether the project is reachable from the
 * user's agents at all is not an advanced concern. Per-tool control lives in
 * Settings > This project, which lists every tool with a project surface
 * whether or not this machine's probe found it.
 *
 * The paths come from the same two core maps the project writer resolves its
 * targets from (`EDITOR_PROJECT_CONFIG_PATH`, `EDITOR_PROJECT_SKILL_ROOT`), so
 * the disclosure cannot advertise a file that never gets written. Tools with a
 * null entry in both are filtered out upstream (via
 * `receivesProjectIntegrationWrite`) and never reach this component.
 *
 * `testIdPrefix` keeps each dialog's row ids distinct; `itemTestIdPrefix` is a
 * second prop rather than a derivation because the create surface's per-tool
 * ids are the singular `create-editor-<id>`, pinned by existing end-to-end
 * selectors.
 */

import {
  EDITOR_LABELS,
  EDITOR_PROJECT_CONFIG_PATH,
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  RESERVED_PROJECT_SKILL_NAME,
} from '@inkeep/open-knowledge-core';
import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useId } from 'react';
import { RowDisclosure } from '@/components/RowDisclosure';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { formatToolList } from '@/lib/tool-list-format';
import { cn } from '@/lib/utils';

interface ProjectAiToolsFieldProps {
  /** `null` while the detection probe is in flight; `[]` once it settled empty. */
  detectedEditors: readonly EditorId[] | null;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled: boolean;
  testIdPrefix: string;
  itemTestIdPrefix: string;
}

export function ProjectAiToolsField({
  detectedEditors,
  checked,
  onCheckedChange,
  disabled,
  testIdPrefix,
  itemTestIdPrefix,
}: ProjectAiToolsFieldProps) {
  const { t } = useLingui();
  const checkboxId = useId();

  // The probe's two non-interactive outcomes share ONE live region that is
  // always mounted. A region that appears at the same moment as its text is not
  // a change to announce — assistive tech has to be observing the node before
  // the content lands — so swapping the message inside a persistent node is what
  // makes "checking…" → "none found" actually reach a screen reader.
  const status =
    detectedEditors === null
      ? { kind: 'probing' as const, message: t`Checking which AI tools you have` }
      : detectedEditors.length === 0
        ? {
            kind: 'none' as const,
            message: t`No AI tools detected yet. Once you install one, connect it from Settings > This project.`,
          }
        : // Carrying the narrowed list on the ready arm is what lets the early
          // return below discriminate it — the guard alone doesn't re-narrow
          // `detectedEditors` for the JSX that follows.
          { kind: 'ready' as const, message: '', editors: detectedEditors };

  const statusRegion = (
    <p
      aria-live="polite"
      className={cn(
        status.kind === 'ready'
          ? 'sr-only'
          : 'rounded-md border border-border px-3 py-2.5 text-1sm text-muted-foreground',
      )}
      data-status={status.kind}
      data-testid={`${testIdPrefix}-status`}
    >
      {status.message}
    </p>
  );

  if (status.kind !== 'ready') return statusRegion;

  // Named local so the `t` macro extracts `{toolList}` rather than a
  // positional placeholder for the inline call expression.
  const toolList = formatToolList(
    status.editors.map((id) => EDITOR_LABELS[id]),
    i18n.locale,
  );

  return (
    <>
      {/* Stays mounted (visually hidden, empty) so the region survives every
        transition rather than being torn down when the checkbox appears. */}
      {statusRegion}
      {/* Same card anatomy as the first-launch setup rows: checkbox + title on
        the first line, subtext indented under the title (checkbox size-4 = 1rem
        + gap-2.5 = 0.625rem), and the "What changes?" disclosure absolutely
        placed on the first line (needs `relative` here; the title's `pe-28`
        keeps long labels from running under it). */}
      <div className="relative overflow-hidden rounded-lg border border-border bg-card/50 px-4 py-3 hover:bg-accent">
        <Label
          htmlFor={checkboxId}
          className="flex min-w-0 cursor-pointer flex-col items-start gap-1 font-normal"
        >
          <span className="flex w-full items-center gap-2.5">
            <Checkbox
              id={checkboxId}
              checked={checked}
              onCheckedChange={() => onCheckedChange(!checked)}
              disabled={disabled}
              data-testid={`${testIdPrefix}-checkbox`}
            />
            {/* Fixed-length title: the detected-tool list goes in the subtext
              below instead, so a machine with many tools can't wrap this line
              and push the "What changes?" button out of alignment. */}
            <span
              className="flex min-w-0 flex-1 items-center gap-1.5 pe-28 text-sm font-medium text-foreground"
              data-testid={`${testIdPrefix}-title`}
            >
              <Trans comment="Checkbox that wires the OpenKnowledge MCP into every detected AI tool for the project">
                Connect your AI tools to this project
              </Trans>
            </span>
          </span>
          {/* Consent integrity: the write set is named here, in always-visible
            text — moving it off the title line must not move it behind the
            "What changes?" disclosure. */}
          <span
            className="text-1sm leading-normal ps-6.5 text-muted-foreground"
            data-testid={`${testIdPrefix}-summary`}
          >
            {/* Tool names carry the emphasis: they are the part of this
              sentence that differs per machine, and the rest is boilerplate.
              Wording tracks the first-launch dialog's MCP row — same promise,
              plus the project skill this surface also writes. */}
            <Trans comment="Subtext under the project AI-tools checkbox">
              Adds an OpenKnowledge MCP entry and the project skill to{' '}
              <span className="font-medium text-foreground">{toolList}</span>, so your agents can
              read and edit your files.
            </Trans>
          </span>
        </Label>
        <RowDisclosure title={t`Adds these files`} testId={`${testIdPrefix}-details-toggle`}>
          {/* A real list: this is an enumeration of files per tool, and screen
            readers announce item counts and offer list navigation for it. */}
          <ul className="flex flex-col gap-2" data-testid={`${testIdPrefix}-details`}>
            {status.editors.map((id) => {
              const configPath = EDITOR_PROJECT_CONFIG_PATH[id];
              const skillRoot = EDITOR_PROJECT_SKILL_ROOT[id];
              return (
                <li
                  key={id}
                  className="flex min-w-0 flex-col"
                  data-testid={`${itemTestIdPrefix}-${id}`}
                >
                  <span className="font-medium">{EDITOR_LABELS[id]}</span>
                  {configPath !== null && (
                    <span className="wrap-break-word opacity-75">
                      <code className="break-all">{configPath}</code>
                    </span>
                  )}
                  {skillRoot !== null && (
                    <span className="wrap-break-word opacity-75">
                      <code className="break-all">{`${skillRoot}/${RESERVED_PROJECT_SKILL_NAME}/`}</code>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </RowDisclosure>
      </div>
    </>
  );
}
