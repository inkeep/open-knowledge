const mountIdByDocName = new Map<string, string>();

export function getMountId(docName: string): string | undefined {
  return mountIdByDocName.get(docName);
}

export function setMountId(docName: string, mountId: string): void {
  mountIdByDocName.set(docName, mountId);
}

export function clearMountId(docName: string): void {
  mountIdByDocName.delete(docName);
}

export function __getMountIdRegistry(): ReadonlyMap<string, string> {
  return mountIdByDocName;
}

export function __resetMountIdRegistry(): void {
  mountIdByDocName.clear();
}
