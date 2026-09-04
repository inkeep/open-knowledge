import './copy-image.ts';

export { OPT_OUT_ATTR } from './clipboard-sanitize.ts';
export { createCopyCutHandler } from './handle-copy.ts';
export { createHandleDrop, createHandlePaste } from './handle-paste.ts';
export {
  createClipboardHtmlSerializer,
  createClipboardTextSerializer,
} from './serialize.ts';
export { createSourceClipboardExtension } from './source-clipboard.ts';
