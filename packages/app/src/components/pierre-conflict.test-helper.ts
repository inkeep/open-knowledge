export const DIFF3_FIXTURE = `# Conflict Test Document

Some preamble text before the conflict region.

<<<<<<< ours
The knowledge base stores every note as plain markdown on the filesystem, so you own your files outright and they remain readable without any software.
||||||| original
The knowledge base stores files as plain text on the filesystem.
=======
The knowledge base stores every document as plain markdown, ensuring long-term durability and readability without proprietary software.
>>>>>>> theirs

Some trailing text after the conflict region.
`;

export function pierreShadow(container: HTMLElement): ShadowRoot {
  const el = container.querySelector('diffs-container');
  if (!el) {
    throw new Error('pierreShadow: no <diffs-container> found in container');
  }
  if (!el.shadowRoot) {
    throw new Error('pierreShadow: <diffs-container> has no open shadow root');
  }
  return el.shadowRoot;
}
