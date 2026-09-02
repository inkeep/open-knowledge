import { toDesktopAssetHref } from '@inkeep/open-knowledge-core';

interface AudioProps {
  src?: string;
  controls?: boolean;
  autoplay?: boolean;
  title?: string;
  muted?: boolean;
  loop?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
}

function resolveControls(controls: boolean | undefined): boolean {
  return controls !== false;
}

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
