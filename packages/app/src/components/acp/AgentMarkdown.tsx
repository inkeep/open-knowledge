/**
 * Streamed agent markdown for the thread transcript. Streamdown closes
 * unterminated constructs (emphasis, fences, links) so partial stream chunks
 * render cleanly mid-turn, and sanitizes the rendered tree — agent output is
 * not trusted HTML. The boundary drops to plain text if the renderer throws
 * on a malformed partial and retries via `resetKeys` when the next chunk
 * changes the text.
 */

import { useLingui } from '@lingui/react/macro';
import { type ReactNode, use } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { type Components, defaultRemarkPlugins, Streamdown } from 'streamdown';
import { codeHighlighter } from '@/lib/acp/code-highlighter';
import { remarkHardBreaks } from '@/lib/acp/remark-hard-breaks';
import { docNameFromHash } from '@/lib/doc-hash';
import { remarkDocPathLinks } from './doc-path-links';
import { DocPathResolverReadyContext } from './doc-path-links-context';

/** Anchor override. Two cases:
 *  - `#/<docName>` hash → in-app link (no `target=_blank`), Lingui'd `title`.
 *  - Anything else → keep Streamdown's own `MarkdownA` classes so external
 *    links still read as links (color + underline + `wrap-anywhere` for long
 *    URLs in the narrow transcript). Overriding `components.a` REPLACES
 *    `MarkdownA` — a bare `<a>` with no class list would leave every ordinary
 *    external link colourless and un-underlined under Tailwind's preflight
 *    (`a { color: inherit; text-decoration: inherit }`).
 *
 *  Streamdown's Components index-signature widens prop types to a records
 *  shape, so we take the raw record and narrow href back out ourselves. */
function AgentAnchor(props: { href?: string; children?: ReactNode }): ReactNode {
  const { t } = useLingui();
  const { href, children } = props;
  if (href?.startsWith('#/')) {
    // Parse with the canonical reader rather than a local slice. The href is
    // percent-encoded by the time it lands here either way: `hashFromDocName`
    // escapes what it builds, and the markdown renderer's URL sanitizer
    // escapes whatever a hand-written link left unescaped. A reader that
    // slices without decoding therefore shows the escapes to the user.
    const docName = docNameFromHash(href) ?? href;
    return (
      <a
        href={href}
        data-testid="agent-thread-doc-link"
        title={t`Open ${docName}`}
        className="text-primary underline underline-offset-2 decoration-primary/40 hover:decoration-primary"
      >
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-streamdown="link"
      className="wrap-anywhere font-medium text-primary underline"
    >
      {children}
    </a>
  );
}

export function AgentMarkdown({ text }: { text: string }): ReactNode {
  // Reads the resolver-ready flag from context so ThreadView can derive
  // workspace + page list ONCE above the transcript instead of per message
  // bubble (which fires `/api/workspace` per bubble on web hosts).
  const resolverReady = use(DocPathResolverReadyContext);
  return (
    <ErrorBoundary
      resetKeys={[text]}
      fallbackRender={() => <span className="whitespace-pre-wrap">{text}</span>}
      onError={(error) => {
        console.error('[AgentMarkdown] markdown render failed, falling back to plain text', error);
      }}
    >
      <Streamdown
        // Key on resolver-availability so every mounted Streamdown remounts
        // exactly once when the resolver becomes ready. Streamdown's Block
        // memoizes its unified processor at first mount and never re-parses
        // when a later render passes a different plugin closure, so a mount
        // that happened before workspace + page list arrived (the transcript
        // on cold page load) would leave those older messages' paths
        // unlinked forever. Text is stable across the null → ready transition
        // (workspace + pages arrive on the first tick; transcript-render
        // lands after), so the remount is imperceptible.
        //
        // Residual race, deliberately not solved: a doc the agent creates
        // mid-thread reaches `pageList.pages` via the CC1 `files` push
        // (300ms coalesce + a `/api/documents` fetch). A short agent message
        // that finishes streaming inside that window keeps its own path as
        // dead text for the rest of the session — the resolver-availability
        // shape never flips again. Keying on a page-set version would fix
        // this but remounts every message on every doc-create burst; the
        // trade isn't worth it for the tail case.
        key={resolverReady ? 'with-resolver' : 'no-resolver'}
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
        className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre_code>span]:block [&_ol]:list-outside [&_ul]:list-outside [&_ol]:ps-6 [&_ul]:ps-6 [&_li+li]:mt-2 [&_li>p]:block! [&_li>*+*]:mt-2 [&_li_[data-streamdown=code-block]]:my-2! [&_code]:text-1sm [&_pre]:text-1sm [&_[data-streamdown=code-block-body]]:p-3 [&_[data-streamdown=code-block-body]]:max-h-80 [&_[data-streamdown=code-block-body]]:overflow-auto"
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
        remarkPlugins={[
          ...Object.values(defaultRemarkPlugins),
          remarkHardBreaks,
          // Pre-called (unlike `remarkHardBreaks`, which is a standard
          // `() => Transformer` Plugin passed by reference). The extra factory
          // layer keeps Streamdown's per-Block processor cache from freezing a
          // stale resolver closure — see doc-path-links.ts.
          remarkDocPathLinks(),
        ]}
        components={{ a: AgentAnchor } as Components}
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
