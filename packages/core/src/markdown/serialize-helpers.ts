
import type { Node as PmNode } from '@tiptap/pm/model';
import type { MdxJsxAttribute, MdxJsxExpressionAttribute, MdxJsxFlowElement } from 'mdast-util-mdx';
import type { PropDef, SerializeContext } from '../registry/types.ts';

function reconstructAttrs(
  pmNode: PmNode,
  props?: readonly PropDef[],
): Array<MdxJsxAttribute | MdxJsxExpressionAttribute> {
  const preserved: Array<MdxJsxAttribute | MdxJsxExpressionAttribute> = Array.isArray(
    pmNode.attrs.attributes,
  )
    ? pmNode.attrs.attributes.filter(
        (a): a is MdxJsxAttribute | MdxJsxExpressionAttribute =>
          a != null && typeof a === 'object' && 'type' in a,
      )
    : [];
  const structuredProps: Record<string, unknown> = pmNode.attrs.props ?? {};

  const omitDefaults = new Map<string, unknown>();
  const stringPropsOmittingEmpty = new Set<string>();
  if (props) {
    for (const p of props) {
      if (p.omitOnDefault === true && 'defaultValue' in p && p.defaultValue !== undefined) {
        omitDefaults.set(p.name, p.defaultValue);
      }
      if (p.type === 'string' && p.required === false && p.defaultValue === undefined) {
        stringPropsOmittingEmpty.add(p.name);
      }
    }
  }

  for (const [key, value] of Object.entries(structuredProps)) {
    const existingIdx = preserved.findIndex((a) => a.type === 'mdxJsxAttribute' && a.name === key);

    if (omitDefaults.has(key) && Object.is(omitDefaults.get(key), value)) {
      if (existingIdx >= 0) preserved.splice(existingIdx, 1);
      continue;
    }

    if (stringPropsOmittingEmpty.has(key) && value === '') {
      if (existingIdx >= 0) preserved.splice(existingIdx, 1);
      continue;
    }

    if (existingIdx >= 0) {
      const existing = preserved[existingIdx];
      if (
        existing.type === 'mdxJsxAttribute' &&
        existing.value != null &&
        typeof existing.value === 'object' &&
        existing.value.type === 'mdxJsxAttributeValueExpression' &&
        expressionMatchesValue(existing.value.value, value)
      ) {
        continue;
      }
    }

    const newAttr = propToMdxJsxAttribute(key, value);
    if (existingIdx >= 0) {
      preserved[existingIdx] = newAttr;
    } else {
      preserved.push(newAttr);
    }
  }

  return preserved;
}

function expressionMatchesValue(exprText: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(exprText)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function propToMdxJsxAttribute(name: string, value: unknown): MdxJsxAttribute {
  if (value === true) {
    return { type: 'mdxJsxAttribute', name, value: null };
  }
  if (value === false) {
    return {
      type: 'mdxJsxAttribute',
      name,
      value: { type: 'mdxJsxAttributeValueExpression', value: 'false' },
    };
  }
  if (value == null) {
    return { type: 'mdxJsxAttribute', name, value: null };
  }
  if (typeof value === 'string') {
    return { type: 'mdxJsxAttribute', name, value };
  }
  if (typeof value === 'number') {
    return {
      type: 'mdxJsxAttribute',
      name,
      value: {
        type: 'mdxJsxAttributeValueExpression',
        value: JSON.stringify(value),
      },
    };
  }
  if (typeof value === 'object') {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
    return {
      type: 'mdxJsxAttribute',
      name,
      value: {
        type: 'mdxJsxAttributeValueExpression',
        value: serialized,
      },
    };
  }
  return { type: 'mdxJsxAttribute', name, value: String(value) };
}

export function emitMdxJsx(
  componentName: string,
  pmNode: PmNode,
  ctx: SerializeContext,
  props?: readonly PropDef[],
): MdxJsxFlowElement {
  return {
    type: 'mdxJsxFlowElement',
    name: componentName,
    attributes: reconstructAttrs(pmNode, props),
    children: ctx.all(pmNode) as MdxJsxFlowElement['children'],
    data: {},
  };
}
