/**
 * Slash-command items for the embed group — generic blank-HTML entry +
 * the themed `html preview` starter family.
 *
 * Every item in this file inserts an `html preview` code block:
 * `language: 'html'`, `meta: 'preview'`. The block opens straight into the
 * live sandboxed iframe preview (see `CodeBlockView`'s `shouldShowPreview`
 * gate + `PREVIEWABLE_LANGUAGES`). The blank entry seeds a minimal
 * theme-token-wired Hello-world so the preview shows something on first
 * paint; the themed entries pull their body from `PREVIEW_EMBED_STARTERS`
 * — single-source-of-truth shared with the `palette` MCP
 * tool's `embedPatterns` so agents and humans see the same palette.
 *
 * Generic blank lives at the TOP of the returned list so `/embed` lands
 * on the from-scratch entry first (matches the "new blank doc →
 * templates" mental model from other tools).
 *
 * Naming convention — every item's `name` field uses the `embed-starter-*`
 * prefix (`embed-starter-html`, `embed-starter-chart`, …). The blank
 * entry's id is `html` rather than a `PREVIEW_EMBED_STARTERS` id, but it
 * shares the prefix so a grep for `embed-starter-` reaches every item in
 * the embed group. The "starter" label is loose: a starting point for an
 * `html preview` embed, not literally a `PreviewEmbedStarter`.
 */

import { PREVIEW_EMBED_STARTERS, type PreviewEmbedStarter } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { BarChart3, Code, LayoutGrid, Shapes, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SlashCommandItem } from './items';

/**
 * Insert an `html preview` code block at the current selection. Single
 * insertion path shared by every entry in this file — blank-HTML and the
 * themed starters both call through here so the (codeBlock + language=html
 * + meta=preview) shape stays in one place.
 */
function insertHtmlPreview(editor: Editor, html: string): void {
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'codeBlock',
      attrs: { language: 'html', meta: 'preview' },
      content: [{ type: 'text', text: html }],
    })
    .run();
}

/**
 * Body for the blank-HTML slash entry. Theme-token wired (no hand-picked
 * colors) so the preview tracks the reader's light/dark theme like the
 * themed starters do. The copy nudges the author toward editing — without
 * a seed the iframe renders empty and the author may think the preview
 * didn't activate.
 */
const BLANK_HTML_BODY = `<div style="padding:20px;font-family:system-ui,sans-serif;color:var(--foreground)">
  <h1 style="margin:0 0 8px;font-size:20px;font-weight:600">Hello, world!</h1>
  <p style="margin:0;color:var(--muted-foreground)">Edit this HTML — the preview updates live.</p>
</div>`;

/** Per-starter menu chrome — icon, search aliases, and the hover preview. */
interface StarterUi {
  icon: SlashCommandItem['icon'];
  aliases: string[];
  render: () => ReactNode;
}

const STARTER_UI: Record<PreviewEmbedStarter['id'], StarterUi> = {
  chart: {
    icon: BarChart3,
    aliases: ['chart', 'bar', 'graph', 'plot', 'viz', 'data', 'embed', 'preview'],
    render: () => (
      <div className="flex h-20 w-full items-end gap-1.5">
        <div className="h-[45%] flex-1 rounded-t-sm bg-chart-1" />
        <div className="h-[70%] flex-1 rounded-t-sm bg-chart-2" />
        <div className="h-[90%] flex-1 rounded-t-sm bg-chart-3" />
        <div className="h-[60%] flex-1 rounded-t-sm bg-chart-4" />
        <div className="h-[80%] flex-1 rounded-t-sm bg-chart-5" />
      </div>
    ),
  },
  'stat-cards': {
    icon: LayoutGrid,
    aliases: ['stat', 'stats', 'metric', 'metrics', 'cards', 'kpi', 'embed', 'preview'],
    render: () => (
      <div className="flex gap-2">
        <div className="flex-1 rounded-md border border-border bg-card p-2">
          <div className="text-[10px] text-muted-foreground">Users</div>
          <div className="text-sm font-bold text-card-foreground">12.4k</div>
          <div className="text-[10px] font-semibold text-chart-2">+8.2%</div>
        </div>
        <div className="flex-1 rounded-md border border-border bg-card p-2">
          <div className="text-[10px] text-muted-foreground">Revenue</div>
          <div className="text-sm font-bold text-card-foreground">$48k</div>
          <div className="text-[10px] font-semibold text-chart-1">+3.1%</div>
        </div>
      </div>
    ),
  },
  'custom-svg': {
    icon: Shapes,
    aliases: ['svg', 'vector', 'graphic', 'illustration', 'ring', 'embed', 'preview'],
    render: () => (
      <div className="flex items-center justify-center text-chart-1">
        <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
          <circle
            cx="36"
            cy="36"
            r="28"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.15"
            strokeWidth="9"
          />
          <circle
            cx="36"
            cy="36"
            r="28"
            fill="none"
            stroke="currentColor"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray="176"
            strokeDashoffset="53"
            transform="rotate(-90 36 36)"
          />
        </svg>
      </div>
    ),
  },
  'interactive-control': {
    icon: SlidersHorizontal,
    aliases: ['interactive', 'slider', 'control', 'widget', 'input', 'embed', 'preview'],
    render: () => (
      <div className="space-y-2">
        <div className="text-lg font-bold text-chart-1">$2,500</div>
        <div className="relative h-1.5 rounded-full bg-muted">
          <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary" />
          <div className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/3 size-3 rounded-full bg-primary" />
        </div>
        <div className="text-[10px] text-muted-foreground">Drag to adjust</div>
      </div>
    ),
  },
};

