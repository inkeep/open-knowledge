/**
 * Public surface of the clipboard module.
 *
 * The four creator functions that callers (`TiptapEditor.tsx`,
 * `SourceEditor.tsx`) need to wire per-view clipboard behavior, plus the
 * `OPT_OUT_ATTR` constant that descriptors and chrome-rendering extensions
 * (`JsxComponentView.tsx`, `drag-handle.ts`) set on subtrees the walker
 * must drop before serialization. The internal dispatcher, is-markdown
 * heuristic, source-detection regex, and structured-telemetry helpers are
 * intentionally NOT re-exported — they're implementation details, not
 * contract.
 *
 * Matches the barrel convention used by sibling editor modules
 * (`source-polish/index.ts`, `image-upload/index.ts`).
 */

export { OPT_OUT_ATTR } from './clipboard-sanitize.ts';
export { createHandleDrop, createHandlePaste } from './handle-paste.ts';
export {
  createClipboardHtmlSerializer,
  createClipboardTextSerializer,
} from './serialize.ts';
export { createSourceClipboardExtension } from './source-clipboard.ts';
