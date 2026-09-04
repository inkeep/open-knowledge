import type { Node as PmNode } from '@tiptap/pm/model';
import type { Nodes as HastNodes } from 'hast';
import type { Nodes as MdastNodes } from 'mdast';
import type { ComponentRegistry } from './index.ts';

export interface PropDefBase {
  name: string;
  required: boolean;
  description?: string;
  hidden?: boolean;
  hideWhen?: (values: Record<string, unknown>) => boolean;
  advanced?: boolean;
  /**
   * Opt-in: when the prop value strictly equals the declared `defaultValue`,
   * omit the attribute on emit. The renderer applies the default at parse
   * time anyway (descriptor `translateProps` and React component-level
   * defaults), so the on-disk attribute is redundant.
   *
   * Distinct from `defaultValue`: `defaultValue` doubles as a UI initial-
   * state hint AND may carry semantic meaning (e.g., `<img alt="">` is
   * "decorative" — different from absent — even though defaultValue is `''`).
   * Set this flag only when the rendered behavior of `prop=default` and
   * `prop absent` is truly identical at the browser layer (e.g., HTML
   * `loading` defaults to `lazy`; HTML5 `<video controls>` defaults to
   * absent-controls = no controls but our descriptor flips that with
   * `defaultValue: true`).
   *
   * Strips redundant attrs on the dirty serialize path only — pristine
   * sourceRaw round-trips byte-identically (precedent #9 untouched).
   */
  omitOnDefault?: boolean;
}

export interface PropDefString extends PropDefBase {
  type: 'string';
  defaultValue?: string;
  accept?: readonly string[];
  autoFocus?: boolean;
  language?: 'mermaid' | 'latex' | 'html' | 'json' | 'yaml' | 'javascript' | 'markdown';
  iconPicker?: boolean;
  colorPicker?: boolean;
  cssLengthInput?: boolean;
}

export interface PropDefBoolean extends PropDefBase {
  type: 'boolean';
  defaultValue?: boolean;
}

export interface PropDefNumber extends PropDefBase {
  type: 'number';
  defaultValue?: number;
}

export interface PropDefEnum extends PropDefBase {
  type: 'enum';
  enumValues: [string, ...string[]];
  defaultValue?: string;
}

export interface PropDefReactNode extends PropDefBase {
  type: 'reactnode';
}

export type PropDef =
  | PropDefString
  | PropDefBoolean
  | PropDefNumber
  | PropDefEnum
  | PropDefReactNode;

export interface SerializeContext {
  all: (node: PmNode) => MdastNodes[];
  registry: Pick<ComponentRegistry, 'getOrWildcard'>;
  serializeChildren: (node: PmNode) => string;
}

type TranslateProps = (compatProps: Record<string, unknown>) => Record<string, unknown>;

interface JsxComponentMetaBase {
  name: string;
  /** PropPanel/slash-menu hint; NodeViewContent always renders per Precedent #26. */
  hasChildren: boolean;
  isSelfClosing?: boolean;
  props: PropDef[];
  icon?: string;
  /** Slash menu grouping category. Precedent #9 keeps this add-only —
   *  extending with new members is free; narrowing is permanent lock-in. */
  category?: 'content' | 'media' | 'embed';
  displayName?: string;
  description?: string;
  searchTerms?: string[];
  emptyChildName?: string;
  placeholder?: { label?: string; icon?: string };
  exampleBody?: string;
  serialize: (node: PmNode, ctx: SerializeContext) => MdastNodes;
  toClipboardHast?: (
    node: PmNode,
    ctx: ClipboardHastContext,
    liveDom?: Element,
  ) => HastNodes | null;
}

export interface ClipboardHastContext {
  registry: Pick<ComponentRegistry, 'getOrWildcard'>;
  descriptorName: string;
}

interface CanonicalMeta extends JsxComponentMetaBase {
  surface: 'canonical';
}

export interface CompatMeta extends JsxComponentMetaBase {
  surface: 'compat';
  rendersAs: string;
  translateProps: TranslateProps;
}

export type JsxComponentMeta = CanonicalMeta | CompatMeta;
