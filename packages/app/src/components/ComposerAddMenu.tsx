import { useLingui } from '@lingui/react/macro';
import { AtSign, MessageSquare, Paperclip, Plus, SquareSlash } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useRef,
  useState,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openFilePicker } from '@/lib/file-picker';

const ComposerFocusActionContext = createContext<((action: () => void) => void) | null>(null);

function useComposerFocusAction(): (action: () => void) => void {
  const scheduleComposerFocusAction = use(ComposerFocusActionContext);
  if (scheduleComposerFocusAction === null) {
    throw new Error('Composer picker menu items must be rendered inside ComposerAddMenu');
  }
  return scheduleComposerFocusAction;
}

type ComposerAddMenuProps = {
  children: ReactNode;
  testId: string;
  size?: Extract<ComponentProps<typeof Button>['size'], 'icon-sm' | 'icon'>;
} & (
  | {
      disabled?: never;
      disabledFocusTargetRef?: never;
    }
  | {
      disabled: boolean;
      disabledFocusTargetRef: RefObject<HTMLElement | null>;
    }
);

export function ComposerAddMenu({
  children,
  disabled = false,
  disabledFocusTargetRef,
  testId,
  size = 'icon-sm',
}: ComposerAddMenuProps): ReactNode {
  const { t } = useLingui();
  const label = t`Add to prompt`;
  const composerFocusActionRef = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <ComposerFocusActionContext
      value={(action) => {
        composerFocusActionRef.current = action;
      }}
    >
      <DropdownMenu
        open={!disabled && open}
        onOpenChange={(nextOpen) => {
          if (disabled) return;
          if (nextOpen) composerFocusActionRef.current = null;
          setOpen(nextOpen);
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size={size}
                variant="ghost"
                className="rounded-lg"
                disabled={disabled}
                aria-label={label}
                data-testid={testId}
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="top"
          align="start"
          className="min-w-52"
          data-composer-portal=""
          onCloseAutoFocus={(event) => {
            if (disabled) {
              event.preventDefault();
              composerFocusActionRef.current = null;
              setOpen(false);
              disabledFocusTargetRef?.current?.focus();
              return;
            }
            const action = composerFocusActionRef.current;
            if (action !== null) {
              event.preventDefault();
              composerFocusActionRef.current = null;
              action();
            }
          }}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </ComposerFocusActionContext>
  );
}

export function ComposerFilesMenuItem({
  onFiles,
  attachmentMode = 'embedded',
}: {
  onFiles: (files: readonly File[]) => Promise<void> | void;
  attachmentMode?: 'embedded' | 'reference';
}): ReactNode {
  const { t } = useLingui();
  return (
    <DropdownMenuItem onSelect={() => openFilePicker({ multiple: true, onFiles })}>
      <Paperclip className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span>
        {t`Attach files`}
        {attachmentMode === 'reference' ? t` · references only (no embedded contents)` : null}
      </span>
    </DropdownMenuItem>
  );
}

export function ComposerCommentsMenuItem({
  count,
  onSelect,
}: {
  count: number;
  onSelect: () => void;
}): ReactNode {
  const { t } = useLingui();
  return (
    <DropdownMenuItem aria-label={t`Attach comments: ${count}`} onSelect={onSelect}>
      <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span>{t`Attach comments`}</span>
      <Badge
        variant="gray"
        aria-hidden="true"
        className="ms-auto h-4 min-w-4 rounded-xs px-1 text-2xs leading-none tabular-nums"
      >
        {count}
      </Badge>
    </DropdownMenuItem>
  );
}

export function ComposerMentionMenuItem({ onSelect }: { onSelect: () => void }): ReactNode {
  const { t } = useLingui();
  const scheduleComposerFocusAction = useComposerFocusAction();
  return (
    <DropdownMenuItem onSelect={() => scheduleComposerFocusAction(onSelect)}>
      <AtSign className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span>{t`Mention a page`}</span>
      <DropdownMenuShortcut aria-hidden="true">@</DropdownMenuShortcut>
    </DropdownMenuItem>
  );
}

export function ComposerCommandsMenuItem({ onSelect }: { onSelect: () => void }): ReactNode {
  const { t } = useLingui();
  const scheduleComposerFocusAction = useComposerFocusAction();
  return (
    <DropdownMenuItem onSelect={() => scheduleComposerFocusAction(onSelect)}>
      <SquareSlash className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span>{t`Commands`}</span>
      <DropdownMenuShortcut aria-hidden="true">/</DropdownMenuShortcut>
    </DropdownMenuItem>
  );
}
