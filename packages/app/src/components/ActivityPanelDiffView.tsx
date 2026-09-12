import { Trans } from '@lingui/react/macro';
import { MultiFileDiff } from '@pierre/diffs/react';
import type * as React from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { okPierreTheme } from '@/lib/pierre-theme';

interface ActivityPanelDiffViewProps {
  before: string;
  after: string;
  cacheKey: string;
}

const PARSE_DIFF_OPTIONS = { context: 999_999 };

const MAX_LINE_DIFF_LENGTH = 50_000;

const GLYPH_STYLE_ATTR = 'data-ok-glyph-override';
const GUTTER_ROW_SELECTOR = '[data-gutter] > [data-line-type]';
const CONTENT_ROW_SELECTOR = '[data-content] > [data-line-type]';
function hideGutterFromAssistiveTech(node: HTMLElement): void {
  const root = node.shadowRoot;
  if (!root) return;

  if (!root.querySelector(`[${GLYPH_STYLE_ATTR}]`)) {
    const style = document.createElement('style');
    style.setAttribute(GLYPH_STYLE_ATTR, '');
    style.textContent = '[data-content] [data-line]::before { color: var(--diffs-fg); }';
    root.appendChild(style);
  }

  const gutterRows = root.querySelectorAll(GUTTER_ROW_SELECTOR);
  for (const el of gutterRows) {
    if (el.getAttribute('aria-hidden') !== 'true') el.setAttribute('aria-hidden', 'true');
  }
  if (gutterRows.length === 0 && root.querySelector(CONTENT_ROW_SELECTOR) !== null) {
    console.warn(
      '[activity-panel-diff] aria-hidden: content rows rendered but no [data-gutter] > [data-line-type] rows — Pierre DOM contract may have changed',
    );
  }
}

function RawDiffFallback({ after }: { after: string }): React.JSX.Element {
  return (
    <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-xs text-foreground/90">
      {after}
    </pre>
  );
}

export function ActivityPanelDiffView({
  before,
  after,
  cacheKey,
}: ActivityPanelDiffViewProps): React.JSX.Element {
  if (before === after) {
    return (
      <div className="activity-panel-diff px-3 py-2 text-xs text-muted-foreground italic">
        <Trans>No changes</Trans>
      </div>
    );
  }

  return (
    <div className="activity-panel-diff">
      <ErrorBoundary
        resetKeys={[cacheKey]}
        fallback={<RawDiffFallback after={after} />}
        onError={(error) =>
          console.error('[activity-panel-diff] Pierre render failed', {
            cacheKey,
            beforeLength: before.length,
            afterLength: after.length,
            error,
          })
        }
      >
        <MultiFileDiff
          className="pierre-diff"
          oldFile={{
            name: 'document.md',
            contents: before,
            lang: 'text',
            cacheKey: `${cacheKey}-before`,
          }}
          newFile={{
            name: 'document.md',
            contents: after,
            lang: 'text',
            cacheKey: `${cacheKey}-after`,
          }}
          options={{
            diffStyle: 'unified',
            overflow: 'wrap',
            maxLineDiffLength: MAX_LINE_DIFF_LENGTH,
            theme: okPierreTheme(),
            parseDiffOptions: PARSE_DIFF_OPTIONS,
            disableFileHeader: true,
            diffIndicators: 'classic',
            onPostRender: hideGutterFromAssistiveTech,
          }}
        />
      </ErrorBoundary>
    </div>
  );
}
