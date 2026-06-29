
import { Trans, useLingui } from '@lingui/react/macro';
import { CopyPlus } from 'lucide-react';

interface MirrorSourceProps {
  id?: string;
  children?: React.ReactNode;
}

export function MirrorSource(props: MirrorSourceProps) {
  const { t } = useLingui();
  const id = props.id ?? '';
  const label = id || t`(no id)`;
  return (
    <div
      className='ok-mirror-source relative -mx-3 rounded-md border border-dashed border-transparent px-3 py-1 transition-colors [.jsx-component-wrapper:hover_&]:border-border/50 [.jsx-component-wrapper[data-selected="true"]_&]:border-border/50'
      data-mirror-source-id={id}
    >
      <div className='ok-mirror-source-badge pointer-events-none absolute -top-2.5 left-2 flex items-center gap-1 rounded-md bg-background px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity [.jsx-component-wrapper:hover_&]:opacity-100 [.jsx-component-wrapper[data-selected="true"]_&]:opacity-100'>
        <CopyPlus className="size-3" aria-hidden="true" />
        <span>
          <Trans>
            Mirror source <code className="font-mono">{label}</code>
          </Trans>
        </span>
      </div>
      <div>{props.children}</div>
    </div>
  );
}
