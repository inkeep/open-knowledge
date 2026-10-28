import {
  incrementJsxActionAborted,
  type JsxNodeAction,
} from '@inkeep/open-knowledge-core/metrics/parse-health';
import { t } from '@lingui/core/macro';
import type { NodeViewProps } from '@tiptap/core';
import { toast } from 'sonner';
import { resolveJsxNodeTarget } from './jsx-node-target.ts';

type JsxActionContext = Pick<NodeViewProps, 'editor' | 'getPos' | 'node'> & {
  descriptorName: string;
};

export function reportJsxActionAborted(
  context: Pick<JsxActionContext, 'node' | 'descriptorName'>,
  action: JsxNodeAction,
  reason: 'changed' | 'removed',
): void {
  incrementJsxActionAborted(action);
  console.warn(
    JSON.stringify({
      event: 'jsx-component-action-aborted',
      action,
      reason,
      component: context.descriptorName === '*' ? 'wildcard' : context.descriptorName,
      rawComponentName: String(context.node.attrs.componentName ?? '').slice(0, 200),
    }),
  );
  toast.info(
    reason === 'removed' ? t`This component was removed.` : t`This component changed. Try again.`,
  );
}

export function resolveJsxActionTarget(context: JsxActionContext, action: JsxNodeAction) {
  const target = resolveJsxNodeTarget(context.editor.state.doc, context.getPos, context.node);
  if (target.kind !== 'current') {
    reportJsxActionAborted(context, action, target.kind);
    return null;
  }
  return target;
}
