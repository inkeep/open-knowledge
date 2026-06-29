
import { PREVIEW_EMBED_STARTERS, type PreviewEmbedStarter } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { BarChart3, Code, LayoutGrid, Shapes, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SlashCommandItem } from './items';

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

const BLANK_HTML_BODY = `<div style="padding:20px;font-family:system-ui,sans-serif;color:var(--foreground)">
  <h1 style="margin:0 0 8px;font-size:20px;font-weight:600">Hello, world!</h1>
  <p style="margin:0;color:var(--muted-foreground)">Edit this HTML — the preview updates live.</p>
</div>`;

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
      <div className="flex h-20 items-end gap-1.5">
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
