import { posixOkManagedBinDir } from './ok-dir.ts';
import { DESKTOP_PRODUCTS, type DesktopProductName } from './product.ts';

function posixHome(home: string): string {
  return home.replace(/\/+/g, '/').replace(/\/+$/, '');
}

export function pathShimHomeDirName(channel: DesktopProductName): string {
  return DESKTOP_PRODUCTS[channel].userHomeDirName;
}

export function pathShimBinDir(channel: DesktopProductName, home: string): string {
  return posixOkManagedBinDir(home, pathShimHomeDirName(channel));
}

export function pathShimMarkerPath(
  channel: DesktopProductName,
  home: string,
  platform = 'darwin',
  xdgConfigHome?: string,
): string {
  if (channel === 'stable') {
    if (platform === 'linux') {
      const configHome = xdgConfigHome?.startsWith('/')
        ? xdgConfigHome
        : `${posixHome(home)}/.config`;
      return `${posixHome(configHome)}/OpenKnowledge/path-install.json`;
    }
    return `${posixHome(home)}/Library/Application Support/OpenKnowledge/path-install.json`;
  }
  return `${posixHome(home)}/${pathShimHomeDirName(channel)}/path-install.json`;
}

export function pathShimBlockLabel(channel: DesktopProductName): string {
  return channel === 'stable' ? 'open-knowledge cli' : `open-knowledge ${channel} cli`;
}

export function pathShimFishConfFileName(channel: DesktopProductName): string {
  return channel === 'stable' ? 'open-knowledge.fish' : `open-knowledge-${channel}.fish`;
}
