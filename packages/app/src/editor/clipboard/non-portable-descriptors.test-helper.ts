import { builtInComponents } from '@inkeep/open-knowledge-core';

const NON_PORTABLE_CANONICALS: ReadonlySet<string> = new Set(['Math', 'MermaidFence']);

export function nonPortableDescriptorNames(): string[] {
  return builtInComponents
    .filter((meta) => {
      const rendersAs = 'rendersAs' in meta ? meta.rendersAs : undefined;
      return (
        NON_PORTABLE_CANONICALS.has(meta.name) ||
        (typeof rendersAs === 'string' && NON_PORTABLE_CANONICALS.has(rendersAs))
      );
    })
    .map((meta) => meta.name);
}
