/**
 * `<MirrorSource id="…">…</MirrorSource>` — marks a block as the
 * source-of-truth for content that `<Mirror>` references render read-only
 * elsewhere. Edits happen at this site; copies reflect the change.
 *
 * The block renders its children as a normal passthrough container — same
 * editing surface as any other block-level JSX wrapper. The "Mirror source"
 * affordance (dashed border + id badge) is hover-only: at rest the block
 * looks identical to surrounding prose so it doesn't disrupt the reading
 * surface. Hover surfaces the chrome so authors know edits here propagate
 * to every `<Mirror>` referencing this id.
 *
 */

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
  // Hover is driven off `.jsx-component-wrapper:hover` rather than the inner
  // `.ok-mirror-source` so the chrome stays visible across the whole NodeView
  // (including the universal trash / settings bubble menu the wrapper owns).
  // Driving hover off the inner div instead would flicker the badge as the
  // cursor crossed the seam between content and bubble — see Mirror.tsx for
  // the full rationale.
  //
  // `-mx-3 px-3` keeps the inner content flush with surrounding prose at
  // rest — the negative margin cancels the padding, so the dashed border
  // (visible only on hover) sits 12px outside the text column and never
  // shifts the content. Padding made symmetric (`px-3`, not `pl-3`) so the
  // hover border doesn't visually crowd the right edge of the content.
  // `data-mirror-source-id={id}` is both the structural marker and the
  // anchor target. `TiptapEditor.tsx`'s scroll handler falls back to
  // `querySelector('[data-mirror-source-id]')` when `getElementById`
  // misses, so MirrorSource ids stay isolated from HeadingAnchors'
  // global DOM-id namespace (avoids `<MirrorSource id="pricing-table">`
  // colliding with a heading slugged `pricing-table` in the same doc).
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
