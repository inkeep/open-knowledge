import { ArrowRight, Bot, Database, type LucideIcon, NotebookPen } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Overview-page blocks recreating the "Refined Classic" docs design:
 * a connected three-layer stack (Editor → Knowledge Engine → Content),
 * numbered "Where to start" path cards, and a Quickstart CTA.
 *
 * Surfaces/borders/text use Fumadocs `fd-*` theme tokens so they track the
 * docs light/dark theme; the periwinkle accent comes from `--ok-*` tokens
 * scoped to `.ok-overview` (see global.css). The connecting spine and inline
 * code chips are styled there too.
 */

interface Layer {
  k: string;
  Icon: LucideIcon;
  title: string;
  role: string;
  desc: ReactNode;
}

const LAYERS: Layer[] = [
  {
    k: 'LAYER 01',
    Icon: NotebookPen,
    title: 'Editor',
    role: 'What you touch',
    desc: (
      <>
        A beautiful "what you see is what you get" editor for your markdown files. Supports
        interactive HTML and JS, Mermaid diagrams, LaTeX, Videos, PDFs, and more.
      </>
    ),
  },
  {
    k: 'LAYER 02',
    Icon: Bot,
    title: 'Agent tools',
    role: 'Knowledge graph',
    desc: 'MCP and skills that improve agent search and discovery, and help agents ingest, organize, and maintain knowledge.',
  },
  {
    k: 'LAYER 03',
    Icon: Database,
    title: 'Content',
    role: 'Your source of truth',
    desc: 'Plain markdown or mdx files in your project, version-controlled in git.',
  },
];

export function LayerStack() {
  return (
    <div className="ok-overview ok-stack not-prose relative mt-1.5 flex flex-col gap-3">
      {LAYERS.map((layer) => (
        <div
          key={layer.k}
          className="relative z-[1] flex items-start gap-[18px] rounded-xl border border-fd-border bg-fd-card px-[22px] py-5 shadow-sm"
        >
          <span
            className="grid size-[38px] shrink-0 place-items-center rounded-[10px] shadow-[0_0_0_5px_var(--color-fd-card)]"
            style={{ background: 'var(--ok-accent-soft)', color: 'var(--ok-accent-ink)' }}
          >
            <layer.Icon className="size-[19px]" strokeWidth={1.7} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <span className="mb-2 block font-mono text-[11px] tracking-[0.06em] text-fd-muted-foreground">
              {layer.k}
            </span>
            <h3 className="m-0 mb-[5px] text-[17px] font-semibold tracking-tight text-fd-foreground">
              {layer.title}
            </h3>
            <p className="m-0 text-[14.5px] leading-[1.55] text-fd-muted-foreground">
              {layer.desc}
            </p>
          </div>
          <span className="hidden shrink-0 self-center whitespace-nowrap rounded-full border border-fd-border bg-fd-muted px-3 py-[7px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fd-muted-foreground md:inline-block">
            {layer.role}
          </span>
        </div>
      ))}
    </div>
  );
}

interface Path {
  href: string;
  title: string;
  desc: string;
}

const PATHS: Path[] = [
  {
    href: '/docs/get-started/quickstart',
    title: 'Try the Quickstart',
    desc: 'Install the desktop app and get your first agent-driven edit in under five minutes.',
  },
  {
    href: '/docs/integrations/claude-code',
    title: 'Setting up an editor?',
    desc: 'Use with Claude, Cursor, Codex, or OpenCode.',
  },
  {
    href: '/docs/workflows/karpathy-llm-wiki',
    title: 'Set up an LLM Wiki',
    desc: 'Build a Karpathy-style LLM Wiki',
  },
];

export function WhereToStart() {
  return (
    <div className="ok-overview not-prose flex flex-col gap-2.5">
      {PATHS.map((path, i) => (
        <a
          key={path.href}
          href={path.href}
          className="group flex items-center gap-4 rounded-xl border border-fd-border bg-fd-card px-[18px] py-4 no-underline shadow-sm transition hover:-translate-y-px hover:border-[var(--ok-accent)]"
        >
          <span
            className="grid size-7 shrink-0 place-items-center rounded-lg font-mono text-[13px] font-semibold"
            style={{ background: 'var(--ok-accent-soft)', color: 'var(--ok-accent-ink)' }}
          >
            {i + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14.5px] font-semibold text-fd-foreground">
              {path.title}
            </span>
            <span className="block text-[13.5px] leading-snug text-fd-muted-foreground">
              {path.desc}
            </span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-fd-muted-foreground transition-colors group-hover:text-[var(--ok-accent)]" />
        </a>
      ))}
    </div>
  );
}
