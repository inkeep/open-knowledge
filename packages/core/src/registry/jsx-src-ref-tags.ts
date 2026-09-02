import { builtInComponents } from './built-ins.ts';

export interface JsxSrcRefTagSpec {
  readonly tagName: string;
  readonly attrName: string;
  readonly resolution: 'bare-doc-name' | 'doc-relative';
}

export const JSX_SRC_REF_TAGS: readonly JsxSrcRefTagSpec[] = [
  { tagName: 'Mirror', attrName: 'src', resolution: 'bare-doc-name' },
  { tagName: 'Excalidraw', attrName: 'src', resolution: 'doc-relative' },
];

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
