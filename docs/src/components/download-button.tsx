import { DownloadSplitButton } from '@/components/download-split-button';
import type { DownloadCta } from '@/lib/site';

type DownloadButtonProps = {
  /** CTA slug reported as `utm_content` on `dmg_downloaded`. */
  cta?: DownloadCta;
};

/**
 * The in-content download CTA, available to MDX as `<DownloadButton />`.
 *
 * A thin alias for {@link DownloadSplitButton} so docs pages keep a stable,
 * prop-free element while the platform detection and the build list live in
 * one place. The old `label` / `href` props are gone deliberately: the label is
 * now derived from the visitor's OS, and a hand-written href would bypass both
 * the picker and the tracked redirect.
 */
export function DownloadButton({ cta = 'docs-content' }: DownloadButtonProps) {
  return <DownloadSplitButton cta={cta} className="my-4" />;
}
