/**
 * `<Mirror src="…" anchor="…" />` — read-only transclusion of a
 * `<MirrorSource id="…">` block from another doc. Master/copy model: edits
 * happen at the source; every Mirror reflects the change.
 *
 * The render-time fetch + live re-render lives in `useMirrorSource`, which
 * opens a `HocuspocusProvider` on the source doc, observes its
 * `Y.Text('source')`, walks the parsed mdast for the matching MirrorSource,
 * and pipes its subtree through the shared `mdastToHtml` renderer.
 *
 * The "Open source" deep-link affordance lives in the universal
 * `.jsx-component-chrome` bubble — see `JsxComponentView.tsx`'s
 * `descriptor.name === 'Mirror'` branch. This component paints only the
 * rendered Mirror (or the appropriate empty / error state).
 */

import { Trans } from '@lingui/react/macro';
import { Copy, Link2, Link2Off } from 'lucide-react';
import { useMirrorSource } from './use-mirror-source.ts';

// "Open source" deep-link affordance lives in the universal
// `.jsx-component-chrome` bubble (see `JsxComponentView.tsx` — search for
// `descriptor.name === 'Mirror'`). Putting it there gets bubble parity for
// free: shows alongside trash + settings on hover-or-selected, same icon
// size, same hit zone, and a fresh `<a href={hashFromDocName(src, anchor)}>`
// gets middle-click / cmd-click new-tab and "Copy link address" without
// custom wiring. The hash navigation is picked up by `DocumentProvider`'s
// hashchange listener — no React imports from `DocumentContext.tsx` are
// pulled in here, which dodges a temporal-dead-zone race on cold load
// (see `use-mirror-source.ts` for the cycle details).

interface MirrorProps {
  src?: string;
  anchor?: string;
}

function StatusFrame(props: { tone: 'placeholder' | 'error'; children: React.ReactNode }) {
  const toneClass =
    props.tone === 'error'
      ? 'border-destructive/40 text-destructive'
      : 'border-border text-muted-foreground';
  return (
    <div
      className={`ok-mirror-state flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-sm ${toneClass}`}
    >
      {props.tone === 'error' ? (
        <Link2Off className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

export function Mirror(props: MirrorProps) {
  const src = props.src ?? '';
  const anchor = props.anchor ?? '';
  const status = useMirrorSource(src, anchor);

  if (status.kind === 'empty-props') {
    return (
      <StatusFrame tone="placeholder">
        <Trans>
          <span className="font-medium">Mirror — pick a source.</span> Set <code>src</code> +{' '}
          <code>anchor</code> via the property panel to point at a <code>{'<MirrorSource>'}</code>{' '}
          elsewhere.
        </Trans>
      </StatusFrame>
    );
  }

  if (status.kind === 'loading') {
    const mirrorRef = src && anchor ? `${src}#${anchor}` : '';
    return (
      <StatusFrame tone="placeholder">
        <Trans>
          Mirror loading <code>{mirrorRef}</code>
        </Trans>
      </StatusFrame>
    );
  }

  if (status.kind === 'source-removed') {
    return (
      <StatusFrame tone="error">
        <Trans>
          <span className="font-medium">Mirror source removed.</span> The doc <code>{src}</code> is
          no longer available.
        </Trans>
      </StatusFrame>
    );
  }

  if (status.kind === 'anchor-not-found') {
    const mirrorSourceTag = `<MirrorSource id="${anchor}">`;
    return (
      <StatusFrame tone="error">
        <Trans>
          <span className="font-medium">Mirror anchor not found.</span> No{' '}
          <code>{mirrorSourceTag}</code> exists in <code>{src}</code>.
        </Trans>
      </StatusFrame>
    );
  }

  // Status.kind === 'ready' — render the resolved source HTML inline.
  // The "Open source" deep-link affordance is rendered by JsxComponentView
  // as a chrome-bubble button (see header JSDoc for the integration site).
  //
  // The dashed border surfaces on `.jsx-component-wrapper:hover` AND
  // `[data-selected="true"]` — same dual-signal the universal chrome
  // bubble uses. `-mx-3 px-3` keeps the inner content flush with
  // surrounding prose at the same x-coordinate (the negative margin
  // cancels the padding); the dashed border sits outside the text column
  // so it doesn't shift the content between rest and hover.
  //
  // The HTML was already sanitized by `rehypeSanitizeUrls` inside the
  // shared `mdastToHtml` pipeline (drops dangerous URL schemes; element-
  // level `<script>` / `<iframe>` injection is dropped because
  // `allowDangerousHtml` is off). `prose-no-margin` keeps tight spacing in
  // line with the surrounding doc.
  return (
    <div
      className='ok-mirror-resolved relative -mx-3 prose-no-margin rounded-md border border-dashed border-transparent px-3 py-2 transition-colors [.jsx-component-wrapper:hover_&]:border-border/40 [.jsx-component-wrapper[data-selected="true"]_&]:border-border/40'
      data-mirror-src={src}
      data-mirror-anchor={anchor}
    >
      {/* Identity badge — mirrors `MirrorSource`'s top-left badge so a
        reader who hovers/selects the block sees what it is at a glance.
        `Copy` icon pairs visually with MirrorSource's `CopyPlus` (copy ↔
        original). Position matches `.ok-mirror-source-badge` so a Mirror
        and a MirrorSource that share a page surface look like
        complementary halves of the same affordance. */}
      <div
        className='ok-mirror-badge pointer-events-none absolute -top-2.5 left-2 flex items-center gap-1 rounded-md bg-background px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity [.jsx-component-wrapper:hover_&]:opacity-100 [.jsx-component-wrapper[data-selected="true"]_&]:opacity-100'
        aria-hidden="true"
      >
        <Copy className="size-3" aria-hidden="true" />
        <span>
          <Trans>
            Mirror of <code className="font-mono">{src}</code>
          </Trans>
        </span>
      </div>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: shared sanitization pipeline gates URL schemes + element-level passthrough — see `mdast-to-html.ts`. */}
      <div dangerouslySetInnerHTML={{ __html: status.html }} />
    </div>
  );
}
