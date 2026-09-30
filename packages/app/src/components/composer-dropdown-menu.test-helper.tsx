import {
  type ComponentProps,
  cloneElement,
  createContext,
  isValidElement,
  type ReactNode,
  use,
} from 'react';
import type * as DropdownMenuModule from '@/components/ui/dropdown-menu';

type DropdownMenuProps<Name extends keyof typeof DropdownMenuModule> = ComponentProps<
  (typeof DropdownMenuModule)[Name]
>;

function asDivProps(props: object): ComponentProps<'div'> {
  return props as ComponentProps<'div'>;
}

function asButtonProps(props: object): ComponentProps<'button'> {
  return props as ComponentProps<'button'>;
}

function asSpanProps(props: object): ComponentProps<'span'> {
  return props as ComponentProps<'span'>;
}

function asHrProps(props: object): ComponentProps<'hr'> {
  return props as ComponentProps<'hr'>;
}

function invokeSelection(onSelect: unknown): void {
  if (typeof onSelect === 'function') Reflect.apply(onSelect, undefined, [new Event('select')]);
}

const CloseAutoFocusContext = createContext<((event: Event) => void) | undefined>(undefined);

function MockMenuItem({
  children,
  disabled,
  onSelect,
  props,
}: {
  children: ReactNode;
  disabled: boolean | undefined;
  onSelect: unknown;
  props: object;
}) {
  const onCloseAutoFocus = use(CloseAutoFocusContext);
  return (
    <button
      type="button"
      role="menuitem"
      {...asButtonProps(props)}
      disabled={disabled}
      onClick={() => {
        invokeSelection(onSelect);
        onCloseAutoFocus?.(new Event('focus', { cancelable: true }));
      }}
    >
      {children}
    </button>
  );
}

export function createComposerDropdownMenuMock() {
  return {
    DropdownMenu: ({ children }: DropdownMenuProps<'DropdownMenu'>) => <div>{children}</div>,
    DropdownMenuPortal: ({ children }: DropdownMenuProps<'DropdownMenuPortal'>) => <>{children}</>,
    DropdownMenuTrigger: ({
      children,
      asChild: _asChild,
      ...props
    }: DropdownMenuProps<'DropdownMenuTrigger'>) =>
      isValidElement(children) ? cloneElement(children, props) : <>{children}</>,
    DropdownMenuContent: ({
      children,
      onCloseAutoFocus,
      ...props
    }: DropdownMenuProps<'DropdownMenuContent'>) => (
      <CloseAutoFocusContext value={onCloseAutoFocus}>
        <div role="menu" {...asDivProps(props)}>
          {children}
        </div>
      </CloseAutoFocusContext>
    ),
    DropdownMenuGroup: ({ children }: DropdownMenuProps<'DropdownMenuGroup'>) => <>{children}</>,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
      ...props
    }: DropdownMenuProps<'DropdownMenuItem'>) => (
      <MockMenuItem {...{ children, disabled, onSelect, props }} />
    ),
    DropdownMenuCheckboxItem: ({
      children,
      disabled,
      checked,
      ...props
    }: DropdownMenuProps<'DropdownMenuCheckboxItem'>) => (
      <button
        type="button"
        role="menuitemcheckbox"
        {...asButtonProps(props)}
        aria-checked={checked === 'indeterminate' ? 'mixed' : checked}
        disabled={disabled}
      >
        {children}
      </button>
    ),
    DropdownMenuRadioGroup: ({ children }: DropdownMenuProps<'DropdownMenuRadioGroup'>) => (
      <>{children}</>
    ),
    DropdownMenuRadioItem: ({
      children,
      disabled,
      ...props
    }: DropdownMenuProps<'DropdownMenuRadioItem'>) => (
      <button
        type="button"
        role="menuitemradio"
        {...asButtonProps(props)}
        aria-checked={false}
        disabled={disabled}
      >
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children, ...props }: DropdownMenuProps<'DropdownMenuLabel'>) => (
      <div {...asDivProps(props)}>{children}</div>
    ),
    DropdownMenuSeparator: (props: DropdownMenuProps<'DropdownMenuSeparator'>) => (
      <hr data-testid="menu-separator" {...asHrProps(props)} />
    ),
    DropdownMenuShortcut: ({ children, ...props }: DropdownMenuProps<'DropdownMenuShortcut'>) => (
      <span {...asSpanProps(props)}>{children}</span>
    ),
    DropdownMenuSub: ({ children }: DropdownMenuProps<'DropdownMenuSub'>) => <>{children}</>,
    DropdownMenuSubTrigger: ({
      children,
      disabled,
      onSelect,
      ...props
    }: DropdownMenuProps<'DropdownMenuSubTrigger'>) => (
      <button
        type="button"
        {...asButtonProps(props)}
        disabled={disabled}
        onClick={() => invokeSelection(onSelect)}
      >
        {children}
      </button>
    ),
    DropdownMenuSubContent: ({
      children,
      ...props
    }: DropdownMenuProps<'DropdownMenuSubContent'>) => (
      <div role="menu" {...asDivProps(props)}>
        {children}
      </div>
    ),
  } satisfies typeof DropdownMenuModule;
}
