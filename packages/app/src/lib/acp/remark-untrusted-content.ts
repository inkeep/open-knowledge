interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  children?: MdastNode[];
}

function inert(node: MdastNode): MdastNode | null {
  if (node.type === 'html') return { type: 'text', value: node.value ?? '' };
  if (node.type === 'image') {
    const label =
      node.alt !== undefined && node.alt !== null && node.alt !== '' ? node.alt : node.url;
    return label === undefined || label === '' ? null : { type: 'text', value: label };
  }
  return node;
}

function rewrite(node: MdastNode): void {
  const children = node.children;
  if (children === undefined) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    const replaced = inert(child);
    if (replaced === null) continue;
    if (replaced === child) rewrite(child);
    next.push(replaced);
  }
  node.children = next;
}

export function remarkUntrustedContent() {
  return () =>
    (tree: MdastNode): void => {
      rewrite(tree);
    };
}
