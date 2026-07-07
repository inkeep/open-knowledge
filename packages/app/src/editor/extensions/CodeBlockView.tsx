/**
 * React NodeView for the visual-mode code block.
 *
 * Visual design — zero permanent chrome: the code body renders solo, with a
 * hover/selection-revealed overlay bar in the top-right carrying the
 * language picker, a copy-to-clipboard button, and a delete affordance.
 * Mirrors the JsxComponentView chrome pattern (precedent #30) so codeblocks
 * compose visually with other rich blocks.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { Check, ChevronDown, Copy, Eye, EyeOff, Pencil, Settings2, Trash2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { OPT_OUT_ATTR } from '../clipboard/index.ts';
import { CodePreviewEditModal } from '../components/CodePreviewEditModal';
import { PreviewBlockedNotice } from '../components/PreviewBlockedNotice';
import { ResizeHandles } from '../components/ResizeHandles.tsx';
import { CODE_BLOCK_LANGUAGES, normalizeCodeLanguage } from './code-block-languages';
import {
  addMetaToken,
  getMetaTitle,
  metaHasToken,
  PREVIEWABLE_LANGUAGES,
  parsePreviewHeight,
  parsePreviewWidth,
  removeMetaToken,
  setMetaKeyValue,
  setMetaTitle,
  shouldShowPreview,
} from './code-block-meta';
import {
  buildPreviewIframeHeader,
  buildPreviewThemeMessage,
  type PreviewBlockedRequest,
  type PreviewTheme,
  parsePreviewCspViolationMessage,
  parsePreviewHeightMessage,
} from './preview-iframe-header';

const PLAIN_TEXT = 'plaintext';

/**
 * Read the reader's resolved app theme from the `<html>.dark` class that
 * `next-themes` maintains. The class is set pre-paint, so this is accurate
 * synchronously — including on the first render before `useTheme()` resolves.
 */
function readAppTheme(): PreviewTheme {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';
}

function useCursorInside(editor: NodeViewProps['editor'], getPos: NodeViewProps['getPos']) {
  const [inside, setInside] = useState(false);
  useEffect(() => {
    const compute = () => {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof pos !== 'number') return;
      const node = editor.state.doc.nodeAt(pos);
      if (!node) return;
      const { from, to } = editor.state.selection;
      const start = pos;
      const end = pos + node.nodeSize;
      // Selection overlaps this node when from < end AND to > start.
      const next = from < end && to > start;
      // Equality guard: avoid scheduling a state update when the cursor-inside
      // bit didn't actually flip — keeps re-render cost flat across remote
      // peer keystrokes inside this block.
      setInside((prev) => (prev === next ? prev : next));
    };
    compute();
    // `selectionUpdate` alone is sufficient — it fires for every selection
    // change including doc mutations that shift the cursor. The previously
    // wired `transaction` listener overlapped (every selection-changing tx
    // fires both) AND woke every mounted code-block on remote-peer ticks
    // under `extension-collaboration`.
    editor.on('selectionUpdate', compute);
    return () => {
      if (!editor.isDestroyed) editor.off('selectionUpdate', compute);
    };
  }, [editor, getPos]);
  return inside;
}

