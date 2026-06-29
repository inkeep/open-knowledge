
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ALIGNABLE_DESCRIPTOR_NAMES } from '../utils/alignable-descriptors.ts';
import { runWithAlignAnimation } from '../utils/animate-align-change.ts';

type Align = 'center' | 'left' | 'right';

const ALIGN_OPTIONS: ReadonlyArray<{
  value: Align;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: 'left', label: 'Align left', icon: AlignLeft },
  { value: 'center', label: 'Align center', icon: AlignCenter },
  { value: 'right', label: 'Align right', icon: AlignRight },
];

function readActiveImageAlign(editor: Editor): Align | null {
  const sel = editor.state.selection;
  const node = (sel as { node?: { type: { name: string }; attrs: Record<string, unknown> } }).node;
  if (!node) return null;
  if (node.type.name !== 'jsxComponent') return null;
  const componentName = node.attrs.componentName;
  if (!ALIGNABLE_DESCRIPTOR_NAMES.has(String(componentName))) {
    return null;
  }
  const props = (node.attrs.props ?? {}) as Record<string, unknown>;
  const raw = props.align;
  if (raw === 'left' || raw === 'right' || raw === 'center') return raw;
  return 'center';
}

interface ImageAlignButtonsProps {
  editor: Editor;
}

export function ImageAlignButtons({ editor }: ImageAlignButtonsProps) {
  const active = useEditorState({
    editor,
    selector: (ctx) => readActiveImageAlign(ctx.editor),
  });

  if (active === null) return null;

  return (
    <div className="flex items-center gap-0.5">
      {ALIGN_OPTIONS.map(({ value, label, icon: Icon }) => {
        const isActive = active === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={label}
                aria-pressed={isActive}
                className={isActive ? 'bg-accent text-primary' : 'text-accent-foreground'}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const sel = editor.state.selection;
                  const liveNode = (
                    sel as {
                      node?: { type: { name: string }; attrs: Record<string, unknown> };
                    }
                  ).node;
                  if (!liveNode || liveNode.type.name !== 'jsxComponent') return;
                  const componentName = String(liveNode.attrs.componentName ?? '');
                  if (!ALIGNABLE_DESCRIPTOR_NAMES.has(componentName)) {
                    return;
                  }
                  if (liveNode.attrs.kind !== 'element') return;
                  const isCommonMark = componentName === 'CommonMarkImage';
                  const pos = (sel as { from: number }).from;
                  const nextProps = {
                    ...((liveNode.attrs.props ?? {}) as Record<string, unknown>),
                    align: value,
                  };
                  const nextAttrs = isCommonMark
                    ? {
                        ...liveNode.attrs,
                        componentName: 'img',
                        props: nextProps,
                        sourceDirty: true,
                      }
                    : { ...liveNode.attrs, props: nextProps, sourceDirty: true };
                  const tr = editor.state.tr.setNodeMarkup(pos, null, nextAttrs);
                  tr.setSelection(NodeSelection.create(tr.doc, pos));
                  const wrapperEl = editor.view.nodeDOM(pos) as HTMLElement | null;
                  runWithAlignAnimation(wrapperEl, () => {
                    editor.view.dispatch(tr);
                  });
                }}
              >
                <Icon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              {label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function isImageNodeSelected(editor: Editor): boolean {
  return readActiveImageAlign(editor) !== null;
}
