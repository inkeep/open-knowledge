// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { mediaKindForSidebarAssetExtension } from '@inkeep/open-knowledge-core';
import { File, Film, FolderOpen, ImageIcon, Volume2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { getFileExtension } from '@/components/file-tree-rename-validation';
import { lucideIconToSvgString } from '@/editor/registry/lucide-svg';
import { cn } from '@/lib/utils.ts';

export const MARKDOWN_FILE_ICON_VIEWBOX = '0 0 32 32';
export const MARKDOWN_FILE_ICON_PATH_D =
  'M26.7075 10.2925L19.7075 3.2925C19.6146 3.19967 19.5042 3.12605 19.3829 3.07586C19.2615 3.02568 19.1314 2.9999 19 3H7C6.46957 3 5.96086 3.21071 5.58579 3.58579C5.21071 3.96086 5 4.46957 5 5V14C5 14.2652 5.10536 14.5196 5.29289 14.7071C5.48043 14.8946 5.73478 15 6 15C6.26522 15 6.51957 14.8946 6.70711 14.7071C6.89464 14.5196 7 14.2652 7 14V5H18V11C18 11.2652 18.1054 11.5196 18.2929 11.7071C18.4804 11.8946 18.7348 12 19 12H25V28C25 28.2652 25.1054 28.5196 25.2929 28.7071C25.4804 28.8946 25.7348 29 26 29C26.2652 29 26.5196 28.8946 26.7071 28.7071C26.8946 28.5196 27 28.2652 27 28V11C27.0001 10.8686 26.9743 10.7385 26.9241 10.6172C26.8739 10.4958 26.8003 10.3854 26.7075 10.2925ZM20 6.41375L23.5863 10H20V6.41375ZM18 18H16C15.7348 18 15.4804 18.1054 15.2929 18.2929C15.1054 18.4804 15 18.7348 15 19V26C15 26.2652 15.1054 26.5196 15.2929 26.7071C15.4804 26.8946 15.7348 27 16 27H18C19.1935 27 20.3381 26.5259 21.182 25.682C22.0259 24.8381 22.5 23.6935 22.5 22.5C22.5 21.3065 22.0259 20.1619 21.182 19.318C20.3381 18.4741 19.1935 18 18 18ZM18 25H17V20H18C18.663 20 19.2989 20.2634 19.7678 20.7322C20.2366 21.2011 20.5 21.837 20.5 22.5C20.5 23.163 20.2366 23.7989 19.7678 24.2678C19.2989 24.7366 18.663 25 18 25ZM13 19V26C13 26.2652 12.8946 26.5196 12.7071 26.7071C12.5196 26.8946 12.2652 27 12 27C11.7348 27 11.4804 26.8946 11.2929 26.7071C11.1054 26.5196 11 26.2652 11 26V22.1725L9.31875 24.5737C9.22652 24.7053 9.10396 24.8126 8.96144 24.8868C8.81892 24.9609 8.66064 24.9996 8.5 24.9996C8.33936 24.9996 8.18108 24.9609 8.03856 24.8868C7.89604 24.8126 7.77348 24.7053 7.68125 24.5737L6 22.1725V26C6 26.2652 5.89464 26.5196 5.70711 26.7071C5.51957 26.8946 5.26522 27 5 27C4.73478 27 4.48043 26.8946 4.29289 26.7071C4.10536 26.5196 4 26.2652 4 26V19C4.00009 18.7874 4.06791 18.5804 4.19363 18.409C4.31935 18.2376 4.49642 18.1107 4.69915 18.0467C4.90188 17.9828 5.11971 17.9851 5.32104 18.0533C5.52236 18.1216 5.6967 18.2522 5.81875 18.4263L8.5 22.2563L11.1812 18.4263C11.3033 18.2522 11.4776 18.1216 11.679 18.0533C11.8803 17.9851 12.0981 17.9828 12.3008 18.0467C12.5036 18.1107 12.6807 18.2376 12.8064 18.409C12.9321 18.5804 12.9999 18.7874 13 19Z';

function isMarkdownExt(ext: string): boolean {
  return ext === '.md' || ext === '.mdx';
}

function iconSvgForExt(ext: string): string {
  switch (mediaKindForSidebarAssetExtension(ext)) {
    case 'image':
      return lucideIconToSvgString(ImageIcon);
    case 'video':
      return lucideIconToSvgString(Film);
    case 'audio':
      return lucideIconToSvgString(Volume2);
    default:
      return lucideIconToSvgString(File);
  }
}

function MarkdownFileIcon({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox={MARKDOWN_FILE_ICON_VIEWBOX}
      {...props}
    >
      <path d={MARKDOWN_FILE_ICON_PATH_D} />
    </svg>
  );
}

function fileEntryIconFieldsForPath(path: string): {
  kind: 'file' | 'folder';
  path: string;
  bodyIndexed?: boolean;
} {
  const ext = getFileExtension(path).toLowerCase();
  if (!ext) return { kind: 'folder', path };
  if (isMarkdownExt(ext)) return { kind: 'file', path };
  return { kind: 'file', path, bodyIndexed: false };
}

export function FileEntryPathIcon({
  path,
  className,
  showExtensionBadge,
}: {
  path: string;
  className?: string;
  showExtensionBadge?: boolean;
}) {
  return (
    <FileEntryIcon
      {...fileEntryIconFieldsForPath(path)}
      className={className}
      showExtensionBadge={showExtensionBadge}
    />
  );
}

export function fileEntryPathIconToSvgString(path: string): string {
  const { kind, bodyIndexed } = fileEntryIconFieldsForPath(path);
  if (kind === 'folder') return lucideIconToSvgString(FolderOpen);

  const ext = bodyIndexed === false ? getFileExtension(path) : getFileExtension(path) || '.md';
  const normalizedExt = ext.toLowerCase();
  if (isMarkdownExt(normalizedExt)) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="0.75rem" height="0.75rem"' +
      ` viewBox="${MARKDOWN_FILE_ICON_VIEWBOX}" fill="currentColor" aria-hidden="true">` +
      `<path d="${MARKDOWN_FILE_ICON_PATH_D}"/></svg>`
    );
  }
  return iconSvgForExt(normalizedExt);
}

