/**
 * FileBubbleButtons — bubble-menu controls for the selected `File` /
 * `WikiEmbedFile` jsxComponent. Currently a single button: explicit
 * Download.
 *
 * Why a separate download surface from the click action? The row's
 * click action is "open in new tab for preview" (browsers render PDF /
 * image / text inline; opaque types fall through to the browser's
 * download prompt). Authors who specifically want to save the file —
 * regardless of whether the browser would preview-render it — get a
 * dedicated button here. The action programmatically clicks a
 * temporary `<a download>` element so the browser bypasses the new-tab
 * preview and goes straight to the save flow.
 *
 * Sister to `ImageAlignButtons` — same lucide-react icon, same shadcn
 * `Button` size + variant, same `Tooltip` `side`/`sideOffset` for
 * positioning. Only ever rendered by `BubbleMenuBar` when a File-
 * rendering jsxComponent is NodeSelected (the parent's `useEditorState`
 * guard keys off `isFileNodeSelected`).
 */

import { Trans, useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { basenameFromUrl } from '@/editor/components/File';

/**
 * Read the active file-jsxComponent's `props.src` if the selection is on
 * a `File` canonical or `WikiEmbedFile` compat. Returns `null` when the
 * selection isn't a file node — the parent skips render in that case.
 */
function readActiveFileSrc(editor: Editor): string | null {
  const sel = editor.state.selection;
  const node = (sel as { node?: { type: { name: string }; attrs: Record<string, unknown> } }).node;
  if (!node) return null;
  if (node.type.name !== 'jsxComponent') return null;
  const componentName = node.attrs.componentName;
  if (componentName !== 'File' && componentName !== 'WikiEmbedFile') return null;
  const props = (node.attrs.props ?? {}) as Record<string, unknown>;
  const src = props.src;
  if (typeof src !== 'string' || src.length === 0) return null;
  return src;
}

/**
 * Read the active file-jsxComponent's display name — alias (compat) /
 * name (canonical) / basename of src. Used as the suggested
 * `download` filename so saved-file dialogs prefill with something
 * recognizable rather than the URL pathname.
 *
 * The basename derivation reuses `File.tsx`'s `basenameFromUrl`
 * (exported and unit-tested there) — handles `data:` / `blob:` /
 * percent-encoded segments / trailing-slash uniformly with the row's
 * own display-name fallback chain.
 */
function readActiveFileName(editor: Editor): string {
  const sel = editor.state.selection;
  const node = (sel as { node?: { type: { name: string }; attrs: Record<string, unknown> } }).node;
  if (!node) return '';
  const props = (node.attrs.props ?? {}) as Record<string, unknown>;
  const alias = typeof props.alias === 'string' ? props.alias : '';
  if (alias.length > 0) return alias;
  const name = typeof props.name === 'string' ? props.name : '';
  if (name.length > 0) return name;
  const src = typeof props.src === 'string' ? props.src : '';
  return basenameFromUrl(src);
}

/**
 * Trigger a programmatic download by spawning a temporary `<a download>`
 * element and clicking it. The `download` attribute hints the browser to
 * save rather than navigate; works same-origin, and falls through to a
 * new-tab open for cross-origin URLs whose server doesn't set
 * `Content-Disposition: attachment` (the most we can do from authored
 * MDX without a fetch+blob proxy).
 */
function triggerDownload(src: string, suggestedName: string): void {
  const link = document.createElement('a');
  link.href = src;
  link.download = suggestedName;
  link.rel = 'noopener noreferrer';
  // Detached from the DOM is fine in modern browsers; appending +
  // removing avoids a Firefox quirk where detached anchor clicks were
  // historically ignored.
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

interface FileBubbleButtonsProps {
  editor: Editor;
}

export function FileBubbleButtons({ editor }: FileBubbleButtonsProps) {
  const { t } = useLingui();
  const src = useEditorState({
    editor,
    selector: (ctx) => readActiveFileSrc(ctx.editor),
  });

  if (src === null) return null;

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t`Download file`}
            className="text-accent-foreground"
            onMouseDown={(e) => {
              // Preserve the editor's selection — `Button`'s default
              // mousedown would steal focus from the editor view and
              // collapse the NodeSelection that's keeping this bubble
              // mode active. Mirrors `InlineFormatButtons` /
              // `ImageAlignButtons`.
              e.preventDefault();
              const liveSrc = readActiveFileSrc(editor);
              if (!liveSrc) return;
              const suggestedName = readActiveFileName(editor);
              triggerDownload(liveSrc, suggestedName);
            }}
          >
            <Download className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          <Trans>Download file</Trans>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Pure helper for `BubbleMenuBar`'s `shouldShow` extension — returns true
 * when selection is on a file-rendering jsxComponent (`File` canonical
 * OR `WikiEmbedFile` compat). Exported so the parent can gate the
 * bubble menu on File NodeSelections (which carry empty `textBetween`
 * and would otherwise be rejected by the default text-bearing-selection
 * guard).
 */
export function isFileNodeSelected(editor: Editor): boolean {
  return readActiveFileSrc(editor) !== null;
}
