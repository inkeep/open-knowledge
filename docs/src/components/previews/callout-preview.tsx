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
import type { ReactNode } from 'react';

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

const TYPE_COLOR: Record<CalloutType, string> = {
  note: '#3b82f6',
  tip: '#22c55e',
  important: '#a855f7',
  warning: '#f59e0b',
  caution: '#ef4444',
  abstract: '#0ea5e9',
  info: '#3b82f6',
  todo: '#6366f1',
  success: '#22c55e',
  question: '#eab308',
  failure: '#ef4444',
  danger: '#dc2626',
  bug: '#f97316',
  example: '#8b5cf6',
  quote: '#94a3b8',
};

interface CalloutPreviewProps {
  type?: CalloutType;
  title?: string;
  color?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children?: ReactNode;
}

export function CalloutPreview({
  type = 'note',
  title,
  color,
  collapsible = false,
  defaultOpen = true,
  children,
}: CalloutPreviewProps) {
  const Icon = TYPE_ICON[type];
  const accent = color ?? TYPE_COLOR[type];

  const rootStyle = { borderLeftColor: accent };
  const rootClass =
    'flex gap-3 rounded-md border border-fd-border border-l-4 bg-fd-card/50 px-4 py-3 text-sm text-fd-foreground';
  const iconStyle = { color: accent };
  const header = (
    <span className="flex items-center gap-2">
      <Icon size={16} style={iconStyle} aria-hidden />
      {title ? <span className="font-medium">{title}</span> : null}
    </span>
  );

  if (collapsible) {
    return (
      <details className={rootClass} style={rootStyle} open={defaultOpen}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
          {header ?? <span className="font-medium">Details</span>}
          <ChevronDown size={16} className="text-fd-muted-foreground" aria-hidden />
        </summary>
        <div className="mt-2 flex flex-col gap-2 pl-6">{children}</div>
      </details>
    );
  }

  return (
    <div className={rootClass} style={rootStyle}>
      <div className="flex flex-col gap-2">
        {header}
        <div className="flex flex-col gap-2">{children}</div>
      </div>
    </div>
  );
}
