/**
 * RTL behavioral tests for the `Video` canonical's dispatch contract.
 * Pins the three render branches: native `<video>` for file-served media,
 * `<LiteYouTubeEmbed>` (thumbnail-first facade — iframe mounts on click)
 * for recognized YouTube URLs, and `@u-wave/react-vimeo` (eager iframe via
 * Vimeo's Player SDK) for recognized Vimeo URLs.
 *
 * Runs under `bun run test:dom` (jsdom substrate per precedent #43).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useEffect, useRef } from 'react';

// `@u-wave/react-vimeo` wraps `@vimeo/player`, which fires an XHR oEmbed
// lookup on `componentDidMount`. jsdom's XHR surface is partial enough
// that the lib throws synchronously before the wrapper render completes,
// taking the Video's outer div down with it. The Vimeo dispatch contract
// we care about lives entirely in `Video.tsx` (which wrapper class, which
// inline style, which props flow through, how it wires `onReady` for
// iframe-title a11y) — the lib's own iframe/oEmbed internals are not our
// test surface. Mock with a passthrough that records the props onto
// data-attributes AND mounts a real `<iframe>` element. We then invoke
// `onReady` with a fake player whose `.element` points at that iframe,
// mirroring the real lib's lifecycle closely enough to exercise the
// VimeoEmbed component's title-sync effect.
mock.module('@u-wave/react-vimeo', () => {
  type MockProps = Record<string, unknown> & {
    onReady?: (player: { element: HTMLIFrameElement | null }) => void;
  };
  return {
    __esModule: true,
    default: (props: MockProps) => {
      const iframeRef = useRef<HTMLIFrameElement | null>(null);
      // Fire-once parity with the real lib (`@vimeo/player`'s
      // `Player.ready()` resolves exactly once per player instance).
      // Without this guard, the mock's effect re-fires whenever
      // `props.onReady` gets a new reference — which React Compiler
      // produces on every prop change — masking production's
      // `useEffect([effectiveTitle])` from rerender-based tests.
      const readyFiredRef = useRef(false);
      useEffect(() => {
        if (!readyFiredRef.current && props.onReady && iframeRef.current) {
          readyFiredRef.current = true;
          props.onReady({ element: iframeRef.current });
        }
      }, [props.onReady]);
      return (
        <div
          data-testid="vimeo-mock"
          data-video={String(props.video ?? '')}
          data-autoplay={String(props.autoplay ?? false)}
          data-muted={String(props.muted ?? false)}
          data-volume={String(props.volume ?? '')}
          data-loop={String(props.loop ?? false)}
          data-controls={String(props.controls ?? true)}
          data-playsinline={String(props.playsInline ?? true)}
          data-responsive={String(props.responsive ?? false)}
          data-width={props.width === undefined ? '' : String(props.width)}
          data-height={props.height === undefined ? '' : String(props.height)}
          data-onready={String(typeof props.onReady === 'function')}
        >
          <iframe
            ref={iframeRef}
            data-testid="vimeo-mock-iframe"
            title="pending — overwritten by VimeoEmbed onReady"
          />
        </div>
      );
    },
  };
});

const { Video } = await import('./Video.tsx');

describe('Video — YouTube dispatch', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders a native <video> for non-YouTube sources', () => {
    // File-served media keeps the HTML5 element so native controls + the
    // browser's codec pipeline take over.
    const { container } = render(<Video src="/assets/clip.mp4" controls />);
    expect(container.querySelector('video')).not.toBeNull();
    expect(container.querySelector('.yt-lite')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  test.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    // `/v/<id>` old player URL. Pinned here so a future tightening doesn't
    // drop it.
    'https://www.youtube.com/v/dQw4w9WgXcQ',
  ])('renders a lite-embed wrapper for %s with the parsed ID in the thumbnail', (src) => {
    const { container } = render(<Video src={src} />);
    const wrapper = container.querySelector('.yt-lite') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    // The lib paints the thumbnail as an inline `background-image` URL
    // on the wrapper article — the URL embeds the 11-char video ID, so
    // we can use it as a proxy assertion for "the parser handed off the
    // right ID to the facade."
    expect(wrapper?.style.backgroundImage ?? '').toContain('dQw4w9WgXcQ');
    // No native `<video>` and no iframe yet — iframe activation requires
    // a user gesture (the perf + autoplay + Referer-allowlist payoff).
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  test('clicking the play button mounts the iframe with the expected attributes', () => {
    const { container } = render(<Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />);
    const playBtn = container.querySelector('button[type="button"]');
    expect(playBtn).not.toBeNull();
    fireEvent.click(playBtn as HTMLButtonElement);

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src') ?? '').toContain('/embed/dQw4w9WgXcQ');
    // Lib defaults: `strict-origin-when-cross-origin` (permissive enough
    // for YouTube's embed allowlist, doesn't leak the editor URL path)
    // and `autoplay` in `allow` (so the post-gesture iframe can satisfy
    // the browser's autoplay permission policy).
    expect(iframe?.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(iframe?.getAttribute('allow') ?? '').toContain('autoplay');
    expect(iframe?.hasAttribute('allowfullscreen')).toBe(true);
  });

  test('routes regular youtube.com paste to the standard host', () => {
    const { container } = render(<Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />);
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);
    expect(container.querySelector('iframe')?.getAttribute('src') ?? '').toContain(
      'www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  test('preserves the privacy host when input uses youtube-nocookie.com', () => {
    const { container } = render(
      <Video src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" />,
    );
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);
    expect(container.querySelector('iframe')?.getAttribute('src') ?? '').toContain(
      'www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  test('threads ?t=<seconds> into the iframe as ?start=', () => {
    const { container } = render(<Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42" />);
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);
    const src = container.querySelector('iframe')?.getAttribute('src') ?? '';
    expect(src).toContain('start=42');
  });

  test('falls back to <video> for malformed YouTube-like URLs', () => {
    // Short ID (<11 chars) doesn't match the YouTube grammar — parser
    // returns null and we drop back to the HTML5 path. The `<video>`
    // element then quietly fails to load, which is no worse than today.
    const { container } = render(<Video src="https://youtu.be/short" />);
    expect(container.querySelector('.yt-lite')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('video')).not.toBeNull();
  });

  test('uses a default title on the lite-embed wrapper when none is provided', () => {
    const { container } = render(<Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />);
    const wrapper = container.querySelector('.yt-lite') as HTMLElement | null;
    expect(wrapper?.getAttribute('data-title')).toBe('YouTube video player');
  });

  test('passes through a custom title to the lite-embed wrapper', () => {
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" title="Demo recording" />,
    );
    const wrapper = container.querySelector('.yt-lite') as HTMLElement | null;
    expect(wrapper?.getAttribute('data-title')).toBe('Demo recording');
  });

  test('controls={false} routes to controls=0 on the post-activation iframe', () => {
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" controls={false} />,
    );
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);
    expect(container.querySelector('iframe')?.getAttribute('src') ?? '').toContain('controls=0');
  });

  test('loop maps to loop=1&playlist=<id> (YouTube single-video loop convention)', () => {
    const { container } = render(<Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" loop />);
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);
    const src = container.querySelector('iframe')?.getAttribute('src') ?? '';
    expect(src).toContain('loop=1');
    expect(src).toContain('playlist=dQw4w9WgXcQ');
  });

  test('playsinline maps to playsinline=1', () => {
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" playsinline />,
    );
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);
    expect(container.querySelector('iframe')?.getAttribute('src') ?? '').toContain('playsinline=1');
  });

  test('muted adds mute=1 to the iframe URL', () => {
    const { container } = render(<Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" muted />);
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);
    expect(container.querySelector('iframe')?.getAttribute('src') ?? '').toContain('mute=1');
  });

  test('autoplay + muted mounts the iframe eagerly (skips the click facade)', () => {
    // `alwaysLoadIframe` engages only when `autoplay && muted` so the
    // lib actually emits `autoplay=1` in the URL (its internal rule,
    // matching the browser's autoplay policy). Iframe is in the DOM at
    // mount, no click required.
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" autoplay muted />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const src = iframe?.getAttribute('src') ?? '';
    expect(src).toContain('autoplay=1');
    expect(src).toContain('mute=1');
  });

  test('autoplay without muted falls back to the click facade', () => {
    // Eager-mounting an iframe that then refuses to autoplay (because
    // browser policy blocks unmuted autoplay) is the worst-of-both
    // worlds — YouTube player loads but doesn't start, no clear cue
    // why. Falling back to the thumbnail-then-click flow makes the
    // first user gesture the autoplay trigger.
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" autoplay />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.yt-lite')).not.toBeNull();
  });

  test('width + height also forward aspectWidth / aspectHeight to the lib', () => {
    // Defensive companion to the inline `style.aspectRatio` (which
    // overrides the lib's hardcoded `.yt-lite { aspect-ratio: 16/9 }`
    // in modern browsers). `aspectWidth` / `aspectHeight` power the
    // `padding-bottom` fallback for browsers without `aspect-ratio`
    // support, so the wrapper still has the right shape pre-paint.
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" width={400} height={300} />,
    );
    const article = container.querySelector('.yt-lite') as HTMLElement | null;
    // Lib sets `--aspect-ratio: <h>/<w>*100%` on the article style.
    expect(article?.style.getPropertyValue('--aspect-ratio')).toBe('75%');
  });

  test('width + height set inline aspect-ratio on the lite-embed', () => {
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" width={400} height={300} />,
    );
    const wrapper = container.querySelector('.ok-video-youtube') as HTMLElement | null;
    expect(wrapper?.style.width).toBe('400px');
    const article = container.querySelector('.yt-lite') as HTMLElement | null;
    // Lib spreads its caller's `style` after its own defaults, so our
    // `aspectRatio` lands on the inline style of the wrapping <article>.
    expect(article?.style.aspectRatio).toBe('400 / 300');
  });

  test('width alone keeps the lib default 16/9 aspect ratio', () => {
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" width={400} />,
    );
    const wrapper = container.querySelector('.ok-video-youtube') as HTMLElement | null;
    expect(wrapper?.style.width).toBe('400px');
    const article = container.querySelector('.yt-lite') as HTMLElement | null;
    // No inline aspectRatio when height is unset — the lib's CSS rule
    // (aspect-ratio: 16/9) wins.
    expect(article?.style.aspectRatio).toBe('');
  });

  test('poster overrides the YouTube thumbnail in the wrapper background', () => {
    const customPoster = '/assets/custom-thumb.jpg';
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" poster={customPoster} />,
    );
    const wrapper = container.querySelector('.yt-lite') as HTMLElement | null;
    expect(wrapper?.style.backgroundImage ?? '').toContain('custom-thumb.jpg');
    expect(wrapper?.style.backgroundImage ?? '').not.toContain('i.ytimg.com');
  });
});

describe('Video — Vimeo dispatch', () => {
  afterEach(() => {
    cleanup();
  });

  test.each([
    'https://vimeo.com/76979871',
    'https://www.vimeo.com/76979871',
    'https://player.vimeo.com/video/76979871',
    // Unlisted-hash, channels, groups, showcase shapes — the lib parses
    // every one of these; we only need to confirm dispatch routes to
    // Vimeo (not YouTube, not HTML5 <video>).
    'https://vimeo.com/76979871/abc123def4',
    'https://vimeo.com/channels/staffpicks/76979871',
    'https://vimeo.com/groups/motion/videos/76979871',
  ])('routes %s to the Vimeo wrapper (no native <video>, no YouTube facade)', (src) => {
    const { container } = render(<Video src={src} />);
    expect(container.querySelector('.ok-video-vimeo')).not.toBeNull();
    expect(container.querySelector('.yt-lite')).toBeNull();
    // `Video.tsx` only emits a `<video>` element on the HTML5 fallback
    // branch — Vimeo dispatch keeps the DOM clean for the lib's iframe.
    expect(container.querySelector('video')).toBeNull();
  });

  test('passes the source URL straight through to the lib `video` prop', () => {
    // No ID extraction on our side — the lib accepts URL or numeric ID,
    // and we hand off the full URL untouched. The mock records the prop
    // onto `data-video` so the dispatch contract is observable without
    // coupling to the lib's internal URL composition / iframe creation.
    const { container } = render(<Video src="https://vimeo.com/76979871/abc123def4" />);
    const stub = container.querySelector('[data-testid="vimeo-mock"]') as HTMLElement | null;
    expect(stub?.getAttribute('data-video')).toBe('https://vimeo.com/76979871/abc123def4');
  });

  test('sets a default accessible iframe title when no title prop is supplied', () => {
    // Parity with the YouTube branch (`title ?? 'YouTube video player'`).
    // The lib's `title` prop is overloaded (controls in-player UI), so we
    // can't pass it via props; we wire `onReady` and set
    // `player.element.title` imperatively. Mock simulates the lifecycle
    // and reports `data-onready` so the test can pin both the default
    // fallback string AND the wiring contract.
    const { container } = render(<Video src="https://vimeo.com/76979871" />);
    const stub = container.querySelector('[data-testid="vimeo-mock"]') as HTMLElement | null;
    expect(stub?.getAttribute('data-onready')).toBe('true');
    const iframe = container.querySelector(
      '[data-testid="vimeo-mock-iframe"]',
    ) as HTMLIFrameElement | null;
    expect(iframe?.title).toBe('Vimeo video player');
  });

  test('threads custom title to the iframe (overrides default fallback)', () => {
    const { container } = render(<Video src="https://vimeo.com/76979871" title="Walkthrough" />);
    const iframe = container.querySelector(
      '[data-testid="vimeo-mock-iframe"]',
    ) as HTMLIFrameElement | null;
    expect(iframe?.title).toBe('Walkthrough');
    // Sanity: wrapper title still mirrors the prop for sighted-user tooltip.
    const wrapper = container.querySelector('.ok-video-vimeo') as HTMLElement | null;
    expect(wrapper?.getAttribute('title')).toBe('Walkthrough');
  });

  test('updates iframe title when title prop changes after mount (useEffect sync path)', () => {
    // Two-phase parity: first mount runs through `onReady`/`handleReady`,
    // post-mount edits run through the `useEffect([effectiveTitle])` in
    // VimeoEmbed. The custom-title test above only exercises the onReady
    // path; this one rerenders with a fresh title to pin the effect.
    const { rerender, container } = render(
      <Video src="https://vimeo.com/76979871" title="First" />,
    );
    const iframe = container.querySelector(
      '[data-testid="vimeo-mock-iframe"]',
    ) as HTMLIFrameElement | null;
    expect(iframe?.title).toBe('First');
    rerender(<Video src="https://vimeo.com/76979871" title="Updated" />);
    expect(iframe?.title).toBe('Updated');
  });

  test('Vimeo defaults: controls=true and playsInline=true when props unset', () => {
    // VimeoEmbed uses `!== false` polarity for both props (different
    // shape from some of the YouTube branch's `=== true` patterns).
    // Pin the unset → true default so a future polarity flip breaks
    // here loudly instead of silently disabling controls / inline
    // playback on iOS Safari for every Vimeo block.
    const { container } = render(<Video src="https://vimeo.com/76979871" />);
    const stub = container.querySelector('[data-testid="vimeo-mock"]') as HTMLElement | null;
    expect(stub?.getAttribute('data-controls')).toBe('true');
    expect(stub?.getAttribute('data-playsinline')).toBe('true');
  });

  test('forwards descriptor props (autoplay / muted / loop / controls / playsinline) to the lib', () => {
    const { container } = render(
      <Video
        src="https://vimeo.com/76979871"
        autoplay
        muted
        loop
        controls={false}
        playsinline={false}
      />,
    );
    const stub = container.querySelector('[data-testid="vimeo-mock"]') as HTMLElement | null;
    expect(stub?.getAttribute('data-autoplay')).toBe('true');
    expect(stub?.getAttribute('data-muted')).toBe('true');
    expect(stub?.getAttribute('data-loop')).toBe('true');
    expect(stub?.getAttribute('data-controls')).toBe('false');
    expect(stub?.getAttribute('data-playsinline')).toBe('false');
  });

  test('mirrors `muted` into the reactive `volume` prop (0 when muted, 1 otherwise)', () => {
    // The lib's `muted` prop is init-only — flipping it post-mount has
    // no effect on the live player. Tracking the same boolean through
    // the reactive `volume` prop is what makes the PropPanel toggle
    // actually mute/unmute a playing video. Pin both directions.
    const muted = render(<Video src="https://vimeo.com/76979871" muted />);
    expect(
      muted.container.querySelector('[data-testid="vimeo-mock"]')?.getAttribute('data-volume'),
    ).toBe('0');
    cleanup();

    const unmuted = render(<Video src="https://vimeo.com/76979871" />);
    expect(
      unmuted.container.querySelector('[data-testid="vimeo-mock"]')?.getAttribute('data-volume'),
    ).toBe('1');
  });

  test('volume tracks muted reactively on rerender (the whole reason the prop exists)', () => {
    // The pass-through test above renders two instances and asserts each
    // — that covers initial prop computation but not the reactive
    // re-render. `muted` is init-only in the lib; `volume` is the
    // reactive sibling we forward to keep post-mount toggles honest.
    // Pin the rerender path so a future regression that drops the
    // reactive mirror breaks here loudly.
    const { rerender, container } = render(<Video src="https://vimeo.com/76979871" />);
    const stub = container.querySelector('[data-testid="vimeo-mock"]') as HTMLElement | null;
    expect(stub?.getAttribute('data-volume')).toBe('1');
    rerender(<Video src="https://vimeo.com/76979871" muted />);
    expect(stub?.getAttribute('data-volume')).toBe('0');
    rerender(<Video src="https://vimeo.com/76979871" />);
    expect(stub?.getAttribute('data-volume')).toBe('1');
  });

  test('responsive mode tracks the wrapper width — on by default, off when width set', () => {
    // When the author doesn't pin a width, the wrapper falls back to the
    // CSS default 720px and the lib's responsive mode keeps the iframe
    // sized to it. An explicit width opts back into the lib's fixed-size
    // path so the iframe matches author intent precisely.
    const noWidth = render(<Video src="https://vimeo.com/76979871" />);
    expect(
      noWidth.container
        .querySelector('[data-testid="vimeo-mock"]')
        ?.getAttribute('data-responsive'),
    ).toBe('true');
    cleanup();

    const withWidth = render(<Video src="https://vimeo.com/76979871" width={400} height={225} />);
    const stub = withWidth.container.querySelector(
      '[data-testid="vimeo-mock"]',
    ) as HTMLElement | null;
    expect(stub?.getAttribute('data-responsive')).toBe('false');
    expect(stub?.getAttribute('data-width')).toBe('400');
    expect(stub?.getAttribute('data-height')).toBe('225');
  });

  test('explicit width sets the wrapper inline style (overrides CSS default 720px)', () => {
    const { container } = render(<Video src="https://vimeo.com/76979871" width={400} />);
    const wrapper = container.querySelector('.ok-video-vimeo') as HTMLElement | null;
    expect(wrapper?.style.width).toBe('400px');
  });

  test('no width omits the inline style so the CSS default applies', () => {
    const { container } = render(<Video src="https://vimeo.com/76979871" />);
    const wrapper = container.querySelector('.ok-video-vimeo') as HTMLElement | null;
    expect(wrapper?.style.width).toBe('');
  });

  test('threads `title` to the wrapper for native tooltip parity', () => {
    const { container } = render(<Video src="https://vimeo.com/76979871" title="Walkthrough" />);
    const wrapper = container.querySelector('.ok-video-vimeo') as HTMLElement | null;
    expect(wrapper?.getAttribute('title')).toBe('Walkthrough');
  });

  test('Vimeo wins over the HTML5 path; YouTube URLs still route to YouTube', () => {
    // Sibling guard against a regression where a future check reorders
    // the dispatch chain and silently steals YouTube → Vimeo (or vice
    // versa). Both checks share a single-pass-through render.
    const yt = render(<Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />);
    expect(yt.container.querySelector('.yt-lite')).not.toBeNull();
    expect(yt.container.querySelector('.ok-video-vimeo')).toBeNull();
    cleanup();

    const vimeo = render(<Video src="https://vimeo.com/76979871" />);
    expect(vimeo.container.querySelector('.ok-video-vimeo')).not.toBeNull();
    expect(vimeo.container.querySelector('.yt-lite')).toBeNull();
  });
});

describe('Video — Loom dispatch', () => {
  afterEach(() => {
    cleanup();
  });

  test.each([
    'https://www.loom.com/share/abc123def456ghi789jk',
    'https://loom.com/share/abc123def456ghi789jk',
    'https://www.loom.com/embed/abc123def456ghi789jk',
    'https://loom.com/embed/abc123def456ghi789jk',
  ])('routes %s to the Loom wrapper (no native <video>, no YouTube facade)', (src) => {
    const { container } = render(<Video src={src} />);
    expect(container.querySelector('.ok-video-loom')).not.toBeNull();
    expect(container.querySelector('.yt-lite')).toBeNull();
    expect(container.querySelector('.ok-video-vimeo')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  test('renders an iframe pointing at the canonical /embed/<id> URL (share → embed conversion)', () => {
    const { container } = render(<Video src="https://www.loom.com/share/abc123def456ghi789jk" />);
    const iframe = container.querySelector('.ok-video-loom iframe') as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe('https://www.loom.com/embed/abc123def456ghi789jk');
  });

  test('pins `referrerPolicy` + `allow` attributes on the Loom iframe (security contract)', () => {
    // YouTube branch's lib defaults to `strict-origin-when-cross-origin`
    // and that policy is explicitly asserted in the YouTube dispatch
    // test. The Loom iframe's policy + allow attrs are pinned here so a
    // future silent regression (e.g. dropping the policy back to the
    // browser default, or reverting to `no-referrer` as YouTube once did)
    // breaks loudly.
    const { container } = render(<Video src="https://www.loom.com/share/abc123def456ghi789jk" />);
    const iframe = container.querySelector('.ok-video-loom iframe') as HTMLIFrameElement | null;
    expect(iframe?.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(iframe?.getAttribute('allow') ?? '').toContain('autoplay');
    expect(iframe?.getAttribute('allow') ?? '').toContain('fullscreen');
    expect(iframe?.hasAttribute('allowfullscreen')).toBe(true);
  });

  test('preserves the `?t=` timestamp verbatim in the embed URL', () => {
    const { container } = render(
      <Video src="https://www.loom.com/share/abc123def456ghi789jk?t=2m30s" />,
    );
    const iframe = container.querySelector('.ok-video-loom iframe') as HTMLIFrameElement | null;
    expect(iframe?.getAttribute('src')).toContain('t=2m30s');
  });

  test('threads autoplay + muted into the iframe URL as query params', () => {
    const { container } = render(
      <Video src="https://www.loom.com/share/abc123def456ghi789jk" autoplay muted />,
    );
    const iframe = container.querySelector('.ok-video-loom iframe') as HTMLIFrameElement | null;
    const src = iframe?.getAttribute('src') ?? '';
    expect(src).toContain('autoplay=true');
    expect(src).toContain('muted=true');
  });

  test('threads autoplay alone (without muted) into the iframe URL', () => {
    // The lib pushes `autoplay=true` and `muted=true` as independent
    // `if` branches. Pin each in isolation so a future refactor that
    // accidentally couples them (e.g., copying YouTube's
    // `autoplay && muted` eager-iframe guard into Loom's param logic)
    // breaks loudly here.
    const { container } = render(
      <Video src="https://www.loom.com/share/abc123def456ghi789jk" autoplay />,
    );
    const src = container.querySelector('.ok-video-loom iframe')?.getAttribute('src') ?? '';
    expect(src).toContain('autoplay=true');
    expect(src).not.toContain('muted=true');
  });

  test('threads muted alone (without autoplay) into the iframe URL', () => {
    const { container } = render(
      <Video src="https://www.loom.com/share/abc123def456ghi789jk" muted />,
    );
    const src = container.querySelector('.ok-video-loom iframe')?.getAttribute('src') ?? '';
    expect(src).toContain('muted=true');
    expect(src).not.toContain('autoplay=true');
  });

  test('omits autoplay/muted params when props are unset (default URL stays clean)', () => {
    const { container } = render(<Video src="https://www.loom.com/share/abc123def456ghi789jk" />);
    const iframe = container.querySelector('.ok-video-loom iframe') as HTMLIFrameElement | null;
    const src = iframe?.getAttribute('src') ?? '';
    expect(src).not.toContain('autoplay');
    expect(src).not.toContain('muted');
  });

  test('sets a default accessible iframe title when no title prop is supplied', () => {
    // Parity with YouTube + Vimeo branches — every dispatch path gives
    // screen-reader users a meaningful accessible name on the iframe.
    const { container } = render(<Video src="https://www.loom.com/share/abc123def456ghi789jk" />);
    const iframe = container.querySelector('.ok-video-loom iframe') as HTMLIFrameElement | null;
    expect(iframe?.getAttribute('title')).toBe('Loom video player');
  });

  test('threads custom title to the iframe (overrides default fallback)', () => {
    const { container } = render(
      <Video
        src="https://www.loom.com/share/abc123def456ghi789jk"
        title="Engineering Walkthrough"
      />,
    );
    const iframe = container.querySelector('.ok-video-loom iframe') as HTMLIFrameElement | null;
    expect(iframe?.getAttribute('title')).toBe('Engineering Walkthrough');
    // Sanity: wrapper title still mirrors the prop for sighted-user tooltip.
    const wrapper = container.querySelector('.ok-video-loom') as HTMLElement | null;
    expect(wrapper?.getAttribute('title')).toBe('Engineering Walkthrough');
  });

  test('explicit width sets the wrapper inline style (overrides CSS default 720px)', () => {
    const { container } = render(
      <Video src="https://www.loom.com/share/abc123def456ghi789jk" width={400} />,
    );
    const wrapper = container.querySelector('.ok-video-loom') as HTMLElement | null;
    expect(wrapper?.style.width).toBe('400px');
  });

  test('Loom wins over HTML5 path; YouTube + Vimeo URLs still route to their dispatchers', () => {
    // Triple guard against a future dispatch reorder silently stealing
    // a recognized provider's URL into the wrong branch.
    const yt = render(<Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />);
    expect(yt.container.querySelector('.yt-lite')).not.toBeNull();
    expect(yt.container.querySelector('.ok-video-loom')).toBeNull();
    cleanup();

    const vimeo = render(<Video src="https://vimeo.com/22439234" />);
    expect(vimeo.container.querySelector('.ok-video-vimeo')).not.toBeNull();
    expect(vimeo.container.querySelector('.ok-video-loom')).toBeNull();
    cleanup();

    const loom = render(<Video src="https://www.loom.com/share/abc123def456ghi789jk" />);
    expect(loom.container.querySelector('.ok-video-loom')).not.toBeNull();
    expect(loom.container.querySelector('.yt-lite')).toBeNull();
    expect(loom.container.querySelector('.ok-video-vimeo')).toBeNull();
  });

  test('falls back to native <video> for malformed Loom-like URLs (too-short id)', () => {
    // \`parseLoomUrl\` rejects IDs under 20 chars; renderer drops to HTML5.
    // The element then 404s (no Content-Type for a 'short' URL), which is
    // no worse than today — and avoids a broken iframe.
    const { container } = render(<Video src="https://www.loom.com/share/short" />);
    expect(container.querySelector('.ok-video-loom')).toBeNull();
    expect(container.querySelector('video')).not.toBeNull();
  });
});
