/**
 * Video — DIY renderer for the lowercase `video` canonical.
 *
 * HTML5 `<video>` wrapper for file-served media; routes to a lite
 * YouTube embed (thumbnail-then-iframe facade) when `src` is a
 * recognizable YouTube URL. Self-closing leaf descriptor symmetric with
 * Image. Renders the descriptor's 11-prop surface — 1 common (src) + 10
 * advanced (controls + autoplay + poster + width + height + title +
 * muted + loop + playsinline + preload). The fresh-insert PropPanel is
 * a single src field; toggle controls / autoplay / etc. from the
 * Advanced section.
 *
 * ── YouTube + Vimeo + Loom dispatch ────────────────────────────────────────
 *
 * Scoped URL sniffing limited to recognized hosts: YouTube via
 * `parseYouTubeUrl` (`youtube.com`, `youtu.be`, `youtube-nocookie.com`,
 * etc.), Vimeo via `isVimeoUrl` (`vimeo.com`, `www.vimeo.com`,
 * `player.vimeo.com`), and Loom via `isLoomUrl` (`loom.com`,
 * `www.loom.com`). YouTube detected → `<LiteYouTubeEmbed>` (react-
 * lite-youtube-embed, built on Paul Irish's `lite-youtube-embed`); the
 * wrapper shows a thumbnail + play button and the real `<iframe>` mounts
 * on click. Vimeo detected → `@u-wave/react-vimeo`, which manages the
 * iframe directly via Vimeo's official Player SDK. Loom detected →
 * direct `<iframe>` to `loom.com/embed/<id>` (Loom's embed is just a
 * URL — no SDK, no facade, no oEmbed lookup). Otherwise fall through
 * to the native HTML5 `<video>` path.
 *
 * The facade sidesteps two YouTube-specific iframe gotchas the eager-
 * iframe approach kept tripping over:
 *
 *   - YouTube's autoplay heuristic — the iframe needs a user gesture to
 *     start playback; a thumbnail-then-click flow provides that gesture
 *     by construction.
 *   - YouTube's Referer-based embed allowlist — when the iframe is
 *     created post-gesture with `referrerPolicy="strict-origin-when-
 *     cross-origin"` (the lib's default), the origin makes it through
 *     and the allowlist is satisfied. The previous `no-referrer` value
 *     triggered "Video unavailable — watch on YouTube" refusals on a
 *     meaningful fraction of videos.
 *
 * Perf bonus: ~5 KB JS for the wrapper vs ~540 KB JS that an eager
 * `<iframe>` pulls in per video block on first paint.
 *
 * ── Privacy-host preservation ───────────────────────────────────────────────
 *
 * `parseYouTubeUrl` returns `noCookie: true` for any `youtube-nocookie.com`
 * input; we forward that to the lib as `cookie={false}` so the post-
 * activation iframe targets the nocookie host. Regular `youtube.com`
 * paste → `cookie={true}` → standard `youtube.com` iframe. Round-trip
 * matches the prior eager-iframe behavior.
 *
 * ── Descriptor prop ↔ lite-embed mapping ────────────────────────────────────
 *
 * Every advanced prop on `htmlVideoProps` that has a YouTube-iframe
 * equivalent is wired through; the lone outlier (`preload`) is hidden
 * from the PropPanel for YouTube URLs via the descriptor's `hideWhen`
 * — the facade already defers the iframe entirely, which is strictly
 * better than any preload hint.
 *
 *   - `src`         → parsed to `{ id, startSeconds, noCookie }`
 *   - `title`       → lib's `title` (a11y + wrapper `data-title`)
 *   - `controls`    → `controls=0` URL param when explicitly `false`
 *   - `autoplay`    → lib's `autoplay`. Combined with `muted`, also
 *                     enables `alwaysLoadIframe={true}` to skip the
 *                     thumbnail facade and auto-play on mount (the lib
 *                     only emits `autoplay=1` when paired with `muted`,
 *                     matching the browser's autoplay policy). Unmuted
 *                     autoplay falls back to the click-facade so the
 *                     first user gesture cleanly satisfies the autoplay
 *                     bar.
 *   - `muted`       → lib's `muted` (adds `mute=1` to the iframe URL)
 *   - `loop`        → `loop=1&playlist=<id>` URL params (YouTube only
 *                     loops a "playlist"; a single video re-queues itself
 *                     as a 1-item list)
 *   - `playsinline` → `playsinline=1` URL param
 *   - `poster`      → lib's `thumbnail` (overrides the default
 *                     `i.ytimg.com` poster)
 *   - `width`       → inline `style.width` on the wrapper `<div>`
 *   - `height`      → combined with `width` → inline `style.aspectRatio`
 *                     on the lite-embed, overriding its default 16/9
 *   - `preload`     → ignored at render; PropPanel hides it via
 *                     `hideWhen` so the setting doesn't pretend to work
 *
 * ── URL-prop edits restart the iframe (expected) ────────────────────────────
 *
 * Once the iframe is mounted (post-click, or eager via `alwaysLoadIframe`),
 * editing a URL-affecting prop (`controls`, `loop`, `muted`, `autoplay`,
 * `playsinline`) recomposes the lib's memoized iframe `src`. React
 * updates the iframe's `src` attribute, the browser navigates, and
 * playback restarts. This is the lib's design — every iframe-backed
 * YouTube embed library behaves the same way because the YouTube player
 * is configured via URL params. Non-URL props (`title`, `width`,
 * `height`, `poster`) do NOT restart — they route to attributes / style
 * that the lib doesn't fold into the `src` useMemo.
 *
 * Authoring tip: tweak the prop, expect a brief re-load, accept the new
 * configuration. If autoplay+muted are set, the reload re-starts the
 * video automatically; otherwise the YouTube player chrome surfaces and
 * the author clicks play.
 *
 * ── Constraints (load-bearing) ──────────────────────────────────────────────
 *
 *   - NO `start` seek prop on the descriptor. Timestamps ride inside the
 *     YouTube URL itself (`?t=42` / `?t=2m30s`); the parser folds them
 *     into the embed query via the lib's `params` prop.
 *   - NO custom player chrome. HTML5 native controls + the lite-embed
 *     thumbnail UI (pre-click) + YouTube's iframe chrome (post-click)
 *     are the UX. The wrapping `.ok-video` class only handles layout.
 *
 * ── Why self-closing (no `<track>` / `<source>` passthrough) ─────────────────
 *
 * HTML5 requires `<track>` and `<source>` as direct children of `<video>`.
 * ProseMirror NodeViews mandate a wrapper DOM element to host the content
 * hole (`NodeViewContent`). The two contracts are structurally
 * incompatible — any PM-children passthrough would wrap the native
 * elements in an intermediate div, which the HTML5 spec does not allow.
 *
 * Authors who need captions or codec fallback sources write raw `<video>` +
 * `<track>` HTML in MDX, which flows through the wildcard / rawMdxFallback
 * path (byte-preserving, editable as MDX source).
 *
 * ── HTML-attr lowercase ↔ React camelCase translation ────────────────────────
 *
 * Descriptor stores HTML-spec spellings (`autoplay`, `playsinline`); React's
 * `<video>` JSX type expects camelCase (`autoPlay`, `playsInline`). The
 * translation lives at the single JSX boundary below.
 *
 * ── Sanitization ─────────────────────────────────────────────────────────────
 *
 * `src` and `poster` flow through `sanitizeComponentProps` at the
 * JsxComponentView boundary (both are in `URL_PROP_NAMES`).
 */

