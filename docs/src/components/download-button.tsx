import { DownloadSplitButton } from '@/components/download-split-button';
import type { DownloadCta } from '@/lib/site';

type DownloadButtonProps = {
  cta?: DownloadCta;
};

export function DownloadButton({ cta = 'docs-content' }: DownloadButtonProps) {
  return <DownloadSplitButton cta={cta} className="my-4" />;
}
