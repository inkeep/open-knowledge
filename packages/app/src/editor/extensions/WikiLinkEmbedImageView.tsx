import { BareImg } from '../components/Image';

export interface WikiLinkEmbedImageViewProps {
  src: string;
  alt: string;
}

/** Shared image leaf for the transient, drop-time wiki-embed NodeView. */
export function WikiLinkEmbedImageView({ src, alt }: WikiLinkEmbedImageViewProps) {
  return <BareImg src={src} alt={alt} />;
}
