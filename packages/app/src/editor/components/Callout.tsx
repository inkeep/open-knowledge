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

/**
 * Default lucide icon per first-class type. `icon` prop overrides via
 * `ICON_OVERRIDES` below. The 5 GFM types keep their original icons
 * (Info / Lightbulb / MessageSquareWarning / AlertTriangle / AlertOctagon)
 * so existing renders are unchanged; the 10 Obsidian-parity additions
 * each get a distinct icon that maps to common Obsidian-vault visual
 * conventions (Bug for bug, FlaskConical for example, Quote for quote,
 * etc.).
 */
const TYPE_ICON: Record<CalloutType, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: AlertTriangle,
  caution: AlertOctagon,
  abstract: ClipboardList,
  // `info` uses BookOpen (not Info) so it's visually distinguishable
  // from `note` — the two types are semantically separate now and
  // sharing an icon would degrade discoverability.
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
  /** Namespaced lucide identifier (e.g. `lucide:Lightbulb`). */
  icon?: string;
  /** Hex accent override (e.g. `#F05032`). Sanitized at JsxComponentView boundary. */
  color?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}

function resolveIcon(icon: string | undefined, type: CalloutType): LucideIcon {
  // Allowlist resolution + prototype-pollution guard live in
  // `lucide-icon-allowlist.ts`. Unresolvable identifiers fall back to the
  // type's default icon so misconfigured `icon` props still render.
  return resolveLucideIcon(icon) ?? TYPE_ICON[type];
}

/**
 * Renderer-side type normalizer. Used as a defensive narrowing pass when
 * the descriptor's `type` prop arrives from a path that bypasses the
 * mdast → PM normalization (e.g. PM `setNodeMarkup` with an arbitrary
 * string, an MDX-authored `<Callout type="weird">`). Mirrors the parser's
 * fallback to `note` for unrecognized tokens.
 *
 * The 15-name `Set` membership check is kept explicit (vs reading from
 * `TYPE_ICON`'s key list) so `type` narrowing and icon lookup stay
 * decoupled — adding an icon override doesn't accidentally widen the
 * accepted enum.
 */
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

/**
 * DIY Callout. Descriptor-dispatched via `componentMap['Callout']`.
 *
 * Note on `color` prop plumbing: we set it on `style['--callout-type-color']`
 * at the root element. The CSS rule for `[data-component-type="callout"]`
 * reads this var both for the left-border tint (this component's own CSS)
 * and the selection-halo (globals.css selection-halo rule inherited from
 * the wrapper). When `color` is unset, both fall back to the per-type
 * accent token declared in CSS.
 */
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