/**
 * Generic `html preview` slash entry — the "blank canvas" sibling of the
 * themed starters. Lands at the TOP of the embed group so authors who want
 * to write arbitrary HTML don't have to scroll past four themed templates
 * to find it. Mirrors the themed-starter shape (code block + `meta:
 * 'preview'`) so it shares CodeBlockView's iframe sandbox, resize affords,
 * settings-popover title editor, and copy chrome with zero extra wiring.
 */
function getBlankHtmlEmbedItem(): SlashCommandItem {
  return {
    name: 'embed-starter-html',
    label: t`HTML`,
    icon: Code,
    category: 'embed',
    aliases: ['html', 'embed', 'preview', 'iframe', 'sandbox', 'web', 'snippet'],
    description: t`Sandboxed HTML embed — write HTML, see the rendered preview live.`,
    command: (editor: Editor) => insertHtmlPreview(editor, BLANK_HTML_BODY),
    preview: {
      description: t`Custom HTML with a live preview pane (sandboxed iframe).`,
      // Hand-built browser-pane mockup matching the `Embed` jsx component's
      // preview shape (component-items.tsx) — gives `/embed → HTML` a
      // recognizable family with the iframe-embed entry without rendering
      // a real iframe in the slash menu pane.
      render: () => (
        <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-background">
          <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1.5">
            <span className="size-1.5 rounded-full bg-muted-foreground/40" />
            <span className="size-1.5 rounded-full bg-muted-foreground/40" />
            <span className="size-1.5 rounded-full bg-muted-foreground/40" />
            <span className="ml-1.5 flex-1 truncate rounded-sm bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              sandbox
            </span>
          </div>
          <div className="flex flex-1 flex-col justify-center gap-1.5 px-3 py-3">
            <span className="font-semibold text-foreground text-sm">
              <Trans>Hello, world!</Trans>
            </span>
            <span className="text-[10px] text-muted-foreground">
              <Trans>Edit this HTML — the preview updates live.</Trans>
            </span>
          </div>
        </div>
      ),
    },
  };
}

/**
 * Slash-menu items for the embed group: generic blank-HTML entry first,
 * followed by the themed `html preview` starters. Merged into the menu via
 * `itemsSources` alongside the built-in and component items.
 */
export function getEmbedStarterItems(): SlashCommandItem[] {
  const starters = PREVIEW_EMBED_STARTERS.map((starter): SlashCommandItem => {
    const ui = STARTER_UI[starter.id];
    return {
      name: `embed-starter-${starter.id}`,
      label: starter.title,
      icon: ui.icon,
      category: 'embed',
      command: (editor: Editor) => insertHtmlPreview(editor, starter.html),
      aliases: ui.aliases,
      description: starter.description,
      preview: {
        description: starter.description,
        render: ui.render,
      },
    };
  });
  return [getBlankHtmlEmbedItem(), ...starters];
}
