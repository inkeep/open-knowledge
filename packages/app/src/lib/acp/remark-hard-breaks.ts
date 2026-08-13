/**
 * Treat a single newline as a line break, the way chat readers expect.
 *
 * Markdown collapses a lone newline into a space; only a blank line starts a new
 * block. That is right for prose and wrong for a chat transcript, where people
 * press Enter once and expect the line to end — which is why the sent-message
 * bubble kept `whitespace-pre-wrap` for as long as it printed text verbatim.
 * Rendering both sides as markdown removed that, so the rule has to come from
 * the parser instead.
 *
 * This is what `remark-breaks` does; it is written out here rather than pulled
 * in because the whole of it is the walk below, and the subtree carries its own
 * lockfile.
 *
 * FENCED AND INLINE CODE ARE SAFE BY CONSTRUCTION. An mdast `code` or
 * `inlineCode` node keeps its content in `value` and has no `children`, so a
 * walk that only ever descends into `children` cannot reach inside one. A
 * newline in a code block stays a newline the code renderer handles itself.
 */

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
      // `\r\n` as one break, not two: a CRLF document would otherwise render
      // every line with a blank one under it.
      const parts = child.value.split(/\r?\n/);
      for (const [index, part] of parts.entries()) {
        if (index > 0) next.push({ type: 'break' });
        // Empty segments come from consecutive newlines; the `break` nodes
        // already carry them, and an empty text node renders as nothing anyway.
        if (part !== '') next.push({ type: 'text', value: part });
      }
      continue;
    }
    splitTextNodes(child);
    next.push(child);
  }
  node.children = next;
}