import {
  isLoomUrl,
  isVimeoUrl,
  type ParsedYouTubeUrl,
  parseLoomUrl,
  parseYouTubeUrl,
  toDesktopAssetHref,
} from '@inkeep/open-knowledge-core';
import Vimeo from '@u-wave/react-vimeo';
import { type CSSProperties, useEffect, useRef } from 'react';
import LiteYouTubeEmbed from 'react-lite-youtube-embed';
import 'react-lite-youtube-embed/dist/LiteYouTubeEmbed.css';

interface VideoProps {
  src?: string;
  controls?: boolean;
  autoplay?: boolean;
  poster?: string;
  width?: number | string;
  height?: number | string;
  // advanced
  title?: string;
  muted?: boolean;
  loop?: boolean;
  playsinline?: boolean;
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
 * Compose the extra `params` string handed to the lite-embed. The lib
 * already manages `autoplay=1` (via its `autoplay` prop) and `mute=1`
 * (via `muted`); everything else rides through `params` so it lands on
 * the post-activation iframe URL.
 *
 *   - `start=<seconds>` ← `?t=42` / `?t=2m30s` / `?start=42` on the input
 *   - `controls=0`      ← descriptor `controls={false}` (default is shown)
 *   - `loop=1&playlist=<id>` ← descriptor `loop`. YouTube only loops a
 *     "playlist"; for a single video the convention is to set
 *     `playlist=<id>` so the player re-queues the same id as a 1-item
 *     list.
 *   - `playsinline=1`   ← descriptor `playsinline`
 */
function buildYouTubeParams(props: VideoProps, yt: ParsedYouTubeUrl): string | undefined {
  const parts: string[] = [];
  if (yt.startSeconds !== null) parts.push(`start=${yt.startSeconds}`);
  if (props.controls === false) parts.push('controls=0');
  if (props.loop === true) parts.push('loop=1', `playlist=${yt.id}`);
  if (props.playsinline === true) parts.push('playsinline=1');
  return parts.length > 0 ? parts.join('&') : undefined;
}

/**
 * Compose the wrapper-`<div>` inline style shared by the YouTube and
 * Vimeo branches. Inline `width` overrides the CSS class's default 720px
 * width when the author opts in; the CSS already supplies `max-width:
 * 100%` so an author width that exceeds the editor column shrinks to fit
 * instead of overflowing.
 */
function buildVideoWrapperStyle(props: VideoProps): CSSProperties | undefined {
  if (props.width === undefined) return undefined;
  return { width: props.width };
}

/**
 * Compose the inline style handed to `<LiteYouTubeEmbed style={...}>`.
 * Width + height together override the lib's default `aspect-ratio: 16/9`
 * so the iframe matches author-declared dimensions; width alone keeps
 * the 16/9 default (height is derived from width).
 */
function buildYouTubeLiteStyle(props: VideoProps): CSSProperties | undefined {
  if (props.width === undefined || props.height === undefined) return undefined;
  return { aspectRatio: `${props.width} / ${props.height}` };
}

/**
 * Vimeo dispatch — extracted as a sibling component so the hooks needed
 * to wire iframe a11y (`useRef` + `useEffect` for the title sync) live
 * at the right call site. Hooks can't live inside the conditional inside
 * `Video`, hence the split.
 *
 * Accessible name parity with the YouTube branch: `@u-wave/react-vimeo`
 * doesn't expose an iframe-title prop (its `title` prop is overloaded —
 * it toggles Vimeo's in-player `showTitle` UI, not the iframe `title`
 * attribute), and the lib doesn't spread unknown props to the iframe.
 * The lib *does* give us `player.element` (the iframe) on `onReady`,
 * which is the same surface its own width/height update uses. We hold
 * the player in a ref, set the iframe title on ready, and sync via
 * effect when the author edits `props.title`.
 */
// `@vimeo/player`'s `Player.element` is the iframe at runtime (the lib's
// own width/height setters mutate `player.element[name]`), but the lib's
// d.ts doesn't expose it. Define the structural shape we need so the
// `onReady` signature lines up with what we actually consume.
interface VimeoPlayerWithElement {
  element: HTMLIFrameElement | null;
}

function VimeoEmbed(props: VideoProps & { src: string }) {
  const playerRef = useRef<VimeoPlayerWithElement | null>(null);
  const fallbackTitle = 'Vimeo video player';
  const effectiveTitle = props.title ?? fallbackTitle;

  // React Compiler is enabled (see CLAUDE.md / AGENTS.md) — no useCallback.
  // The handler closes over the latest title via the effect below.
  // Lib types onReady as `(player: Player) => void`; we receive the same
  // runtime object and just need the (real but undocumented) `.element`.
  const handleReady = (player: unknown) => {
    const p = player as VimeoPlayerWithElement;
    playerRef.current = p;
    if (p.element) {
      p.element.title = effectiveTitle;
    }
  };

  // Title sync on prop change (post-ready). Player object is held across
  // renders in the ref; element is the iframe.
  useEffect(() => {
    const player = playerRef.current;
    if (player?.element) {
      player.element.title = effectiveTitle;
    }
  }, [effectiveTitle]);

  return (
    <div
      className="ok-video ok-video-vimeo"
      style={buildVideoWrapperStyle(props)}
      title={props.title}
    >
      <Vimeo
        video={props.src}
        responsive={props.width === undefined}
        width={props.width}
        height={props.height}
        autoplay={props.autoplay === true}
        muted={props.muted === true}
        // `volume` is the lib's reactive audio control. The `muted`
        // prop is documented as init-only ("starts in a muted state to
        // help with autoplay"), so flipping it after mount has no
        // effect on the live player. Mirroring `muted` into `volume`
        // (0 when muted, 1 otherwise) makes the PropPanel toggle
        // actually mute/unmute the playing video — the SDK propagates
        // volume changes through Player.setVolume() under the hood.
        volume={props.muted === true ? 0 : 1}
        loop={props.loop === true}
        controls={props.controls !== false}
        playsInline={props.playsinline !== false}
        onReady={handleReady}
      />
    </div>
  );
}

/**
 * Loom dispatch — direct iframe to `loom.com/embed/<id>`. Loom's embed
 * is a plain iframe (no SDK, no facade, no oEmbed lookup), so we own the
 * URL composition and the iframe element directly. `parseLoomUrl`
 * converts `/share/<id>` to `/embed/<id>` and preserves the verbatim
 * `?t=` timestamp; the descriptor's `autoplay` + `muted` map to
 * Loom URL params on the embed iframe's `src`.
 *
 * Hidden from the Vimeo-style `hideWhen` audit for the same reasons
 * (none of these can take effect for the Loom embed): `controls` (Loom
 * always shows its top bar — no toggle), `poster` (Loom serves its own
 * thumbnail, no override), `preload` (no embed equivalent),
 * `playsinline` (not applicable to Loom's iframe), and `loop` (Loom
 * doesn't expose a loop param). The runtime still receives whatever
 * authors set via raw MDX; we just don't surface those fields when the
 * URL is recognized as Loom so the PropPanel doesn't make promises the
 * embed can't keep.
 */
function LoomEmbed(props: VideoProps & { src: string }) {
  const parsed = parseLoomUrl(props.src);
  // Caller has already gated on isLoomUrl(props.src), so parsed is
  // guaranteed non-null at runtime. Defensive guard for the type-narrow.
  if (!parsed) return null;

  const params: string[] = [];
  if (parsed.startRaw !== null) params.push(`t=${parsed.startRaw}`);
  if (props.autoplay === true) params.push('autoplay=true');
  if (props.muted === true) params.push('muted=true');
  const embedUrl =
    params.length > 0
      ? `https://www.loom.com/embed/${parsed.id}?${params.join('&')}`
      : `https://www.loom.com/embed/${parsed.id}`;

  return (
    <div
      className="ok-video ok-video-loom"
      style={buildVideoWrapperStyle(props)}
      title={props.title}
    >
      <iframe
        className="ok-video-loom-iframe"
        src={embedUrl}
        title={props.title ?? 'Loom video player'}
        width={props.width}
        height={props.height}
        allow="autoplay; fullscreen"
        // Defense-in-depth parity with the YouTube branch (which gets
        // `strict-origin-when-cross-origin` via react-lite-youtube-embed's
        // default). Doc routing today is fragment-only (`/#/<doc>`,
        // which `Referer` strips by spec), but pinning the policy now
        // is cheap insurance against a future routing change leaking
        // editor path info to loom.com.
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    </div>
  );
}

/**
 * DIY Video. Descriptor-dispatched via `componentMap['video']`.
 *
 * When `src` is a recognized YouTube URL, render `<LiteYouTubeEmbed>`
 * (thumbnail-first facade — iframe mounts on click). When it's a Vimeo
 * URL, render `<Vimeo>` from `@u-wave/react-vimeo`. When it's a Loom
 * URL, render `<LoomEmbed>` (direct iframe — Loom's embed is just a
 * URL). Otherwise render the HTML5 `<video>` element.
 */
export function Video(props: VideoProps) {
  if (props.src !== undefined && isLoomUrl(props.src)) {
    // `controls`, `poster`, `preload`, `playsinline`, and `loop` are
    // hidden from the PropPanel for Loom URLs via descriptor `hideWhen`
    // (each can't take effect for Loom's embed — see built-ins.ts). The
    // runtime still forwards them in case raw-MDX authoring sets them.
    return <LoomEmbed {...props} src={props.src} />;
  }
  if (props.src !== undefined && isVimeoUrl(props.src)) {
    // `controls`, `poster`, `preload`, and `playsinline` are hidden
    // from the PropPanel for Vimeo URLs via descriptor `hideWhen` (each
    // can't reliably take effect for Vimeo at the editor's authoring
    // tier — see built-ins.ts). The runtime still forwards them in case
    // raw-MDX authoring sets them; nothing pretends to work in the UI.
    return <VimeoEmbed {...props} src={props.src} />;
  }
  const yt = props.src !== undefined ? parseYouTubeUrl(props.src) : null;
  if (yt !== null) {
    // Eager-mount the iframe only when BOTH `autoplay` and `muted` are
    // set. That mirrors the lib's internal rule for adding `autoplay=1`
    // to the URL — and that rule itself mirrors the browser's autoplay
    // policy (unmuted media needs a user gesture). Eager-mounting an
    // iframe that then refuses to autoplay is the worst of both worlds:
    // the YouTube player loads up but doesn't start, and the author
    // can't tell why. Falling back to the click-facade in the unmuted
    // case gives a clean thumbnail → click → playing flow (the click
    // counts as the gesture, so `autoplay=1` works on activation).
    const eagerIframe = props.autoplay === true && props.muted === true;
    const explicitWidth = props.width !== undefined;
    const explicitAspect = explicitWidth && props.height !== undefined;
    return (
      <div className="ok-video ok-video-youtube" style={buildVideoWrapperStyle(props)}>
        <LiteYouTubeEmbed
          id={yt.id}
          title={props.title ?? 'YouTube video player'}
          // `cookie={true}` → youtube.com host; `cookie={false}` →
          // youtube-nocookie.com. Round-trips the input host so an
          // author who deliberately pasted nocookie keeps the privacy
          // posture; regular paste gets the standard youtube.com embed.
          cookie={!yt.noCookie}
          params={buildYouTubeParams(props, yt)}
          muted={props.muted === true}
          autoplay={props.autoplay === true}
          alwaysLoadIframe={eagerIframe}
          // Author-supplied poster overrides the default YouTube
          // thumbnail (which the lib fetches from i.ytimg.com).
          thumbnail={props.poster !== undefined ? toDesktopAssetHref(props.poster) : undefined}
          // `aspectWidth` / `aspectHeight` set the lib's `--aspect-ratio`
          // CSS variable, which powers the `padding-bottom` fallback in
          // browsers without native `aspect-ratio` support. Modern
          // browsers honor the inline `aspectRatio` style on the wrapper
          // (see `buildYouTubeLiteStyle`); these props are the defensive
          // companion for legacy engines so the wrapper still has the
          // right shape pre-paint.
          aspectWidth={explicitAspect ? Number(props.width) : undefined}
          aspectHeight={explicitAspect ? Number(props.height) : undefined}
          style={buildYouTubeLiteStyle(props)}
        />
      </div>
    );
  }
  return (
    <video
      className="ok-video"
      src={props.src === undefined ? undefined : toDesktopAssetHref(props.src)}
      title={props.title}
      controls={resolveControls(props.controls)}
      autoPlay={props.autoplay}
      muted={props.muted}
      loop={props.loop}
      playsInline={props.playsinline}
      poster={props.poster === undefined ? undefined : toDesktopAssetHref(props.poster)}
      preload={props.preload}
      width={props.width}
      height={props.height}
    />
  );
}
