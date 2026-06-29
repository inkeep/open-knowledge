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
      const next = from < end && to > start;
      setInside((prev) => (prev === next ? prev : next));
    };
    compute();
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
  const copyResetRef = useRef<number | null>(null);
  const previewWrapperRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [autoHeight, setAutoHeight] = useState<number | null>(null);
  const [blockedRequests, setBlockedRequests] = useState<{
    blocked: PreviewBlockedRequest[];
    truncated: boolean;
  } | null>(null);
  const { resolvedTheme } = useTheme();
  const appTheme: PreviewTheme =
    resolvedTheme === 'dark' || resolvedTheme === 'light' ? resolvedTheme : readAppTheme();
  const [bakedTheme] = useState<PreviewTheme>(readAppTheme);
  const rawLanguage = (node.attrs.language as string | null) ?? null;
  const rawMeta = (node.attrs.meta as string | null) ?? null;
  const title = getMetaTitle(rawMeta);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const baseId = useId();
  const titleInputId = `${baseId}-title-input`;
  const titleHelpId = `${baseId}-title-help`;
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
  const effectivePreviewHeight =
    previewHeight ?? (autoHeight !== null ? `${autoHeight}px` : undefined);
  const codeVisible = !previewActive;

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    },
    [],
  );

  const editable = editor.isEditable;
  const cursorInside = useCursorInside(editor, getPos);

  useEffect(() => {
    previewFrameRef.current?.contentWindow?.postMessage(buildPreviewThemeMessage(appTheme), '*');
  }, [appTheme]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== previewFrameRef.current?.contentWindow) return;
      const reported = parsePreviewHeightMessage(e.data);
      if (reported !== null) {
        setAutoHeight((prev) =>
          prev !== null && Math.abs(prev - reported) <= 2 ? prev : reported,
        );
        return;
      }
      const violation = parsePreviewCspViolationMessage(e.data);
      if (violation !== null) setBlockedRequests(violation);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const handleCopy = () => {
    const text = node.textContent;
    const flipSuccess = () => {
      setCopied(true);
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1200);
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(flipSuccess, () => {});
      }
    } catch {}
  };

  const handleDelete = () => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof pos !== 'number') return;
    try {
      editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
    } catch (err) {
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

  const handleTitleChange = (raw: string) => {
    const newMeta = setMetaTitle(rawMeta, raw.length > 0 ? raw : null);
    if (newMeta === rawMeta) return;
    updateAttributes({ meta: newMeta });
  };

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
          onMouseDown={(e) => e.stopPropagation()}
        >
          <iframe
            title={t`HTML preview`}
            ref={previewFrameRef}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={buildPreviewIframeHeader(bakedTheme) + node.textContent}
            className="ok-codeblock-preview-frame"
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
            onResize={(size) => {
              const el = previewWrapperRef.current;
              if (!el) return;
              el.style.width = `${size.width}px`;
              el.style.height = `${size.height}px`;
            }}
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
          `title="…"` in its info-string (PRD-6819). Display-only here; the
          editable surface is the title input inside the settings popover
          (see chrome below). `contentEditable={false}` so PM's contentDOM
          contract isn't disturbed. The title is content (not chrome) so
          it stays AT-visible — screen readers announce it once with the
          surrounding code block. */}
      {title ? (
        <div
          className="ok-codeblock-title"
          contentEditable={false}
          data-testid="ok-codeblock-title"
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
                  aria-describedby={titleHelpId}
                  onChange={(e) => handleTitleChange(e.target.value)}
                  onKeyDown={(e) => {
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
