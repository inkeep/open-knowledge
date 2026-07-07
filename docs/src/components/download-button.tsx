import { DownloadIcon } from 'lucide-react';
import { DOWNLOAD_ROUTE } from '@/lib/site';

type DownloadButtonProps = {
  /** Defaults to the tracked stable-download route (fires `dmg_downloaded`). */
  href?: string;
  label?: string;
};

export function DownloadButton({
  href = DOWNLOAD_ROUTE,
  label = 'DOWNLOAD FOR MAC',
}: DownloadButtonProps) {
  // Raw <a>, not next/link: the download route is a 302 redirect handler, so
  // next/link would prefetch it (firing the redirect) and double-fetch on click.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="not-prose my-4 inline-flex items-center gap-2 rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 dark:bg-neutral-100 dark:text-neutral-900"
    >
      {label}
      <DownloadIcon className="size-4" aria-hidden="true" />
    </a>
  );
}
