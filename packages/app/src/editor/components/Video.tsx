
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
  title?: string;
  muted?: boolean;
  loop?: boolean;
  playsinline?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
}

function resolveControls(controls: boolean | undefined): boolean {
  return controls !== false;
}

function buildYouTubeParams(props: VideoProps, yt: ParsedYouTubeUrl): string | undefined {
  const parts: string[] = [];
  if (yt.startSeconds !== null) parts.push(`start=${yt.startSeconds}`);
  if (props.controls === false) parts.push('controls=0');
  if (props.loop === true) parts.push('loop=1', `playlist=${yt.id}`);
  if (props.playsinline === true) parts.push('playsinline=1');
  return parts.length > 0 ? parts.join('&') : undefined;
}

function buildVideoWrapperStyle(props: VideoProps): CSSProperties | undefined {
  if (props.width === undefined) return undefined;
  return { width: props.width };
}

function buildYouTubeLiteStyle(props: VideoProps): CSSProperties | undefined {
  if (props.width === undefined || props.height === undefined) return undefined;
  return { aspectRatio: `${props.width} / ${props.height}` };
}

interface VimeoPlayerWithElement {
  element: HTMLIFrameElement | null;
}

function VimeoEmbed(props: VideoProps & { src: string }) {
  const playerRef = useRef<VimeoPlayerWithElement | null>(null);
  const fallbackTitle = 'Vimeo video player';
  const effectiveTitle = props.title ?? fallbackTitle;

  const handleReady = (player: unknown) => {
    const p = player as VimeoPlayerWithElement;
    playerRef.current = p;
    if (p.element) {
      p.element.title = effectiveTitle;
    }
  };

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
        volume={props.muted === true ? 0 : 1}
        loop={props.loop === true}
        controls={props.controls !== false}
        playsInline={props.playsinline !== false}
        onReady={handleReady}
      />
    </div>
  );
}

function LoomEmbed(props: VideoProps & { src: string }) {
  const parsed = parseLoomUrl(props.src);
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
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    </div>
  );
}

export function Video(props: VideoProps) {
  if (props.src !== undefined && isLoomUrl(props.src)) {
    return <LoomEmbed {...props} src={props.src} />;
  }
  if (props.src !== undefined && isVimeoUrl(props.src)) {
    return <VimeoEmbed {...props} src={props.src} />;
  }
  const yt = props.src !== undefined ? parseYouTubeUrl(props.src) : null;
  if (yt !== null) {
    const eagerIframe = props.autoplay === true && props.muted === true;
    const explicitWidth = props.width !== undefined;
    const explicitAspect = explicitWidth && props.height !== undefined;
    return (
      <div className="ok-video ok-video-youtube" style={buildVideoWrapperStyle(props)}>
        <LiteYouTubeEmbed
          id={yt.id}
          title={props.title ?? 'YouTube video player'}
          cookie={!yt.noCookie}
          params={buildYouTubeParams(props, yt)}
          muted={props.muted === true}
          autoplay={props.autoplay === true}
          alwaysLoadIframe={eagerIframe}
          thumbnail={props.poster !== undefined ? toDesktopAssetHref(props.poster) : undefined}
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
