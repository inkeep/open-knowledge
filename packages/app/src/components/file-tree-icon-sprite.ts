import { __iconNode as botIcon } from 'lucide-react/dist/esm/icons/bot';
import { __iconNode as link2Icon } from 'lucide-react/dist/esm/icons/link-2';
import {
  EXCALIDRAW_FILE_ICON_PATH_D,
  EXCALIDRAW_FILE_ICON_VIEWBOX,
  MARKDOWN_FILE_ICON_PATH_D,
  MARKDOWN_FILE_ICON_VIEWBOX,
} from '@/components/file-entry-icon';

export const LINK_DECORATION_ICON_ID = 'ok-file-tree-link-decoration';
export const AGENT_DECORATION_ICON_ID = 'ok-file-tree-agent-decoration';
export const MARKDOWN_FILE_ICON_ID = 'ok-file-tree-markdown';
export const EXCALIDRAW_FILE_ICON_ID = 'ok-file-tree-excalidraw';
const MARKDOWN_FILE_ICON_SYMBOL = `<symbol id="${MARKDOWN_FILE_ICON_ID}" viewBox="${MARKDOWN_FILE_ICON_VIEWBOX}" fill="currentColor"><path d="${MARKDOWN_FILE_ICON_PATH_D}"/></symbol>`;
const EXCALIDRAW_FILE_ICON_SYMBOL = `<symbol id="${EXCALIDRAW_FILE_ICON_ID}" viewBox="${EXCALIDRAW_FILE_ICON_VIEWBOX}" fill="currentColor"><path d="${EXCALIDRAW_FILE_ICON_PATH_D}"/></symbol>`;

type IconNode = [string, Record<string, string>][];

function iconNodeToSvg(iconNode: IconNode): string {
  return iconNode
    .map(([tag, { key: _, ...attrs }]) => {
      const attrString = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${attrString} />`;
    })
    .join('');
}

function createLucideSpriteSymbol(id: string, iconNode: IconNode): string {
  const symbolContent = iconNodeToSvg(iconNode);
  return `<symbol id="${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${symbolContent}</symbol>`;
}

export const FILE_TREE_DECORATION_SPRITE_SHEET = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  ${createLucideSpriteSymbol(LINK_DECORATION_ICON_ID, link2Icon)}
  ${createLucideSpriteSymbol(AGENT_DECORATION_ICON_ID, botIcon)}
  ${MARKDOWN_FILE_ICON_SYMBOL}
  ${EXCALIDRAW_FILE_ICON_SYMBOL}
</svg>`;