export function FileEntryIcon({
  kind,
  path,
  docExt,
  bodyIndexed,
  className,
  showExtensionBadge = true,
}: {
  kind: 'file' | 'folder';
  path: string;
  docExt?: string;
  bodyIndexed?: boolean;
  className?: string;
  showExtensionBadge?: boolean;
}) {
  if (kind === 'folder') {
    return (
      <FolderOpen
        aria-hidden="true"
        className={cn('shrink-0', className)}
        data-file-entry-icon="folder"
      />
    );
  }

  const ext =
    bodyIndexed === false ? getFileExtension(path) : (docExt ?? (getFileExtension(path) || '.md'));
  const normalizedExt = ext.toLowerCase();
  const mediaKind = mediaKindForSidebarAssetExtension(normalizedExt);
  const badge =
    showExtensionBadge && ext && normalizedExt !== '.md' ? ext.slice(1).toUpperCase() : null;
  const iconClassName = cn(className, mediaKind === 'image' && 'text-rose-500');

  return (
    <span className="relative inline-flex shrink-0" data-file-entry-icon={normalizedExt || 'file'}>
      {isMarkdownExt(normalizedExt) ? (
        <MarkdownFileIcon className={iconClassName} data-testid="file-entry-icon-markdown" />
      ) : mediaKind === 'image' ? (
        <ImageIcon
          aria-hidden="true"
          className={iconClassName}
          data-testid="file-entry-icon-image"
        />
      ) : mediaKind === 'video' ? (
        <Film aria-hidden="true" className={iconClassName} data-testid="file-entry-icon-video" />
      ) : mediaKind === 'audio' ? (
        <Volume2 aria-hidden="true" className={iconClassName} data-testid="file-entry-icon-audio" />
      ) : (
        <File aria-hidden="true" className={iconClassName} data-testid="file-entry-icon-file" />
      )}
      {badge ? (
        <span
          aria-hidden="true"
          className="-right-1 -bottom-1 absolute rounded-sm bg-background px-0.5 font-medium text-[0.5rem] text-muted-foreground leading-none"
          data-testid="file-entry-extension-badge"
        >
          {badge}
        </span>
      ) : null}
    </span>
  );
}
