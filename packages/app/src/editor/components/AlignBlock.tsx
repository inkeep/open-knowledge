/**
 * AlignBlock — DIY renderer for the `HtmlAlignBlock` canonical descriptor
 * (`<div align="…">` GitHub-README wrapper, promoted by
 * `div-align-promoter.ts`). Children are ordinary PM-managed blocks; the
 * wrapper only contributes text alignment, so images/badges (inline
 * content) and headings center the way GitHub renders them.
 */

import { cn } from '@/lib/utils';

const ALIGN_CLASS: Record<string, string> = {
  center: 'text-center',
  left: 'text-left',
  right: 'text-right',
  justify: 'text-justify',
};

interface AlignBlockProps {
  align?: string;
  children?: React.ReactNode;
}

export function AlignBlock(props: AlignBlockProps) {
  return (
    <div
      data-component-type="align-block"
      className={cn('prose-no-margin', ALIGN_CLASS[props.align ?? ''] ?? null)}
    >
      {props.children}
    </div>
  );
}
