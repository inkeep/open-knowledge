import { matchAssetUrl, toDesktopAssetHref } from '@inkeep/open-knowledge-core/utils/asset-href';
import { extensionOf } from '@inkeep/open-knowledge-core/utils/extension';
import { FileUp } from 'lucide-react';
import { dispatchAssetClick } from '@/editor/asset-dispatch';

interface FileProps {
  src?: string;
  name?: string;
  size?: string;
  title?: string;
}

export function basenameFromUrl(src: string | undefined): string {
  if (!src) return '';
  let pathname: string;
  let protocol: string | null = null;
  try {
    const url = new URL(src, 'https://placeholder.local');
    protocol = url.protocol;
    pathname = url.pathname;
  } catch {
    const before = src.split('?')[0] ?? src;
    pathname = before;
  }
  if (protocol === 'data:' || protocol === 'blob:') return '';
  const segments = pathname.split('/');
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function projectFileRelPath(href: string): string | null {
  const desktop = window.okDesktop;
  return desktop ? matchAssetUrl(href, desktop.config.apiOrigin) : null;
}

function openProjectFile(href: string, relPath: string, title: string): void {
  void dispatchAssetClick({
    url: href,
    projectRelPath: relPath,
    ext: extensionOf(relPath),
    title,
    forceOsDelegation: true,
  });
}

export function File(props: FileProps) {
  const displayName = props.name?.trim() || basenameFromUrl(props.src) || 'Untitled file';
  const sizeText = props.size?.trim() ? props.size : null;
  const href = props.src ? toDesktopAssetHref(props.src) : undefined;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!href) return;
    const relPath = projectFileRelPath(href);
    if (relPath !== null) {
      openProjectFile(href, relPath, displayName);
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  const handleAuxClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 1 || !href) return;
    const relPath = projectFileRelPath(href);
    if (relPath === null) return;
    e.stopPropagation();
    e.preventDefault();
    openProjectFile(href, relPath, displayName);
  };

  return (
    <a
      href={href}
      title={props.title}
      className="ok-file-attachment"
      target="_blank"
      rel="noopener noreferrer"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
    >
      <FileUp className="ok-file-icon" aria-hidden="true" />
      <span className="ok-file-name">{displayName}</span>
      {sizeText ? <span className="ok-file-size">{sizeText}</span> : null}
    </a>
  );
}
