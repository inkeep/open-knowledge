export function attributeName(node) {
  const name = node.name;
  if (!name) return '';
  if (name.type === 'JSXNamespacedName') {
    return `${name.namespace?.name ?? ''}:${name.name?.name ?? ''}`;
  }
  return name.name ?? '';
}

export function isClassNameAttribute(node) {
  return attributeName(node).endsWith('lassName');
}

export function elementName(node) {
  const name = node.name;
  if (!name) return '';
  return name.type === 'JSXIdentifier' ? (name.name ?? '') : '';
}
