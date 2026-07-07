/**
 * Embed — generic iframe canonical for the `Embed` descriptor.
 *
 * Drop a URL, get a resizable inline preview pane. Lighter sibling to
 * `Pdf` (single iframe + a wrapper rather than the full pdfjs canvas
 * pipeline). Designed for docs links, CodeSandbox, Figma, prototype
 * URLs — anything an author wants to render in-place instead of as a
 * link the reader has to chase.
 *
 * Security
 * --------
 *
 * 1. Scheme allowlist: only `http://` and `https://` URLs reach the
 *    iframe. Any other scheme (`data:`, `blob:`, `javascript:`, …)
 *    routes to the invalid-URL placeholder. Cross-origin isolation
 *    does NOT block opaque-origin `data:text/html,<script>…</script>`
 *    documents from loading and running script, so the scheme check
 *    has to gate the render itself.
 *
 * 2. Cross-origin enforcement: URLs whose origin matches
 *    `window.location.origin` are refused. The HTML spec warns that
 *    `allow-scripts + allow-same-origin` lets a same-origin iframe
 *    reach into `window.parent`, strip its own sandbox, and reload
 *    unsandboxed — full access to the editor's Y.Doc and session
 *    state follows. Cross-origin URLs are immune because SOP blocks
 *    the escape vector. Practical risk window is local dev
 *    (`localhost:5173` embedding `localhost:5173/...`) and self-
 *    hosted single-origin deployments.
 *
 * 3. `sandbox` token set: `allow-scripts allow-same-origin allow-forms
 *    allow-popups allow-popups-to-escape-sandbox allow-presentation`.
 *    Critically NOT in the set: `allow-top-navigation` — without it,
 *    a hostile embedded page can't redirect the editor by setting
 *    `window.top.location`. `allow-same-origin` keeps the iframe in
 *    its real origin so cookies + localStorage work for legitimate
 *    embeds (Figma, CodeSandbox, …); paired with the cross-origin
 *    enforcement above the sandbox-escape vector is closed.
 *    `allow-presentation` lets slideshow embeds use the Presentation
 *    API.
 *
 * 4. `referrerPolicy="no-referrer"` strips the embedder URL from the
 *    `Referer` header so the embedded site can't correlate viewer
 *    traffic with the doc path.
 *
 * 5. The remote site's own X-Frame-Options / `frame-ancestors` CSP
 *    decides whether it agrees to be framed at all. Sites that refuse
 *    framing render as an empty pane — that's a remote-policy choice
 *    we can't override.
 *
 * Resize
 * ------
 *
 * 8 handles (4 corners + 4 edges) overlay the wrapper via
 * `ResizeHandles`. Every drag updates the wrapper's inline style for
 * smooth visual feedback; on pointer-up the final pixel dimensions
 * are persisted into the descriptor's `width` / `height` props so the
 * size survives reload and travels through the markdown round-trip.
 */

import { rewriteEmbedUrl } from '@inkeep/open-knowledge-core';
import { useEffect, useRef } from 'react';
import { useJsxComponentHost } from './jsx-host-context.tsx';
import { ResizeHandles } from './ResizeHandles.tsx';

interface EmbedProps {
  src?: string;
  title?: string;
  width?: string;
  height?: string;
  align?: 'left' | 'center' | 'right';
}

const DEFAULT_HEIGHT = '26rem';
const DEFAULT_TITLE = 'Embedded content';

// Only `http://` and `https://` schemes load into the iframe. Anything
// else (data:, blob:, javascript:, file:, …) is rejected at render — see
// the security note in the file header. Mirrored by the chrome-bar
// "Open in new tab" anchor in `JsxComponentView` so the editor surface
// also refuses to navigate to a non-allowlisted URL.
const HTTP_SCHEME_RE = /^https?:\/\//i;

/**
 * Same-origin URLs are refused even with valid http(s) scheme. The HTML
 * spec warns that an iframe loaded with `sandbox="allow-scripts
 * allow-same-origin"` AND served from the SAME ORIGIN as the embedder
 * can reach into `window.parent`, remove its sandbox attribute, and
 * reload itself unsandboxed — full access to the editor's Y.Doc and
 * session state follows. Cross-origin URLs are safe because the
 * same-origin policy blocks the escape vector.
 *
 * Practical risk window is local dev (`http://localhost:5173` embedding
 * `http://localhost:5173/...`) and self-hosted single-origin
 * deployments. Returns `false` when `URL` parsing throws — a malformed
 * URL is rejected upstream by `HTTP_SCHEME_RE` anyway, so the
 * try/catch is purely defensive.
 */
function isCrossOriginUrl(src: string): boolean {
  try {
    return new URL(src).origin !== window.location.origin;
  } catch {
    return false;
  }
}

// NOTE: NOT a type predicate (`src is string`) — the TS narrowing in the
// caller's `else` branch would otherwise collapse `src` to `never` and
// block the placeholder copy from inspecting the original value to
// pick a scheme-vs-cross-origin hint.
function isEmbedSrcSafe(src: string | undefined): boolean {
  if (typeof src !== 'string') return false;
  if (!HTTP_SCHEME_RE.test(src)) return false;
  if (!isCrossOriginUrl(src)) return false;
  return true;
}

