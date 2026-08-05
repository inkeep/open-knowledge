/**
 * In-viewer find bar for read-only rendered prose (§8.4) — Cmd/Ctrl+F inside a
 * read-only surface opens it; matches highlight via the CSS Custom Highlight
 * API (`CSS.highlights`), so the DOM is never rewritten (no <mark> injection
 * into TipTap's rendered output). Self-contained + surface-agnostic: give it
 * the scroll container ref and it owns query state, match ranges, highlight
 * painting, and next/prev navigation. Works identically in web and desktop —
 * no Electron `findInPage` IPC (which would also highlight the sidebar).
 *
 * The text viewer (CodeMirror) doesn't need this — `basicSetup` ships the CM
 * search keymap, so Cmd+F there opens CodeMirror's own panel when focused.
 */
// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const HIGHLIGHT_ALL = 'ok-find';
const HIGHLIGHT_ACTIVE = 'ok-find-active';

function collectMatchRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const lower = text.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx >= 0) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      ranges.push(range);
      idx = lower.indexOf(needle, idx + needle.length);
    }
  }
  return ranges;
}

export function ProseFindBar({
  containerRef,
  onClose,
}: {
  /** The scrollable element holding the rendered prose to search. */
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Range[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Recompute + repaint on query change; clear the painted highlights on
  // unmount so closing the bar removes every mark.
  // biome-ignore lint/correctness/useExhaustiveDependencies: containerRef is a stable ref
  useEffect(() => {
    const root = containerRef.current;
    const highlights = CSS.highlights;
    if (!root || highlights === undefined) return;
    const ranges = collectMatchRanges(root, query.trim());
    setMatches(ranges);
    setActive(0);
    highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges));
    return () => {
      highlights.delete(HIGHLIGHT_ALL);
      highlights.delete(HIGHLIGHT_ACTIVE);
    };
  }, [query]);

  // Paint + scroll the active match.
  useEffect(() => {
    const highlights = CSS.highlights;
    if (highlights === undefined) return;
    const current = matches[active];
    if (current === undefined) {
      highlights.delete(HIGHLIGHT_ACTIVE);
      return;
    }
    highlights.set(HIGHLIGHT_ACTIVE, new Highlight(current));
    const el = current.startContainer.parentElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [matches, active]);

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    setActive((a) => (a + dir + matches.length) % matches.length);
  };

  return (
    <div className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-md border bg-popover p-1 shadow-md">
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t`Find`}
        aria-label={t`Find in file`}
        className="h-7 w-44"
        onKeyDown={(e) => {
          if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
          if (e.key === 'Escape') onClose();
        }}
      />
      <span className="min-w-10 text-center text-muted-foreground text-xs tabular-nums">
        {query.trim() === '' ? null : matches.length === 0 ? (
          <Trans>0/0</Trans>
        ) : (
          `${active + 1}/${matches.length}`
        )}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => step(-1)}
        aria-label={t`Previous match`}
      >
        <ChevronUp className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => step(1)}
        aria-label={t`Next match`}
      >
        <ChevronDown className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onClose}
        aria-label={t`Close find`}
      >
        <X className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
