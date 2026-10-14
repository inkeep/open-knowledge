import {
  type DesktopProduct,
  desktopProductForCliCommand,
  userHomeDisplayPath,
} from '@inkeep/open-knowledge-core/constants/product';

function rendererDesktopProduct(): DesktopProduct {
  return desktopProductForCliCommand(
    typeof window === 'undefined' ? null : window.okDesktop?.cliCommandName,
  );
}

export function okCliCommandName(): string {
  return rendererDesktopProduct().cliCommandNames[0];
}

export function okUserHomeLabel(...segments: string[]): string {
  return userHomeDisplayPath(rendererDesktopProduct(), ...segments);
}
