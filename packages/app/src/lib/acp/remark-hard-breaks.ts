interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

export function remarkHardBreaks() {
  return (tree: MdastNode): void => {
    splitTextNodes(tree);
  };
}

function splitTextNodes(node: MdastNode): void {
  const children = node.children;
  if (children === undefined) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (child.type === 'text' && child.value !== undefined && child.value.includes('\n')) {
      const parts = child.value.split(/\r?\n/);
      for (const [index, part] of parts.entries()) {
        if (index > 0) next.push({ type: 'break' });
        if (part !== '') next.push({ type: 'text', value: part });
      }
      continue;
    }
    splitTextNodes(child);
    next.push(child);
  }
  node.children = next;
}
