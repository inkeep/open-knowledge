import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ShieldAlert, X } from 'lucide-react';
import type { PreviewBlockedRequest } from '../extensions/preview-iframe-header';

export interface PreviewBlockedNoticeProps {
  blocked: PreviewBlockedRequest[];
  truncated: boolean;
  onDismiss: () => void;
}

const VISIBLE_LIMIT = 4;

export function PreviewBlockedNotice({ blocked, truncated, onDismiss }: PreviewBlockedNoticeProps) {
  const { t } = useLingui();
  const visible = blocked.slice(0, VISIBLE_LIMIT);
  const undisplayed = !truncated && blocked.length > visible.length;

  return (
    <div
      role="status"
      className="ok-codeblock-preview-blocked mt-1.5 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      contentEditable={false}
    >
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {truncated ? (
            <Trans>
              More than {blocked.length} requests were blocked by the preview's security policy
            </Trans>
          ) : (
            <Plural
              value={blocked.length}
              one="# request blocked by the preview's security policy"
              other="# requests blocked by the preview's security policy"
            />
          )}
        </p>
        <p className="mt-0.5">
          <Trans>
            The preview blocks resources that don't meet its security rules (for example plain
            http:// URLs, or code that uses eval). The content above may render incompletely.
          </Trans>
        </p>
        <ul className="mt-1 space-y-0.5">
          {visible.map((b) => (
            <li key={`${b.directive} ${b.uri}`} className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="break-all font-mono">{b.uri || t`(inline)`}</span>
              <span className="text-muted-foreground/70">{b.directive}</span>
            </li>
          ))}
        </ul>
        {undisplayed ? (
          <p className="mt-0.5 text-muted-foreground/70">
            <Trans>More requests were blocked.</Trans>
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="-mr-1 -mt-0.5 shrink-0 rounded p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t`Dismiss notice`}
        onClick={onDismiss}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
