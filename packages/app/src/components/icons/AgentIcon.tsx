import { type LucideProps, Sparkles } from 'lucide-react';
import type { SVGProps } from 'react';
import { ClaudeIcon } from './claude';
import { ClineIcon } from './cline';
import { CodexIcon } from './codex';
import { CopilotIcon } from './copilot';
import { CursorIcon } from './cursor';
import { WindsurfIcon } from './windsurf';

/** Map `icon` identifier (from `iconFromClientName`) to its SVG component. Unknown agents fall back to Sparkles. */
export function AgentIcon({ icon, ...props }: { icon?: string } & SVGProps<SVGSVGElement>) {
  if (icon === 'claude') return <ClaudeIcon {...props} />;
  if (icon === 'cursor') return <CursorIcon {...props} />;
  if (icon === 'windsurf') return <WindsurfIcon {...props} />;
  if (icon === 'openai') return <CodexIcon {...props} />;
  if (icon === 'cline') return <ClineIcon {...props} />;
  if (icon === 'github') return <CopilotIcon {...props} />;
  return <Sparkles strokeWidth={1.5} {...(props as LucideProps)} />;
}
