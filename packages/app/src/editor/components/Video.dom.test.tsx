/**
 * RTL behavioral tests for the `Video` canonical's dispatch contract.
 * Pins the three render branches: native `<video>` for file-served media,
 * `<LiteYouTubeEmbed>` (thumbnail-first facade — iframe mounts on click)
 * for recognized YouTube URLs, and `@u-wave/react-vimeo` (eager iframe via
 * Vimeo's Player SDK) for recognized Vimeo URLs.
 *
 * Runs under `bun run test:dom` (jsdom substrate per precedent #43).
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@u-wave/react-vimeo', () => {
  type MockProps = Record<string, unknown> & {
    onReady?: (player: { element: HTMLIFrameElement | null }) => void;
  };
  return {
    __esModule: true,
    default: (props: MockProps) => {
      const iframeRef = useRef<HTMLIFrameElement | null>(null);
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
    'https://www.youtube.com/v/dQw4w9WgXcQ',
  ])('renders a lite-embed wrapper for %s with the parsed ID in the thumbnail', (src) => {
    const { container } = render(<Video src={src} />);
    const wrapper = container.querySelector('.yt-lite') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.backgroundImage ?? '').toContain('dQw4w9WgXcQ');
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
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" autoplay />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.yt-lite')).not.toBeNull();
  });

  test('width + height also forward aspectWidth / aspectHeight to the lib', () => {
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" width={400} height={300} />,
    );
    const article = container.querySelector('.yt-lite') as HTMLElement | null;
    expect(article?.style.getPropertyValue('--aspect-ratio')).toBe('75%');
  });

  test('width + height set inline aspect-ratio on the lite-embed', () => {
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" width={400} height={300} />,
    );
    const wrapper = container.querySelector('.ok-video-youtube') as HTMLElement | null;
    expect(wrapper?.style.width).toBe('400px');
    const article = container.querySelector('.yt-lite') as HTMLElement | null;
    expect(article?.style.aspectRatio).toBe('400 / 300');
  });

  test('width alone keeps the lib default 16/9 aspect ratio', () => {
    const { container } = render(
      <Video src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" width={400} />,
    );
    const wrapper = container.querySelector('.ok-video-youtube') as HTMLElement | null;
    expect(wrapper?.style.width).toBe('400px');
    const article = container.querySelector('.yt-lite') as HTMLElement | null;
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
    'https://vimeo.com/76979871/abc123def4',
    'https://vimeo.com/channels/staffpicks/76979871',
    'https://vimeo.com/groups/motion/videos/76979871',
  ])('routes %s to the Vimeo wrapper (no native <video>, no YouTube facade)', (src) => {
    const { container } = render(<Video src={src} />);
    expect(container.querySelector('.ok-video-vimeo')).not.toBeNull();
    expect(container.querySelector('.yt-lite')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  test('passes the source URL straight through to the lib `video` prop', () => {
    const { container } = render(<Video src="https://vimeo.com/76979871/abc123def4" />);
    const stub = container.querySelector('[data-testid="vimeo-mock"]') as HTMLElement | null;
    expect(stub?.getAttribute('data-video')).toBe('https://vimeo.com/76979871/abc123def4');
  });

  test('sets a default accessible iframe title when no title prop is supplied', () => {
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
    const wrapper = container.querySelector('.ok-video-vimeo') as HTMLElement | null;
    expect(wrapper?.getAttribute('title')).toBe('Walkthrough');
  });

  test('updates iframe title when title prop changes after mount (useEffect sync path)', () => {
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
    const { rerender, container } = render(<Video src="https://vimeo.com/76979871" />);
    const stub = container.querySelector('[data-testid="vimeo-mock"]') as HTMLElement | null;
    expect(stub?.getAttribute('data-volume')).toBe('1');
    rerender(<Video src="https://vimeo.com/76979871" muted />);
    expect(stub?.getAttribute('data-volume')).toBe('0');
    rerender(<Video src="https://vimeo.com/76979871" />);
    expect(stub?.getAttribute('data-volume')).toBe('1');
  });

  test('responsive mode tracks the wrapper width — on by default, off when width set', () => {
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
    const { container } = render(<Video src="https://www.loom.com/share/short" />);
    expect(container.querySelector('.ok-video-loom')).toBeNull();
    expect(container.querySelector('video')).not.toBeNull();
  });
});
