
import { Trans, useLingui } from '@lingui/react/macro';
import { useId, useState } from 'react';
import { toast as sonnerToast } from 'sonner';
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
import type { OkMcpWiringEditorId, OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import { type McpConsentStore, mcpConsentStore } from '@/lib/mcp-consent-store';

type EditorDetection = OkMcpWiringShowPayload['detectedEditors'][number];

export function computeInitialSelection(
  detectedEditors: readonly EditorDetection[],
): ReadonlySet<OkMcpWiringEditorId> {
  const out = new Set<OkMcpWiringEditorId>();
  for (const d of detectedEditors) if (d.detected) out.add(d.id);
  return out;
}

export function toggleSelectedId(
  prev: ReadonlySet<OkMcpWiringEditorId>,
  id: OkMcpWiringEditorId,
): ReadonlySet<OkMcpWiringEditorId> {
  const next = new Set(prev);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function selectedIdsOrdered(
  selection: ReadonlySet<OkMcpWiringEditorId>,
  detectedEditors: readonly EditorDetection[],
): OkMcpWiringEditorId[] {
  const out: OkMcpWiringEditorId[] = [];
  for (const d of detectedEditors) if (selection.has(d.id)) out.push(d.id);
  return out;
}

export interface McpConsentDialogBodyProps {
  store?: McpConsentStore;
  toast?: ToastImpl;
  payload?: OkMcpWiringShowPayload;
}

export interface ToastImpl {
  error(message: string): void;
}

const defaultToast: ToastImpl = {
  error: (message) => sonnerToast.error(message),
};

export function McpConsentDialogBody({
  store = mcpConsentStore,
  toast = defaultToast,
  payload,
}: McpConsentDialogBodyProps = {}) {
  const snapshot = payload ?? store.getSnapshot();
  if (!snapshot) return null;
  return <McpConsentDialogForm payload={snapshot} store={store} toast={toast} />;
}

interface McpConsentDialogFormProps {
  payload: OkMcpWiringShowPayload;
  store: McpConsentStore;
  toast: ToastImpl;
}

function McpConsentDialogForm({ payload, store, toast }: McpConsentDialogFormProps) {
  const { t } = useLingui();
  const detectedEditors = payload.detectedEditors;
  const [selection, setSelection] = useState<ReadonlySet<OkMcpWiringEditorId>>(() =>
    computeInitialSelection(detectedEditors),
  );
  const [busy, setBusy] = useState(false);
  const idPrefix = useId();

  function onToggle(id: OkMcpWiringEditorId) {
    setSelection((prev) => toggleSelectedId(prev, id));
  }

  async function onAdd() {
    setBusy(true);
    const result = await store.confirm(selectedIdsOrdered(selection, detectedEditors));
    if (!result.ok) {
      toast.error(result.error);
      setBusy(false);
    }
  }

  async function onSkip() {
    setBusy(true);
    const result = await store.skip();
    if (!result.ok) {
      toast.error(result.error);
      setBusy(false);
    }
  }

  function onOpenChange(open: boolean) {
    if (!open && !busy) void onSkip();
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/*
       * Radix Dialog auto-wires `aria-labelledby` / `aria-describedby` on
       * `DialogContent` from `DialogTitle` / `DialogDescription` via context
       * — no manual `useId` plumbing needed (Review Pass 0 Major #11 +
       * Minor #4). Each row's `<Label>` is associated to its `<Checkbox>` by
       * `htmlFor` + matching `id`, providing the accessible name; no
       * `aria-describedby` on the checkbox itself, since duplicating the
       * label content via that attr causes screen readers to either
       * announce the label twice or drop the association.
       */}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add OpenKnowledge to your AI tools</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              OpenKnowledge manages the <code>open-knowledge</code> MCP server name, the{' '}
              <code>open-knowledge-ui</code> launch config, and <code>ok</code> /{' '}
              <code>open-knowledge</code> on PATH (including OK-owned symlinks). Using a custom
              wrapper? Register it under a different name.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <ul className="rounded-md border border-border bg-card/50 divide-y divide-border overflow-hidden">
            {detectedEditors.map((editor) => {
              const checked = selection.has(editor.id);
              const checkboxId = `${idPrefix}-${editor.id}`;
              const statusLabel = editor.willReplace
                ? t`Will replace existing OpenKnowledge entry`
                : editor.detected
                  ? t`Detected on this machine`
                  : t`Not detected`;
              const statusClass = editor.willReplace
                ? 'text-xs text-amber-600 dark:text-amber-400'
                : 'text-xs text-muted-foreground';
              return (
                <li key={editor.id}>
                  <Label
                    htmlFor={checkboxId}
                    className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal hover:bg-accent"
                  >
                    <Checkbox
                      id={checkboxId}
                      checked={checked}
                      disabled={busy}
                      onCheckedChange={() => onToggle(editor.id)}
                      className="mt-0.5"
                      data-testid={`mcp-consent-checkbox-${editor.id}`}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">{editor.label}</span>
                      <span className={statusClass} data-testid={`mcp-consent-status-${editor.id}`}>
                        {statusLabel}
                      </span>
                    </span>
                  </Label>
                </li>
              );
            })}
          </ul>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="outline"
            className="font-mono uppercase"
            onClick={() => void onSkip()}
            disabled={busy}
            data-testid="mcp-consent-skip"
          >
            <Trans comment="Secondary button — dismisses the dialog without wiring any tools">
              Skip
            </Trans>
          </Button>
          <Button
            onClick={() => void onAdd()}
            disabled={busy || selection.size === 0}
            data-testid="mcp-consent-add"
          >
            {busy ? (
              <Trans>Working</Trans>
            ) : (
              <Trans comment="Primary button that writes MCP config for the selected AI tools">
                Add
              </Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default McpConsentDialogBody;
