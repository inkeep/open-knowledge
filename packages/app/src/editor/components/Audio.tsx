/**
 * Audio — DIY renderer for the lowercase `audio` canonical (lowercase
 * media pivot).
 *
 * Pure HTML5 `<audio>` wrapper. Self-closing leaf descriptor symmetric with
 * Video. Renders the descriptor's 7-prop surface — 1 common (src) + 6
 * advanced (controls + autoplay + title + muted + loop + preload). Toggle
 * `controls={false}` for chrome-less playback (rare, mostly hero loops).
 *
 * ── `controls` is now an explicit prop ───────────────────────────────────────
 *
 * Previous canonical `Audio` hardcoded controls always-on per the
 * "no confidently-broken chrome" stance. Lowercase `audio` makes it an
 * explicit prop (default true) so authors who want a chrome-less audio
 * (`autoplay` background loop) can set `controls={false}` from the
 * descriptor instead of escaping to raw HTML. The default keeps the prior
 * always-on behavior for the common case.
 *
 * ── Why self-closing (no `<source>` / `<track>` passthrough) ─────────────────
 *
 * HTML5 requires `<source>` and `<track>` as direct children of `<audio>`.
 * ProseMirror NodeViews mandate a wrapper DOM element to host the content
 * hole (`NodeViewContent`). The two contracts are structurally
 * incompatible — see Video.tsx's comment block for the full rationale.
 *
 * Audio is a leaf descriptor. Authors who need codec fallback sources write
 * raw `<audio>` + `<source>` HTML in MDX, which flows through the wildcard
 * / rawMdxFallback path (byte-preserving, editable as MDX source).
 *
 * ── HTML-attr lowercase ↔ React camelCase translation ────────────────────────
 *
 * Descriptor stores HTML-spec `autoplay`; React's `<audio>` JSX type expects
 * `autoPlay`. The translation lives at the single JSX boundary below.
 *
 * ── Sanitization ─────────────────────────────────────────────────────────────
 *
 * `src` flows through `sanitizeComponentProps` at the JsxComponentView
 * boundary (it is in `URL_PROP_NAMES`).
 */

import { toDesktopAssetHref } from '@inkeep/open-knowledge-core';

interface AudioProps {
  src?: string;
  controls?: boolean;
  autoplay?: boolean;
  // advanced
  title?: string;
  muted?: boolean;
  loop?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
}

/**
 * Resolve the `controls` prop's effective boolean. Descriptor's default is
 * `true`; defensive at runtime — explicit `false` disables controls, anything
 * else (undefined, true) enables them.
 */
function resolveControls(controls: boolean | undefined): boolean {
  return controls !== false;
}

/**
 * DIY Audio. Descriptor-dispatched via `componentMap['audio']`.
 */
export function Audio(props: AudioProps) {
  return (
    <audio
      className="ok-audio"
      src={props.src === undefined ? undefined : toDesktopAssetHref(props.src)}
      title={props.title}
      controls={resolveControls(props.controls)}
      autoPlay={props.autoplay}
      loop={props.loop}
      muted={props.muted}
      preload={props.preload}
    />
  );
}
