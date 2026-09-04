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