export function Embed({ src, title, width, height }: EmbedProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const host = useJsxComponentHost();

  // Inline width/height come from props. Render-time mirror — every drag
  // updates the inline style synchronously for smooth feedback, then we
  // commit to props on pointer-up.
  const initialStyle = {
    width: width || undefined,
    height: height || DEFAULT_HEIGHT,
  };

  // Sync the inline style from props on every commit. Without this, a
  // remote-peer prop change wouldn't update the visual until the next
  // user-driven resize.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    el.style.width = width || '';
    el.style.height = height || DEFAULT_HEIGHT;
  }, [width, height]);

  // Three render gates before the iframe:
  //   - `!src` (undefined or empty): show the standard placeholder.
  //     The descriptor's `placeholder.label` covers slash-insert
  //     (`src === ''`); this branch additionally covers pasted
  //     `<Embed />` with no `src` attribute at all (which bypasses
  //     `shouldRenderPlaceholder`'s `=== ''` check).
  //   - unsafe scheme (data:, blob:, javascript:, …): refuse with a
  //     scheme hint. Without this, a malicious pasted MDX `<Embed
  //     src="data:text/html,<script>…</script>" />` would instantiate
  //     an iframe in an opaque origin where script runs.
  //   - same-origin URL: refuse with a cross-origin hint. The
  //     `allow-scripts + allow-same-origin` sandbox combo allows a
  //     same-origin iframe to remove its own sandbox; only cross-
  //     origin URLs are safe to frame.
  if (!isEmbedSrcSafe(src)) {
    let message = 'Embed a URL';
    if (typeof src === 'string' && src.length > 0) {
      message = HTTP_SCHEME_RE.test(src)
        ? 'Embed only supports cross-origin URLs'
        : 'URL must start with http:// or https://';
    }
    return (
      <div className="ok-embed ok-embed--placeholder" contentEditable={false}>
        <span>{message}</span>
      </div>
    );
  }

  const writeSize = (next: { width: number; height: number }) => {
    if (!host) return;
    const { editor, getPos } = host;
    // Read the live pos at dispatch time, not at render time. The pointerup
    // commit can fire seconds after the last render; a concurrent CRDT
    // transaction inserting above this node would otherwise shift the
    // snapshot pos to point at a different node.
    const pos = getPos();
    if (typeof pos !== 'number') return;
    try {
      const node = editor.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'jsxComponent') return;
      const props = (node.attrs.props as Record<string, unknown>) ?? {};
      const nextProps = {
        ...props,
        width: `${Math.round(next.width)}px`,
        height: `${Math.round(next.height)}px`,
      };
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, null, {
          ...node.attrs,
          props: nextProps,
          sourceDirty: true,
        }),
      );
    } catch (err) {
      // `setNodeMarkup` throws RangeError when pos is out-of-bounds (the
      // node was deleted between getPos() and dispatch by a concurrent
      // remote-peer edit). Classify as a user-observable miss rather than
      // letting it bubble into the component ErrorBoundary, which would
      // mis-attribute the click-time race as a render failure.
      if (err instanceof RangeError) return;
      throw err;
    }
  };

  // Rewrite known video-host watch URLs to their frame-embeddable
  // counterparts before handing to the iframe. The user-facing URLs
  // for YouTube / Vimeo / Loom (`youtube.com/watch?v=…`, `vimeo.com/<id>`,
  // `loom.com/share/<id>`) all refuse to be framed via
  // `X-Frame-Options: SAMEORIGIN` — without the rewrite an agent /
  // author who pasted the URL bar's copy sees a blank iframe forever.
  // The descriptor's `src` prop still holds the original; only the
  // in-flight iframe `src` changes. The `<video>` block remains the
  // better tool for video URLs (it routes through the lite-embed
  // facade and handles autoplay heuristics + nocookie hosts); this
  // covers the legacy / non-canonical path where an `<Embed>` already
  // shipped.
  const iframeSrc = rewriteEmbedUrl(src);
  // YouTube's embed allowlist rejects `referrerPolicy="no-referrer"`
  // with a generic "Error 153 — Video player configuration error".
  // When the rewriter changed the URL (i.e. it's a known video host),
  // loosen to `strict-origin-when-cross-origin` so the bare origin
  // reaches the embed allowlist; the hash-routed editor path is still
  // stripped from `Referer` by spec so the doc path doesn't leak.
  // Mirrors `LoomEmbed` / `<LiteYouTubeEmbed>` defaults in `Video.tsx`.
  const referrerPolicy = iframeSrc !== src ? 'strict-origin-when-cross-origin' : 'no-referrer';

  return (
    <div className="ok-embed" style={initialStyle} ref={wrapperRef} contentEditable={false}>
      <iframe
        title={title || DEFAULT_TITLE}
        src={iframeSrc}
        // Sandbox without `allow-top-navigation`: blocks the canonical
        // attack vector (embedded page setting `window.top.location` to
        // redirect the editor). `allow-same-origin` keeps cookies +
        // localStorage available for legitimate embeds (Figma,
        // CodeSandbox); the `allow-scripts + allow-same-origin` pair is
        // only dangerous for SAME-origin embeds (which could remove
        // their own sandbox) — Embed only loads cross-origin URLs in
        // practice. `allow-popups-to-escape-sandbox` lets external
        // links in the embedded page open in real tabs without the
        // sandbox inherited from the parent. `allow-presentation`
        // enables slideshow embeds. See file header for full security
        // rationale.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"
        referrerPolicy={referrerPolicy}
        loading="lazy"
        className="ok-embed-frame"
      />
      {host ? (
        <ResizeHandles
          targetRef={wrapperRef}
          bounds={{
            minWidth: 192,
            maxWidth: 2000,
            minHeight: 128,
            maxHeight: Math.round(window.innerHeight * 0.9),
          }}
          // Live: paint the new size on the wrapper for smooth feedback.
          onResize={(size) => {
            const el = wrapperRef.current;
            if (!el) return;
            el.style.width = `${size.width}px`;
            el.style.height = `${size.height}px`;
          }}
          // Commit: persist into the descriptor's prop bag so the size
          // survives reload + markdown round-trip.
          onResizeEnd={writeSize}
        />
      ) : null}
    </div>
  );
}
