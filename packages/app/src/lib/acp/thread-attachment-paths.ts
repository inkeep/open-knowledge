import type { RenderedItem } from '@/lib/acp/thread-event-model';

export function threadAttachmentPaths(items: readonly RenderedItem[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'message' || item.role !== 'user') continue;
    for (const attachment of item.attachments ?? []) {
      if (attachment.kind !== 'file' && attachment.kind !== 'folder') continue;
      if (seen.has(attachment.path)) continue;
      seen.add(attachment.path);
      paths.push(attachment.path);
    }
  }
  return paths;
}
