
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
