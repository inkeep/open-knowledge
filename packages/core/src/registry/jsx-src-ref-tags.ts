/**
 * Registry of by-reference JSX components whose attribute names another
 * document (`<Mirror src="api-spec" />`, `<Excalidraw src="board.excalidraw" />`).
 *
 * Component-registry domain knowledge, kept beside `builtInComponents`: the
 * server's rename rewriter (`managed-rename-rewrite.ts`), its backlink
 * extractor (`backlink-index.ts`), and the app's render-prop normalization
 * must all agree on which tags carry document references and how a `src`
 * value resolves to a docName, or a reference the graph discovers is one the
 * rewriter cannot rewrite (and vice versa). Adding a third by-reference
 * component means adding a registry row, not a hand-copied rewriter or
 * extractor.
 */

import { builtInComponents } from './built-ins.ts';

export interface JsxSrcRefTagSpec {
  readonly tagName: string;
  readonly attrName: string;
  /**
   * How the attribute value addresses its target document:
   *
   * - `'bare-doc-name'` — the value IS the docName, verbatim
   *   (`<Mirror src="api-spec" />`). The renderer performs no path
   *   resolution, so matching is exact string equality.
   * - `'doc-relative'` — the renderer resolves the value with
   *   `normalizeDocRelativeAssetUrl(value, sourceDocName)` before use (the
   *   component is in the app's `DOC_RELATIVE_SRC_COMPONENTS` set), so
   *   `board.excalidraw` inside `notes/index` addresses docName
   *   `notes/board.excalidraw` while `/notes/board.excalidraw` addresses it
   *   from anywhere. Matching must compare the NORMALIZED value.
   */
  readonly resolution: 'bare-doc-name' | 'doc-relative';
}

export const JSX_SRC_REF_TAGS: readonly JsxSrcRefTagSpec[] = [
  { tagName: 'Mirror', attrName: 'src', resolution: 'bare-doc-name' },
  { tagName: 'Excalidraw', attrName: 'src', resolution: 'doc-relative' },
];

// Registry↔descriptor guard. `tagName`/`attrName` are free strings compiled
// into the matcher regexes — a typo ('Mirrror') compiles fine and the pass
// just stops matching: a silent no-op with no error and no failing test.
// Cross-check every entry against the canonical component descriptors at
// module load so a mismatch throws at boot instead (same convention as the
// `assertSubset` guards in the upload constants).
for (const spec of JSX_SRC_REF_TAGS) {
  const descriptor = builtInComponents.find((component) => component.name === spec.tagName);
  if (!descriptor) {
    throw new Error(
      `JSX_SRC_REF_TAGS: no built-in component descriptor named '${spec.tagName}' — ` +
        `the rename-rewrite and backlink passes for this entry would silently never match. ` +
        `Fix the tagName to match a descriptor in builtInComponents.`,
    );
  }
  if (!descriptor.props.some((prop) => prop.name === spec.attrName)) {
    throw new Error(
      `JSX_SRC_REF_TAGS: component '${spec.tagName}' declares no prop named '${spec.attrName}' — ` +
        `the rename-rewrite and backlink passes for this entry would silently never match. ` +
        `Fix the attrName to match one of the descriptor's props.`,
    );
  }
}
