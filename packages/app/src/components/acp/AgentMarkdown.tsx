/**
 * Streamed agent markdown for the thread transcript. Streamdown closes
 * unterminated constructs (emphasis, fences, links) so partial stream chunks
 * render cleanly mid-turn, and sanitizes the rendered tree — agent output is
 * not trusted HTML. The boundary drops to plain text if the renderer throws
 * on a malformed partial and retries via `resetKeys` when the next chunk
 * changes the text.
 */

import type { ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { defaultRemarkPlugins, Streamdown } from 'streamdown';
import { codeHighlighter } from '@/lib/acp/code-highlighter';
import { remarkHardBreaks } from '@/lib/acp/remark-hard-breaks';

export function AgentMarkdown({ text }: { text: string }): ReactNode {
  return (
    <ErrorBoundary
      resetKeys={[text]}
      fallbackRender={() => <span className="whitespace-pre-wrap">{text}</span>}
      onError={(error) => {
        console.warn('[AgentMarkdown] markdown render failed, falling back to plain text', error);
      }}
    >
      <Streamdown
        // The `pre code>span` rule restores per-line block display in code
        // blocks: Streamdown bundles it into the line-number counter classes,
        // so `lineNumbers={false}` alone collapses multi-line code onto one
        // visual line.
        //
        // Lists force `list-outside` + inline-start padding for a deterministic
        // hanging indent: the marker sits in the padding and wrapped lines align
        // under the text. Without this, lists inherit Tailwind's preflight
        // (ol/ul padding:0) and Streamdown's list-style-position varies by build
        // — top-level markers then hang into zero padding and clip off the
        // transcript's narrow, scroll-free left edge. Padding matches
        // Streamdown's own nested-list `[li_&]:pl-6`.
        //
        // Code drops a notch to 13px (Streamdown hard-codes `text-sm` on both
        // inline and block code) so the mono face, which reads larger than the
        // UI face at a matched point size, sits optically level with the prose
        // around it. Deliberately not `!`: the descendant selector already
        // outranks Streamdown's own class, which leaves an `!` override on a
        // wrapper — the thought bubble's flattening — free to win.
        //
        // The code-block-body overrides tighten Streamdown's p-4 a notch and
        // cap tall blocks at max-h-80 with internal scroll, targeting the
        // stable `data-streamdown` hooks rather than its Tailwind classes.
        className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre_code>span]:block [&_ol]:list-outside [&_ul]:list-outside [&_ol]:ps-6 [&_ul]:ps-6 [&_code]:text-1sm [&_pre]:text-1sm [&_[data-streamdown=code-block-body]]:p-3 [&_[data-streamdown=code-block-body]]:max-h-80 [&_[data-streamdown=code-block-body]]:overflow-auto"
        // A lone newline ends the line, as it does in every chat client. The
        // transcript renders sent messages too now, and those are typed by a
        // person pressing Enter — not prose where only a blank line means a new
        // block.
        //
        // SPREAD THE DEFAULTS FIRST. This prop REPLACES Streamdown's own set
        // rather than adding to it, so passing a bare `[remarkHardBreaks]`
        // silently dropped remark-gfm with it — tables and strikethrough stopped
        // rendering in agent output, nowhere near the line that caused it.
        // `defaultRemarkPlugins` is a RECORD keyed by name, not a list.
        remarkPlugins={[...Object.values(defaultRemarkPlugins), remarkHardBreaks]}
        lineNumbers={false}
        controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
        // Shiki-backed syntax highlighting via the in-house curated-grammar
        // plugin (not `@streamdown/code`, whose full-bundle shiki blows the
        // all-chunks size budget). github-light/github-dark, follows the
        // app's `.dark` variant; grammars load lazily on first code block.
        plugins={{ code: codeHighlighter }}
        // Plain hardened anchors instead of Streamdown's confirm-modal flow:
        // both shells already gate external opens (web: target=_blank +
        // noreferrer; desktop: the asset-safety-net window-open handler with
        // scheme allowlisting), matching every other external link in the app.
        linkSafety={{ enabled: false }}
      >
        {text}
      </Streamdown>
    </ErrorBoundary>
  );
}
