import type { ComponentProps } from 'react';
import {
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';

export type SkillMenuKind = 'context' | 'dropdown';

type MenuKindProp = { menuKind: SkillMenuKind };

export function SkillMenuGroup({
  menuKind,
  ...props
}: MenuKindProp & ComponentProps<typeof DropdownMenuGroup>) {
  return menuKind === 'context' ? (
    <ContextMenuGroup {...props} />
  ) : (
    <DropdownMenuGroup {...props} />
  );
}

export function SkillMenuItem({
  menuKind,
  ...props
}: MenuKindProp & ComponentProps<typeof DropdownMenuItem>) {
  return menuKind === 'context' ? <ContextMenuItem {...props} /> : <DropdownMenuItem {...props} />;
}

export function SkillMenuCheckboxItem({
  menuKind,
  ...props
}: MenuKindProp & ComponentProps<typeof DropdownMenuCheckboxItem>) {
  return menuKind === 'context' ? (
    <ContextMenuCheckboxItem {...props} />
  ) : (
    <DropdownMenuCheckboxItem {...props} />
  );
}

export function SkillMenuLabel({
  menuKind,
  ...props
}: MenuKindProp & ComponentProps<typeof DropdownMenuLabel>) {
  return menuKind === 'context' ? (
    <ContextMenuLabel {...props} />
  ) : (
    <DropdownMenuLabel {...props} />
  );
}

export function SkillMenuSeparator({
  menuKind,
  ...props
}: MenuKindProp & ComponentProps<typeof DropdownMenuSeparator>) {
  return menuKind === 'context' ? (
    <ContextMenuSeparator {...props} />
  ) : (
    <DropdownMenuSeparator {...props} />
  );
}

export function SkillMenuSub({
  menuKind,
  ...props
}: MenuKindProp & ComponentProps<typeof DropdownMenuSub>) {
  return menuKind === 'context' ? <ContextMenuSub {...props} /> : <DropdownMenuSub {...props} />;
}

export function SkillMenuSubContent({
  menuKind,
  ...props
}: MenuKindProp & ComponentProps<typeof DropdownMenuSubContent>) {
  return menuKind === 'context' ? (
    <ContextMenuSubContent {...props} />
  ) : (
    <DropdownMenuSubContent {...props} />
  );
}

export function SkillMenuSubTrigger({
  menuKind,
  ...props
}: MenuKindProp & ComponentProps<typeof DropdownMenuSubTrigger>) {
  return menuKind === 'context' ? (
    <ContextMenuSubTrigger {...props} />
  ) : (
    <DropdownMenuSubTrigger {...props} />
  );
}