export function CodeBlockView({ node, updateAttributes, editor, getPos, selected }: NodeViewProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // When preview is active, hide the code by default — preview is the primary
  // surface. Local state (not persisted): a fresh view of the same doc starts
  // collapsed, matching the CodeSandbox / StackBlitz convention where the
  // running output is the canonical first view.
  // Code visibility used to be a toggle (`showCode`) gated by the
  // chrome-bar `</>` button. That was replaced with the modal-edit
  // affordance — preview-mode authors now click the pencil to read /
  // edit the source in a split view instead of expanding it inline
  // below. No state, no toggle button.
  const copyResetRef = useRef<number | null>(null);
  const previewWrapperRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  // Height the preview iframe last reported for its rendered content — drives
  // auto-height when the fence carries no explicit `h=`. `null` until the
  // first report; the wrapper shows the CSS default height until then.
  const [autoHeight, setAutoHeight] = useState<number | null>(null);
  // Requests the preview iframe's CSP (or the host's security layer) blocked,
  // reported back over the same postMessage channel as auto-height. `null`
  // until the iframe reports a violation; reset on every (re)load since a
  // code/policy edit re-evaluates the policy from scratch.
  const [blockedRequests, setBlockedRequests] = useState<{
    blocked: PreviewBlockedRequest[];
    truncated: boolean;
  } | null>(null);
  // The reader's resolved app theme. `next-themes`' `resolvedTheme` is the
  // re-render trigger; the `<html>.dark` class is the synchronous source of
  // truth (set pre-paint), so `appTheme` is correct even on the first render
  // before `resolvedTheme` resolves.
  const { resolvedTheme } = useTheme();
  const appTheme: PreviewTheme =
    resolvedTheme === 'dark' || resolvedTheme === 'light' ? resolvedTheme : readAppTheme();
  // Theme baked into the preview `srcDoc` for a flash-free first paint.
  // Frozen at mount: a theme toggle must NOT rebuild `srcDoc` (rebuilding
  // reloads the iframe — state loss, chart re-animation), so toggles re-skin
  // the live iframe via `postMessage`. A reload from a code/policy edit
  // re-bakes this mount-time value; the iframe `onLoad` handler re-syncs
  // `appTheme` so a post-toggle reload cannot strand a stale theme class.
  const [bakedTheme] = useState<PreviewTheme>(readAppTheme);
  const rawLanguage = (node.attrs.language as string | null) ?? null;
  const rawMeta = (node.attrs.meta as string | null) ?? null;
  const title = getMetaTitle(rawMeta);
  // Settings popover state — opens via the chrome's gear button, hosts
  // the title input and is the natural home for future
  // node-level knobs that don't fit the language-picker / icon-button
  // chrome surface. Mirrors `PropPanel`'s "Advanced" section in spirit
  // — single trigger, popover-shaped, holds the rarely-used knobs that
  // would otherwise crowd the always-visible chrome.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Modal-edit affordance for preview-rendering code blocks.
  // Lives next to the chrome buttons rather than the settings popover
  // because "edit source" is a primary action when the preview is the
  // dominant on-screen surface (HTML preview hides the code by default).
  const [editOpen, setEditOpen] = useState(false);
  // React's `useId` gives each NodeView instance its own DOM ids so a doc
  // with multiple code blocks doesn't collide on `htmlFor` ↔ `id`
  // association (clicking one block's title label would otherwise focus a
  // sibling block's input) and stays WCAG 4.1.1-compliant when popovers
  // briefly overlap during outside-click teardown. Two ids per block:
  //   - `titleInputId` → input ↔ label
  //   - `titleHelpId`  → input ↔ help paragraph via `aria-describedby`,
  //     so AT users hear the round-trip caveat alongside the field name.
  // `useId` is React 18+'s SSR-safe form.
  const baseId = useId();
  const titleInputId = `${baseId}-title-input`;
  const titleHelpId = `${baseId}-title-help`;
  // Mirror `rawMeta` into a ref so the resize commit can read the latest
  // value without re-listing rawMeta in stable callbacks. React Compiler
  // rejects ref mutation during render, so sync via an effect.
  const rawMetaRef = useRef(rawMeta);
  useEffect(() => {
    rawMetaRef.current = rawMeta;
  }, [rawMeta]);
  const normalized = normalizeCodeLanguage(rawLanguage);
  const currentLabel = !rawLanguage
    ? t`Plain`
    : (CODE_BLOCK_LANGUAGES.find((l) => l.value === normalized)?.label ?? rawLanguage);
  const previewToggled = metaHasToken(rawMeta, 'preview');
  const previewRenderable = normalized ? PREVIEWABLE_LANGUAGES.has(normalized) : false;
  const previewActive = shouldShowPreview(normalized, rawMeta);
  const previewHeight = previewActive ? parsePreviewHeight(rawMeta) : null;
  const previewWidth = previewActive ? parsePreviewWidth(rawMeta) : null;
  // Explicit `h=` always wins; otherwise fit to the height the iframe reports
  // (auto-height). `undefined` before the first report → the CSS default.
  const effectivePreviewHeight =
    previewHeight ?? (autoHeight !== null ? `${autoHeight}px` : undefined);
  // When preview is off, the code is the only thing to render. When
  // preview is on, the code is hidden entirely — the
  // chrome `</>` show-code toggle was replaced with the modal edit affordance, so
  // source editing now happens through the pencil → modal path.
  const codeVisible = !previewActive;

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    },
    [],
  );

  const editable = editor.isEditable;
  const cursorInside = useCursorInside(editor, getPos);

  // Re-skin the live preview when the reader toggles the app theme —
  // `postMessage` only, no `srcDoc` rebuild, so the iframe never reloads.
  // The iframe `onLoad` handler covers the reverse: re-pushing the current
  // theme after a reload.
  useEffect(() => {
    previewFrameRef.current?.contentWindow?.postMessage(buildPreviewThemeMessage(appTheme), '*');
  }, [appTheme]);

  // Auto-height: the preview iframe reports its rendered content height; fit
  // the wrapper to it. An explicit `h=` always wins downstream in
  // `effectivePreviewHeight`, so this only governs the no-`h=` case. Filtered
  // to this block's own iframe so a sibling preview's report can't resize it.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== previewFrameRef.current?.contentWindow) return;
      const reported = parsePreviewHeightMessage(e.data);
      if (reported !== null) {
        // Dead-band: ignore sub-3px churn so reflow ticks don't thrash height.
        setAutoHeight((prev) =>
          prev !== null && Math.abs(prev - reported) <= 2 ? prev : reported,
        );
        return;
      }
      // The iframe posts a cumulative, deduped snapshot each debounce window —
      // replace state with the latest (most complete) report.
      const violation = parsePreviewCspViolationMessage(e.data);
      if (violation !== null) setBlockedRequests(violation);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const handleCopy = () => {
    const text = node.textContent;
    // `writeText` returns a Promise; gate the success-state flip on actual
    // resolution so a permissions denial or insecure-context rejection
    // (NotAllowedError, returned async) doesn't paint a misleading
    // checkmark over a no-op write.
    const flipSuccess = () => {
      setCopied(true);
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1200);
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(flipSuccess, () => {
          /* permission denial / insecure context — leave the icon as-is */
        });
      }
    } catch {
      /* sync throw (navigator absent in test env) — fail silent */
    }
  };

  const handleDelete = () => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof pos !== 'number') return;
    try {
      editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
    } catch (err) {
      // Concurrent remote-peer edits or Observer B re-parse can shift `pos`
      // between getPos() and the chain run, producing a RangeError. Mirrors
      // the JsxComponentView.deleteNode pattern — classify + log instead of
      // letting the error boundary catch what's actually a benign race.
      if (!(err instanceof RangeError)) throw err;
      console.warn('[CodeBlockView] delete failed — position race', err);
    }
  };

  const handleTogglePreview = () => {
    const next = previewToggled
      ? removeMetaToken(rawMeta, 'preview')
      : addMetaToken(rawMeta, 'preview');
    updateAttributes({ meta: next });
  };

  // Live-commit pattern matching `PropPanel`'s text inputs: every keystroke
  // writes through to `meta`, no local draft. An empty string removes the
  // `title=…` token entirely (returns the fence to the no-title state) so
  // backspacing to empty doesn't leave a stale `title=""` in the markdown.
  const handleTitleChange = (raw: string) => {
    const newMeta = setMetaTitle(rawMeta, raw.length > 0 ? raw : null);
    if (newMeta === rawMeta) return;
    updateAttributes({ meta: newMeta });
  };

  /**
   * Commit the modal's draft back into the code block's text content.
   * Replaces the block in-place via a single PM transaction:
   *   - locate the node at `getPos()` (the live position — `setNodeMarkup`
   *     wants the post-mutation index, not the cached one)
   *   - construct a fresh `codeBlock` node of the same type with the
   *     existing attrs preserved and the new text as the single child
   *   - replace the slice in one transaction so undo lands the
   *     pre-modal text in a single step
   * Mirrors `handleDelete`'s position-race classification — concurrent
   * remote edits or Observer B re-parse can shift `pos`, so the
   * RangeError catch keeps us off the error boundary for benign races.
   */
  const handleEditSave = (value: string) => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof pos !== 'number') return;
    try {
      const { schema, tr } = editor.state;
      const newNode = node.type.create(node.attrs, value.length > 0 ? schema.text(value) : null);
      tr.replaceWith(pos, pos + node.nodeSize, newNode);
      editor.view.dispatch(tr);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.warn('[CodeBlockView] edit-save failed — position race', err);
    }
  };

  // Commit the final drag size into fence `h=` + `w=` meta so the size is
  // markdown-byte-stable across sessions. Called once per drag (pointerup).
  const handleResizeEnd = (size: { width: number; height: number }) => {
    const w = `${Math.round(size.width)}px`;
    const h = `${Math.round(size.height)}px`;
    const withHeight = setMetaKeyValue(rawMetaRef.current, 'h', h);
    const next = setMetaKeyValue(withHeight, 'w', w);
    updateAttributes({ meta: next });
  };

  return (
    <NodeViewWrapper
      className="ok-codeblock relative my-3"
      data-language={rawLanguage ?? undefined}
      data-cursor-inside={cursorInside ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-preview={previewActive ? 'true' : undefined}
      data-code-visible={codeVisible ? 'true' : 'false'}
    >
      {previewActive ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation required so resize-handle drags don't bubble into PM
        <div
          ref={previewWrapperRef}
          className={cn(
            'ok-codeblock-preview',
            codeVisible ? 'ok-codeblock-preview--with-code' : 'ok-codeblock-preview--solo',
          )}
          contentEditable={false}
          style={{
            ...(effectivePreviewHeight ? { height: effectivePreviewHeight } : {}),
            ...(previewWidth ? { width: previewWidth } : {}),
          }}
          // PM treats mousedown inside contentEditable as a selection drag.
          // The resize handles themselves stopPropagation in ResizeHandles,
          // but the wrapper also needs it so click-into-iframe selection
          // attempts don't trip PM's drag.
          onMouseDown={(e) => e.stopPropagation()}
        >
          <iframe
            title={t`HTML preview`}
            ref={previewFrameRef}
            // `allow-scripts` runs the embedded JS; omitting `allow-same-origin`
            // forces a null origin so the iframe cannot reach the parent doc,
            // its cookies, or the auth-bearing fetch surface.
            sandbox="allow-scripts"
            // `about:srcdoc` inherits the embedder's URL as the Referer for
            // any `<img>` / `fetch` request the renderer makes — leaking the
            // doc path. The CSP above blocks the requests outright, but
            // `no-referrer` is cheap defense-in-depth.
            referrerPolicy="no-referrer"
            // `bakedTheme` is frozen at mount, so a theme toggle never lands
            // here (it re-skins via the postMessage effect above) — only a
            // code or policy edit rebuilds srcDoc and reloads the iframe.
            srcDoc={buildPreviewIframeHeader(bakedTheme) + node.textContent}
            className="ok-codeblock-preview-frame"
            // Re-push the resolved theme after every (re)load so a reload from
            // a code/policy edit cannot leave the iframe on a stale baked theme.
            // Also clear any prior blocked-request notice — the reloaded iframe
            // re-evaluates the policy and will re-report from scratch.
            onLoad={() => {
              setBlockedRequests(null);
              previewFrameRef.current?.contentWindow?.postMessage(
                buildPreviewThemeMessage(appTheme),
                '*',
              );
            }}
          />
          <ResizeHandles
            targetRef={previewWrapperRef}
            bounds={{
              minWidth: 192,
              maxWidth: Math.round(window.innerWidth * 0.9),
              minHeight: 128,
              maxHeight: Math.round(window.innerHeight * 0.9),
            }}
            // Live: paint the new size on the wrapper for smooth feedback.
            onResize={(size) => {
              const el = previewWrapperRef.current;
              if (!el) return;
              el.style.width = `${size.width}px`;
              el.style.height = `${size.height}px`;
            }}
            // Commit: persist both axes into `w=` + `h=` fence meta.
            onResizeEnd={handleResizeEnd}
          />
        </div>
      ) : null}

      {previewActive && blockedRequests ? (
        <PreviewBlockedNotice
          blocked={blockedRequests.blocked}
          truncated={blockedRequests.truncated}
          onDismiss={() => setBlockedRequests(null)}
        />
      ) : null}

      {/* Title strip — rendered above the source whenever the fence carries
          `title="…"` in its info-string. Display-only here; the
          editable surface is the title input inside the settings popover.
          `contentEditable={false}` so PM's contentDOM
          contract isn't disturbed. The title is content (not chrome) so
          it stays AT-visible — screen readers announce it once with the
          surrounding code block. */}
      {title ? (
        <div
          className="ok-codeblock-title"
          contentEditable={false}
          data-testid="ok-codeblock-title"
          // Browser-native tooltip surfaces the full title on hover when the
          // strip truncates with text-overflow: ellipsis (long filenames /
          // narrow viewports). Cheap, AT-friendly, no JS state needed.
          title={title}
        >
          <span className="ok-codeblock-title-text">{title}</span>
        </div>
      ) : null}

      {/* `<pre>` is ALWAYS mounted so PM's contentDOM has a stable host — we
          hide via CSS only (`data-code-visible="false"`) rather than
          conditional render. Keeps caret stability, undo history, and any
          decorations from churning when the user collapses the code. */}
      <pre
        className={cn(
          'ok-codeblock-pre m-0 overflow-x-auto px-5 py-4 font-mono text-sm leading-relaxed',
          previewActive && codeVisible ? 'rounded-b-lg' : null,
          !previewActive ? 'rounded-lg' : null,
        )}
        // Hide from AT when collapsed — visually-zero content still in the
        // accessibility tree gets announced by screen readers (WCAG 1.3.1).
        // `aria-hidden` doesn't affect DOM existence, so PM's contentDOM
        // contract holds.
        aria-hidden={!codeVisible || undefined}
      >
        <NodeViewContent<'code'>
          as="code"
          className={cn(
            'hljs block whitespace-pre bg-transparent p-0',
            rawLanguage ? `language-${rawLanguage}` : undefined,
          )}
        />
      </pre>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation required inside PM NodeView */}
      <div
        className="ok-codeblock-chrome"
        contentEditable={false}
        onMouseDown={(e) => e.stopPropagation()}
        {...{ [OPT_OUT_ATTR]: 'true' }}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!editable}
              className="ok-codeblock-chrome-btn ok-codeblock-chrome-lang"
              aria-label={t`Code block language: ${currentLabel}. Click to change.`}
            >
              <span>{currentLabel}</span>
              {editable ? <ChevronDown className="size-3 opacity-60" aria-hidden="true" /> : null}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={6} className="w-56 p-0">
            <Command
              filter={(value, search) => {
                if (!search) return 1;
                return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
              }}
            >
              <CommandInput placeholder={t`Filter languages`} />
              <CommandList>
                <CommandEmpty>{t`No language match.`}</CommandEmpty>
                <CommandGroup>
                  {CODE_BLOCK_LANGUAGES.map((lang) => {
                    // The Plain entry is active when the fence has no language
                    // (`null`) OR the user explicitly typed `plaintext` /
                    // an alias that normalizes to it — without the second
                    // branch, ` ```plaintext ` fences show no checkmark.
                    const isActive =
                      lang.value === PLAIN_TEXT
                        ? !rawLanguage || normalized === PLAIN_TEXT
                        : normalized === lang.value;
                    return (
                      <CommandItem
                        key={lang.value}
                        value={`${lang.label} ${lang.value} ${lang.aliases?.join(' ') ?? ''}`}
                        onSelect={() => {
                          const next = lang.value === PLAIN_TEXT ? null : lang.value;
                          updateAttributes({ language: next });
                          setOpen(false);
                          editor.commands.focus();
                        }}
                      >
                        <span className="flex-1">{lang.label}</span>
                        {isActive ? <Check className="size-3.5" aria-hidden="true" /> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {editable && previewActive ? (
          <button
            type="button"
            className="ok-codeblock-chrome-btn"
            aria-label={t`Edit source`}
            data-testid="ok-codeblock-edit-btn"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}

        {editable && previewRenderable ? (
          <button
            type="button"
            className="ok-codeblock-chrome-btn"
            data-active={previewToggled ? 'true' : undefined}
            aria-pressed={previewToggled}
            aria-label={previewToggled ? t`Hide HTML preview` : t`Show HTML preview`}
            onClick={handleTogglePreview}
          >
            {previewToggled ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        ) : null}

        {editable ? (
          <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ok-codeblock-chrome-btn"
                data-active={title ? 'true' : undefined}
                aria-label={t`Code block settings`}
              >
                <Settings2 className="size-3.5" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={6} className="w-64 p-3">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={titleInputId}
                  className="text-2xs font-mono uppercase tracking-wide text-muted-foreground"
                >
                  <Trans>Title</Trans>
                </label>
                <Input
                  id={titleInputId}
                  type="text"
                  value={title ?? ''}
                  placeholder={t`e.g. server.ts`}
                  data-testid="ok-codeblock-title-input"
                  // Link the help paragraph below so screen readers announce
                  // the round-trip caveat after the field label.
                  aria-describedby={titleHelpId}
                  onChange={(e) => handleTitleChange(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter / Escape close the popover; the live-commit
                    // already happened on the prior `onChange` keystroke
                    // so there's no draft to flush or revert.
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      e.preventDefault();
                      setSettingsOpen(false);
                    }
                  }}
                  className="h-8"
                />
                <p id={titleHelpId} className="text-2xs text-muted-foreground">
                  <Trans>
                    Shows above the code body. Round-trips as `title="..."` in markdown.
                  </Trans>
                </p>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}

        <button
          type="button"
          className="ok-codeblock-chrome-btn"
          aria-label={copied ? t`Copied` : t`Copy code`}
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </button>

        {editable ? (
          <button
            type="button"
            className="ok-codeblock-chrome-btn ok-codeblock-chrome-btn--delete"
            aria-label={t`Delete code block`}
            onClick={handleDelete}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {editable && previewActive ? (
        <CodePreviewEditModal
          open={editOpen}
          onOpenChange={setEditOpen}
          initialValue={node.textContent}
          // `normalized` is `'xml'` here — `normalizeCodeLanguage` collapses
          // `html` / `htm` / `xml` / `svg` onto the canonical `xml` lowlight
          // key. `previewActive` already gates on this set, so seeing the
          // modal at all implies an HTML-shape block; `lang-html` covers
          // XML-shaped markup including SVG.
          language={normalized === 'xml' ? 'html' : 'plain'}
          title={t`Edit source`}
          renderPreview={(value) => (
            <iframe
              title={t`HTML preview`}
              sandbox="allow-scripts"
              className="size-full border-0"
              srcDoc={buildPreviewIframeHeader(bakedTheme) + value}
            />
          )}
          onSave={handleEditSave}
        />
      ) : null}
    </NodeViewWrapper>
  );
}
