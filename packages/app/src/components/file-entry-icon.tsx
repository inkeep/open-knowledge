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

export const EXCALIDRAW_FILE_ICON_VIEWBOX = '0 0 24 24';
export const EXCALIDRAW_FILE_ICON_PATH_D =
  'M23.9428 19.8058a0.1962 0.1962 0 0 0 -0.1679 -0.0337c-1.26 -1.8552 -2.8727 -3.6104 -4.4186 -5.3152l-0.2521 -0.284c-0.0016 -0.0732 -0.0667 -0.1207 -0.1342 -0.1504 -0.0284 -0.0277 -0.0562 -0.0558 -0.0843 -0.0837 -0.0505 -0.1005 -0.1685 -0.1673 -0.2858 -0.1005 -0.4706 0.2347 -0.9068 0.5855 -1.3274 0.9195 -0.5536 0.4345 -1.1085 0.8695 -1.6296 1.354a5.0577 5.0577 0 0 0 -0.5879 0.6185c-0.0842 0.1168 -0.0168 0.2172 0.0843 0.2672 -0.3701 0.3677 -0.7402 0.736 -1.109 1.1198a0.1896 0.1896 0 0 0 -0.0506 0.1342c0 0.05 0.0337 0.1 0.0668 0.1168l0.6559 0.5012v0.0169c0.9237 0.9194 2.5538 2.1729 4.2844 3.5268 0.2515 0.201 0.5205 0.4014 0.7727 0.6017 0.1173 0.1342 0.2346 0.2847 0.3357 0.4182 0.0506 0.0662 0.1685 0.0837 0.2353 0.0331 0.0337 0.0337 0.0843 0.0668 0.118 0.1005a0.2395 0.2395 0 0 0 0.1004 0.0337 0.1534 0.1534 0 0 0 0.1348 -0.0668 0.2371 0.2371 0 0 0 0.0331 -0.1004c0.0175 0 0.0169 0.0168 0.0337 0.0168a0.1915 0.1915 0 0 0 0.1348 -0.0505l3.058 -3.3265c0.1198 -0.1159 0.0135 -0.2668 -0.0005 -0.2672zm-7.6277 -0.1336 -1.5459 -1.1704 -0.151 -0.0998c-0.0337 -0.0169 -0.0674 -0.0506 -0.1011 -0.0668l-0.1174 -0.1005c0.6597 -0.659 1.3297 -1.3074 1.9996 -1.9557 -0.4874 0.4844 -1.4622 1.9057 -1.2606 2.3733 0.0023 0 0.0186 0.0419 0.0674 0.0842 0.3704 0.311 0.7398 0.6232 1.109 0.9357zm4.0997 3.1261 -1.277 -0.97a26.9056 26.9056 0 0 0 -1.5795 -1.5044c0.689 0.5181 1.2769 0.9694 1.3611 1.053 0.6722 0.585 0.6379 0.485 1.0922 0.8696l0.5542 0.4008c-0.0735 0.103 -0.151 0.1477 -0.151 0.151zm0.3357 0.2503 -0.0337 -0.0168c0.0506 -0.0331 0.1011 -0.0668 0.1517 -0.1168zM0.5885 3.4751c0.0331 0.2172 0.0843 0.4344 0.1174 0.6354 0.2015 1.103 0.4031 2.1061 0.7726 2.8583l0.1516 0.568c0.0506 0.2173 0.1342 0.485 0.2185 0.5519 0.8568 0.7521 2.1674 1.8714 3.5785 2.9419a0.1775 0.1775 0 0 0 0.2185 0s0 0.0162 0.0168 0.0162a0.1528 0.1528 0 0 0 0.118 0.0506 0.1912 0.1912 0 0 0 0.1341 -0.0506c1.798 -1.9887 3.1418 -3.6267 4.0997 -4.9974 0.0674 -0.0668 0.0843 -0.1673 0.0843 -0.251 0.0668 -0.0668 0.1173 -0.1504 0.1847 -0.2004 0.0668 -0.0668 0.0668 -0.184 0 -0.2346l-0.0168 -0.0163c0 -0.033 -0.0169 -0.0836 -0.0506 -0.1005 -0.42 -0.4007 -0.722 -0.6848 -1.0416 -0.9856A93.5546 93.5546 0 0 1 6.822 1.9876c-0.0169 -0.0169 -0.0337 -0.0337 -0.0674 -0.0337 -0.3358 -0.1168 -1.0248 -0.2341 -1.8817 -0.3845C3.596 1.3527 1.865 1.0519 0.3027 0.583c0 0 -0.1011 0 -0.118 0.0169L0.1348 0.6505C0.0498 0.7139 0.0222 0.7058 0 0.7167c0.017 0.1005 0.017 0.1673 0.0506 0.2846 0 0.0331 0.0673 0.3009 0.0673 0.334zm7.1909 4.7802 -0.0337 0.0337a0.0362 0.0362 0 0 1 0.0337 -0.0337zM6.553 2.238c0.101 0.1005 0.5211 0.5019 0.6216 0.5855 -0.4369 -0.201 -1.5284 -0.7022 -2.0333 -0.8695 0.5043 0.1005 1.1933 0.201 1.4117 0.284ZM0.7901 1.4027c0.2521 0.4344 0.4537 1.9388 0.6553 3.4095 -0.118 -0.4682 -0.2016 -0.9357 -0.3027 -1.3708C0.9917 2.673 0.84 1.9876 0.6385 1.3858c0.1232 0 0.1516 0.0212 0.1516 0.0169zm-0.2858 -0.3683c0 -0.0162 0 -0.033 -0.0169 -0.033 0.0843 0 0.1342 0.0168 0.2016 0.0499 0.0006 0.0057 -0.1448 -0.0169 -0.1847 -0.0169zM23.6738 0.8172c0.0169 -0.0662 -0.3358 -0.367 -0.2184 -0.3845 0.2527 -0.0163 0.2527 -0.4008 0 -0.4008 -0.3358 0.0169 -0.6884 0.0999 -1.008 0.1504 -0.5878 0.1168 -1.1926 0.2341 -1.781 0.3671 -1.327 0.2846 -2.6375 0.5855 -3.9481 0.937 -0.4032 0.1167 -0.857 0.2003 -1.2432 0.4007 -0.1348 0.0668 -0.118 0.2004 -0.0506 0.284 -0.0337 0.0169 -0.0505 0.0169 -0.0842 0.0337 -0.1174 0.0169 -0.2185 0.0337 -0.3358 0.05 -0.1011 0.0168 -0.1516 0.1004 -0.1348 0.201 0 0.0162 0.0169 0.0499 0.0169 0.0661 -0.7059 0.9363 -1.4954 1.9226 -2.3523 2.9757 -0.84 0.9694 -1.7306 1.9893 -2.6212 3.0424 -2.8396 3.3096 -6.0487 7.0705 -9.5936 10.38a0.1613 0.1613 0 0 0 0 0.2341c0.0169 0.0163 0.0337 0.0331 0.0506 0.0331 -0.0506 0.0506 -0.1011 0.0843 -0.1517 0.1336 -0.0337 0.0337 -0.0505 0.0668 -0.0505 0.1005a0.364 0.364 0 0 0 -0.0668 0.0837c-0.0674 0.0667 -0.0674 0.1835 0.0169 0.234 0.0667 0.0662 0.1847 0.0662 0.2346 -0.0168 0.0175 -0.0169 0.0175 -0.0337 0.0337 -0.0337a0.2648 0.2648 0 0 1 0.3701 0c0.2016 0.2178 0.4032 0.435 0.588 0.6186l-0.4201 -0.3508c-0.0674 -0.0668 -0.1847 -0.05 -0.2347 0.0168 -0.068 0.0662 -0.0511 0.1835 0.0163 0.234l4.4691 3.7273c0.0337 0.0337 0.0674 0.0337 0.118 0.0337 0.0505 0 0.0842 -0.0169 0.1173 -0.0506l0.101 -0.0999c0.017 0.0163 0.05 0.0163 0.0669 0.0163 0.0505 0 0.0842 -0.0163 0.118 -0.05 6.0486 -6.0505 10.9216 -10.6141 16.4997 -14.6927 0.05 -0.0331 0.0668 -0.1 0.0668 -0.1505 0.0674 0 0.118 -0.05 0.151 -0.1167 1.0254 -3.1255 1.227 -5.9007 1.2938 -7.2709 0 -0.0579 0.0169 -0.0371 0.0169 -0.0668 0.0168 -0.0337 0.0168 -0.0505 0.0168 -0.0505a0.9784 0.9784 0 0 0 -0.0668 -0.6186zm-10.82 4.9144c0.2684 -0.3008 0.5374 -0.6186 0.8064 -0.9026 -1.7306 2.2734 -4.6033 5.7665 -8.67 9.9288C7.7626 11.699 10.5517 8.54 12.854 5.7316ZM5.1414 23.4662c-0.0162 -0.0168 -0.0162 -0.0168 0 -0.0168zm2.5033 -2.156c0.1348 -0.1505 0.2695 -0.284 0.4206 -0.4345 0 0 0 0.0163 0.0168 0.0163 -0.2236 0.1978 -0.4334 0.4182 -0.4374 0.4182zm0.6896 -0.6686c0.0994 -0.0993 0.14 -0.1724 0.2852 -0.3177 0.9917 -1.0193 2.0164 -2.0393 3.058 -3.0755l0.0169 -0.0168c0.2521 -0.2004 0.5542 -0.4177 0.8232 -0.6186a228.0627 228.0627 0 0 0 -4.1833 4.0286zm6.5187 -16.732c-0.5543 0.719 -1.1759 1.6716 -1.697 2.4238 -1.6463 2.3733 -6.9393 8.1735 -7.0566 8.274A1189.6473 1189.6473 0 0 1 1.26 19.204l-0.1005 0.1005c-0.0843 -0.1005 -0.0843 -0.251 0.0168 -0.3346 7.476 -7.0037 12.0132 -12.837 13.845 -15.3944 -0.0506 0.1167 -0.0843 0.2166 -0.1685 0.334zm2.9064 3.4269c-0.6716 -0.3851 -0.9905 -0.9869 -0.8064 -1.5712l0.0506 -0.201a0.7753 0.7753 0 0 1 0.0842 -0.1666c0.1848 -0.301 0.4538 -0.5518 0.7564 -0.7023 0.0163 0 0.0331 0 0.05 -0.0168 -0.0169 -0.0337 -0.0169 -0.0837 -0.0169 -0.1336 0.0169 -0.1005 0.0843 -0.1673 0.2016 -0.1673 0.2016 0 0.8238 0.1841 1.059 0.3845 0.0669 0.05 0.1343 0.1168 0.2017 0.1836 0.0842 0.1004 0.2184 0.2677 0.2852 0.4013 0.0337 0.0169 0.0674 0.1841 0.118 0.2678 0.0336 0.1336 0.0667 0.284 0.0505 0.4176 -0.0169 0.0169 0 0.1167 -0.0169 0.1167a1.6055 1.6055 0 0 1 -0.2184 0.6186c-0.0307 0.0307 0.0064 0.0119 -0.0505 0.0668 -0.0843 0.1342 -0.2016 0.251 -0.319 0.3346 -0.3869 0.2672 -0.8238 0.3508 -1.2606 0.234 -0.1105 -0.0473 -0.1672 -0.0667 -0.1685 -0.0667zm4.3692 1.4039c0 0.0168 -0.0168 0.0499 0 0.0667 -0.0337 0 -0.0505 0.0169 -0.0842 0.0337 -1.3274 0.9689 -2.6212 1.9888 -3.915 3.0256 1.109 -0.9868 2.218 -1.9894 3.3776 -2.9756 0.3358 -0.3009 0.5711 -0.6854 0.6379 -1.1199l0.1685 -1.003v-0.0332c0.0842 -0.201 0.4032 -0.1173 0.3526 0.1 -0.0042 -0.0012 -0.1731 0.795 -0.5374 1.9057z';

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
    case 'excalidraw':
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${EXCALIDRAW_FILE_ICON_VIEWBOX}" fill="currentColor" aria-hidden="true"><path d="${EXCALIDRAW_FILE_ICON_PATH_D}"/></svg>`;
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

function ExcalidrawFileIcon({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox={EXCALIDRAW_FILE_ICON_VIEWBOX}
      {...props}
    >
      <path d={EXCALIDRAW_FILE_ICON_PATH_D} />
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
      ) : mediaKind === 'excalidraw' ? (
        <ExcalidrawFileIcon className={iconClassName} data-testid="file-entry-icon-excalidraw" />
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
