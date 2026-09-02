import { BareImg } from '../components/Image';

export interface WikiLinkEmbedImageViewProps {
  src: string;
  alt: string;
}

export function WikiLinkEmbedImageView({ src, alt }: WikiLinkEmbedImageViewProps) {
  return <BareImg src={src} alt={alt} />;
}
