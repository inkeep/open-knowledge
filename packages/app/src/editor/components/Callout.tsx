/**
 * Callout — DIY renderer for the 15-type callout system (5 GFM + 10
 * Obsidian-parity).
 *
 * Renders the descriptor's 7-prop surface: `type` (15-value enum),
 * `title`, `icon` (namespaced lucide), `color` (hex accent override),
 * `collapsible`, `defaultOpen`, and `children` (the PM-managed
 * NodeViewContent slot).
 *
 * Two render branches:
 *
 *   1. Static (collapsible !== true): flex container with a left-border accent,
 *      type-inferred icon, optional title row, and the body.
 *
 *   2. Collapsible (collapsible === true): native HTML5 <details>/<summary>.
 *      `defaultOpen` maps to the `open` attribute. The summary carries the
 *      icon + title (no editable chrome — PM does not mount inside <summary>).
 *      Body renders unconditionally; browsers display:none the content when
 *      collapsed but DOM is retained, so PM children stay live.
 *
 * The component accepts `children` (NodeViewContent injected by JsxComponentView)
 * as an opaque React element and places it inside the body region. The
 * surrounding chrome is non-editable; clicking the summary toggles the open
 * state via native browser behavior (no JS handler needed).
 *
 * Zero upstream-docs-lib React imports — all styling flows
 * through Tailwind utility classes + the `[data-component-type="callout"]`
 * selector in globals.css (OK shadcn semantic tokens). An inline
 * `--callout-type-color` CSS variable drives the left-border accent +
 * selection-halo; when the user authors a `color` prop, the inline style
 * overrides the per-type default.
 *
 * Precedent #30 (all user content visible): children slot is ALWAYS rendered,
 * never `display: none` via React. Native `<details>` does its own
 * display-toggle inside the browser — that is orthogonal to the precedent.
 */

import { Trans } from '@lingui/react/macro';
import {
  AlertOctagon,
  AlertTriangle,
  BookOpen,
  Bug,
  ChevronDown,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardList,
  FlaskConical,
  Info,
  Lightbulb,
  ListTodo,
  type LucideIcon,
  MessageSquareWarning,
  Quote,
  Zap,
} from 'lucide-react';
import { resolveLucideIcon } from './lucide-icon-allowlist.ts';

const TYPE_ICON: Record<CalloutType, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: AlertTriangle,
  caution: AlertOctagon,
  abstract: ClipboardList,
  info: BookOpen,
  todo: ListTodo,
  success: CircleCheck,
  question: CircleHelp,
  failure: CircleX,
  danger: Zap,
  bug: Bug,
  example: FlaskConical,
  quote: Quote,
};

type CalloutType =
  | 'note'
  | 'tip'
  | 'important'
  | 'warning'
  | 'caution'
  | 'abstract'
  | 'info'
  | 'todo'
  | 'success'
  | 'question'
  | 'failure'
  | 'danger'
  | 'bug'
  | 'example'
  | 'quote';

interface CalloutProps {
  type?: CalloutType | string;
  title?: string;
  icon?: string;
  color?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}

function resolveIcon(icon: string | undefined, type: CalloutType): LucideIcon {
  return resolveLucideIcon(icon) ?? TYPE_ICON[type];
}

const ACCEPTED_TYPES: ReadonlySet<string> = new Set<CalloutType>([
  'note',
  'tip',
  'important',
  'warning',
  'caution',
  'abstract',
  'info',
  'todo',
  'success',
  'question',
  'failure',
  'danger',
  'bug',
  'example',
  'quote',
]);

function normalizeType(raw: CalloutType | string | undefined): CalloutType {
  if (typeof raw === 'string' && ACCEPTED_TYPES.has(raw)) return raw as CalloutType;
  return 'note';
}

export function Callout(props: CalloutProps) {
  const type = normalizeType(props.type);
  const Icon = resolveIcon(props.icon, type);
  const rootStyle: React.CSSProperties = props.color
    ? ({ ['--callout-type-color' as string]: props.color } as React.CSSProperties)
    : {};

  const header =
    props.title || Icon ? (
      <span className="callout-header" contentEditable={false}>
        <Icon size={16} className="callout-icon" aria-hidden="true" />
        {props.title ? <span className="callout-title">{props.title}</span> : null}
      </span>
    ) : null;

  if (props.collapsible) {
    const defaultOpen = props.defaultOpen ?? true;
    return (
      <details
        className="callout callout-collapsible"
        data-callout-type={type}
        open={defaultOpen}
        style={rootStyle}
      >
        <summary className="callout-summary" contentEditable={false}>
          {header ?? (
            <span className="callout-title">
              <Trans>Details</Trans>
            </span>
          )}
          <ChevronDown size={16} className="callout-chevron" aria-hidden="true" />
        </summary>
        <div className="callout-body">{props.children}</div>
      </details>
    );
  }

  return (
    <div className="callout callout-static" data-callout-type={type} style={rootStyle}>
      {header}
      <div className="callout-body">{props.children}</div>
    </div>
  );
}
