import type * as React from 'react';

type UserTextProps = Omit<React.ComponentProps<'bdi'>, 'dir'>;

export function UserText({ children, ...props }: UserTextProps) {
  return <bdi {...props}>{children}</bdi>;
}
