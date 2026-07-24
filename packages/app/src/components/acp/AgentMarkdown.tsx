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
import { Streamdown } from 'streamdown';

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
        // Code drops a notch to 13px (Streamdown hard-codes `text-sm` on both
        // inline and block code) so the mono face, which reads larger than the
        // UI face at a matched point size, sits optically level with the prose
        // around it. Deliberately not `!`: the descendant selector already
        // outranks Streamdown's own class, which leaves an `!` override on a
        // wrapper — the thought bubble's flattening — free to win.
        className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre_code>span]:block [&_code]:text-1sm [&_pre]:text-1sm"
        lineNumbers={false}
        controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
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
